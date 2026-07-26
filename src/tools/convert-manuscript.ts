// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * convert_manuscript — convert an entire local .txt/.md/.html manuscript
 * file into an EPUB's chapters in one call. Mirrors Go's
 * tools/convert_manuscript.go.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { chaptersToXHTML } from "./chapter-markdown.ts";
import { resolveArg } from "./elicit.ts";
import { archiveIdInUse } from "./edit-resource.ts";
import { deleteChapterDocument, insertChapter } from "./edit-chapter.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { detectManuscriptFormat, splitManuscriptChapters, stripHtmlTags } from "./manuscript-parse.ts";
import { rebuildToc } from "./nav-rebuild.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { chapterNumberFromLabel, deriveTocLabel } from "../epub/labels.ts";
import { primaryPackage, proseSpineDocuments } from "../epub/resolve.ts";
import type { Epub, Package } from "../epub/types.ts";

interface ConvertManuscriptArgs {
  path?: string;
  sourcePath?: string;
}

interface ConvertManuscriptResult {
  path: string;
  sourcePath: string;
  chaptersFound: number;
  createdIds?: string[];
  replacedIds?: string[];
  leftoverIds?: string[];
  leftoverAction?: string;
  tocRebuilt: boolean;
}

export const convertManuscriptTool: EpubTool = {
  name: "convert_manuscript",
  description:
    "Convert an entire local .txt/.md/.html manuscript file into an EPUB's chapters in one call. This is the expedient tool when converting a whole book to EPUB — prefer it over looping edit_chapter create calls one chapter at a time.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      sourcePath: { type: "string", description: "filesystem path to the .txt, .md, or .html manuscript file to convert into chapters, read directly from disk (not sent through MCP)" },
    },
  },
};

export async function handleConvertManuscript(server: Server, args: ConvertManuscriptArgs): Promise<ToolHandlerResult> {
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be converted into? Provide its filesystem path.");
  const sourcePath = await resolveArg(server, args.sourcePath, "sourcePath", "What is the filesystem path to the manuscript file (.txt, .md, or .html) to convert?");

  const raw = await readFile(sourcePath, "utf-8");
  const text = detectManuscriptFormat(sourcePath) === "html" ? stripHtmlTags(raw) : raw;

  const fragments = splitManuscriptChapters(text);
  if (fragments.length === 0) throw new Error(`no chapters found in ${JSON.stringify(sourcePath)}`);

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document to add chapters to`);

  const existingByNumber = existingChaptersByNumber(e, pkg);
  const baseId = deriveManuscriptBaseId(e, pkg);

  const createdIds: string[] = [];
  const replacedIds: string[] = [];
  let maxNewNumber = 0;

  for (let i = 0; i < fragments.length; i++) {
    const frag = fragments[i]!;
    if (frag.number > maxNewNumber) maxNewNumber = frag.number;
    const markup = chaptersToXHTML([frag]);

    const existingId = frag.number > 0 ? existingByNumber.get(frag.number) : undefined;
    if (existingId !== undefined) {
      const doc = e.contentDocuments[existingId];
      if (doc) {
        doc.markup = markup;
        replacedIds.push(existingId);
        continue;
      }
    }

    let chapterId = `${baseId}-${i + 1}.xhtml`;
    let label = "";
    if (frag.number > 0) {
      chapterId = `${baseId}-${frag.number}.xhtml`;
      label = `Chapter ${frag.number}`;
      if (frag.title !== "") label += `: ${frag.title}`;
    }
    chapterId = uniqueArchiveId(e, chapterId);

    insertChapter(e, pkg, chapterId, markup, label);
    createdIds.push(chapterId);
  }

  const leftoverIds = leftoverChapterIds(existingByNumber, maxNewNumber);
  let leftoverAction = "";
  if (leftoverIds.length > 0) {
    leftoverAction = await elicitLeftoverAction(server, leftoverIds);
    if (leftoverAction === "delete") {
      for (const id of leftoverIds) deleteChapterDocument(e, pkg, id);
    }
  }

  // Rebuilt once, at the end, rather than per chapter: the toc is a pure
  // function of the finished spine, and every create above has already
  // appended its own (now superseded) entry via insertChapter.
  const tocRebuilt = rebuildToc(e, pkg);

  epubCache.markDirty(abs);

  const result: ConvertManuscriptResult = {
    path: abs,
    sourcePath,
    chaptersFound: fragments.length,
    createdIds: createdIds.length > 0 ? createdIds : undefined,
    replacedIds: replacedIds.length > 0 ? replacedIds : undefined,
    leftoverIds: leftoverIds.length > 0 ? leftoverIds : undefined,
    leftoverAction: leftoverIds.length > 0 ? leftoverAction : undefined,
    tocRebuilt,
  };

  let summary = `Converted ${JSON.stringify(sourcePath)} into ${JSON.stringify(abs)}: ${fragments.length} chapter(s) found (${createdIds.length} created, ${replacedIds.length} replaced).`;
  if (leftoverIds.length > 0) {
    summary += ` ${leftoverIds.length} existing chapter(s) past the new source's range were ${leftoverVerb(leftoverAction)}.`;
  }
  summary += tocRebuilt
    ? " The table of contents was rebuilt from the spine."
    : " This book has no navigation document, so no table of contents was rebuilt.";
  summary += ` Call save_epub to persist this to disk.${evictionNote(eviction)}`;

  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

