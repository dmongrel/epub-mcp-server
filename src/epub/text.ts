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

/**
 * Extracts the readable text from an XHTML content document's markup: tags
 * and attributes are discarded, and line breaks are inserted at block-level
 * element boundaries so paragraphs remain separated.
 */
export function plainText(markup: string): string {
  let doc: ReturnType<typeof lenientParser.parseFromString>;
  try {
    doc = lenientParser.parseFromString(autoCloseVoidElements(markup), "application/xhtml+xml");
  } catch {
    // @xmldom/xmldom's fatalError handler always throws a ParseError when no
    // Document could be produced at all (e.g. empty input), regardless of
    // the onError callback above. That's equivalent to "no root element" for
    // our purposes, so it resolves to the same empty-string result.
    return "";
  }
  const root = doc.documentElement;
  if (!root) return "";

  const parts: string[] = [];
  collectRawText(root, parts);
  const raw = parts.join("");

  const paragraphs: string[] = [];
  for (const segment of raw.split(PARAGRAPH_BREAK)) {
    const collapsed = segment.replace(/\s+/g, " ").trim();
    if (collapsed !== "") paragraphs.push(collapsed);
  }
  return paragraphs.join("\n\n");
}
