// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * edit_chapter — create, edit, or remove one content document (chapter/
 * section). Mirrors Go's tools/edit_chapter.go.
 *
 * manifestIdCandidate/uniqueManifestId are imported from ./edit-resource.ts
 * rather than defined here, even though Go defines them in
 * tools/edit_chapter.go (edit_resource.go's createResource calls them
 * cross-file via Go's flat package namespace). This TS port already placed
 * both in edit-resource.ts during Phase 4; since that's already merged and
 * tested, this file imports from there instead of relocating shipped code.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  autoDetectMarkdown,
  chaptersToXHTML,
  isXHTML,
  parseChaptersFromMarkdown,
} from "./chapter-markdown.ts";
import { resolveArg } from "./elicit.ts";
import { archiveIdInUse, manifestIdCandidate, uniqueManifestId } from "./edit-resource.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { removeMatching } from "./idlist.ts";
import { syncTocOnChapterCreate, syncTocOnChapterRemove } from "./nav-sync.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemByHref, primaryPackage, relativeHref, spineInsertionIndexBeforeBackCover } from "../epub/resolve.ts";
import { insertAt, renumberSpine } from "./edit-spine.ts";
import { validateXHTML } from "../epub/validate.ts";
import type { Eviction } from "../epub/cache.ts";
import type { Epub, Package } from "../epub/types.ts";

interface EditChapterArgs {
  action?: string;
  path?: string;
  id?: string;
  content?: string;
  label?: string;
}

interface EditChapterResult {
  action: string;
  id: string;
  previousLength?: number;
  newLength?: number;
  tocSynced?: boolean;
  createdIds?: string[];
}

export const editChapterTool: EpubTool = {
  name: "edit_chapter",
  description: "Create, edit, or remove one content document (chapter/section) of an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a new chapter, "edit" an existing one, or "remove" one' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: "content document id: the new chapter's archive path for create, or an existing one's id for edit/remove" },
      content: { type: "string", description: "new XHTML markup for the chapter; used by create and edit, ignored by remove" },
      label: { type: "string", description: "table-of-contents entry text for this chapter; used only by create, auto-derived from id if omitted" },
    },
  },
};

function idPrompt(action: string): string {
  if (action === "create") return 'What archive path should the new chapter be saved at (e.g. "OEBPS/text/chapter-18.xhtml")?';
  return "Which chapter should be affected? Provide its content document id (see read_epub's contentDocuments list).";
}

export async function handleEditChapter(server: Server, args: EditChapterArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const id = await resolveArg(server, args.id, "id", idPrompt(action));

  let content = "";
  if (action !== "remove") {
    content = await resolveArg(server, args.content, "content", "What should this chapter's content be? Leave blank if you don't have text yet.");
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);

  let outcome: { summary: string; result: EditChapterResult };
  switch (action) {
    case "create":
      if (autoDetectMarkdown(content) && !isXHTML(content)) {
        outcome = createChaptersFromMarkdown(e, abs, id, content, eviction);
      } else {
        try {
          validateXHTML(content);
        } catch {
          throw new Error(
            'content is not well-formed XHTML and does not contain "# Chapter N" markers — either provide valid XHTML or markdown with chapter headers',
          );
        }
        outcome = createChapter(e, abs, id, content, args.label ?? "", eviction);
      }
      break;
    case "edit":
      outcome = editExistingChapter(e, abs, id, content, eviction);
      break;
    case "remove":
      outcome = removeChapter(e, abs, id, eviction);
      break;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  epubCache.markDirty(abs);
  return {
    content: [{ type: "text", text: outcome.summary }],
    structuredContent: outcome.result as unknown as Record<string, unknown>,
  };
}

function createChapter(
  e: Epub,
  absPath: string,
  id: string,
  content: string,
  label: string,
  eviction: Eviction | undefined,
): { summary: string; result: EditChapterResult } {
  if (archiveIdInUse(e, id)) throw new Error(`${JSON.stringify(id)} already exists in this book; use action "edit" instead`);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(absPath)} has no package document to add a chapter to`);

  const tocSynced = insertChapter(e, pkg, id, content, label);

  const result: EditChapterResult = { action: "create", id, newLength: content.length, tocSynced };
  const tocNote = tocSynced ? " Added a matching toc entry to the navigation document." : " No navigation document to add a toc entry to.";
  const summary = `Created ${JSON.stringify(id)} in ${JSON.stringify(absPath)} (${content.length} characters), appended to the end of the manifest and spine.${tocNote} Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { summary, result };
}

