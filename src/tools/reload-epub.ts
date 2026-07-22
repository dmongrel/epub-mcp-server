// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * reload_epub — discard a cached EPUB and re-parse it fresh from disk.
 * Mirrors Go's tools/reload_epub.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { canonicalPath } from "../epub/cache.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { summarizeEpub } from "./read-epub.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

interface ReloadEpubArgs {
  path: string;
}

export const reloadEpubTool: EpubTool = {
  name: "reload_epub",
  description: "Discard a cached EPUB and re-parse it fresh from disk. Changing.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path of the epub to reload, as previously passed to read_epub" } },
    required: ["path"],
  },
};

export async function handleReloadEpub(_server: Server, args: ReloadEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);
  const canonical = canonicalPath(abs);

  const { wasDirty } = epubCache.remove(canonical);

  const { epub: e, eviction } = await epubCache.load(canonical);

  const result = summarizeEpub(canonical, e);

  const discardNote = wasDirty ? " Discarded unsaved edits that were in memory." : "";
  const summary = `Reloaded ${JSON.stringify(canonical)} from disk (${result.manifestItemCount} manifest items, ${result.contentDocuments.length} spine entries).${discardNote}${evictionNote(eviction)}`;

  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  reloadEpubTool,
  "Takes path, the same .epub filesystem path used with read_epub. Drops whatever is currently cached for " +
    "it — including any unsaved edit_chapter edits, which are lost unless already saved — and re-parses " +
    "the file from disk into a clean cache entry. Useful either to intentionally throw away in-memory " +
    "edits since the last save, or to pick up changes made to the file outside this server. Returns the " +
    "same summary as read_epub (title, creators, content document ids, table of contents), reflecting " +
    "whatever is on disk right now. path doesn't need to already be cached; reloading an uncached path " +
    "behaves like a plain read_epub.",
  handleReloadEpub as never,
);

