// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * edit_cover — create, edit, or remove the front cover image of an
 * already-read EPUB. Mirrors Go's tools/edit_cover.go.
 *
 * Also hosts coverPageMarkup/xmlEscapeAttr/uniqueArchivePath/
 * removeCoverPage/guessImageMediaType-adjacent helpers consumed by
 * edit-back-cover.ts (this phase's Task 3), mirroring Go's own choice to
 * put them here and have edit_back_cover.go call straight into them.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { archiveIdInUse, guessImageMediaType, manifestIdCandidate, uniqueManifestId } from "./edit-resource.ts";
import { insertAt, renumberSpine } from "./edit-spine.ts";
import { applyGuideEdit } from "./edit-guide.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { findCoverItem } from "./get-cover.ts";
import { primaryNavigation } from "./get-navigation.ts";
import { addLandmarkEntry, bookTitle, renumberNavPoints as renumberNavPointsForLandmarks } from "./edit-navigation.ts";
import { removeMatching, verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemByHref, primaryPackage, relativeArchiveHref, relativeHref, resolveHref } from "../epub/resolve.ts";
import { renderNavigationDocument } from "../epub/render-nav.ts";
import type { Epub, Package } from "../epub/types.ts";

interface EditCoverArgs {
  action?: string;
  path?: string;
  id?: string;
  sourcePath?: string;
  mediaType?: string;
}

interface EditCoverResult {
  action: string;
  id?: string;
  mediaType?: string;
  sizeBytes?: number;
}

export const editCoverTool: EpubTool = {
  name: "edit_cover",
  description: "Create, edit, or remove the cover image of an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a cover image (fails if one exists), "edit" its bytes in place, or "remove" it' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: 'archive path for the new cover image, e.g. "OEBPS/images/cover.jpg"; used only by create — edit and remove always target the book\'s existing cover' },
      sourcePath: { type: "string", description: "filesystem path to the image file to use as the cover, read directly from disk (not sent through MCP); used by create and edit, ignored by remove" },
      mediaType: { type: "string", description: 'image media type, e.g. "image/jpeg"; guessed from id\'s extension if omitted on create' },
    },
  },
};