function editExistingChapter(
  e: Epub,
  absPath: string,
  id: string,
  content: string,
  eviction: Eviction | undefined,
): { summary: string; result: EditChapterResult } {
  const doc = e.contentDocuments[id];
  if (!doc) throw new Error(`no content document with id ${JSON.stringify(id)} in ${JSON.stringify(absPath)}; call read_epub to list valid ids`);

  const previousLength = doc.markup.length;
  doc.markup = content;

  const result: EditChapterResult = { action: "edit", id, previousLength, newLength: content.length };
  const summary = `Updated ${JSON.stringify(id)} in ${JSON.stringify(absPath)} (${previousLength} -> ${content.length} characters). Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { summary, result };
}

function removeChapter(
  e: Epub,
  absPath: string,
  id: string,
  eviction: Eviction | undefined,
): { summary: string; result: EditChapterResult } {
  const del = deleteChapterDocument(e, primaryPackage(e), id);
  if (!del.ok) throw new Error(`no content document with id ${JSON.stringify(id)} in ${JSON.stringify(absPath)}; call read_epub to list valid ids`);

  const result: EditChapterResult = { action: "remove", id, previousLength: del.previousLength, tocSynced: del.tocSynced };
  const tocNote = del.tocSynced ? " Removed its matching toc entry from the navigation document." : "";
  const summary = `Removed ${JSON.stringify(id)} from ${JSON.stringify(absPath)} (${del.previousLength} characters).${tocNote} Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { summary, result };
}

