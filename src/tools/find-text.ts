// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * find_text — search chapter prose for a plaintext substring or regex
 * pattern, reporting every match's chapter and line number.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { summarizeEpub } from "./read-epub.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { isCoverPage, plainText } from "../epub/text.ts";

interface FindTextArgs {
  path: string;
  query: string;
  regex?: boolean;
  chapters?: number[];
}

interface FindTextMatch {
  chapter: number;
  chapterId: string;
  line: number;
  text: string;
}

interface FindTextResult {
  query: string;
  regex: boolean;
  chaptersSearched: number[];
  totalChapters: number;
  matches: FindTextMatch[];
}

export const findTextTool: EpubTool = {
  name: "find_text",
  description:
    "Search chapter prose (excluding front/back cover pages) in an already-read EPUB for a plaintext substring or regex pattern, reporting the chapter and line number of every match. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      query: { type: "string", description: "the text to search for, as a literal substring or (if regex is true) a regular expression" },
      regex: { type: "boolean", description: "if true, treat query as a regular expression instead of a literal substring; defaults to false" },
      chapters: {
        type: "array",
        items: { type: "integer" },
        description:
          "1-based chapter numbers (in spine reading order, excluding cover pages) to limit the search to; omit to search every chapter",
      },
    },
    required: ["path", "query"],
  },
};

/** Escapes every character with special meaning in a regular expression, so a literal string can be matched via RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function handleFindText(_server: Server, args: FindTextArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  if (!args.query) throw new Error("query is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const orderedIds = summarizeEpub(abs, e).contentDocuments.filter((id) => {
    const doc = e.contentDocuments[id];
    return doc !== undefined && !isCoverPage(doc.markup);
  });
  if (orderedIds.length === 0) throw new Error(`${JSON.stringify(abs)} has no content documents to search`);

  const isRegex = args.regex ?? false;
  let pattern: RegExp;
  try {
    pattern = new RegExp(isRegex ? args.query : escapeRegExp(args.query), "g");
  } catch (err) {
    throw new Error(`invalid regex pattern ${JSON.stringify(args.query)}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let chapterNumbers: number[];
  if (args.chapters && args.chapters.length > 0) {
    for (const n of args.chapters) {
      if (!Number.isInteger(n) || n < 1 || n > orderedIds.length) {
        throw new Error(`chapter number ${n} is out of range; this book has ${orderedIds.length} chapter(s)`);
      }
    }
    chapterNumbers = args.chapters;
  } else {
    chapterNumbers = orderedIds.map((_, i) => i + 1);
  }

  const matches: FindTextMatch[] = [];
  for (const chapterNumber of chapterNumbers) {
    const chapterId = orderedIds[chapterNumber - 1]!;
    const doc = e.contentDocuments[chapterId];
    if (!doc) continue;

    const lines = plainText(doc.markup).split("\n\n");
    lines.forEach((line, i) => {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(line)) !== null) {
        matches.push({ chapter: chapterNumber, chapterId, line: i + 1, text: line });
        if (m[0].length === 0) pattern.lastIndex++; // avoid an infinite loop on zero-length matches
      }
    });
  }

  const result: FindTextResult = {
    query: args.query,
    regex: isRegex,
    chaptersSearched: chapterNumbers,
    totalChapters: orderedIds.length,
    matches,
  };

  let summary = `Found ${matches.length} match(es) for ${JSON.stringify(args.query)} across ${chapterNumbers.length} of ${orderedIds.length} chapter(s).`;
  for (const match of matches) {
    summary += `\n  Chapter ${match.chapter} (${match.chapterId}), line ${match.line}: ${match.text}`;
  }
  summary += evictionNote(eviction);

  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  findTextTool,
  "Takes path, the same .epub filesystem path passed to read_epub, and query, the text to search for. By " +
    'default query is matched as a literal substring; pass regex: true to treat it as a JavaScript regular ' +
    "expression instead (e.g. to match a word boundary or a case-insensitive alternation like " +
    '"(?i:gray|grey)").\n\n' +
    "Searches every chapter's rendered prose (the same text get_chapter returns, not the raw XHTML markup), " +
    "not the whole book's markup verbatim, so tags and attributes never produce false matches. Each chapter's " +
    'text is split into "lines" at paragraph boundaries (block-element breaks such as <p>, <h1>-<h6>, <li>) ' +
    "— line 1 is the chapter's first paragraph or heading, line 2 its second, and so on.\n\n" +
    "Chapters are searched in spine reading order and numbered from 1, matching the order read_epub's " +
    "contentDocuments list reports — except front- and back-cover wrapper pages (see edit_cover/" +
    "edit_back_cover) are skipped entirely and never occupy a chapter number, so numbering always lines up " +
    "with the book's actual chapters instead of counting cover pages as chapter 1 (or similar). Pass " +
    "chapters, a list of those 1-based numbers, to restrict the search to specific chapters instead of the " +
    "whole book; omit it to search every chapter. An out-of-range chapter number fails the call outright " +
    "rather than silently skipping it.\n\n" +
    "Returns matches, an array of every occurrence found — each with chapter (its 1-based number), " +
    "chapterId (its content document id, for use with get_chapter/edit_chapter), line (its 1-based line " +
    "number within that chapter), and text (the full line the match was found in). A chapter with multiple " +
    "occurrences on the same line reports one entry per occurrence, all sharing that line number. Also " +
    "returns chaptersSearched and totalChapters for context. If nothing matches, matches is an empty array " +
    "rather than an error.",
  handleFindText as never,
);
