// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * edit_back_cover — create, edit, or remove the back cover image of an
 * already-read EPUB. Mirrors Go's tools/edit_back_cover.go.
 *
 * Key structural difference from front cover: the EPUB 3 spec reserves no
 * manifest property for a back cover. It is an ordinary image asset (no
 * "cover-image" property, no meta name="cover" pointer). What identifies
 * the back cover instead is a guide reference of type "other.back-cover"
 * pointing at its XHTML wrapper page; the raw image's identity in e.resources
 * is resolved from that page's <img src> by literal string search.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { renumberSpine } from "./edit-spine.ts";
import { applyGuideEdit } from "./edit-guide.ts";
import { primaryNavigation } from "./get-navigation.ts";
import { addLandmarkEntry } from "./edit-navigation.ts";
import { removeMatching, verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { archiveIdInUse, guessImageMediaType, manifestIdCandidate, uniqueManifestId } from "./edit-resource.ts";
import { relativeArchiveHref, relativeHref, primaryPackage, manifestItemByHref, backCoverGuideRef } from "../epub/resolve.ts";
import { removeCoverPage, coverPageMarkup, uniqueArchivePath } from "./edit-cover.ts";
import type { Epub, Package } from "../epub/types.ts";

interface EditBackCoverArgs {
  action?: string;
  path?: string;
  id?: string;
  sourcePath?: string;
  mediaType?: string;
}

interface EditBackCoverResult {
  action: string;
  id?: string;
  mediaType?: string;
  sizeBytes?: number;
}

export const editBackCoverTool: EpubTool = {
  name: "edit_back_cover",
  description: "Create, edit, or remove the back cover image of an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a back cover image (fails if one exists), "edit" its bytes in place, or "remove" it' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: 'archive path for the new back cover image, e.g. "OEBPS/images/back-cover.jpg"; used only by create — edit and remove always target the book\'s existing back cover' },
      sourcePath: { type: "string", description: "filesystem path to the image file to use as the back cover, read directly from disk (not sent through MCP); used by create and edit, ignored by remove" },
      mediaType: { type: "string", description: 'image media type, e.g. "image/jpeg"; guessed from id\'s extension if omitted on create' },
    },
  },
};

/** Returns the package's guide reference of type "other.back-cover", or undefined if none exists. */
export function findBackCoverGuideRef(pkg: Package): { href: string } | undefined {
  return backCoverGuideRef(pkg);
}

/**
 * Resolves a document-relative href against the source file's directory,
 * returning the target archive path. Inverse of relativeArchiveHref.
 */
export function resolveDocumentRelativeHref(fromArchivePath: string, href: string): string {
  if (href.startsWith("/")) return href.slice(1);
  const fromDir = dirname(fromArchivePath);
  if (!fromDir || fromDir === ".") return href;
  // Manual resolution avoids node:path's Windows backslash normalization.
  const combined = fromDir.endsWith("/") ? fromDir + href : fromDir + "/" + href;
  // Collapse any ".." segments (shouldn't happen in well-formed EPUBs, but be safe).
  const parts = combined.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** Resolves wrapper page at pageId back to the archive path of the image it displays. */
export function backCoverImageId(e: Epub, pageId: string): string | undefined {
  const markup = e.contentDocuments[pageId]?.markup;
  if (!markup) return undefined;

  // coverPageMarkup always produces <img src="..."> — extract it by literal search.
  const imgTag = markup.match(/<img\s+src="([^"]+)"/);
  if (!imgTag) return undefined;
  const href = imgTag[1];
  return resolveDocumentRelativeHref(pageId, href);
}

