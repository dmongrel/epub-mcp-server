/**
 * close_epub — remove a cached EPUB from memory, freeing its cache slot.
 * Mirrors Go's tools/close_epub.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

interface CloseEpubArgs {
  path: string;
}

interface CloseEpubResult {
  path: string;
  closed: boolean;
  hadUnsavedEdits?: boolean;
}

export const closeEpubTool: EpubTool = {
  name: "close_epub",
  description: "Remove a cached EPUB from memory, freeing its cache slot. Changing.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path of the cached epub to close, as previously passed to read_epub" } },
    required: ["path"],
  },
};

export async function handleCloseEpub(_server: Server, args: CloseEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { removed, wasDirty } = epubCache.remove(abs);
  const result: CloseEpubResult = { path: abs, closed: removed };
  if (removed && wasDirty) result.hadUnsavedEdits = true;

  let summary: string;
  if (!removed) {
    summary = `${JSON.stringify(abs)} was not cached; nothing to close.`;
  } else if (wasDirty) {
    summary = `Closed ${JSON.stringify(abs)}, discarding unsaved edits. Call save_epub before closing next time if you want to keep them.`;
  } else {
    summary = `Closed ${JSON.stringify(abs)}.`;
  }

  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  closeEpubTool,
  "Takes path, the same .epub filesystem path used with read_epub. Frees that book's slot in the cache " +
    "immediately, rather than waiting for it to be pushed out by loading other books. If the book had " +
    "unsaved edit_chapter edits (see get_cache_status), they're discarded — call save_epub first if you " +
    "want to keep them; the response's hadUnsavedEdits reports whether that happened. A path that isn't " +
    "currently cached isn't an error; closed is simply false. The next read_epub, get_chapter, or " +
    "edit_chapter call for this path re-parses it fresh from disk.",
  handleCloseEpub as never,
);
