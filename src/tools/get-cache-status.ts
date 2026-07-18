/**
 * get_cache_status — list the EPUBs currently held in memory. Mirrors
 * Go's tools/get_cache_status.go.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

export const getCacheStatusTool: EpubTool = {
  name: "get_cache_status",
  description: "List the EPUBs currently held in memory, most recently used first, and which have unsaved edits. Read-only.",
  inputSchema: { type: "object", properties: {} },
};

export async function handleGetCacheStatus(_server: Server, _args: unknown): Promise<ToolHandlerResult> {
  const entries = epubCache.entries();
  const dirtyCount = entries.filter((e) => e.dirty).length;

  const structuredContent = { capacity: epubCache.capacity, entries };
  const summary = `${entries.length}/${epubCache.capacity} cache slots used (${dirtyCount} with unsaved edits)`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getCacheStatusTool,
  "Takes no arguments. Returns the cache's capacity and every currently-cached EPUB's path and dirty " +
    "flag, ordered most- to least-recently-used. dirty is true when an edit_ tool has changed that book in " +
    "memory since it was last loaded or saved via save_epub with no as argument. Since the cache holds a " +
    "bounded number of books, loading one more than capacity silently evicts the least recently used entry " +
    "(read_epub and get_chapter both note it in their response when it happens) — check here before that " +
    "matters, and use close_epub or save_epub to manage a book proactively instead of letting it happen by " +
    "surprise.",
  handleGetCacheStatus as never,
);
