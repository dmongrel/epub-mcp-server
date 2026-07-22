// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * get_manifest — list every manifest item. Mirrors Go's
 * tools/get_manifest.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemById, primaryPackage, resolveHref } from "../epub/resolve.ts";
import type { Package } from "../epub/types.ts";

interface GetManifestArgs {
  path: string;
}

export const getManifestTool: EpubTool = {
  name: "get_manifest",
  description: "List every manifest item (chapter, resource, cover, navigation document, NCX) of an already-read EPUB. Read-only.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" } },
    required: ["path"],
  },
};

/**
 * Resolves a ManifestItem's fallback/mediaOverlay field — an opf:id IDREF,
 * looked up via manifestItemById (never a raw href comparison; ids aren't
 * baseDir-relative) — to the archive path get_manifest reports for it.
 * Falls back to the raw id itself if it doesn't resolve to a known item.
 */
function resolveManifestIdRef(pkg: Package, opfId: string): string {
  const item = manifestItemById(pkg, opfId);
  return item ? resolveHref(pkg, item.href) : opfId;
}

export async function handleGetManifest(_server: Server, args: GetManifestArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const inSpine = new Set(pkg.spine.itemRefs.map((ref) => ref.idRef));

  const items = pkg.manifest.items.map((item) => {
    const prefix = pkg.manifest.id + "/";
    const opfId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
    const entry: Record<string, unknown> = {
      id: resolveHref(pkg, item.href),
      mediaType: item.mediaType,
      properties: item.properties.length > 0 ? item.properties : undefined,
      inSpine: inSpine.has(opfId),
    };
    if (item.fallback) entry.fallback = resolveManifestIdRef(pkg, item.fallback);
    if (item.mediaOverlay) entry.mediaOverlay = resolveManifestIdRef(pkg, item.mediaOverlay);
    return entry;
  });

  const structuredContent = { items };
  const summary = `Read manifest of ${JSON.stringify(abs)} (${items.length} items).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getManifestTool,
  "Takes path, the same .epub filesystem path passed to read_epub. Returns every file the rendition " +
    'declares, each with its id (archive path), mediaType, properties (e.g. "cover-image", "nav", ' +
    '"scripted"), fallback and mediaOverlay (archive paths of other manifest items, if set), and inSpine ' +
    "(whether it's part of the default reading order). This is the full inventory behind read_epub's " +
    "manifestItemCount and the more specific get_chapter/get_resource/get_cover/get_navigation tools — use " +
    "it to find an id before calling one of those, or edit_manifest to change an entry's properties/" +
    "fallback/mediaOverlay/mediaType in place.",
  handleGetManifest as never,
);

