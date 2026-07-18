/**
 * Plaintext-markdown-to-XHTML chapter splitting: the "# Chapter N" /
 * "## \"Title\"" marker format edit_chapter's create action parses when
 * given prose instead of pre-formatted XHTML. Mirrors Go's
 * tools/chapter_markdown.go.
 */

/** The parsed contents of a single chapter from raw prose text. number is 0 if no "# Chapter N" marker was found. */
export interface ChapterFragment {
  number: number;
  title: string;
  body: string[];
}

/**
 * Splits raw prose text into per-chapter fragments, deduplicating any
 * repeated "# Chapter N" markers so at most one chapter (heading and body)
 * is kept per number, in first-occurrence order. Returns the ordered
 * fragments and the number of duplicate chapters dropped (0 if none were
 * found).
 */
export function parseChaptersFromMarkdown(raw: string): [ChapterFragment[], number] {
  const chapters = splitIntoChapters(raw);
  return deduplicateChapters(chapters);
}

/**
 * Drops chapters whose number repeats an earlier chapter's, keeping the
 * first occurrence's title and body. Untitled/unmarked fragments (number
 * 0) are never treated as duplicates of one another.
 */
function deduplicateChapters(chapters: ChapterFragment[]): [ChapterFragment[], number] {
  const seen = new Set<number>();
  const deduped: ChapterFragment[] = [];
  let duplicates = 0;

  for (const chapter of chapters) {
    if (chapter.number > 0) {
      if (seen.has(chapter.number)) {
        duplicates++;
        continue;
      }
      seen.add(chapter.number);
    }
    deduped.push(chapter);
  }

  return [deduped, duplicates];
}

/** Splits text that already has unique "# Chapter N" markers into per-chapter fragments. */
function splitIntoChapters(text: string): ChapterFragment[] {
  const lines = text.split("\n");

  interface ChapterPos {
    markerLine: number;
    titleLine: number; // -1 if none
  }
  const positions: ChapterPos[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isChapterMarker(lines[i]!)) {
      const pos: ChapterPos = { markerLine: i, titleLine: -1 };
      if (i + 1 < lines.length && isChapterTitle(lines[i + 1]!)) pos.titleLine = i + 1;
      positions.push(pos);
    }
  }

  if (positions.length === 0) {
    return [{ number: 0, title: "", body: splitProseParagraphs(text) }];
  }

  const chapters: ChapterFragment[] = [];
  for (let pi = 0; pi < positions.length; pi++) {
    const { markerLine, titleLine } = positions[pi]!;
    const bodyStart = titleLine >= 0 ? titleLine + 1 : markerLine + 1;
    const endLine = pi + 1 < positions.length ? positions[pi + 1]!.markerLine : lines.length;

    const body = splitProseParagraphs(lines.slice(bodyStart, endLine).join("\n"));
    const frag: ChapterFragment = { number: extractChapterNumber(lines[markerLine]!), title: "", body };
    if (titleLine >= 0) frag.title = extractChapterTitle(lines[titleLine]!);
    chapters.push(frag);
  }

  return chapters;
}

/** Reports whether line starts with "# Chapter" followed by a digit. */
export function isChapterMarker(line: string): boolean {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("# chapter")) return false;
  const rest = lower.slice("# chapter".length).trimStart();
  return rest.length > 0 && rest[0]! >= "0" && rest[0]! <= "9";
}

/** Reports whether line matches `## "Title"`. */
function isChapterTitle(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.toLowerCase().startsWith("## ")) return false;
  const content = trimmed.slice(3).trim();
  return content.length > 0 && content[0] === '"';
}

