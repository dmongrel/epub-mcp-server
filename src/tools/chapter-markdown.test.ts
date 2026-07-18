import { describe, expect, test } from "bun:test";
import {
  autoDetectMarkdown,
  chaptersToXHTML,
  escapeXHTML,
  fragmentToXHTML,
  isChapterMarker,
  isXHTML,
  parseChaptersFromMarkdown,
  splitProseParagraphs,
} from "./chapter-markdown.ts";

describe("isChapterMarker", () => {
  test("matches a bare chapter heading", () => {
    expect(isChapterMarker("# Chapter 1")).toBe(true);
  });
  test("is case-insensitive", () => {
    expect(isChapterMarker("# CHAPTER 12")).toBe(true);
  });
  test("rejects non-marker lines", () => {
    expect(isChapterMarker("Just some text")).toBe(false);
    expect(isChapterMarker("## Chapter 1")).toBe(false);
    expect(isChapterMarker("# Chapters are fun")).toBe(false);
  });
});

describe("parseChaptersFromMarkdown", () => {
  test("splits multiple chapters with titles and body paragraphs", () => {
    const raw = [
      "# Chapter 1",
      '## "The Beginning"',
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "# Chapter 2",
      "No title here.",
    ].join("\n");

    const [chapters, duplicates] = parseChaptersFromMarkdown(raw);

    expect(duplicates).toBe(0);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toEqual({ number: 1, title: "The Beginning", body: ["First paragraph.", "Second paragraph."] });
    expect(chapters[1]).toEqual({ number: 2, title: "", body: ["No title here."] });
  });

  test("preserves the original case of a mixed-case title (deviates from a literal Go port; see Global Constraints)", () => {
    const raw = ['# Chapter 1', '## "The Mage Who Didn\'t Need a Wand"', "Body text."].join("\n");
    const [chapters] = parseChaptersFromMarkdown(raw);
    expect(chapters[0]?.title).toBe("The Mage Who Didn't Need a Wand");
  });

  test("deduplicates repeated chapter numbers, keeping the first occurrence", () => {
    const raw = ["# Chapter 1", "First.", "", "# Chapter 1", "Second (duplicate, should be dropped)."].join("\n");
    const [chapters, duplicates] = parseChaptersFromMarkdown(raw);
    expect(duplicates).toBe(1);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.body).toEqual(["First."]);
  });

  test("treats content with no markers as a single untitled chapter", () => {
    const raw = "Just some prose.\n\nAnother paragraph.";
    const [chapters, duplicates] = parseChaptersFromMarkdown(raw);
    expect(duplicates).toBe(0);
    expect(chapters).toEqual([{ number: 0, title: "", body: ["Just some prose.", "Another paragraph."] }]);
  });
});

describe("splitProseParagraphs", () => {
  test("joins consecutive non-blank lines into one paragraph, splitting on blank lines", () => {
    expect(splitProseParagraphs("Line one.\nLine two.\n\nLine three.")).toEqual(["Line one. Line two.", "Line three."]);
  });

  test("treats *** and --- as paragraph boundaries", () => {
    expect(splitProseParagraphs("Para one.\n***\nPara two.\n---\nPara three.")).toEqual(["Para one.", "Para two.", "Para three."]);
  });

  test("strips leading whitespace variants (spaces, &nbsp;&nbsp;) from each line", () => {
    expect(splitProseParagraphs("  Indented text.\n&nbsp;&nbsp;More indented text.")).toEqual(["Indented text. More indented text."]);
  });

  test("collapses internal whitespace while preserving HTML entities", () => {
    expect(splitProseParagraphs("Word1   word2\tword3 &mdash; word4")).toEqual(["Word1 word2 word3 &mdash; word4"]);
  });
});

describe("fragmentToXHTML / chaptersToXHTML", () => {
  test("renders a heading only when number or title is present", () => {
    expect(fragmentToXHTML({ number: 0, title: "", body: ["Just body."] })).toBe("<p>Just body.</p>\n");
    expect(fragmentToXHTML({ number: 1, title: "", body: ["Body."] })).toBe("<h2>Chapter 1</h2>\n<p>Body.</p>\n");
    expect(fragmentToXHTML({ number: 1, title: "Title", body: ["Body."] })).toBe("<h2>Chapter 1: Title</h2>\n<p>Body.</p>\n");
  });

  test("chaptersToXHTML wraps fragments in a complete XHTML document", () => {
    const doc = chaptersToXHTML([{ number: 1, title: "", body: ["Body."] }]);
    expect(doc).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(doc).toContain("<h2>Chapter 1</h2>");
    expect(doc).toContain("<p>Body.</p>");
    expect(doc.trim().endsWith("</html>")).toBe(true);
  });
});

describe("autoDetectMarkdown / isXHTML", () => {
  test("autoDetectMarkdown is true only when a chapter marker is present", () => {
    expect(autoDetectMarkdown("# Chapter 1\nSome text.")).toBe(true);
    expect(autoDetectMarkdown("Just some text.")).toBe(false);
  });

  test("isXHTML detects a leading angle bracket after trimming", () => {
    expect(isXHTML('  <?xml version="1.0"?>')).toBe(true);
    expect(isXHTML("# Chapter 1")).toBe(false);
  });
});

describe("escapeXHTML", () => {
  test("escapes < and & but leaves other characters and existing entities alone", () => {
    expect(escapeXHTML("A & B < C")).toBe("A &amp; B &lt; C");
    expect(escapeXHTML("Already &mdash; escaped")).toBe("Already &mdash; escaped");
  });
});