/**
 * Maps each chapter number already in the book to the archive path of the
 * content document carrying it, read from each prose document's own heading
 * in spine order.
 *
 * Deliberately not read from the table of contents: this call rebuilds the
 * toc at the end, so treating it as an input too would make it both cause
 * and effect, and it can be stale in the meantime — edit_chapter's "edit"
 * action changes a chapter's heading without touching its toc label, and
 * edit_navigation can rename an entry to anything at all. The spine plus
 * each document's markup is the only source of truth here.
 *
 * Documents whose heading names no chapter number are omitted, so unnumbered
 * front matter never claims a number a manuscript fragment might match.
 */
function existingChaptersByNumber(e: Epub, pkg: Package): Map<number, string> {
  const result = new Map<number, string>();
  for (const doc of proseSpineDocuments(e, pkg)) {
    const number = chapterNumberFromLabel(deriveTocLabel(doc.markup, doc.archivePath));
    if (number > 0 && !result.has(number)) result.set(number, doc.archivePath);
  }
  return result;
}

/** Returns the content document ids of every existing chapter numbered higher than maxNewNumber, sorted for deterministic output. */
function leftoverChapterIds(existing: Map<number, string>, maxNewNumber: number): string[] {
  const ids: string[] = [];
  for (const [num, id] of existing) {
    if (num > maxNewNumber) ids.push(id);
  }
  ids.sort();
  return ids;
}

/**
 * Prompts the user once, asking whether to keep or delete leftoverIds. A
 * blank accepted answer defaults to "keep" — the non-destructive choice.
 * An explicit decline or cancellation is an error. Uses a custom
 * elicitation schema (an enum) rather than resolveArg's plain string
 * field, following resolveArg's own implementation as the template.
 */
async function elicitLeftoverAction(server: Server, leftoverIds: string[]): Promise<string> {
  const message = `The manuscript has fewer chapters than the book already has. ${leftoverIds.length} existing chapter(s) past its range were left untouched: ${leftoverIds.join(", ")}. Keep or delete them?`;

  const res = await server.elicitInput({
    message,
    requestedSchema: {
      type: "object",
      properties: {
        leftoverAction: { type: "string", enum: ["keep", "delete"] },
      },
    },
  });

  if (res.action !== "accept") {
    throw new Error(`leftover chapter action was not provided (prompt was ${res.action})`);
  }

  const value = res.content?.leftoverAction;
  if (value === "" || value === undefined || value === "keep") return "keep";
  if (value === "delete") return "delete";
  throw new Error(`leftover chapter action must be "keep" or "delete", got ${JSON.stringify(value)}`);
}