export async function handleEditBackCover(server: Server, args: EditBackCoverArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");

  let id = "";
  if (action === "create") {
    id = await resolveArg(server, args.id, "id", 'What archive path should the back cover image be saved at (e.g. "OEBPS/images/back-cover.jpg")?');
  }

  let data = new Uint8Array(0);
  if (action !== "remove") {
    const sourcePath = await resolveArg(server, args.sourcePath, "sourcePath", "What is the filesystem path to the image file to use as the back cover?");
    data = await readFile(sourcePath);
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  let result: EditBackCoverResult;
  switch (action) {
    case "create":
      result = createBackCover(e, pkg, id, data, args.mediaType ?? "");
      break;
    case "edit":
      result = editExistingBackCover(e, pkg, data, args.mediaType ?? "");
      break;
    case "remove":
      result = removeBackCover(e, pkg);
      break;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  epubCache.markDirty(abs);
  const summary = `${verbPast(action)}d back cover ${JSON.stringify(result.id)} in ${JSON.stringify(abs)} (${result.sizeBytes} bytes). Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

function createBackCover(e: Epub, pkg: Package, id: string, data: Uint8Array, mediaType: string): EditBackCoverResult {
  if (findBackCoverGuideRef(pkg)) throw new Error(`${JSON.stringify(pkg.id)} already has a back cover; use action "edit" instead`);
  if (archiveIdInUse(e, id)) throw new Error(`${JSON.stringify(id)} already exists in the book`);
  const resolvedMediaType = mediaType || guessImageMediaType(id);

  // --- image resource ---
  const opfIdImg = uniqueManifestId(pkg, manifestIdCandidate(id));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${opfIdImg}`,
    href: relativeHref(pkg, id),
    mediaType: resolvedMediaType,
    properties: [], // back cover is an ordinary item — no "cover-image" property
    fallback: "",
    mediaOverlay: "",
  });
  e.resources[id] = { id, mediaType: resolvedMediaType, data };

  // --- wrapper page ---
  const pageId = uniqueArchivePath(e, `${pkg.baseDir}back-cover.xhtml`);
  e.contentDocuments[pageId] = {
    id: pageId,
    mediaType: "application/xhtml+xml",
    markup: coverPageMarkup("Back Cover", "backmatter cover", relativeArchiveHref(pageId, id)),
  };
  const opfIdPage = uniqueManifestId(pkg, manifestIdCandidate(pageId));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${opfIdPage}`,
    href: relativeHref(pkg, pageId),
    mediaType: "application/xhtml+xml",
    properties: [], // ordinary item — no cover-image property on the wrapper either
    fallback: "",
    mediaOverlay: "",
  });

  // --- spine: APPEND (back matter position), not insert at index 0 like front cover ---
  pkg.spine.itemRefs.push({ id: `${pkg.spine.id}/itemref[${pkg.spine.itemRefs.length}]`, idRef: opfIdPage, linear: true, properties: [] });
  renumberSpine(pkg);

  // --- best-effort: guide reference + landmark ---
  try {
    applyGuideEdit(pkg, "create", "other.back-cover", "Back Cover", pageId);
  } catch {
    /* ignore — matching Go's best-effort pattern */
  }
  try {
    const nav = primaryNavigation(e, pkg);
    addLandmarkEntry(pkg, nav, "Back Cover", pageId, "afterword");
  } catch {
    /* no EPUB 3 navigation document; best-effort */
  }

  return { action: "create", id, mediaType: resolvedMediaType, sizeBytes: data.length };
}

function editExistingBackCover(e: Epub, pkg: Package, data: Uint8Array, mediaType: string): EditBackCoverResult {
  const ref = findBackCoverGuideRef(pkg);
  if (!ref) throw new Error(`${JSON.stringify(pkg.id)} has no back cover; use action "create" instead`);

  // Resolve wrapper page to image id via backCoverImageId.
  const imgId = backCoverImageId(e, ref.href);
  if (!imgId) throw new Error(`back cover wrapper at ${JSON.stringify(ref.href)} does not contain an <img src>`);

  const res = e.resources[imgId];
  if (!res) throw new Error(`back cover image at ${JSON.stringify(imgId)} is not in resources`);

  res.data = data;
  if (mediaType) {
    res.mediaType = mediaType;
    const item = manifestItemByHref(pkg, imgId);
    if (item) item.mediaType = mediaType;
  }

  return { action: "edit", id: imgId, mediaType: res.mediaType, sizeBytes: data.length };
}

function removeBackCover(e: Epub, pkg: Package): EditBackCoverResult {
  const ref = findBackCoverGuideRef(pkg);
  if (!ref) throw new Error(`${JSON.stringify(pkg.id)} has no back cover`);

  // Resolve wrapper page to image id.
  const imgId = backCoverImageId(e, ref.href);
  if (!imgId) throw new Error(`back cover wrapper at ${JSON.stringify(ref.href)} does not contain an <img src>`);

  const res = e.resources[imgId];
  const sizeBytes = res?.data.length ?? 0;

  // Remove image manifest item and resource.
  if (res) {
    const item = manifestItemByHref(pkg, imgId);
    if (item) {
      pkg.manifest.items = removeMatching(pkg.manifest.items, (it) => it.id !== item.id);
    }
    delete e.resources[imgId];
  }

  // Guide reference isn't cleaned up by removeCoverPage — strip it here,
  // mirroring edit-cover.ts's removeCover.
  if (pkg.guide) {
    pkg.guide.references = removeMatching(pkg.guide.references, (r) => r.type !== "other.back-cover");
  }

  // Clean up wrapper page: content doc, manifest entry, spine entry, landmark.
  removeCoverPage(e, pkg, ref.href);

  return { action: "remove", id: imgId, sizeBytes };
}

registerTool(
  editBackCoverTool,
  'Takes action ("create", "edit", or "remove"), path, id, and sourcePath; any may be omitted to ' +
    "be prompted for (see edit_chapter's description for the general elicitation rules every edit_ tool " +
    "follows).\n\n" +
    'action "create": adds a back cover image at the given archive path. Unlike front covers, the EPUB 3 ' +
    "spec reserves no manifest property for back covers — this is an ordinary image asset with empty " +
    '"properties". No meta name="cover" pointer is created. A minimal XHTML wrapper page is built around ' +
    "the image and wired in: appended to the end of the spine (so it's the last thing a linear read reaches), " +
    'an epub:type="afterword" entry in the navigation document\'s "landmarks" list, and a legacy guide ' +
    'reference of type "other.back-cover". create only ever adds a back cover where none exists — it never ' +
    'updates one already there, so it fails outright if the book already has a back cover; use "edit" instead.\n\n' +
    'action "edit": replaces the existing back cover\'s bytes (and mediaType, if given) in place. There is no ' +
    "id parameter — the existing back cover is found automatically via its guide reference, and the image's " +
    "identity resolved from the wrapper page markup. id and sourcePath are ignored — Fails if the book has " +
    'no back cover yet (use "create" instead).\n\n' +
    'action "remove": deletes the back cover resource, manifest entry, wrapper page content doc, spine entry, ' +
    "landmark entry, and guide reference. id is ignored.\n\nAll three actions only touch the in-memory cache; " +
    "call save_epub afterwards to persist.",
  handleEditBackCover as never,
);

