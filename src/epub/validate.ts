import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";

/**
 * HTML5 void elements Go's xml.HTMLAutoClose tolerates without a closing
 * slash (e.g. <br> rather than <br/>). @xmldom/xmldom has no equivalent
 * auto-close option, so markup is preprocessed to self-close these before
 * parsing. This operates on the raw text, not a tokenizer, so it can be
 * confused by a ">" inside one of these elements' own attribute values —
 * rare in practice for the attributes void elements typically carry
 * (src, alt, href, ...).
 */
const VOID_ELEMENTS = [
  "area",
  "base",
  "br",
  "col",
  "command",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
];
const voidElementPattern = new RegExp(`<(${VOID_ELEMENTS.join("|")})((?:\\s+[^<>]*)?)(?<!/)>`, "gi");

/** Self-closes any of VOID_ELEMENTS not already written with a trailing "/>". */
export function autoCloseVoidElements(markup: string): string {
  return markup.replace(voidElementPattern, "<$1$2/>");
}

const strictParser = new DOMParser({ onError: onErrorStopParsing });

/**
 * Throws if markup is not well-formed XML. Tolerates HTML named entities
 * (&mdash;) and unclosed void elements (<br>) the way real XHTML content
 * documents use them, but genuine structural breakage (unterminated tags,
 * stray & or <) still throws.
 */
export function validateXHTML(markup: string): void {
  const doc = strictParser.parseFromString(autoCloseVoidElements(markup), "application/xhtml+xml");
  if (!doc.documentElement) {
    throw new Error("no root element");
  }
}
