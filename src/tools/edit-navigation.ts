// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * edit_navigation — create, edit, or remove one entry of the EPUB 3
 * navigation document (table of contents, landmarks, page-list),
 * keeping a legacy NCX in sync for "toc" changes. Mirrors Go's
 * tools/edit_navigation.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg, withHint } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { clampPosition, insertAt } from "./edit-spine.ts";
import { removeAt, verbPast } from "./idlist.ts";
import { primaryNavigation } from "./get-navigation.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { ncxItem, primaryPackage, resolveHref } from "../epub/resolve.ts";
import { renderNavigationDocument, renderNCXDocument } from "../epub/render-nav.ts";
import type { NavList, NavPoint, Navigation, NCXNavPoint, Package } from "../epub/types.ts";

interface EditNavigationArgs {
  action?: string;
  path?: string;
  id?: string;
  label?: string;
  labelPrompt?: string;
  listType?: string;
  href?: string;
  type?: string;
  position?: string;
}

interface EditNavigationResult {
  action: string;
  listType: string;
  id: string;
  ncxSynced: boolean;
}

export const editNavigationTool: EpubTool = {
  name: "edit_navigation",
  description:
    "Create, edit, or remove one entry of an already-read EPUB's navigation document (table of contents, landmarks, page-list). Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a new entry, "edit" an existing one, or "remove" one' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: {
        type: "string",
        description:
          'for create: the parent entry\'s id to nest the new one under, or "" for a top-level entry; for edit/remove: the target entry\'s id, from get_navigation',
      },
      label: { type: "string", description: "the entry's display text; used by create and edit, ignored by remove" },
      labelPrompt: {
        type: "string",
        description:
          "extra context to show the user if label is omitted and they must be prompted for it — e.g. what this entry is for, or its current label; ignored if label is given directly, and never itself prompted for",
      },
      listType: {
        type: "string",
        description: 'which nav list this entry belongs to ("toc", "landmarks", "page-list", ...); defaults to "toc", creating the list if it doesn\'t exist yet',
      },
      href: { type: "string", description: 'target archive path, optionally with a "#fragment"; empty makes a heading-only entry that exists only to hold children' },
      type: {
        type: "string",
        description:
          'this entry\'s own epub:type attribute, distinct from listType — meaningful mainly in the "landmarks" list, e.g. "cover" or "afterword"; replaced wholesale like label/href on edit, so pass the current value back if only something else is changing',
      },
      position: { type: "string", description: "0-based index among its siblings to insert/move this entry to; omit to append at the end" },
    },
  },
};

/** Finds nav's list of the given type, or — if action is "create" — creates and appends it. Throws if not found and action isn't "create". */
export function findOrCreateNavList(nav: Navigation, listType: string, action: string): NavList {
  const existing = nav.lists.find((l) => l.type === listType);
  if (existing) return existing;
  if (action !== "create") throw new Error(`navigation document has no list of type ${JSON.stringify(listType)}`);
  const list: NavList = {
    id: `${nav.id}#${listType}`,
    type: listType,
    heading: listType.charAt(0).toUpperCase() + listType.slice(1),
    items: [],
  };
  nav.lists.push(list);
  return list;
}

/** Returns pkg's first title, or "Navigation" if it has none/an empty one. */
export function bookTitle(pkg: Package): string {
  const first = pkg.metadata.titles[0];
  if (first && first.value) return first.value;
  return "Navigation";
}

/** Returns pkg's first identifier's value, or "" if it has none. */
export function bookUID(pkg: Package): string {
  const first = pkg.metadata.identifiers[0];
  return first ? first.value : "";
}

/** Converts a NavPoint tree to an NCXNavPoint tree; id/playOrder are left blank for renderNCXDocument to fill in. */
export function toNCXPoints(points: NavPoint[]): NCXNavPoint[] {
  return points.map((p) => ({ id: "", playOrder: 0, label: p.label, src: p.href, children: toNCXPoints(p.children) }));
}

/**
 * Appends a new top-level entry to nav's "landmarks" list (creating the
 * list if it doesn't exist yet), tagged with navType as its epub:type —
 * used to auto-register the "cover"/"afterword" landmark edit_cover and
 * edit_back_cover wire up for their pages (Phase 8). Renders nav's markup
 * to match (landmarks has no NCX equivalent to sync). A no-op, returning
 * false, if an entry already targets href, so re-running the caller
 * doesn't duplicate it; callers should still call save_epub as usual
 * afterwards regardless of the return value.
 */
export function addLandmarkEntry(pkg: Package, nav: Navigation, label: string, href: string, navType: string): boolean {
  const list = findOrCreateNavList(nav, "landmarks", "create");
  if (findDuplicateNavPoint(list.items, label, href) !== "") return false;
  list.items.push({ id: "", label, href, type: navType, children: [] });
  renumberNavPoints(list.id, list.items);
  renderNavigationDocument(nav, bookTitle(pkg));
  return true;
}