/** Builds a minimal XHTML wrapper page that displays a single full-page image, for both front- and back-cover pages. imgHref is document-relative (see relativeArchiveHref), not the package's baseDir. */
export function coverPageMarkup(title: string, sectionType: string, imgHref: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
<meta charset="UTF-8"/>
<title>${xmlEscapeAttr(title)}</title>
<style type="text/css">html,body{margin:0;padding:0;text-align:center;} img{max-width:100%;max-height:100%;}</style>
</head>
<body>
<section epub:type="${xmlEscapeAttr(sectionType)}">
<img src="${xmlEscapeAttr(imgHref)}" alt="${xmlEscapeAttr(title)}"/>
</section>
</body>
</html>
`;
}

/** Escapes text for use inside a double-quoted XML attribute or as element content. */
export function xmlEscapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

/** Returns candidate, or candidate with a numeric suffix inserted before its extension, whichever isn't already used by anything in e. */
export function uniqueArchivePath(e: Epub, candidate: string): string {
  if (!archiveIdInUse(e, candidate)) return candidate;
  const ext = extname(candidate);
  const base = candidate.slice(0, candidate.length - ext.length);
  for (let n = 2; ; n++) {
    const attempt = `${base}-${n}${ext}`;
    if (!archiveIdInUse(e, attempt)) return attempt;
  }
}

export async function handleEditCover(server: Server, args: EditCoverArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");

  let id = "";
  if (action === "create") {
    id = await resolveArg(server, args.id, "id", 'What archive path should the cover image be saved at (e.g. "OEBPS/images/cover.jpg")?');
  }

  let data = new Uint8Array(0);
  if (action !== "remove") {
    const sourcePath = await resolveArg(server, args.sourcePath, "sourcePath", "What is the filesystem path to the image file to use as the cover?");
    data = await readFile(sourcePath);
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  let result: EditCoverResult;
  switch (action) {
    case "create":
      result = createCover(e, pkg, id, data, args.mediaType ?? "");
      break;
    case "edit":
      result = editExistingCover(e, pkg, data, args.mediaType ?? "");
      break;
    case "remove":
      result = removeCover(e, pkg);
      break;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  epubCache.markDirty(abs);
  const summary = `${verbPast(action)}d cover ${JSON.stringify(result.id)} in ${JSON.stringify(abs)} (${result.sizeBytes} bytes). Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

function createCover(e: Epub, pkg: Package, id: string, data: Uint8Array, mediaType: string): EditCoverResult {
  const existing = findCoverItem(pkg);
  if (existing) throw new Error(`${JSON.stringify(pkg.id)} already has a cover image (${JSON.stringify(resolveHref(pkg, existing.href))}); use action "edit" instead`);
  if (archiveIdInUse(e, id)) throw new Error(`${JSON.stringify(id)} already exists in this book; use action "edit" instead`);
  const resolvedMediaType = mediaType || guessImageMediaType(id);

  const opfId = uniqueManifestId(pkg, manifestIdCandidate(id));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${opfId}`,
    href: relativeHref(pkg, id),
    mediaType: resolvedMediaType,
    properties: ["cover-image"],
    fallback: "",
    mediaOverlay: "",
  });
  e.resources[id] = { id, mediaType: resolvedMediaType, data };
  pkg.metadata.metas.push({
    id: `${pkg.metadata.id}/meta[${pkg.metadata.metas.length}]`,
    property: "",
    refines: "",
    scheme: "",
    value: opfId,
    name: "cover",
  });

  const pageId = uniqueArchivePath(e, `${pkg.baseDir}cover.xhtml`);
  e.contentDocuments[pageId] = {
    id: pageId,
    mediaType: "application/xhtml+xml",
    markup: coverPageMarkup("Cover", "cover", relativeArchiveHref(pageId, id)),
  };
  const pageOpfId = uniqueManifestId(pkg, manifestIdCandidate(pageId));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${pageOpfId}`,
    href: relativeHref(pkg, pageId),
    mediaType: "application/xhtml+xml",
    properties: [],
    fallback: "",
    mediaOverlay: "",
  });
  pkg.spine.itemRefs = insertAt(pkg.spine.itemRefs, 0, { id: "", idRef: pageOpfId, linear: true, properties: [] });
  renumberSpine(pkg);

  try {
    applyGuideEdit(pkg, "create", "cover", "Cover", pageId);
  } catch {
    // A pre-existing guide reference of type "cover" without a tracked
    // cover-image manifest item would be unusual; ignore the error rather
    // than fail cover creation over it, matching Go's own `_ = applyGuideEdit(...)`.
  }
  try {
    const nav = primaryNavigation(e, pkg);
    addLandmarkEntry(pkg, nav, "Cover", pageId, "cover");
  } catch {
    // No EPUB 3 navigation document to add a landmark to; best-effort, matching Go.
  }

  return { action: "create", id, mediaType: resolvedMediaType, sizeBytes: data.length };
}

function editExistingCover(e: Epub, pkg: Package, data: Uint8Array, mediaType: string): EditCoverResult {
  const item = findCoverItem(pkg);
  if (!item) throw new Error(`${JSON.stringify(pkg.id)} has no cover image; use action "create" instead`);
  const archivePath = resolveHref(pkg, item.href);
  const res = e.resources[archivePath];
  if (!res) throw new Error(`cover manifest item ${JSON.stringify(item.id)} resolves to ${JSON.stringify(archivePath)}, which isn't in resources`);

  res.data = data;
  if (mediaType) {
    res.mediaType = mediaType;
    item.mediaType = mediaType;
  }

  return { action: "edit", id: archivePath, mediaType: res.mediaType, sizeBytes: data.length };
}

