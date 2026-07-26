// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { documentTitle, firstHeadingText, isCoverPage, plainText } from "./text.ts";

describe("plainText", () => {
  test("strips tags and keeps paragraph text", () => {
    expect(
      plainText('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hello, world.</p></body></html>'),
    ).toBe("Hello, world.");
  });

  test("separates paragraphs with a blank line", () => {
    expect(
      plainText(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>First.</p><p>Second.</p></body></html>',
      ),
    ).toBe("First.\n\nSecond.");
  });

  test("collapses internal whitespace within a paragraph", () => {
    expect(
      plainText(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Word   with\n  extra   spaces.</p></body></html>',
      ),
    ).toBe("Word with extra spaces.");
  });

  test("treats headings and list items as their own paragraphs", () => {
    expect(
      plainText(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><ul><li>Item A</li><li>Item B</li></ul></body></html>',
      ),
    ).toBe("Chapter One\n\nItem A\n\nItem B");
  });

  test("treats <br> as a line break, tolerating it unclosed", () => {
    expect(
      plainText('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Line one<br>Line two</p></body></html>'),
    ).toBe("Line one\n\nLine two");
  });

  test("resolves HTML named entities", () => {
    expect(
      plainText('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Em&mdash;dash.</p></body></html>'),
    ).toBe("Em—dash.");
  });

  test("drops inline markup but keeps its text", () => {
    expect(
      plainText(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Some <em>emphasized</em> and <strong>bold</strong> text.</p></body></html>',
      ),
    ).toBe("Some emphasized and bold text.");
  });

  test("returns an empty string for markup with no root element", () => {
    expect(plainText("")).toBe("");
  });

  test("ignores <head><title> text instead of leaking it as a leading paragraph", () => {
    expect(
      plainText(
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h2>Chapter 1</h2><p>Body text.</p></body></html>',
      ),
    ).toBe("Chapter 1\n\nBody text.");
  });
});

describe("firstHeadingText", () => {
  test("returns the first heading's text, whatever its level", () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>before</p><h3>Chapter 4: The Storm</h3><h1>Later</h1></body></html>`;
    expect(firstHeadingText(markup)).toBe("Chapter 4: The Storm");
  });

  test("collapses whitespace and strips inline markup inside the heading", () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><body><h2>Chapter\n  5:\t<em>The</em> Fall</h2></body></html>`;
    expect(firstHeadingText(markup)).toBe("Chapter 5: The Fall");
  });

  test("ignores a heading-shaped element in <head> and returns '' when <body> has none", () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 9</title></head><body><p>text</p></body></html>`;
    expect(firstHeadingText(markup)).toBe("");
  });

  test("returns '' for unparseable markup", () => {
    expect(firstHeadingText("")).toBe("");
  });
});

describe("documentTitle", () => {
  test("returns the <head><title> text", () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>The Storm</title></head><body><p>text</p></body></html>`;
    expect(documentTitle(markup)).toBe("The Storm");
  });

  test("ignores a <title> outside <head>, such as one inside an inline <svg>", () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><svg><title>Cover art</title></svg></body></html>`;
    expect(documentTitle(markup)).toBe("");
  });

  test("returns '' when there is no title at all", () => {
    expect(documentTitle(`<html xmlns="http://www.w3.org/1999/xhtml"><body><p>x</p></body></html>`)).toBe("");
  });
});

describe("isCoverPage", () => {
  test("recognizes a front cover page", () => {
    expect(isCoverPage(`<body><section epub:type="cover"><img src="c.jpg"/></section></body>`)).toBe(true);
  });

  test("recognizes a back cover page by its multi-token epub:type", () => {
    expect(isCoverPage(`<body><section epub:type="backmatter cover"><img src="b.jpg"/></section></body>`)).toBe(true);
  });

  test("does not match a type that merely contains 'cover' as a substring", () => {
    expect(isCoverPage(`<body><section epub:type="discover"><p>x</p></section></body>`)).toBe(false);
  });

  test("returns false for an ordinary chapter", () => {
    expect(isCoverPage(`<body><h2>Chapter 1</h2><p>text</p></body>`)).toBe(false);
  });
});