function createChaptersFromMarkdown(
  e: Epub,
  absPath: string,
  id: string,
  content: string,
  eviction: Eviction | undefined,
): { summary: string; result: EditChapterResult } {
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(absPath)} has no package document to add chapters to`);

  const [fragments, duplicatesRemoved] = parseChaptersFromMarkdown(content);
  if (fragments.length === 0) throw new Error('no chapters found in content — does it contain "# Chapter N" markers?');

  const baseId = deriveChapterBase(id);
  const createdIds: string[] = [];
  let totalChars = 0;

  fragments.forEach((frag, i) => {
    let chapterId = baseId;
    if (fragments.length > 1 || (frag.number > 0 && baseHasNoNumber(baseId))) {
      const stem = stripExtension(basename(id));
      let dir = "";
      const slash = id.lastIndexOf("/");
      if (slash >= 0) dir = id.slice(0, slash);
      chapterId = `${dir}/${stem}-${i + 1}.xhtml`;
    }

    let label = `Chapter ${frag.number}`;
    if (frag.title !== "") {
      label += `: ${frag.title}`;
    } else if (!baseHasNoNumber(baseId) && baseId !== "") {
      label = stripExtension(basename(id));
    }

    const markup = chaptersToXHTML([frag]);
    insertChapter(e, pkg, chapterId, markup, label);
    totalChars += markup.length;
    createdIds.push(chapterId);
  });

  const result: EditChapterResult = {
    action: "create",
    id: createdIds[0]!,
    createdIds,
    newLength: totalChars,
    tocSynced: true,
  };

  let summary = `Parsed ${fragments.length} chapters from markdown (removed ${duplicatesRemoved} duplicate markers). Created:`;
  for (const cid of createdIds) summary += `\n  - ${JSON.stringify(cid)}`;
  summary += `\nTotal: ${totalChars} characters. Call save_epub to persist this to disk.${evictionNote(eviction)}`;

  return { summary, result };
}

function basename(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Extracts the "stem" from an id like "OEBPS/text/chapter-1.xhtml" -> "chapter". */
function deriveChapterBase(id: string): string {
  const name = stripExtension(basename(id));
  let out = "";
  for (const ch of name) {
    if (/[a-zA-Z_]/.test(ch)) {
      out += ch;
    } else {
      break;
    }
  }
  return out.length > 0 ? out : name;
}

/** Reports whether a chapter stem (like "chapter" or "text") has no digits. */
function baseHasNoNumber(stem: string): boolean {
  return !/\d/.test(stem);
}

/**
 * Removes id's content document, manifest entry, spine entry, and any toc
 * entry targeting it from e — the shared core of removeChapter and
 * convert_manuscript's leftover-chapter cleanup. Returns the content
 * document's markup length and whether its toc entry was synced, plus
 * whether id was found at all.
 */
export function deleteChapterDocument(e: Epub, pkg: Package | undefined, id: string): { previousLength: number; tocSynced: boolean; ok: boolean } {
  const doc = e.contentDocuments[id];
  if (!doc) return { previousLength: 0, tocSynced: false, ok: false };
  const previousLength = doc.markup.length;

  let tocSynced = false;
  if (pkg) {
    tocSynced = syncTocOnChapterRemove(e, pkg, id);
    const item = manifestItemByHref(pkg, id);
    if (item) {
      const prefix = pkg.manifest.id + "/";
      const opfId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
      pkg.manifest.items = removeMatching(pkg.manifest.items, (it) => it.id !== item.id);
      pkg.spine.itemRefs = removeMatching(pkg.spine.itemRefs, (ref) => ref.idRef !== opfId);
    }
  }

  delete e.contentDocuments[id];
  return { previousLength, tocSynced, ok: true };
}

/**
 * Adds a new content document at id, with the given content and (if a
 * navigation document exists) a matching top-level toc entry, to e's
 * manifest and spine. Inserted just before the back cover if the book has
 * one (see spineInsertionIndexBeforeBackCover), otherwise appended at the
 * end, so a back cover always stays the last thing a linear read reaches.
 * Shared by createChapter, convert_manuscript, and a future save_epub's
 * fallback that ensures a book being saved has at least one content
 * document. Returns whether the toc entry was added.
 */
export function insertChapter(e: Epub, pkg: Package, id: string, content: string, label: string): boolean {
  const opfId = uniqueManifestId(pkg, manifestIdCandidate(id));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${opfId}`,
    href: relativeHref(pkg, id),
    mediaType: "application/xhtml+xml",
    properties: [],
    fallback: "",
    mediaOverlay: "",
  });
  const at = spineInsertionIndexBeforeBackCover(pkg);
  pkg.spine.itemRefs = insertAt(pkg.spine.itemRefs, at, { id: "", idRef: opfId, linear: true, properties: [] });
  renumberSpine(pkg);
  e.contentDocuments[id] = { id, mediaType: "application/xhtml+xml", markup: content };
  return syncTocOnChapterCreate(e, pkg, id, label);
}