/** Parses the chapter number from a marker line like "# Chapter 1". */
function extractChapterNumber(line: string): number {
  let s = line.trim().replace(/^#+/, "").trim().toLowerCase();
  if (s.startsWith("chapter")) s = s.slice("chapter".length);
  s = s.trim();
  const match = /^\d+/.exec(s);
  return match ? Number.parseInt(match[0], 10) : 0;
}

/**
 * Parses the title from a line like `## "The Title"`. Strips the `## `
 * prefix case-insensitively but preserves the original case of the
 * extracted content — see Global Constraints for why this deviates from
 * a literal port of Go's extractChapterTitle, which silently lowercases
 * the whole title.
 */
function extractChapterTitle(line: string): string {
  const trimmed = line.trim();
  const withoutPrefix = trimmed.toLowerCase().startsWith("## ") ? trimmed.slice(3) : trimmed;
  const content = withoutPrefix.trim();
  if (content.length >= 2 && content[0] === '"' && content[content.length - 1] === '"') {
    return content.slice(1, -1);
  }
  return content;
}

/**
 * Splits prose text into body paragraphs. Blank lines, "***"/"*****"
 * separators, and "---" horizontal rules become paragraph boundaries.
 * Leading whitespace — &nbsp;&nbsp;, regular spaces, or non-breaking
 * spaces — is stripped so paragraphs don't start with indentation
 * artifacts.
 */
export function splitProseParagraphs(text: string): string[] {
  const lines = text.split("\n");
  const paragraphs: string[] = [];
  let buf = "";

  for (const rawLine of lines) {
    let line = rawLine;
    let trimmed = line.trim();
    if (trimmed === "" || trimmed === "***" || trimmed === "*****" || trimmed === "---") {
      if (buf.length > 0) {
        paragraphs.push(flushParagraph(buf));
        buf = "";
      }
      continue;
    }

    while (true) {
      if (line.startsWith("&nbsp;&nbsp;")) {
        line = line.slice(12);
        continue;
      }
      if (line.length >= 2 && line[0] === " " && line[1] === " ") {
        line = line.slice(2);
        continue;
      }
      break;
    }

    trimmed = line.trim();
    if (trimmed === "") continue;

    if (buf.length > 0) buf += " ";
    buf += trimmed;
  }

  if (buf.length > 0) paragraphs.push(flushParagraph(buf));

  return paragraphs;
}

/** Collapses internal whitespace (spaces and tabs) into single spaces while preserving HTML entities like &mdash; or &nbsp;. */
function flushParagraph(s: string): string {
  s = s.trim();
  let out = "";
  let inEntity = false;
  for (const ch of s) {
    if (ch === "&") {
      inEntity = true;
      out += ch;
      continue;
    }
    if (inEntity) {
      out += ch;
      if (ch === ";") inEntity = false;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (out.length > 0 && out[out.length - 1] !== " ") out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Converts a single ChapterFragment into XHTML markup for an EPUB content document. The heading is optional — only body paragraphs are required. */
export function fragmentToXHTML(f: ChapterFragment): string {
  let b = "";
  if (f.number > 0 || f.title !== "") {
    b += "<h2>";
    if (f.number > 0) {
      b += `Chapter ${f.number}`;
      if (f.title !== "") b += ": ";
    }
    if (f.title !== "") b += f.title;
    b += "</h2>\n";
  }
  for (const para of f.body) {
    b += `<p>${escapeXHTML(para)}</p>\n`;
  }
  return b;
}

/** Converts a list of ChapterFragments into a complete XHTML document for an EPUB content page. */
export function chaptersToXHTML(frags: ChapterFragment[]): string {
  let b = "";
  for (const f of frags) b += fragmentToXHTML(f);

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n` +
    `<head>\n<meta charset="UTF-8"/>\n<title>Chapter</title>\n` +
    `<link rel="stylesheet" type="text/css" href="../styles/style.css"/>\n</head>\n<body>\n` +
    b +
    `</body>\n</html>`
  );
}

/** Reports whether content looks like the plaintext-markdown chapter format — at least one "# Chapter N" marker. */
export function autoDetectMarkdown(content: string): boolean {
  return content.split("\n").some((line) => isChapterMarker(line));
}

/** Reports whether content is (already) XHTML markup, detected by its first non-whitespace character being "<". */
export function isXHTML(content: string): boolean {
  return content.trim().startsWith("<");
}

/** Matches a well-formed XML/HTML entity reference at the start of a string, e.g. "&mdash;", "&#8212;", "&#x2014;". */
const ENTITY_PATTERN = /^&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;

/** Escapes only the characters illegal in XHTML text content: < becomes &lt;, & becomes &amp;. Existing well-formed entities (e.g. &mdash;) pass through unchanged rather than being double-escaped. */
export function escapeXHTML(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "&") {
      const match = ENTITY_PATTERN.exec(s.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
      out += "&amp;";
      i += 1;
      continue;
    }
    if (ch === "<") {
      out += "&lt;";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