/**
 * Returns the id of the sibling in siblings that already targets href
 * (or, for a heading-only entry with href === "", already carries the
 * same label), or "" if none matches. Siblings are compared at one
 * nesting level only, matching where create would insert.
 */
function findDuplicateNavPoint(siblings: NavPoint[], label: string, href: string): string {
  for (const s of siblings) {
    if (href !== "" && s.href === href) return s.id;
    if (href === "" && s.href === "" && s.label === label) return s.id;
  }
  return "";
}

/** Returns the NavPoint with the given id anywhere in points (searching children too), or undefined. Mutating fields on the returned object mutates the tree, matching Go's *NavPoint semantics. */
function findNavPointRec(points: NavPoint[], id: string): NavPoint | undefined {
  for (const p of points) {
    if (p.id === id) return p;
    const found = findNavPointRec(p.children, id);
    if (found) return found;
  }
  return undefined;
}

/** Inserts np at index at among parentId's children (top-level siblings if parentId is ""), reporting whether parentId was found (top-level insertion always succeeds). */
function insertNavPointRec(points: NavPoint[], parentId: string, at: number, np: NavPoint): [NavPoint[], boolean] {
  if (parentId === "") {
    return [insertAt(points, clampPosition(at, points.length), np), true];
  }
  for (const p of points) {
    if (p.id === parentId) {
      p.children = insertAt(p.children, clampPosition(at, p.children.length), np);
      return [points, true];
    }
    const [children, ok] = insertNavPointRec(p.children, parentId, at, np);
    if (ok) {
      p.children = children;
      return [points, true];
    }
  }
  return [points, false];
}

/** Deletes the NavPoint with the given id from points (searching children too), reporting whether it was found. */
function removeNavPointRec(points: NavPoint[], id: string): [NavPoint[], boolean] {
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.id === id) return [removeAt(points, i), true];
  }
  for (const p of points) {
    const [children, ok] = removeNavPointRec(p.children, id);
    if (ok) {
      p.children = children;
      return [points, true];
    }
  }
  return [points, false];
}

/** Relocates the NavPoint with the given id to index at among its current siblings, reporting whether it was found. */
function moveNavPointRec(points: NavPoint[], id: string, at: number): [NavPoint[], boolean] {
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.id === id) {
      const p = points[i]!;
      const rest = removeAt(points, i);
      return [insertAt(rest, clampPosition(at, rest.length), p), true];
    }
  }
  for (const p of points) {
    const [children, ok] = moveNavPointRec(p.children, id, at);
    if (ok) {
      p.children = children;
      return [points, true];
    }
  }
  return [points, false];
}

/** Reassigns positional ids ("<base>/item[<index>]") to every NavPoint in points after a structural change, so every entry keeps a valid, collision-free id. */
export function renumberNavPoints(base: string, points: NavPoint[]): void {
  points.forEach((p, i) => {
    p.id = `${base}/item[${i}]`;
    renumberNavPoints(p.id, p.children);
  });
}

/** Builds the elicitation message used when label is omitted, working in whatever context is already available. */
function labelPromptMessage(action: string, listType: string, id: string, href: string): string {
  if (action === "create") {
    if (href !== "") return `What should the display text be for this new ${JSON.stringify(listType)} entry, linking to ${JSON.stringify(href)}?`;
    if (id !== "") return `What should the display text be for this new ${JSON.stringify(listType)} entry, nested under entry ${JSON.stringify(id)}?`;
    return `What should the display text be for this new top-level ${JSON.stringify(listType)} entry?`;
  }
  if (href !== "") {
    return `What should the display text be for the ${JSON.stringify(listType)} entry ${JSON.stringify(id)} (which targets ${JSON.stringify(href)})? This replaces its current label.`;
  }
  return `What should the display text be for the ${JSON.stringify(listType)} entry ${JSON.stringify(id)}? This replaces its current label.`;
}

