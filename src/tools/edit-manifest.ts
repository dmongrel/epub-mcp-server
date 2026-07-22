// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * edit_manifest — change the properties/fallback/mediaOverlay/mediaType
 * of an existing manifest item. Mirrors Go's tools/edit_manifest.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemByHref, primaryPackage } from "../epub/resolve.ts";
import type { Package } from "../epub/types.ts";

interface EditManifestArgs {
  action?: string;
  path?: string;
  id?: string;
  mediaType?: string;
  properties?: string;
  fallback?: string;
  mediaOverlay?: string;
}

export const editManifestTool: EpubTool = {
  name: "edit_manifest",
  description: "Change the properties, fallback, media overlay, or media type of an existing manifest item in an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'only "edit" is supported here; create/remove a manifest item via edit_chapter, edit_resource, edit_cover, or edit_navigation instead' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: "the manifest item's archive path, from get_manifest" },
      mediaType: { type: "string", description: "new media type; omit to leave unchanged" },
      properties: { type: "string", description: 'space-separated manifest properties, e.g. "scripted svg"; omit to leave unchanged, pass "none" to clear' },
      fallback: { type: "string", description: 'archive path of another manifest item to use as a fallback; omit to leave unchanged, pass "none" to clear' },
      mediaOverlay: { type: "string", description: 'archive path of this item\'s SMIL media overlay; omit to leave unchanged, pass "none" to clear' },
    },
  },
};

/**
 * Translates archivePath ("" = leave unchanged, "none" = clear) into the
 * opf:id to store in a fallback/mediaOverlay field, or undefined if the
 * caller didn't ask for a change. archivePath is a full archive path (as
 * the tool's fallback/mediaOverlay arguments are), so the lookup must go
 * through manifestItemByHref — never a raw `.href === archivePath`
 * comparison, since ManifestItem.href is stored relative to pkg.baseDir.
 */
function resolveManifestIdRefEdit(pkg: Package, archivePath: string): string | undefined {
  if (archivePath === "") return undefined;
  if (archivePath === "none") return "";
  const item = manifestItemByHref(pkg, archivePath);
  if (!item) throw new Error(`no manifest item with archive path ${JSON.stringify(archivePath)}`);
  const prefix = pkg.manifest.id + "/";
  return item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
}

export async function handleEditManifest(server: Server, args: EditManifestArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'Only "edit" is supported; confirm to proceed.');
  if (action !== "edit") {
    throw new Error('edit_manifest only supports action "edit"; use edit_chapter, edit_resource, edit_cover, or edit_navigation to create or remove a manifest item');
  }
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const id = await resolveArg(server, args.id, "id", "Which manifest item (archive path) should be changed?");

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  // id is a full archive path (from get_manifest), so this lookup must use
  // manifestItemByHref — never a raw `.href === id` comparison.
  const item = manifestItemByHref(pkg, id);
  if (!item) throw new Error(`no manifest item with archive path ${JSON.stringify(id)}; call get_manifest to list valid ids`);

  if (args.mediaType) item.mediaType = args.mediaType;
  switch (args.properties) {
    case undefined:
    case "":
      break;
    case "none":
      item.properties = [];
      break;
    default:
      item.properties = args.properties.split(/\s+/).filter(Boolean);
  }
  const fallback = resolveManifestIdRefEdit(pkg, args.fallback ?? "");
  if (fallback !== undefined) item.fallback = fallback;
  const mediaOverlay = resolveManifestIdRefEdit(pkg, args.mediaOverlay ?? "");
  if (mediaOverlay !== undefined) item.mediaOverlay = mediaOverlay;

  epubCache.markDirty(abs);
  const summary = `Updated manifest item ${JSON.stringify(id)} in ${JSON.stringify(abs)}. Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: { id } };
}

registerTool(
  editManifestTool,
  'Takes action, path, and id; action must be "edit" — this tool only adjusts metadata of a manifest item ' +
    "that already exists. To add or remove the item itself, use edit_chapter (content documents), " +
    "edit_resource (stylesheets/images/fonts/etc.), edit_cover (the cover image), or edit_navigation (the " +
    "navigation document or NCX). path and id may be omitted to be prompted for (see edit_chapter's " +
    "description for the general elicitation rules every edit_ tool follows). mediaType, properties, " +
    'fallback, and mediaOverlay are all optional and left unchanged when omitted; pass "none" to ' +
    "properties/fallback/mediaOverlay to clear them. Only touches the in-memory cache; call save_epub " +
    "afterwards to persist.",
  handleEditManifest as never,
);

