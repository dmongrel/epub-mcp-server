import { describe, expect, test } from "bun:test";
import { detectManuscriptFormat, splitManuscriptChapters, stripHtmlTags } from "./manuscript-parse.ts";

describe("detectManuscriptFormat", () => {
  test("recognizes .html/.htm as html, everything else as text", () => {
    expect(detectManuscriptFormat("book.html")).toBe("html");
    expect(detectManuscriptFormat("book.HTM")).toBe("html");
    expect(detectManuscriptFormat("book.txt")).toBe("text");
    expect(detectManuscriptFormat("book.md")).toBe("text");
  });
});

describe("stripHtmlTags", () => {
  test("drops script/style blocks, converts block closes to newlines, strips remaining tags", () => {
    const html = "<html><head><style>body{color:red}</style></head><body><p>Hello</p><p>World</p></body></html>";
    const result = stripHtmlTags(html);
    expect(result).not.toContain("<");
    expect(result).not.toContain("color:red");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });

  test("leaves named entities alone", () => {
    expect(stripHtmlTags("<p>Em&mdash;dash</p>")).toContain("&mdash;");
  });

  test("drops script/style blocks spanning multiple lines, case-insensitively", () => {
    const html = "<STYLE>\nbody{color:red}\n</STYLE><p>Kept</p>";
    const result = stripHtmlTags(html);
    expect(result).not.toContain("color:red");
    expect(result).toContain("Kept");
  });
});

describe("splitManuscriptChapters", () => {
  test("splits on loose 'Chapter N' markers, optionally with an inline title", () => {
    const text = ["Chapter 1: The Beginning", "", "First paragraph.", "", "Chapter 2", "", "Second paragraph."].join("\n");

    const fragments = splitManuscriptChapters(text);

    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toMatchObject({ number: 1, title: "The Beginning" });
    expect(fragments[0]?.body).toEqual(["First paragraph."]);
    expect(fragments[1]).toMatchObject({ number: 2, title: "" });
    expect(fragments[1]?.body).toEqual(["Second paragraph."]);
  });

  test("tolerates a markdown ATX chapter marker", () => {
    const text = ["# Chapter 3", "", "Body text."].join("\n");
    const fragments = splitManuscriptChapters(text);
    expect(fragments[0]).toMatchObject({ number: 3 });
  });

  test("picks up a standalone markdown title heading on the next non-blank line", () => {
    const text = ['Chapter 4', '', '## "A Standalone Title"', "", "Body text."].join("\n");
    const fragments = splitManuscriptChapters(text);
    expect(fragments[0]).toMatchObject({ number: 4, title: "A Standalone Title" });
    expect(fragments[0]?.body).toEqual(["Body text."]);
  });

  test("treats content with no markers as a single untitled chapter", () => {
    const fragments = splitManuscriptChapters("Just prose.\n\nMore prose.");
    expect(fragments).toEqual([{ number: 0, title: "", body: ["Just prose.", "More prose."] }]);
  });

  test("deduplicates repeated chapter numbers, keeping the first occurrence", () => {
    const text = ["Chapter 1", "First.", "", "Chapter 1", "Second (duplicate)."].join("\n");
    const fragments = splitManuscriptChapters(text);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.body).toEqual(["First."]);
  });

  test("is case-insensitive and tolerates a trailing colon/period", () => {
    const text = ["CHAPTER 5.", "", "Body."].join("\n");
    const fragments = splitManuscriptChapters(text);
    expect(fragments[0]).toMatchObject({ number: 5 });
  });
});