registerTool(
  editChapterTool,
  "Converting a whole existing manuscript file (.txt/.md/.html) into a book's chapters in one call is what " +
    "convert_manuscript is for — it's the more expedient tool when the goal is ingesting an entire book at " +
    "once, rather than looping edit_chapter create calls one chapter at a time.\n\n" +
    'Takes action ("create", "edit", or "remove"), path (the .epub filesystem path passed to read_epub), ' +
    "id, and content. Any of these may be omitted, in which case the user is prompted for it directly; a " +
    "blank answer to that prompt is accepted as given rather than re-prompted or rejected, since it means " +
    "the user doesn't have that information yet — it then fails validation just as a directly-passed blank " +
    "value would (e.g. action must still end up one of the three valid choices).\n\n" +
    'action "create": id is the archive path the new chapter should be saved at (e.g. ' +
    '"OEBPS/text/chapter-18.xhtml"). It\'s added to the manifest and appended to the end of the spine ' +
    "reading order — or, if the book has a back cover (see edit_back_cover), just before it, so the back " +
    "cover stays the last thing a linear read reaches. content becomes its initial markup, and it's appended as a new entry to the navigation " +
    'document\'s "toc" list (label, if given, or else auto-derived from id, e.g. "chapter-18.xhtml" -> ' +
    '"Chapter 18") — the same list read_epub\'s tableOfContents and get_navigation report. Use ' +
    "edit_navigation afterwards if you want to rename, reorder, or nest that entry instead of accepting " +
    "the default. create only ever adds a brand-new chapter — it never updates one that already exists, so " +
    'it fails outright if id is already in use; use "edit" instead to change that chapter\'s content.\n\n' +
    'When creating chapters from raw text (not pre-formatted XHTML), pass the prose with "# Chapter N" ' +
    "markers — one per chapter. The parser deduplicates any repeated \"# Chapter N\" markers, extracts " +
    'each chapter\'s optional title line ("## Title") and body paragraphs, then creates a separate XHTML ' +
    'document for every chapter it finds using id as a template (e.g. id="chapter-1.xhtml" produces ' +
    'chapter-1.xhtml, chapter-2.xhtml, ...). An explicit label overrides the auto-derived one.\n\n' +
    "-- Submission Formatting --\n\n" +
    'The chapter\'s "content" argument accepts two formats: plaintext markdown or full XHTML. The server ' +
    'auto-detects which format you\'re using based on whether it finds a "# Chapter N" marker.\n\n' +
    'Plaintext — pass raw prose with "# Chapter N" markers:\n\n' +
    "# Chapter N              <- chapter marker; only the first occurrence of each number is kept\n" +
    '## "Chapter Title"       <- optional title line on the next row, wrapped in double quotes\n\n' +
    "Body paragraph text begins here. Leading spaces or tabs on every row are stripped automatically and " +
    "consecutive lines are joined into a single <p> element.\n\n" +
    "Additional paragraphs (repeat as needed)...\n\n" +
    "<empty line or any separator ends this chapter body>\n\n" +
    "Rules for plaintext:\n" +
    '- Each "# Chapter N" marker starts a new chapter document. If the same number appears more than once ' +
    "only the first is kept — duplicates are silently removed.\n" +
    '- The optional "## Title" on the row immediately after the marker becomes an <h2> heading; omit it ' +
    "for chapters without titles.\n" +
    '- Everything between the (optional) title and the next "# Chapter N" (or EOF) is body text. Blank ' +
    "lines produce paragraph boundaries — consecutive non-blank lines are joined into a single <p>.\n" +
    "- Leading whitespace on every line is stripped so paragraphs don't start with indentation artifacts. " +
    "Whether that whitespace is regular spaces, tabs, &nbsp;&nbsp; (HTML entity), or non-breaking-space " +
    "characters doesn't matter — all leading whitespace is removed.\n" +
    '- If no "# Chapter N" markers are found the entire input is treated as a single chapter with no ' +
    "heading — just <p> elements.\n\n" +
    "HTML submissions — pass complete XHTML, e.g.:\n\n" +
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n' +
    "<head>\n<meta charset=\"UTF-8\"/>\n<title>Chapter Title</title>\n" +
    '<link rel="stylesheet" type="text/css" href="../styles/style.css"/>\n</head>\n<body>\n' +
    "<h1>Chapter Heading (optional)</h1>\n<p>First paragraph of body text.</p>\n</body>\n</html>\n\n" +
    "Rules for HTML:\n" +
    "- Content must be well-formed XHTML — it is validated before acceptance. Self-closing tags (<br/>, " +
    "<img .../>) and named entities (&mdash;, &amp;) are supported because real EPUB content documents " +
    "use them.\n" +
    "- The entire markup replaces the chapter's existing document verbatim — no automatic heading or " +
    "paragraph wrapping is applied. You control every element yourself.\n" +
    "- No chapter-marker parsing occurs; everything you pass is treated as one complete XHTML document.\n\n" +
    "action \"edit\": id must be an existing content document id, from read_epub's contentDocuments list; " +
    "content entirely replaces its markup. The toc entry (if any) is left untouched — use edit_navigation " +
    "to rename it.\n\n" +
    'action "remove": id must be an existing content document id; content is ignored. Its content ' +
    "document, manifest entry, spine entry, and any top-level toc entry targeting it are all deleted.\n\n" +
    "All three actions only touch the in-memory cache; call save_epub afterwards to write the result to disk.",
  handleEditChapter as never,
);