function removeCover(e: Epub, pkg: Package): EditCoverResult {
  const item = findCoverItem(pkg);
  if (!item) throw new Error(`${JSON.stringify(pkg.id)} has no cover image`);
  const archivePath = resolveHref(pkg, item.href);
  const prefix = pkg.manifest.id + "/";
  const opfId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
  const sizeBytes = e.resources[archivePath]?.data.length ?? 0;

  pkg.manifest.items = removeMatching(pkg.manifest.items, (it) => it.id !== item.id);
  delete e.resources[archivePath];
  pkg.metadata.metas = removeMatching(pkg.metadata.metas, (meta) => !(meta.name === "cover" && meta.value === opfId));

  // The front-cover XHTML wrapper page (spine/manifest/landmark) that
  // createCover builds alongside the raw image is tracked via the guide
  // reference of type "cover" pointing at it; clean it up too, if present.
  if (pkg.guide) {
    let pageId = "";
    const keptRefs = pkg.guide.references.filter((r) => {
      if (r.type === "cover") {
        pageId = r.href;
        return false;
      }
      return true;
    });
    pkg.guide.references = keptRefs;
    if (pageId) removeCoverPage(e, pkg, pageId);
  }

  return { action: "remove", id: archivePath, sizeBytes };
}

/**
 * Deletes the cover wrapper page's content document, manifest item,
 * spine entry, and "landmarks" entry — everything createCover (or
 * createBackCover) builds around the raw image besides the image entry
 * itself, which the caller handles separately.
 */
export function removeCoverPage(e: Epub, pkg: Package, pageId: string): void {
  delete e.contentDocuments[pageId];
  const item = manifestItemByHref(pkg, pageId);
  if (item) {
    const prefix = pkg.manifest.id + "/";
    const opfId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
    pkg.manifest.items = removeMatching(pkg.manifest.items, (it) => it.id !== item.id);
    pkg.spine.itemRefs = removeMatching(pkg.spine.itemRefs, (ref) => ref.idRef !== opfId);
    renumberSpine(pkg);
  }

  let nav;
  try {
    nav = primaryNavigation(e, pkg);
  } catch {
    return;
  }
  for (const list of nav.lists) {
    if (list.type !== "landmarks") continue;
    const before = list.items.length;
    list.items = list.items.filter((p) => p.href !== pageId);
    if (list.items.length !== before) {
      // Landmark removal renumbers via the same helper edit_navigation
      // uses after any structural toc/landmarks change, then re-renders
      // nav.markup so the removed landmark doesn't linger in the
      // serialized XHTML after the structured nav.lists data has already
      // dropped it.
      renumberNavPointsForLandmarks(list.id, list.items);
      renderNavigationDocument(nav, bookTitle(pkg));
    }
  }
}

registerTool(
  editCoverTool,
  'Takes action ("create", "edit", or "remove"), path, id, and sourcePath; any may be omitted to ' +
    "be prompted for (see edit_chapter's description for the general elicitation rules every edit_ tool " +
    "follows). sourcePath is a filesystem path to the image file to use as the cover — it's read " +
    "directly from disk on the machine running this server, never sent through MCP as bytes.\n\n" +
    'action "create": id is the archive path to save the new cover image at. Adds it to the ' +
    'manifest with the "cover-image" property (the only part of the EPUB 3 spec reserved ' +
    "specifically for front covers — it's what tells reading systems which image to use as the " +
    "library thumbnail) and a legacy EPUB 2 meta name=\"cover\" pointer for older reading systems. " +
    "It also builds a minimal XHTML wrapper page around the image and wires it in the way front " +
    "covers are conventionally expected to appear: first entry in the spine (so it's the very first " +
    'thing a linear read reaches), an epub:type="cover" entry in the navigation document\'s ' +
    '"landmarks" list (so reading systems can offer a "go to cover" jump), and a matching legacy ' +
    "guide reference for older systems. create only ever adds a cover where none exists — it never " +
    'updates one already there, so it fails outright if the book already has a cover; use "edit" ' +
    "instead to replace its bytes.\n\n" +
    'action "edit": replaces the existing cover\'s bytes (and mediaType, if given) in place. id is ' +
    "ignored — there's only ever one cover, found automatically. The wrapper page, spine entry, " +
    'landmark, and guide reference from create are left as they are. Fails if the book has no cover ' +
    'yet (use "create" instead).\n\n' +
    'action "remove": deletes the cover resource and its manifest entry, the legacy meta pointer, ' +
    'and — if create built one — the wrapper page, its spine entry, its "landmarks" entry, and the ' +
    'guide reference of type "cover". id and sourcePath are ignored.\n\n' +
    "All three actions only touch the in-memory cache; call save_epub afterwards to persist.",
  handleEditCover as never,
);

