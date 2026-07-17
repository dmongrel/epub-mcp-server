import { describe, expect, test } from "bun:test";
import { autoCloseVoidElements, validateXHTML } from "./validate.ts";

describe("validateXHTML", () => {
  test("accepts well-formed XHTML", () => {
    expect(() =>
      validateXHTML('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hello.</p></body></html>'),
    ).not.toThrow();
  });

  test("accepts an unclosed void element like <br>", () => {
    expect(() =>
      validateXHTML(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Line one<br>Line two</p></body></html>',
      ),
    ).not.toThrow();
  });

  test("accepts HTML named entities like &mdash;", () => {
    expect(() =>
      validateXHTML('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Em&mdash;dash.</p></body></html>'),
    ).not.toThrow();
  });

  test("rejects a mismatched closing tag", () => {
    expect(() =>
      validateXHTML('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Broken</div></body></html>'),
    ).toThrow();
  });

  test("rejects an unterminated tag", () => {
    expect(() => validateXHTML('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Unterminated')).toThrow();
  });
});

describe("autoCloseVoidElements", () => {
  test("self-closes a bare <br>", () => {
    expect(autoCloseVoidElements("<p>a<br>b</p>")).toBe("<p>a<br/>b</p>");
  });

  test("leaves an already-self-closed void element unchanged", () => {
    expect(autoCloseVoidElements("<p>a<br/>b</p>")).toBe("<p>a<br/>b</p>");
  });

  test("self-closes a void element with attributes", () => {
    expect(autoCloseVoidElements('<img src="cover.jpg" alt="Cover">')).toBe('<img src="cover.jpg" alt="Cover"/>');
  });

  test("leaves non-void elements unchanged", () => {
    expect(autoCloseVoidElements("<p>text</p>")).toBe("<p>text</p>");
  });
});
