// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * get_chapter — read one content document by its id. Mirrors Go's
 * tools/get_chapter.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { plainText } from "../epub/text.ts";

interface GetChapterArgs {
  path: string;
  id: string;
}

interface GetChapterResult {
  id: string;
  mediaType: string;
  text: string;
  markup: string;
}

export const getChapterTool: EpubTool = {
  name: "get_chapter",
  description: "Read one content document (chapter/section) of an already-read EPUB by its id. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: 'content document id (archive path) to read, e.g. one of the entries in read_epub\'s contentDocuments list' },
    },
    required: ["path", "id"],
  },
};

export async function handleGetChapter(_server: Server, args: GetChapterArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  if (!args.id?.trim()) throw new Error("id is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const doc = e.contentDocuments[args.id];
  if (!doc) throw new Error(`no content document with id ${JSON.stringify(args.id)} in ${JSON.stringify(abs)}; call read_epub to list valid ids`);

  const text = plainText(doc.markup);
  const result: GetChapterResult = { id: args.id, mediaType: doc.mediaType, text, markup: doc.markup };
  const summary = `Read ${JSON.stringify(args.id)} (${text.length} characters).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  getChapterTool,
  "Takes path, the same .epub filesystem path passed to read_epub, and id, one of the archive-path ids " +
    "from that call's contentDocuments list (or from a table-of-contents entry's href, with any " +
    "\"#fragment\" removed). Loads the EPUB through the same cache read_epub uses, so calling read_epub " +
    "first isn't required but is cheap either way. Returns both text — the chapter's prose with markup " +
    "stripped, paragraphs separated by blank lines — and markup — the raw XHTML, for when exact markup is " +
    "needed rather than plain reading text. Fails if id doesn't name a content document in this book; " +
    "re-check the ids from read_epub if so.",
  handleGetChapter as never,
);

