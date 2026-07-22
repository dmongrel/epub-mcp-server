// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * Whole-manuscript chapter splitting for convert_manuscript: looser
 * chapter-marker matching than chapter-markdown.ts's "# Chapter N" (which
 * requires a leading "# " and nothing else) — real manuscripts number
 * chapters as bare lines ("Chapter 12", "Chapter 12: The Storm") in plain
 * text, or as markdown ATX headings ("# Chapter 12") when the source is a
 * .md file. Mirrors Go's tools/manuscript_parse.go.
 */
import { extname } from "node:path";
import { splitProseParagraphs, type ChapterFragment } from "./chapter-markdown.ts";

const MANUSCRIPT_CHAPTER_MARKER = /^#*\s*chapter\s+(\d+)\b\.?:?\s*(.*)$/i;
const HTML_SCRIPT_STYLE = /<(script|style)[^>]*>[\s\S]*?<\/(script|style)>/gi;
const HTML_BLOCK_BREAK = /<\/(p|div|h[1-6]|li|br|tr)\s*>/gi;
const HTML_TAG = /<[^>]+>/g;
const MANUSCRIPT_TITLE_HEADING = /^#+\s*(.+)$/;

/** Classifies sourcePath by extension: "html" for .html/.htm, "text" for everything else. */
export function detectManuscriptFormat(sourcePath: string): "html" | "text" {
  const ext = extname(sourcePath).toLowerCase();
  return ext === ".html" || ext === ".htm" ? "html" : "text";
}

/**
 * Reduces raw HTML to plain text suitable for splitManuscriptChapters:
 * <script>/<style> blocks are dropped entirely, block-level closing tags
 * become line breaks (so paragraphs don't run together), and every
 * remaining tag is removed. Named entities are left alone.
 */
export function stripHtmlTags(raw: string): string {
  let s = raw.replace(HTML_SCRIPT_STYLE, "");
  s = s.replace(HTML_BLOCK_BREAK, "\n");
  s = s.replace(HTML_TAG, "");
  return s;
}

/**
 * Splits raw manuscript text into ChapterFragments wherever a line looks
 * like "Chapter <number>". If no marker is found, the entire text becomes
 * a single fragment with no chapter number. Repeated markers for the same
 * chapter number are deduplicated, keeping only the first occurrence.
 */
export function splitManuscriptChapters(text: string): ChapterFragment[] {
  const lines = text.split("\n");

  interface Marker {
    markerLine: number;
    bodyStart: number;
    number: number;
    title: string;
  }
  const markers: Marker[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = MANUSCRIPT_CHAPTER_MARKER.exec(lines[i]!.trim());
    if (!m) continue;

    const num = Number.parseInt(m[1]!, 10);
    let title = trimQuotesAndSpaces(m[2]!);
    let bodyStart = i + 1;

    if (title === "") {
      let j = i + 1;
      if (j < lines.length && lines[j]!.trim() === "") j++;
      if (j < lines.length) {
        const tm = MANUSCRIPT_TITLE_HEADING.exec(lines[j]!.trim());
        if (tm) {
          title = trimQuotesAndSpaces(tm[1]!);
          bodyStart = j + 1;
        }
      }
    }

    markers.push({ markerLine: i, bodyStart, number: num, title });
  }

  if (markers.length === 0) {
    return [{ number: 0, title: "", body: splitProseParagraphs(text) }];
  }

  const fragments: ChapterFragment[] = [];
  for (let mi = 0; mi < markers.length; mi++) {
    const mk = markers[mi]!;
    const end = mi + 1 < markers.length ? markers[mi + 1]!.markerLine : lines.length;
    const body = splitProseParagraphs(lines.slice(mk.bodyStart, end).join("\n"));
    fragments.push({ number: mk.number, title: mk.title, body });
  }

  return dedupeFragmentsByNumber(fragments);
}

function trimQuotesAndSpaces(s: string): string {
  return s.replace(/^["' ]+|["' ]+$/g, "");
}

/** Drops every fragment whose number repeats one already seen, keeping the first occurrence. Fragments with number 0 always pass through. */
function dedupeFragmentsByNumber(fragments: ChapterFragment[]): ChapterFragment[] {
  const seen = new Set<number>();
  const out: ChapterFragment[] = [];
  for (const f of fragments) {
    if (f.number > 0) {
      if (seen.has(f.number)) continue;
      seen.add(f.number);
    }
    out.push(f);
  }
  return out;
}

