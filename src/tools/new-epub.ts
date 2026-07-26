// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * new_epub — create a blank EPUB file on disk and load it into the
 * server's cache. Mirrors Go's tools/new_epub.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { canonicalPath } from "../epub/cache.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { newEpub as buildNewEpub } from "../epub/new-epub.ts";
import { summarizeEpub } from "./read-epub.ts";
import { writeEpub } from "../epub/write.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

interface NewEpubArgs {
  path?: string;
  title?: string;
  author?: string;
}

export const newEpubTool: EpubTool = {
  name: "new_epub",
  description: "Create a blank EPUB file on disk and load it into the server's LRU cache.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path where the new .epub file should be created" },
      title: { type: "string", description: 'EPUB title (defaults to "Untitled")' },
      author: { type: "string", description: 'Creator name (defaults to "Anonymous")' },
    },
  },
};

export async function handleNewEpub(server: Server, args: NewEpubArgs): Promise<ToolHandlerResult> {
  const path = await resolveArg(
    server,
    args.path,
    "path",
    "Where should the new EPUB file be created? Provide a filesystem path ending in .epub.",
  );
  const titleArg = await resolveArg(server, args.title, "title", "What should the EPUB's title be?");
  const title = titleArg || "Untitled";
  const authorArg = await resolveArg(server, args.author, "author", "Who is the creator/author of this EPUB?");
  const author = authorArg || "Anonymous";

  // Build and write the blank EPUB to disk first — canonicalPath resolves
  // symlinks via realpathSync, which needs a real file on disk to resolve
  // against. Canonicalization can only happen after the write, unlike every
  // other tool's plain resolve()-only convention.
  const abs = resolve(path);
  const e = buildNewEpub(title, author);
  await writeEpub(e, abs);
  const canonical = canonicalPath(abs);

  const { epub: loaded, eviction } = await epubCache.load(canonical);

  const result = summarizeEpub(canonical, loaded);
  const summary = `Created new EPUB ${JSON.stringify(canonical)} (${result.manifestItemCount} manifest items, ${result.contentDocuments.length} spine entries). Title: ${title}. Call save_epub to persist changes.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  newEpubTool,
  'Takes optional arguments path (filesystem path for the new .epub), title (defaults to "Untitled"), and ' +
    'author (defaults to "Anonymous"). Builds a minimal valid EPUB 3 archive on disk (container.xml, ' +
    "mimetype, navigation document with an empty table of contents, stylesheet) — deliberately with no " +
    "chapters yet, rather than a placeholder one you'd have to remember to delete before adding real " +
    "content. Caches the parsed result in memory — inserting it as the most recently used entry and " +
    "evicting the least recently used if the cache is full — and returns its metadata, including an " +
    "(initially empty) tableOfContents tree in the same shape read_epub returns. After creating an " +
    "EPUB, use edit_chapter to add chapters (each one is added to the table of contents automatically) and " +
    "save_epub to persist changes; the book stays empty until you add a chapter, and save_epub never " +
    "invents one. The returned path is canonicalized " +
    "(symlinks resolved, case folded on filesystems that are case-insensitive by default) — reuse it " +
    "verbatim in later tool calls rather than re-typing your own path string, so every call is guaranteed " +
    "to refer to this exact same cache entry.",
  handleNewEpub as never,
);