export async function handleEditNavigation(server: Server, args: EditNavigationArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const idPromptMsg =
    action === "create"
      ? 'Which entry should the new one be nested under? Provide its id, or "" for a top-level entry.'
      : "Which entry should be affected? Provide its id from get_navigation.";
  const id = await resolveArg(server, args.id, "id", idPromptMsg);

  const listType = args.listType || "toc";

  let label = "";
  if (action !== "remove") {
    let labelMsg = labelPromptMessage(action, listType, id, args.href ?? "");
    if (args.labelPrompt) labelMsg = withHint(labelMsg, args.labelPrompt);
    label = await resolveArg(server, args.label, "label", labelMsg);
  }

  let position: number | undefined;
  if (args.position) {
    const p = Number.parseInt(args.position, 10);
    if (Number.isNaN(p)) throw new Error(`position must be an integer, got ${JSON.stringify(args.position)}`);
    position = p;
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);
  const nav = primaryNavigation(e, pkg);

  const list = findOrCreateNavList(nav, listType, action);

  // resultId reports the entry the caller now cares about: for edit/remove
  // that's still the target id they passed in, but for create it's the
  // brand-new entry's own id (not the parent id in `id`) — the only way a
  // caller who created a heading-only entry with id "" can later nest a
  // child under it or remove it, without first calling get_navigation.
  let resultId = id;

  switch (action) {
    case "create": {
      let siblings: NavPoint[];
      let at = list.items.length;
      if (id !== "") {
        const target = findNavPointRec(list.items, id);
        if (!target) throw new Error(`no navigation entry with id ${JSON.stringify(id)} in list ${JSON.stringify(listType)}`);
        siblings = target.children;
        at = target.children.length;
      } else {
        siblings = list.items;
      }
      const href = args.href ?? "";
      const dupId = findDuplicateNavPoint(siblings, label, href);
      if (dupId !== "") {
        throw new Error(`list ${JSON.stringify(listType)} already has an entry with this href/label (id ${JSON.stringify(dupId)}); use action "edit" instead`);
      }

      const np: NavPoint = { id: "", label, href, type: args.type ?? "", children: [] };
      if (position !== undefined) at = position;
      const [items, ok] = insertNavPointRec(list.items, id, at, np);
      if (!ok) throw new Error(`no navigation entry with id ${JSON.stringify(id)} in list ${JSON.stringify(listType)}`);
      list.items = items;
      renumberNavPoints(list.id, list.items);
      resultId = np.id;
      break;
    }
    case "edit": {
      const target = findNavPointRec(list.items, id);
      if (!target) throw new Error(`no navigation entry with id ${JSON.stringify(id)} in list ${JSON.stringify(listType)}`);
      target.label = label;
      target.href = args.href ?? "";
      target.type = args.type ?? "";
      if (position !== undefined) {
        const [items, moved] = moveNavPointRec(list.items, id, position);
        if (!moved) throw new Error(`no navigation entry with id ${JSON.stringify(id)} in list ${JSON.stringify(listType)}`);
        list.items = items;
      }
      break;
    }
    case "remove": {
      const [items, ok] = removeNavPointRec(list.items, id);
      if (!ok) throw new Error(`no navigation entry with id ${JSON.stringify(id)} in list ${JSON.stringify(listType)}`);
      list.items = items;
      renumberNavPoints(list.id, list.items);
      break;
    }
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  const docTitle = bookTitle(pkg);
  renderNavigationDocument(nav, docTitle);

  let ncxSynced = false;
  if (listType === "toc") {
    const ncxManifestItem = ncxItem(pkg);
    if (ncxManifestItem) {
      const ncx = e.nCXs[resolveHref(pkg, ncxManifestItem.href)];
      if (ncx) {
        ncx.navMap = toNCXPoints(list.items);
        renderNCXDocument(ncx, docTitle, bookUID(pkg));
        ncxSynced = true;
      }
    }
  }

  epubCache.markDirty(abs);
  const result: EditNavigationResult = { action, listType, id: resultId, ncxSynced };
  const summary = `${verbPast(action)}d navigation entry in list ${JSON.stringify(listType)} of ${JSON.stringify(abs)}. Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  editNavigationTool,
  'Takes action ("create", "edit", or "remove"), path, id, and label; any of these may be omitted to be ' +
    "prompted for (see edit_chapter's description for the general elicitation rules every edit_ tool " +
    "follows). If label is omitted, pass labelPrompt with context the user needs to answer sensibly — what " +
    'this entry is for, what it currently says, what it links to — since the bare question "what should ' +
    'this entry\'s display text be?" gives them nothing to go on; labelPrompt is folded into the prompt and ' +
    'is never itself elicited. listType picks which nav list is affected (default "toc", the same list ' +
    "read_epub's tableOfContents and edit_chapter's create/remove keep updated as chapters come and go, " +
    "appending/removing a top-level entry automatically — use edit_navigation instead when you want to " +
    "reorder, rename, nest, or add a heading-only entry rather than accept the auto-generated one).\n\n" +
    'action "create": id is the parent entry to nest the new one under, or "" for a top-level entry in the ' +
    "list; href is the target (leave empty for a heading-only entry meant to hold children, e.g. a part or " +
    "section heading); position controls where among its siblings it lands. create never touches an " +
    "existing entry — it only inserts a brand-new sibling, so it cannot be used to retitle, move, or " +
    "retarget one that's already there. It fails if a sibling at the same nesting level already targets " +
    "the same href (or, for a heading-only entry, already has the same label) — call get_navigation first " +
    'to check, and use "edit" on that entry\'s id instead of "create" if it already exists.\n\naction ' +
    '"edit": id is the entry to change; label, href, and type are replaced wholesale (pass their current ' +
    "values back if only one is changing); position, if given, moves it among its current siblings.\n\n" +
    'action "remove": id is the entry to delete, along with any children it has.\n\nWhen listType is "toc" ' +
    "(the default) and the book also has a legacy EPUB 2 NCX, edit_navigation regenerates the NCX's navMap " +
    "and markup to match automatically — there's no separate NCX tool. Only touches the in-memory cache; " +
    "call save_epub afterwards to persist.",
  handleEditNavigation as never,
);

