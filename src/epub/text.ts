// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { DOMParser, type Element, type Node } from "@xmldom/xmldom";
import { autoCloseVoidElements } from "./validate.ts";

/** XHTML tags whose boundaries become line breaks when flattening markup to plain text. */
const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "section",
  "article",
  "tr",
]);

// No onError override: unlike validate.ts's strict parser, this one never
// throws on a recoverable error (only a truly fatal one), matching Go's
// PlainText running its xml.Decoder with Strict = false. The no-op callback
// (rather than the default, which console.errors) keeps test/tool output
// pristine.
const lenientParser = new DOMParser({ onError: () => {} });

function localName(tagName: string): string {
  const i = tagName.indexOf(":");
  return i === -1 ? tagName : tagName.slice(i + 1);
}

// Sentinel marking a block-element boundary in the accumulated raw text.
// Deliberately distinct from an ordinary "\n": a text node's own content can
// itself contain literal newlines (e.g. source markup wrapped across
// lines), and those must collapse into the surrounding paragraph rather
// than being mistaken for a paragraph break. U+0000 cannot appear in parsed
// XML text content, so splitting on it later can't be confused by real
// whitespace in the source markup.
const PARAGRAPH_BREAK = "\u0000";

function collectRawText(node: Node, out: string[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      // TEXT_NODE
      out.push(child.nodeValue ?? "");
    } else if (child.nodeType === 1) {
      // ELEMENT_NODE
      const el = child as Element;
      const isBlock = BLOCK_ELEMENTS.has(localName(el.tagName));
      if (isBlock) out.push(PARAGRAPH_BREAK);
      collectRawText(el, out);
      if (isBlock) out.push(PARAGRAPH_BREAK);
    }
  }
}

/** Finds the first descendant element (depth-first) with the given local name, or undefined if none exists. */
function findElementByLocalName(node: Node, name: string): Element | undefined {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue; // ELEMENT_NODE
    const el = child as Element;
    if (localName(el.tagName) === name) return el;
    const found = findElementByLocalName(el, name);
    if (found) return found;
  }
  return undefined;
}

/** XHTML heading tags, in the order a document may use them — any of them can open a chapter. */
const HEADING_ELEMENTS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Parses markup leniently and returns its root element, or undefined if no
 * Document could be produced at all. Shared by plainText, firstHeadingText,
 * and documentTitle so all three treat unparseable input identically.
 */
function parseRoot(markup: string): Element | undefined {
  let doc: ReturnType<typeof lenientParser.parseFromString>;
  try {
    doc = lenientParser.parseFromString(autoCloseVoidElements(markup), "application/xhtml+xml");
  } catch {
    // @xmldom/xmldom's fatalError handler always throws a ParseError when no
    // Document could be produced at all (e.g. empty input), regardless of the
    // onError callback above.
    return undefined;
  }
  return doc.documentElement ?? undefined;
}

/** Collapses every whitespace run in s to a single space and trims the ends. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Returns el's full descendant text with block boundaries flattened to spaces — a heading or title is one line by definition, unlike plainText's paragraphs. */
function elementText(el: Element): string {
  const parts: string[] = [];
  collectRawText(el, parts);
  return parts.join("").split(PARAGRAPH_BREAK).join(" ");
}

/** Finds the first h1-h6 descendant (depth-first) of node, or undefined if it has none. */
function findHeading(node: Node): Element | undefined {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue; // ELEMENT_NODE
    const el = child as Element;
    if (HEADING_ELEMENTS.has(localName(el.tagName))) return el;
    const found = findHeading(el);
    if (found) return found;
  }
  return undefined;
}

/**
 * Returns the text of the first h1-h6 element inside markup's <body>, with
 * inline markup stripped and whitespace collapsed, or "" if there is none.
 * This is a chapter document's most reliable self-description: the heading
 * chaptersToXHTML writes ("Chapter 5: The Fall") and the one a hand-authored
 * or imported EPUB's chapter opens with.
 */
export function firstHeadingText(markup: string): string {
  const root = parseRoot(markup);
  if (!root) return "";
  const body = findElementByLocalName(root, "body") ?? root;
  const heading = findHeading(body);
  return heading ? collapseWhitespace(elementText(heading)) : "";
}

/**
 * Returns the text of markup's <head><title>, or "" if it has none. Scoped
 * to <head> deliberately: an inline <svg> on a cover page carries its own
 * <title>, which is artwork description rather than the document's name.
 */
export function documentTitle(markup: string): string {
  const root = parseRoot(markup);
  if (!root) return "";
  const head = findElementByLocalName(root, "head");
  if (!head) return "";
  const title = findElementByLocalName(head, "title");
  return title ? collapseWhitespace(elementText(title)) : "";
}

/**
 * Reports whether markup is a front- or back-cover wrapper page, per this
 * server's own convention (see coverPageMarkup in edit-cover.ts): both are
 * built around a <section epub:type="..."> whose space-separated epub:type
 * tokens always include "cover" ("cover" for the front, "backmatter cover"
 * for the back) — checked directly on the page's own markup rather than via
 * the (optional, legacy) guide/landmarks, which aren't guaranteed present or
 * in sync. Callers use it to tell prose from wrapper pages: find_text's
 * chapter numbering and the table of contents rebuilt by rebuildToc both
 * skip cover pages, and must skip exactly the same ones.
 */
export function isCoverPage(markup: string): boolean {
  const re = /epub:type\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup)) !== null) {
    if (m[1]!.split(/\s+/).includes("cover")) return true;
  }
  return false;
}

/**
 * Extracts the readable text from an XHTML content document's markup: tags
 * and attributes are discarded, and line breaks are inserted at block-level
 * element boundaries so paragraphs remain separated.
 */
export function plainText(markup: string): string {
  const root = parseRoot(markup);
  if (!root) return "";

  // Only the <body> is readable content — walking the whole document would
  // also pick up <head><title> text (and any future <head> text content) as
  // a spurious leading "paragraph" with no block-boundary of its own to
  // separate it from the real content. Fall back to root for malformed
  // markup with no <body> at all, rather than returning nothing.
  const body = findElementByLocalName(root, "body") ?? root;

  const parts: string[] = [];
  collectRawText(body, parts);
  const raw = parts.join("");

  const paragraphs: string[] = [];
  for (const segment of raw.split(PARAGRAPH_BREAK)) {
    const collapsed = segment.replace(/\s+/g, " ").trim();
    if (collapsed !== "") paragraphs.push(collapsed);
  }
  return paragraphs.join("\n\n");
}

