/**
 * edit_guide — create, edit, or remove one legacy EPUB 2 guide reference.
 * Mirrors Go's tools/edit_guide.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { findIndex, removeAt, verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { Package } from "../epub/types.ts";

interface EditGuideArgs {
  action?: string;
  path?: string;
  id?: string;
  href?: string;
  title?: string;
}

export const editGuideTool: EpubTool = {
  name: "edit_guide",
  description: "Create, edit, or remove one legacy EPUB 2 guide reference of an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a new guide reference, "edit" an existing one, or "remove" one' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: 'the guide reference\'s type, e.g. "cover", "toc", "text", "bibliography"' },
      href: { type: "string", description: 'target archive path, optionally with a "#fragment"; used by create and edit, ignored by remove' },
      title: { type: "string", description: "human-readable title for this reference; optional, never prompted for" },
    },
  },
};

/** Mutates pkg.guide in place per action; creates the guide element on the first "create" if absent. */
export function applyGuideEdit(pkg: Package, action: string, typ: string, title: string, href: string): void {
  if (!pkg.guide) {
    if (action !== "create") throw new Error(`${JSON.stringify(pkg.id)} has no guide element; use action "create" instead`);
    pkg.guide = { id: `${pkg.id}#guide`, references: [] };
  }

  const index = findIndex(pkg.guide.references, typ, (r) => r.type);

  switch (action) {
    case "create":
      if (index >= 0) throw new Error(`guide reference ${JSON.stringify(typ)} already exists; use action "edit" instead`);
      pkg.guide.references.push({ id: `${pkg.guide.id}/reference[${typ}]`, type: typ, title, href });
      return;
    case "edit":
      if (index < 0) throw new Error(`no guide reference ${JSON.stringify(typ)}; use action "create" instead`);
      pkg.guide.references[index]!.title = title;
      pkg.guide.references[index]!.href = href;
      return;
    case "remove":
      if (index < 0) throw new Error(`no guide reference ${JSON.stringify(typ)}`);
      pkg.guide.references = removeAt(pkg.guide.references, index);
      return;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }
}

export async function handleEditGuide(server: Server, args: EditGuideArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const typ = await resolveArg(server, args.id, "id", 'What guide reference type ("cover", "toc", "text", etc.)?');

  let href = "";
  if (action !== "remove") {
    href = await resolveArg(server, args.href, "href", "What archive path should this guide reference point to?");
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  applyGuideEdit(pkg, action, typ, args.title ?? "", href);

  epubCache.markDirty(abs);
  const result = { action, type: typ };
  const summary = `${verbPast(action)}d guide reference ${JSON.stringify(typ)} in ${JSON.stringify(abs)}. Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result };
}

registerTool(
  editGuideTool,
  'Takes action ("create", "edit", or "remove"), path, id, and href; any of these may be omitted to be ' +
    "prompted for (see edit_chapter's description for the general elicitation rules every edit_ tool " +
    'follows). id is the reference\'s type (e.g. "cover", "toc", "text"), since guide references are ' +
    "addressed by type rather than a separate id. title is optional. This is a legacy EPUB 2 structure " +
    "kept for older reading systems; prefer edit_navigation's landmarks list for new books.\n\ncreate only " +
    "ever adds a reference of a type that doesn't exist yet — it never updates one that's already there, " +
    'so it fails outright if a reference of that type already exists; use "edit" instead to change its ' +
    "href/title. Only touches the in-memory cache; call save_epub afterwards to persist.",
  handleEditGuide as never,
);
