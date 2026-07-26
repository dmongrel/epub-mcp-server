// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * How a chapter names itself. Every structure in an EPUB that has to agree
 * about "which chapter is this" — the table of contents rebuilt by
 * rebuildToc, convert_manuscript's matching of source fragments to existing
 * chapters, and validate_epub's alignment checks — derives that name here,
 * so none of them can drift apart by disagreeing about the rules.
 */
import { documentTitle, firstHeadingText } from "./text.ts";

/**
 * The literal <title> chaptersToXHTML hardcodes into every document it
 * generates. It names no particular chapter, so deriveTocLabel treats it as
 * absent rather than labelling half a book "Chapter".
 */
const GENERATED_TITLE_PLACEHOLDER = "Chapter";

const CHAPTER_NUMBER_PATTERN = /^chapter\s+(\d+)\b/i;

/**
 * Derives a human-readable toc label from an archive path's file name, e.g.
 * "text/chapter-18.xhtml" -> "Chapter 18". The last resort, for a document
 * that describes itself neither by a heading nor by a title.
 */
export function defaultChapterLabel(archivePath: string): string {
  let name = archivePath;
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot > 0) name = name.slice(0, dot);
  name = name.replace(/[-_]/g, " ");
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Untitled";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The table-of-contents label for a content document, in descending order of
 * how much the document itself tells us: its first heading, then its <head>
 * <title> (unless that's the generated placeholder), then its file name.
 * Markup is the source of truth, so a chapter retitled in its own text gets
 * a corrected toc entry the next time the toc is rebuilt.
 */
export function deriveTocLabel(markup: string, archivePath: string): string {
  const heading = firstHeadingText(markup);
  if (heading !== "") return heading;
  const title = documentTitle(markup);
  if (title !== "" && title !== GENERATED_TITLE_PLACEHOLDER) return title;
  return defaultChapterLabel(archivePath);
}

/**
 * Extracts the chapter number from a label like "Chapter 12: The Storm",
 * or 0 if the label doesn't open with one. Only leading "Chapter <digits>"
 * counts — spelled-out numbers and mid-label digits are deliberately not
 * matched, since guessing there would produce false alignment failures.
 */
export function chapterNumberFromLabel(label: string): number {
  const m = CHAPTER_NUMBER_PATTERN.exec(label.trim());
  if (!m) return 0;
  return Number.parseInt(m[1]!, 10);
}
