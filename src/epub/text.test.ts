// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { plainText } from "./text.ts";

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