function leftoverVerb(action: string): string {
  return action === "delete" ? "deleted" : "kept";
}

/** Picks a directory + stem to build new chapter archive paths from: borrows an existing content document's directory if the book has one, falling back to the package's own baseDir. */
function deriveManuscriptBaseId(e: Epub, pkg: Package): string {
  let dir = pkg.baseDir;
  for (const id of Object.keys(e.contentDocuments)) {
    const slash = id.lastIndexOf("/");
    dir = slash >= 0 ? id.slice(0, slash + 1) : "";
    break;
  }
  return dir + "chapter";
}

/** Returns candidate, or candidate with a numeric suffix inserted before its extension, whichever isn't already used by a resource, content document, navigation document, or NCX in e. */
function uniqueArchiveId(e: Epub, candidate: string): string {
  if (!archiveIdInUse(e, candidate)) return candidate;
  const ext = extname(candidate);
  const stem = candidate.slice(0, candidate.length - ext.length);
  for (let n = 2; ; n++) {
    const id = `${stem}-${n}${ext}`;
    if (!archiveIdInUse(e, id)) return id;
  }
}

registerTool(
  convertManuscriptTool,
  "Takes path (the .epub file, as previously passed to read_epub) and sourcePath (the manuscript file to " +
    "ingest, read directly from disk on the machine running this server, never sent through MCP as bytes). " +
    "Either may be omitted, in which case the user is prompted for it directly (see edit_chapter's " +
    "description for the general elicitation rules every tool on this server follows).\n\n" +
    'Reads sourcePath in full and splits it into chapters wherever a line looks like "Chapter <number>" ' +
    '(case-insensitive, optionally followed by a title on the same line, e.g. "Chapter 12: The Storm") — ' +
    'looser than edit_chapter\'s markdown path, which requires a leading "# ". No markers found means the ' +
    "whole file becomes a single chapter. .html sources are stripped of tags (and <script>/<style> " +
    "blocks) before splitting. Each chapter chunk is rendered into an XHTML content document the same way " +
    "edit_chapter's markdown parsing does.\n\n" +
    "If a parsed chapter's number matches an existing chapter already in the book — matched against the " +
      "chapter number in each existing chapter's own heading, in spine order, not against its " +
      "table-of-contents label — that existing content document's markup is replaced in place rather than " +
      "duplicated. Numbers not already present are appended as new chapters, manifest and spine wiring " +
      "included, same as edit_chapter's create action.\n\n" +
    "When every chapter has been written, the table of contents is rebuilt from scratch: one flat entry " +
      "per chapter, in spine reading order, each labelled from that chapter's own heading (falling back to " +
      "its <title>, then to its file name). Front and back cover pages are skipped. The legacy EPUB 2 NCX, " +
      "if the book has one, is regenerated to match, and the landmarks and page-list navs are left alone. " +
      "Because the rebuild is wholesale, any manual nesting or renaming previously applied to the table of " +
      "contents with edit_navigation is discarded — reapply it after converting, or use edit_chapter " +
      "instead of convert_manuscript when you want incremental changes that preserve a curated table of " +
      "contents. Reported as tocRebuilt, which is false only when the book has no navigation document at " +
      "all.\n\n" +
    "If the source has fewer chapters than the book already had — its highest chapter number is lower " +
    "than some existing chapter's — those existing chapters past that range are left untouched by default " +
    "and reported as leftover. The user is prompted once, asking whether to keep or delete all of them; a " +
    'blank accepted answer defaults to "keep" (nothing destroyed by default), while an explicit decline of ' +
    "the prompt is an error.\n\n" +
    "Only touches the in-memory cache; call save_epub afterwards to persist the result to disk.",
  handleConvertManuscript as never,
);

