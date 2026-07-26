// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { chapterNumberFromLabel, defaultChapterLabel, deriveTocLabel } from "./labels.ts";

describe("defaultChapterLabel", () => {
  test("title-cases a hyphenated file name", () => {
    expect(defaultChapterLabel("text/chapter-18.xhtml")).toBe("Chapter 18");
  });

  test("falls back to 'Untitled' for a name with no words", () => {
    expect(defaultChapterLabel("text/-.xhtml")).toBe("Untitled");
  });
});

describe("deriveTocLabel", () => {
  test("prefers the document's own heading", () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h2>Chapter 5: The Fall</h2><p>x</p></body></html>`;
    expect(deriveTocLabel(markup, "text/chapter-5.xhtml")).toBe("Chapter 5: The Fall");
  });

  test("falls back to <title> when there is no heading", () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Author's Note</title></head><body><p>x</p></body></html>`;
    expect(deriveTocLabel(markup, "text/note.xhtml")).toBe("Author's Note");
  });

  test("skips the literal 'Chapter' placeholder chaptersToXHTML always emits", () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p>x</p></body></html>`;
    expect(deriveTocLabel(markup, "text/chapter-7.xhtml")).toBe("Chapter 7");
  });

  test("falls back to the file name when the document describes itself not at all", () => {
    expect(deriveTocLabel(`<html xmlns="http://www.w3.org/1999/xhtml"><body><p>x</p></body></html>`, "text/chapter-3.xhtml")).toBe("Chapter 3");
  });

  test("falls through a blank heading to the next source", () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Prologue</title></head><body><h2>   </h2><p>x</p></body></html>`;
    expect(deriveTocLabel(markup, "text/pro.xhtml")).toBe("Prologue");
  });
});

describe("chapterNumberFromLabel", () => {
  test("reads the number out of a chapter label", () => {
    expect(chapterNumberFromLabel("Chapter 12: The Storm")).toBe(12);
  });

  test("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(chapterNumberFromLabel("  chapter 3 ")).toBe(3);
  });

  test("returns 0 for a label that names no chapter number", () => {
    expect(chapterNumberFromLabel("Prologue")).toBe(0);
    expect(chapterNumberFromLabel("Chapter One")).toBe(0);
    expect(chapterNumberFromLabel("The 5th Chapter")).toBe(0);
  });
});
