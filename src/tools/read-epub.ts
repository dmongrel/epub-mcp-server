/**
 * read_epub — parse a .epub file from disk into memory and return its
 * metadata, reading order, and table of contents. Mirrors Go's
 * tools/read_epub.go.
 *
 * summarizeEpub is exported for reload-epub.ts (this phase's Task 4),
 * which needs the identical summary shape after a fresh re-parse.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { canonicalPath } from "../epub/cache.ts";
import { evictionNote } from "./eviction.ts";
import { epubCache } from "./epub-cache.ts";
import { tableOfContents, type TocEntry } from "./get-navigation.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemById, primaryPackage, resolveHref } from "../epub/resolve.ts";
import type { Epub } from "../epub/types.ts";

interface ReadEpubArgs {
  path: string;
}

export interface ReadEpubResult {
  path: string;
  title?: string;
  creators?: string[];
  language?: string;
  manifestItemCount: number;
  contentDocuments: string[];
  tableOfContents?: TocEntry[];
}

export const readEpubTool: EpubTool = {
  name: "read_epub",
  description: "Parse a .epub file from disk into memory and return its metadata, reading order, and table of contents. Read-only.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path to the .epub file to read" } },
    required: ["path"],
  },
};

/**
 * Builds a ReadEpubResult for an already-loaded Epub. Shared by read_epub
 * and reload_epub, since both need the same title/creators/
 * contentDocuments/table-of-contents summary after (re)loading a book.
 */
export function summarizeEpub(abs: string, e: Epub): ReadEpubResult {
  const result: ReadEpubResult = { path: abs, manifestItemCount: 0, contentDocuments: [] };

  const pkg = primaryPackage(e);
  if (!pkg) return result;

  result.manifestItemCount = pkg.manifest.items.length;
  if (pkg.metadata.titles.length > 0) result.title = pkg.metadata.titles[0]!.value;
  if (pkg.metadata.creators.length > 0) result.creators = pkg.metadata.creators.map((c) => c.name);
  if (pkg.metadata.languages.length > 0) result.language = pkg.metadata.languages[0]!.value;

  for (const ref of pkg.spine.itemRefs) {
    const item = manifestItemById(pkg, ref.idRef);
    if (!item) continue;
    const archivePath = resolveHref(pkg, item.href);
    // Only actual content documents (chapters/sections) belong here — the
    // spine can also carry the nav document itself (as newEpub's does), which
    // lives in e.navigation rather than e.contentDocuments and isn't
    // something other tools can target as a chapter.
    if (!(archivePath in e.contentDocuments)) continue;
    result.contentDocuments.push(archivePath);
  }

  result.tableOfContents = tableOfContents(e, pkg);
  return result;
}

export async function handleReadEpub(_server: Server, args: ReadEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);
  const canonical = canonicalPath(abs);

  const { epub: e, eviction } = await epubCache.load(canonical);

  const result = summarizeEpub(canonical, e);
  const summary = `Loaded ${JSON.stringify(canonical)} (${result.manifestItemCount} manifest items, ${result.contentDocuments.length} spine entries).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  readEpubTool,
  "Takes a single argument, path, the filesystem path to a .epub file. Parses the file and caches the " +
    "parsed result in memory (evicting the least recently used entry when full — see get_cache_status to " +
    "check what's loaded, and close_epub to free a slot deliberately instead of waiting for that eviction), " +
    "keyed by a canonicalized form of the path (symlinks resolved, case folded on filesystems that are " +
    "case-insensitive by default); calling read_epub again with any spelling of the same file is cheap and " +
    "returns the cached parse rather than re-reading it. Returns the book's title, creators, language, " +
    "manifest item count, the content document ids in spine reading order (use these to target a specific " +
    "chapter with other tools), and the table of contents (from the EPUB 3 navigation document, or the " +
    "legacy NCX if that's what the book has) as a tree of id/label/href entries. The returned path is " +
    "already in that canonical form — reuse it verbatim in later tool calls (edit_chapter, save_epub, " +
    "close_epub, etc.) rather than re-typing your own path string, so every call is guaranteed to refer to " +
    "this exact same cache entry.",
  handleReadEpub as never,
);
