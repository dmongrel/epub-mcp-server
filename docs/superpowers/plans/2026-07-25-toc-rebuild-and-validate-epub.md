# TOC Rebuild, Blank-Chapter Removal, and `validate_epub` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `convert_manuscript` rebuild the table of contents from the spine, stop `save_epub` from injecting a blank placeholder chapter, and add a read-only `validate_epub` tool that reports cross-structure misalignment with actionable remedies.

**Architecture:** Label derivation and prose-spine traversal move into the `src/epub/` layer as pure helpers (`labels.ts`, additions to `text.ts` and `resolve.ts`) so both the TOC rebuild and the validator share one definition of "chapter N is this document." `rebuildToc` lives in `src/tools/nav-rebuild.ts` and reuses the existing `syncNavRender` to keep the nav document and legacy NCX in lockstep. The validator is a registry of pure check functions in `src/tools/validate-checks.ts` behind a thin MCP tool in `src/tools/validate-epub.ts`.

**Tech Stack:** TypeScript (ESM, `.ts` extensions in imports), Bun (`bun test`, `bun run typecheck`), `@modelcontextprotocol/sdk`, `@xmldom/xmldom`, `fflate`.

**Spec:** `docs/superpowers/specs/2026-07-25-toc-rebuild-and-validate-epub-design.md`

## Global Constraints

- Every new file starts with the two-line SPDX header used by every existing source file:
  ```ts
  // SPDX-FileCopyrightText: 2026 Joel L. Caesar
  // SPDX-License-Identifier: MIT
  ```
- All relative imports carry the `.ts` extension (`./labels.ts`, `../epub/text.ts`). This is a hard requirement of the project's ESM config.
- Tests use `bun:test` (`import { describe, expect, test } from "bun:test";`) and live beside the file they test as `<name>.test.ts`.
- Layering: `src/epub/` must never import from `src/tools/`. `src/tools/` may import from `src/epub/`.
- Tools throw `Error` on invalid input; they never return an error-shaped success result.
- Every tool handler returns `{ content: [{ type: "text", text: summary }], structuredContent: result }`.
- Run `bun test` and `bun run typecheck` before every commit. Both must pass.
- `newEpub(title, author)` from `src/epub/new-epub.ts` is the standard in-memory fixture for unit tests. Its package has `baseDir: ""`, its navigation document is at `nav.xhtml`, and it has no NCX and no content documents.

### Deviation from the spec, deliberate

The spec placed `deriveTocLabel` in `src/tools/nav-rebuild.ts`, `isCoverPage` in `src/epub/text.ts`, and the checks in `src/epub/checks.ts`. The checks need `deriveTocLabel`, `defaultChapterLabel`, and prose-spine traversal, and `checks.ts` also needs `primaryNavigation`, which lives in `src/tools/get-navigation.ts`. To respect the layering constraint above:

- `deriveTocLabel`, `defaultChapterLabel`, and `chapterNumberFromLabel` go in a new `src/epub/labels.ts`.
- Prose-spine traversal goes in `src/epub/resolve.ts` as `proseSpineDocuments`.
- The checks go in `src/tools/validate-checks.ts`, not `src/epub/checks.ts`.

Everything else follows the spec as written.

## File Structure

**Create:**
- `src/epub/labels.ts` — `defaultChapterLabel` (moved from `nav-sync.ts`), `deriveTocLabel`, `chapterNumberFromLabel`
- `src/epub/labels.test.ts`
- `src/tools/nav-rebuild.ts` — `rebuildToc`
- `src/tools/nav-rebuild.test.ts`
- `src/tools/validate-checks.ts` — `ValidateEpubFinding`, `Check`, all 16 check functions, `CHECKS` registry
- `src/tools/validate-checks.test.ts`
- `src/tools/validate-epub.ts` — the MCP tool
- `src/tools/validate-epub.test.ts`

**Modify:**
- `src/epub/text.ts` — add `firstHeadingText`, `documentTitle`, `isCoverPage` (moved in from `find-text.ts`); refactor `plainText` onto a shared `parseRoot`
- `src/epub/text.test.ts` — tests for the three new exports
- `src/epub/resolve.ts` — add `proseSpineDocuments`
- `src/epub/resolve.test.ts` — tests for it
- `src/tools/find-text.ts` — delete local `isCoverPage`, import it from `../epub/text.ts`
- `src/tools/nav-sync.ts` — delete `defaultChapterLabel`, re-export it from `../epub/labels.ts` for existing importers
- `src/tools/nav-sync.test.ts` — no change needed (the re-export keeps its import valid)
- `src/tools/convert-manuscript.ts` — call `rebuildToc`, add `tocRebuilt`, rewrite `existingChaptersByNumber`
- `src/tools/convert-manuscript.test.ts` — new cases
- `src/tools/save-epub.ts` — delete `ensureAtLeastOneChapter` / `defaultBlankChapterId` and the `addedBlankChapter` plumbing
- `src/tools/save-epub.test.ts` — rewrite the three blank-chapter tests
- `src/tools/new-epub.ts` — correct the registered description
- `src/index.ts` — import `./tools/validate-epub.ts`
- `README.md` — tool count 27 → 28, add the `validate_epub` entry
- `CHANGELOG.md`, `package.json` — version bump

---

### Task 1: Text helpers for label derivation

**Files:**
- Modify: `src/epub/text.ts`
- Modify: `src/tools/find-text.ts:62-80` (delete local `isCoverPage`, import instead)
- Test: `src/epub/text.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `firstHeadingText(markup: string): string`
  - `documentTitle(markup: string): string`
  - `isCoverPage(markup: string): boolean`
  - all exported from `src/epub/text.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `src/epub/text.test.ts`:

```ts
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
```

Add the three names to the file's existing import from `./text.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/text.test.ts`
Expected: FAIL — `firstHeadingText`, `documentTitle`, and `isCoverPage` are not exported from `./text.ts`.

- [ ] **Step 3: Implement the helpers**

In `src/epub/text.ts`, add below the existing `findElementByLocalName`:

```ts
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
```

Then refactor `plainText`'s opening onto `parseRoot`, replacing its own try/catch and `documentElement` check:

```ts
export function plainText(markup: string): string {
  const root = parseRoot(markup);
  if (!root) return "";

  // Only the <body> is readable content — walking the whole document would
  // also pick up <head><title> text (and any future <head> text content) as
  // a spurious leading "paragraph" with no block-boundary of its own to
  // separate it from the real content. Fall back to root for malformed
  // markup with no <body> at all, rather than returning nothing.
  const body = findElementByLocalName(root, "body") ?? root;
  // ... rest of the existing body is unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/text.test.ts`
Expected: PASS, including every pre-existing `plainText` test.

- [ ] **Step 5: Point find-text.ts at the shared copy**

In `src/tools/find-text.ts`, delete the local `isCoverPage` function and its doc comment, and change the existing text import to:

```ts
import { isCoverPage, plainText } from "../epub/text.ts";
```

- [ ] **Step 6: Verify nothing regressed**

Run: `bun test && bun run typecheck`
Expected: PASS — `find-text.test.ts`'s cover-exclusion case still passes against the moved function.

- [ ] **Step 7: Commit**

```bash
git add src/epub/text.ts src/epub/text.test.ts src/tools/find-text.ts
git commit -m "Add firstHeadingText/documentTitle and share isCoverPage from text.ts"
```

---

### Task 2: Chapter label derivation

**Files:**
- Create: `src/epub/labels.ts`
- Modify: `src/tools/nav-sync.ts` (delete `defaultChapterLabel`, re-export it)
- Test: `src/epub/labels.test.ts`

**Interfaces:**
- Consumes: `firstHeadingText`, `documentTitle` from `src/epub/text.ts` (Task 1).
- Produces:
  - `defaultChapterLabel(archivePath: string): string`
  - `deriveTocLabel(markup: string, archivePath: string): string`
  - `chapterNumberFromLabel(label: string): number` — returns `0` when the label names no chapter number
  - all from `src/epub/labels.ts`. `src/tools/nav-sync.ts` re-exports `defaultChapterLabel` so its existing importers and tests are unaffected.

- [ ] **Step 1: Write the failing tests**

Create `src/epub/labels.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/labels.test.ts`
Expected: FAIL — module `./labels.ts` does not exist.

- [ ] **Step 3: Create `src/epub/labels.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * How a chapter names itself. Every structure in an EPUB that has to agree
 * about "which chapter is this" — the table of contents rebuilt by
 * rebuildToc, convert_manuscript's matching of source fragments to existing
 * chapters, and validate_epub's alignment checks — derives that name here,
 * so none of them can drift apart by disagreeing about the rules.
 */
import { documentTitle, firstHeadingText } from "./text.ts";

/**
 * The literal <title> chaptersToXHTML hardcodes into every document it
 * generates. It names no particular chapter, so deriveTocLabel treats it as
 * absent rather than labelling half a book "Chapter".
 */
const GENERATED_TITLE_PLACEHOLDER = "Chapter";

const CHAPTER_NUMBER_PATTERN = /^chapter\s+(\d+)\b/i;

/**
 * Derives a human-readable toc label from an archive path's file name, e.g.
 * "text/chapter-18.xhtml" -> "Chapter 18". The last resort, for a document
 * that describes itself neither by a heading nor by a title.
 */
export function defaultChapterLabel(archivePath: string): string {
  let name = archivePath;
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot > 0) name = name.slice(0, dot);
  name = name.replace(/[-_]/g, " ");
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Untitled";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The table-of-contents label for a content document, in descending order of
 * how much the document itself tells us: its first heading, then its <head>
 * <title> (unless that's the generated placeholder), then its file name.
 * Markup is the source of truth, so a chapter retitled in its own text gets
 * a corrected toc entry the next time the toc is rebuilt.
 */
export function deriveTocLabel(markup: string, archivePath: string): string {
  const heading = firstHeadingText(markup);
  if (heading !== "") return heading;
  const title = documentTitle(markup);
  if (title !== "" && title !== GENERATED_TITLE_PLACEHOLDER) return title;
  return defaultChapterLabel(archivePath);
}

/**
 * Extracts the chapter number from a label like "Chapter 12: The Storm",
 * or 0 if the label doesn't open with one. Only leading "Chapter <digits>"
 * counts — spelled-out numbers and mid-label digits are deliberately not
 * matched, since guessing there would produce false alignment failures.
 */
export function chapterNumberFromLabel(label: string): number {
  const m = CHAPTER_NUMBER_PATTERN.exec(label.trim());
  if (!m) return 0;
  return Number.parseInt(m[1]!, 10);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/labels.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove the duplicate from `nav-sync.ts`**

In `src/tools/nav-sync.ts`, delete the `defaultChapterLabel` function and its doc comment, and add near the other imports:

```ts
import { defaultChapterLabel } from "../epub/labels.ts";

// Re-exported so existing importers (and nav-sync.test.ts) keep reaching it
// here, while the single definition lives in the epub layer where the
// validator can use it too without importing from src/tools/.
export { defaultChapterLabel };
```

- [ ] **Step 6: Verify nothing regressed**

Run: `bun test && bun run typecheck`
Expected: PASS — `nav-sync.test.ts`'s `defaultChapterLabel` cases still pass through the re-export.

- [ ] **Step 7: Commit**

```bash
git add src/epub/labels.ts src/epub/labels.test.ts src/tools/nav-sync.ts
git commit -m "Add labels.ts with shared chapter label derivation"
```

---

### Task 3: Prose spine traversal

**Files:**
- Modify: `src/epub/resolve.ts`
- Test: `src/epub/resolve.test.ts`

**Interfaces:**
- Consumes: `isCoverPage` from `src/epub/text.ts` (Task 1).
- Produces: `proseSpineDocuments(e: Epub, pkg: Package): ProseDocument[]` where `interface ProseDocument { archivePath: string; markup: string }`, both exported from `src/epub/resolve.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `src/epub/resolve.test.ts` (add `proseSpineDocuments` to its existing import from `./resolve.ts`, and `newEpub` from `./new-epub.ts` if not already imported):

```ts
describe("proseSpineDocuments", () => {
  /** Adds a content document to e with a manifest item and a spine entry at the end, mirroring what insertChapter does. */
  function addDoc(e: ReturnType<typeof newEpub>, archivePath: string, opfId: string, markup: string): void {
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/${opfId}`, href: archivePath, mediaType: "application/xhtml+xml", properties: [], fallback: "", mediaOverlay: "" });
    pkg.spine.itemRefs.push({ id: "", idRef: opfId, linear: true, properties: [] });
    e.contentDocuments[archivePath] = { id: archivePath, mediaType: "application/xhtml+xml", markup };
  }

  test("returns prose documents in spine order", () => {
    const e = newEpub("Prose Order", "Author");
    addDoc(e, "text/b.xhtml", "b", "<body><h2>Chapter 2</h2></body>");
    addDoc(e, "text/a.xhtml", "a", "<body><h2>Chapter 1</h2></body>");

    expect(proseSpineDocuments(e, primaryPackage(e)!).map((d) => d.archivePath)).toEqual(["text/b.xhtml", "text/a.xhtml"]);
  });

  test("skips cover pages", () => {
    const e = newEpub("Prose Covers", "Author");
    addDoc(e, "text/cover.xhtml", "cov", `<body><section epub:type="cover"><img src="c.jpg"/></section></body>`);
    addDoc(e, "text/ch1.xhtml", "ch1", "<body><h2>Chapter 1</h2></body>");
    addDoc(e, "text/back.xhtml", "back", `<body><section epub:type="backmatter cover"><img src="b.jpg"/></section></body>`);

    expect(proseSpineDocuments(e, primaryPackage(e)!).map((d) => d.archivePath)).toEqual(["text/ch1.xhtml"]);
  });

  test("skips spine entries that resolve to no content document", () => {
    const e = newEpub("Prose Dangling", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", "<body><h2>Chapter 1</h2></body>");
    const pkg = primaryPackage(e)!;
    pkg.spine.itemRefs.push({ id: "", idRef: "ghost", linear: true, properties: [] });

    expect(proseSpineDocuments(e, pkg).map((d) => d.archivePath)).toEqual(["text/ch1.xhtml"]);
  });

  test("carries each document's markup alongside its path", () => {
    const e = newEpub("Prose Markup", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", "<body><h2>Chapter 1: Dawn</h2></body>");

    expect(proseSpineDocuments(e, primaryPackage(e)!)[0]?.markup).toContain("Chapter 1: Dawn");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/resolve.test.ts`
Expected: FAIL — `proseSpineDocuments` is not exported from `./resolve.ts`.

- [ ] **Step 3: Implement it**

At the end of `src/epub/resolve.ts`, and add `import { isCoverPage } from "./text.ts";` at the top:

```ts
/** One prose content document, located and loaded — what proseSpineDocuments yields. */
export interface ProseDocument {
  /** The document's archive path, which keys Epub.contentDocuments. */
  archivePath: string;
  markup: string;
}

/**
 * Every prose content document in pkg's spine reading order: each itemref
 * resolved through the manifest to a content document, with cover pages and
 * anything that isn't a content document (a dangling idref, an image, an
 * NCX) skipped.
 *
 * This is the canonical answer to "what are this book's chapters, in
 * order". rebuildToc builds the table of contents from it, validate_epub
 * checks the table of contents against it, and find_text numbers chapters
 * the same way — so a book's Nth chapter means the same thing everywhere.
 */
export function proseSpineDocuments(e: Epub, pkg: Package): ProseDocument[] {
  const out: ProseDocument[] = [];
  for (const ref of pkg.spine.itemRefs) {
    const item = manifestItemById(pkg, ref.idRef);
    if (!item) continue;
    const archivePath = resolveHref(pkg, item.href);
    const doc = e.contentDocuments[archivePath];
    if (!doc) continue;
    if (isCoverPage(doc.markup)) continue;
    out.push({ archivePath, markup: doc.markup });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/resolve.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/epub/resolve.ts src/epub/resolve.test.ts
git commit -m "Add proseSpineDocuments to resolve.ts"
```

---

### Task 4: `rebuildToc`

**Files:**
- Create: `src/tools/nav-rebuild.ts`
- Test: `src/tools/nav-rebuild.test.ts`

**Interfaces:**
- Consumes: `deriveTocLabel` from `src/epub/labels.ts` (Task 2), `proseSpineDocuments` from `src/epub/resolve.ts` (Task 3), and the existing `primaryNavigation`, `findOrCreateNavList`, `renumberNavPoints`, `syncNavRender`.
- Produces: `rebuildToc(e: Epub, pkg: Package): boolean` from `src/tools/nav-rebuild.ts`. Returns `false` (no throw) when the book has no EPUB 3 navigation document.

- [ ] **Step 1: Write the failing tests**

Create `src/tools/nav-rebuild.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { rebuildToc } from "./nav-rebuild.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { Epub } from "../epub/types.ts";

/** Adds a content document to e with a manifest item and a spine entry at the given index (default: the end). */
function addDoc(e: Epub, archivePath: string, opfId: string, markup: string, at?: number): void {
  const pkg = primaryPackage(e)!;
  pkg.manifest.items.push({ id: `${pkg.manifest.id}/${opfId}`, href: archivePath, mediaType: "application/xhtml+xml", properties: [], fallback: "", mediaOverlay: "" });
  const ref = { id: "", idRef: opfId, linear: true, properties: [] };
  if (at === undefined) pkg.spine.itemRefs.push(ref);
  else pkg.spine.itemRefs.splice(at, 0, ref);
  e.contentDocuments[archivePath] = { id: archivePath, mediaType: "application/xhtml+xml", markup };
}

function tocOf(e: Epub) {
  return e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
}

function chapterMarkup(heading: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h2>${heading}</h2><p>Text.</p></body></html>`;
}

describe("rebuildToc", () => {
  test("replaces the toc with one flat entry per prose document, in spine order", () => {
    const e = newEpub("Rebuild Order", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1: Dawn"));
    addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2: Dusk"));

    expect(rebuildToc(e, primaryPackage(e)!)).toBe(true);

    const toc = tocOf(e);
    expect(toc.items.map((i) => [i.label, i.href])).toEqual([
      ["Chapter 1: Dawn", "text/ch1.xhtml"],
      ["Chapter 2: Dusk", "text/ch2.xhtml"],
    ]);
    expect(toc.items.every((i) => i.children.length === 0)).toBe(true);
  });

  test("discards stale entries left by incremental syncing, including a chapter appended after a back cover", () => {
    const e = newEpub("Rebuild Stale", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));
    addDoc(e, "text/back.xhtml", "back", `<body><section epub:type="backmatter cover"><img src="b.jpg"/></section></body>`);
    // Inserted before the back cover in the spine, but appended last in the
    // toc — exactly the drift syncTocOnChapterCreate produces.
    addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2"), 1);
    const toc = tocOf(e);
    toc.items = [
      { id: "", label: "Chapter 1", href: "text/ch1.xhtml", type: "", children: [] },
      { id: "", label: "Back Cover", href: "text/back.xhtml", type: "", children: [] },
      { id: "", label: "Chapter 2", href: "text/ch2.xhtml", type: "", children: [] },
    ];

    rebuildToc(e, primaryPackage(e)!);

    expect(tocOf(e).items.map((i) => i.href)).toEqual(["text/ch1.xhtml", "text/ch2.xhtml"]);
  });

  test("picks up a chapter's retitled heading", () => {
    const e = newEpub("Rebuild Retitle", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1: The New Title"));
    tocOf(e).items = [{ id: "", label: "Chapter 1: The Old Title", href: "text/ch1.xhtml", type: "", children: [] }];

    rebuildToc(e, primaryPackage(e)!);

    expect(tocOf(e).items[0]?.label).toBe("Chapter 1: The New Title");
  });

  test("re-renders the navigation document's markup to match", () => {
    const e = newEpub("Rebuild Markup", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1: Dawn"));

    rebuildToc(e, primaryPackage(e)!);

    expect(e.navigation["nav.xhtml"]!.markup).toContain("Chapter 1: Dawn");
    expect(e.navigation["nav.xhtml"]!.markup).toContain('href="text/ch1.xhtml"');
  });

  test("regenerates the legacy NCX from the rebuilt toc when the book has one", () => {
    const e = newEpub("Rebuild NCX", "Author");
    const pkg = primaryPackage(e)!;
    pkg.spine.tocRef = "ncx";
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ncx`, href: "toc.ncx", mediaType: "application/x-dtbncx+xml", properties: [], fallback: "", mediaOverlay: "" });
    e.nCXs["toc.ncx"] = { id: "toc.ncx", markup: "", navMap: [] };
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1: Dawn"));

    rebuildToc(e, pkg);

    expect(e.nCXs["toc.ncx"]!.navMap.map((p) => p.label)).toEqual(["Chapter 1: Dawn"]);
    expect(e.nCXs["toc.ncx"]!.markup).toContain("Chapter 1: Dawn");
  });

  test("leaves other nav lists such as landmarks untouched", () => {
    const e = newEpub("Rebuild Landmarks", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));
    const nav = e.navigation["nav.xhtml"]!;
    nav.lists.push({ id: `${nav.id}#landmarks`, type: "landmarks", heading: "Landmarks", items: [{ id: "", label: "Start", href: "text/ch1.xhtml", type: "bodymatter", children: [] }] });

    rebuildToc(e, primaryPackage(e)!);

    const landmarks = nav.lists.find((l) => l.type === "landmarks")!;
    expect(landmarks.items.map((i) => i.label)).toEqual(["Start"]);
  });

  test("assigns collision-free positional ids to the rebuilt entries", () => {
    const e = newEpub("Rebuild Ids", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));
    addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2"));

    rebuildToc(e, primaryPackage(e)!);

    const toc = tocOf(e);
    expect(toc.items.map((i) => i.id)).toEqual([`${toc.id}/item[0]`, `${toc.id}/item[1]`]);
  });

  test("returns false, changing nothing, when the book has no EPUB 3 navigation document", () => {
    const e = newEpub("Rebuild No Nav", "Author");
    const pkg = primaryPackage(e)!;
    delete e.navigation["nav.xhtml"];
    const navManifestItem = pkg.manifest.items.find((i) => i.properties.includes("nav"));
    if (navManifestItem) navManifestItem.properties = [];
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));

    expect(rebuildToc(e, pkg)).toBe(false);
  });

  test("produces an empty toc for a book with no prose documents", () => {
    const e = newEpub("Rebuild Empty", "Author");

    expect(rebuildToc(e, primaryPackage(e)!)).toBe(true);
    expect(tocOf(e).items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/nav-rebuild.test.ts`
Expected: FAIL — module `./nav-rebuild.ts` does not exist.

- [ ] **Step 3: Create `src/tools/nav-rebuild.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * Rebuilding the table of contents from scratch, as opposed to nav-sync.ts's
 * incremental append/remove.
 *
 * The incremental path is right for a single edit_chapter call, where the
 * user may have curated the toc with edit_navigation and one new chapter
 * shouldn't discard that work. It is wrong for convert_manuscript, which
 * loads a whole new book's worth of text: there the manuscript is the source
 * of truth, and any toc predating it is stale by definition. Incremental
 * syncing also drifts — syncTocOnChapterCreate appends to the end of the toc
 * while insertChapter inserts into the spine before the back cover, so the
 * two orders diverge the moment a book has a back cover.
 *
 * rebuildToc discards the "toc" list wholesale and derives a new flat one
 * from the spine. Manual nesting and hand-edited labels in that list do not
 * survive; landmarks, page-list, and custom nav lists are untouched.
 *
 * Like nav-sync.ts's helpers, this is deliberately best-effort — a book with
 * no EPUB 3 navigation document has nothing to rebuild, which is not an
 * error for the conversion that triggered it. primaryNavigation's throw is
 * caught and converted to a false return rather than propagated.
 */
import { primaryNavigation } from "./get-navigation.ts";
import { findOrCreateNavList, renumberNavPoints } from "./edit-navigation.ts";
import { syncNavRender } from "./nav-sync.ts";
import { deriveTocLabel } from "../epub/labels.ts";
import { proseSpineDocuments } from "../epub/resolve.ts";
import type { Epub, NavList, Navigation, Package } from "../epub/types.ts";

/**
 * Replaces the primary navigation document's "toc" list with one flat entry
 * per prose content document, in spine reading order, each labelled from the
 * document's own markup. Re-renders the navigation document and regenerates
 * the legacy NCX to match. Returns whether the rebuild happened.
 */
export function rebuildToc(e: Epub, pkg: Package): boolean {
  let nav: Navigation;
  try {
    nav = primaryNavigation(e, pkg);
  } catch {
    return false;
  }

  let list: NavList;
  try {
    list = findOrCreateNavList(nav, "toc", "create");
  } catch {
    // Unreachable while findOrCreateNavList only throws for a non-"create"
    // third argument; kept as defensive symmetry with nav-sync.ts.
    return false;
  }

  list.items = proseSpineDocuments(e, pkg).map((doc) => ({
    id: "",
    label: deriveTocLabel(doc.markup, doc.archivePath),
    href: doc.archivePath,
    type: "",
    children: [],
  }));

  renumberNavPoints(list.id, list.items);
  syncNavRender(e, pkg, nav, list);
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/nav-rebuild.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/nav-rebuild.ts src/tools/nav-rebuild.test.ts
git commit -m "Add rebuildToc to regenerate the toc from the spine"
```

---

### Task 5: Wire the rebuild into `convert_manuscript`

**Files:**
- Modify: `src/tools/convert-manuscript.ts`
- Test: `src/tools/convert-manuscript.test.ts`

**Interfaces:**
- Consumes: `rebuildToc` (Task 4), `chapterNumberFromLabel` and `deriveTocLabel` (Task 2), `proseSpineDocuments` (Task 3).
- Produces: `ConvertManuscriptResult` gains `tocRebuilt: boolean`. `existingChaptersByNumber(e, pkg)` keeps its `Map<number, string>` signature but now reads headings instead of toc labels. `MANUSCRIPT_TOC_CHAPTER_LABEL` is deleted, replaced by `chapterNumberFromLabel`.

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/convert-manuscript.test.ts`, following the file's existing setup conventions for creating a temp EPUB and a source file:

```ts
describe("convert_manuscript toc rebuild", () => {
  test("leaves the toc in spine order and reports tocRebuilt", async () => {
    const { path, dir } = await newTestEpub("Toc Rebuild");
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "Chapter 1: Dawn\n\nFirst.\n\nChapter 2: Dusk\n\nSecond.\n", "utf-8");

    const res = await handleConvertManuscript(fakeServer, { path, sourcePath });

    expect((res.structuredContent as { tocRebuilt: boolean }).tocRebuilt).toBe(true);
    const e = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(e)!;
    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items.map((i) => i.href)).toEqual(proseSpineDocuments(e, pkg).map((d) => d.archivePath));
  });

  test("a replaced chapter's new title reaches its toc entry", async () => {
    const { path, dir } = await newTestEpub("Toc Retitle");
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "Chapter 1: Old Title\n\nFirst.\n", "utf-8");
    await handleConvertManuscript(fakeServer, { path, sourcePath });

    await writeFile(sourcePath, "Chapter 1: New Title\n\nFirst, revised.\n", "utf-8");
    await handleConvertManuscript(fakeServer, { path, sourcePath });

    const e = epubCache.get(resolve(path))!;
    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(1);
    expect(toc.items[0]?.label).toBe("Chapter 1: New Title");
  });

  test("matches existing chapters by their headings even when toc labels are stale", async () => {
    const { path, dir } = await newTestEpub("Toc Stale Labels");
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "Chapter 1\n\nFirst.\n", "utf-8");
    await handleConvertManuscript(fakeServer, { path, sourcePath });

    // Simulate a toc gone stale — edit_navigation renamed the entry so it no
    // longer names a chapter number at all.
    const e = epubCache.get(resolve(path))!;
    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    toc.items[0]!.label = "Opening";

    await writeFile(sourcePath, "Chapter 1\n\nFirst, revised.\n", "utf-8");
    const res = await handleConvertManuscript(fakeServer, { path, sourcePath });

    const result = res.structuredContent as { createdIds?: string[]; replacedIds?: string[] };
    expect(result.replacedIds).toHaveLength(1);
    expect(result.createdIds).toBeUndefined();
    expect(Object.keys(epubCache.get(resolve(path))!.contentDocuments)).toHaveLength(1);
  });

  test("reports tocRebuilt false for a book with no navigation document", async () => {
    const { path, dir } = await newTestEpub("Toc No Nav");
    const e = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(e)!;
    delete e.navigation["nav.xhtml"];
    const navItem = pkg.manifest.items.find((i) => i.properties.includes("nav"));
    if (navItem) navItem.properties = [];
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "Chapter 1\n\nFirst.\n", "utf-8");

    const res = await handleConvertManuscript(fakeServer, { path, sourcePath });

    expect((res.structuredContent as { tocRebuilt: boolean }).tocRebuilt).toBe(false);
  });
});
```

If `newTestEpub` and `fakeServer` are named differently in the existing file, reuse whatever it already defines rather than adding new helpers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/convert-manuscript.test.ts`
Expected: FAIL — `tocRebuilt` is `undefined`, and the stale-label test creates a duplicate chapter instead of replacing.

- [ ] **Step 3: Rewrite `existingChaptersByNumber` and call `rebuildToc`**

In `src/tools/convert-manuscript.ts`:

Replace the `primaryNavigation` import with the new helpers, and add `rebuildToc`:

```ts
import { rebuildToc } from "./nav-rebuild.ts";
import { chapterNumberFromLabel, deriveTocLabel } from "../epub/labels.ts";
import { primaryPackage, proseSpineDocuments } from "../epub/resolve.ts";
```

Delete the `MANUSCRIPT_TOC_CHAPTER_LABEL` constant and replace `existingChaptersByNumber` with:

```ts
/**
 * Maps each chapter number already in the book to the archive path of the
 * content document carrying it, read from each prose document's own heading
 * in spine order.
 *
 * Deliberately not read from the table of contents: this call rebuilds the
 * toc at the end, so treating it as an input too would make it both cause
 * and effect, and it can be stale in the meantime — edit_chapter's "edit"
 * action changes a chapter's heading without touching its toc label, and
 * edit_navigation can rename an entry to anything at all. The spine plus
 * each document's markup is the only source of truth here.
 *
 * Documents whose heading names no chapter number are omitted, so unnumbered
 * front matter never claims a number a manuscript fragment might match.
 */
function existingChaptersByNumber(e: Epub, pkg: Package): Map<number, string> {
  const result = new Map<number, string>();
  for (const doc of proseSpineDocuments(e, pkg)) {
    const number = chapterNumberFromLabel(deriveTocLabel(doc.markup, doc.archivePath));
    if (number > 0 && !result.has(number)) result.set(number, doc.archivePath);
  }
  return result;
}
```

Add `tocRebuilt` to the result interface:

```ts
interface ConvertManuscriptResult {
  path: string;
  sourcePath: string;
  chaptersFound: number;
  createdIds?: string[];
  replacedIds?: string[];
  leftoverIds?: string[];
  leftoverAction?: string;
  tocRebuilt: boolean;
}
```

In `handleConvertManuscript`, after the leftover handling and before `epubCache.markDirty(abs)`:

```ts
  // Rebuilt once, at the end, rather than per chapter: the toc is a pure
  // function of the finished spine, and every create above has already
  // appended its own (now superseded) entry via insertChapter.
  const tocRebuilt = rebuildToc(e, pkg);

  epubCache.markDirty(abs);
```

Add `tocRebuilt` to the `result` object literal, and extend the summary immediately before the `save_epub` sentence:

```ts
  summary += tocRebuilt
    ? " The table of contents was rebuilt from the spine."
    : " This book has no navigation document, so no table of contents was rebuilt.";
  summary += ` Call save_epub to persist this to disk.${evictionNote(eviction)}`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/convert-manuscript.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Update the tool's registered description**

In the `registerTool` call at the bottom of `src/tools/convert-manuscript.ts`, replace the paragraph beginning "If a parsed chapter's number matches an existing chapter" with:

```
"If a parsed chapter's number matches an existing chapter already in the book — matched against the " +
  "chapter number in each existing chapter's own heading, in spine order, not against its " +
  "table-of-contents label — that existing content document's markup is replaced in place rather than " +
  "duplicated. Numbers not already present are appended as new chapters, manifest and spine wiring " +
  "included, same as edit_chapter's create action.\n\n" +
"When every chapter has been written, the table of contents is rebuilt from scratch: one flat entry " +
  "per chapter, in spine reading order, each labelled from that chapter's own heading (falling back to " +
  "its <title>, then to its file name). Front and back cover pages are skipped. The legacy EPUB 2 NCX, " +
  "if the book has one, is regenerated to match, and the landmarks and page-list navs are left alone. " +
  "Because the rebuild is wholesale, any manual nesting or renaming previously applied to the table of " +
  "contents with edit_navigation is discarded — reapply it after converting, or use edit_chapter " +
  "instead of convert_manuscript when you want incremental changes that preserve a curated table of " +
  "contents. Reported as tocRebuilt, which is false only when the book has no navigation document at " +
  "all.\n\n" +
```

- [ ] **Step 6: Verify and commit**

Run: `bun test && bun run typecheck`
Expected: PASS.

```bash
git add src/tools/convert-manuscript.ts src/tools/convert-manuscript.test.ts
git commit -m "Rebuild the toc from the spine at the end of convert_manuscript"
```

---

### Task 6: Stop `save_epub` injecting a blank chapter

**Files:**
- Modify: `src/tools/save-epub.ts`
- Modify: `src/tools/new-epub.ts` (registered description only)
- Test: `src/tools/save-epub.test.ts:70-115`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SaveEpubResult` loses its `addedBlankChapter?: string` field. `ensureAtLeastOneChapter` and `defaultBlankChapterId` cease to exist.

- [ ] **Step 1: Rewrite the failing tests**

In `src/tools/save-epub.test.ts`, delete these three tests entirely:
- `"marks the original dirty when saving to a different 'as' path auto-adds a blank chapter"` (line ~70)
- `"adds a blank chapter automatically when saving a book with none"` (line ~89)
- `"does not add a blank chapter when one already exists"` (line ~104)

Replace them with:

```ts
  test("saves a book with no chapters as-is, adding nothing", async () => {
    const { path } = await newTestEpub("No Auto Chapter");

    const res = await handleSaveEpub(fakeServer, { path });

    expect(res.structuredContent).not.toHaveProperty("addedBlankChapter");
    const e = epubCache.get(resolve(path))!;
    expect(Object.keys(e.contentDocuments)).toHaveLength(0);
    expect(primaryPackage(e)!.spine.itemRefs).toHaveLength(0);
    expect(res.content[0]!.text).not.toContain("blank");
  });

  test("a saved-then-reloaded empty book still has no chapters", async () => {
    const { path } = await newTestEpub("No Auto Chapter Roundtrip");
    await handleSaveEpub(fakeServer, { path });
    await handleCloseEpub(fakeServer, { path });

    await handleReadEpub(fakeServer, { path });

    expect(Object.keys(epubCache.get(resolve(path))!.contentDocuments)).toHaveLength(0);
  });

  test("converting a manuscript into a freshly saved new book puts chapter 1 at chapter-1.xhtml", async () => {
    const { path, dir } = await newTestEpub("No Stub Collision");
    // The bug this guards: save_epub used to inject text/chapter-1.xhtml
    // here, so the real chapter 1 landed at chapter-1-2.xhtml with a blank
    // stub left at the head of the book and its table of contents.
    await handleSaveEpub(fakeServer, { path });
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "Chapter 1: Dawn\n\nFirst.\n\nChapter 2: Dusk\n\nSecond.\n", "utf-8");

    await handleConvertManuscript(fakeServer, { path, sourcePath });

    const e = epubCache.get(resolve(path))!;
    expect(Object.keys(e.contentDocuments).sort()).toEqual(["text/chapter-1.xhtml", "text/chapter-2.xhtml"]);
    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items.map((i) => i.label)).toEqual(["Chapter 1: Dawn", "Chapter 2: Dusk"]);
  });
```

Add whatever imports these need (`handleConvertManuscript`, `handleCloseEpub`, `handleReadEpub`, `primaryPackage`, `writeFile`, `join`) using the same import style the file already uses.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/save-epub.test.ts`
Expected: FAIL — the empty book still gains `text/chapter-1.xhtml`, and the collision test finds `text/chapter-1-2.xhtml`.

- [ ] **Step 3: Delete the injection**

In `src/tools/save-epub.ts`:

Delete the `ensureAtLeastOneChapter` and `defaultBlankChapterId` functions and their doc comments. Delete `addedBlankChapter?: string;` from `SaveEpubResult`. Delete the now-unused imports (`insertChapter`, `defaultChapterLabel`, `archiveIdInUse`, `primaryPackage`, and `Epub` if nothing else uses it — let `bun run typecheck` confirm).

Replace the body of `handleSaveEpub` from the `dest` line onward with:

```ts
  const dest = args.as?.trim() ? resolve(args.as) : abs;

  await writeEpub(e, dest);
  if (dest === abs) epubCache.clearDirty(abs);

  const result: SaveEpubResult = { savedTo: dest };
  const summary = `Saved ${JSON.stringify(dest)}.`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}
```

The `else if (addedChapterId) epubCache.markDirty(abs)` branch goes with it: it existed only to record the chapter the save had just invented, and saving to a different `as` path no longer mutates the cached book at all.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/save-epub.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Correct both tool descriptions**

In `src/tools/save-epub.ts`'s `registerTool` call, replace the sentence beginning "If the book still has zero chapters when save_epub runs" with:

```
"A book with no chapters is saved exactly as it is — nothing is invented to fill it. Note that EPUB 3 " +
  "requires a spine with at least one entry, so such a file is not yet valid for a reading system; add " +
  "a chapter with edit_chapter or convert_manuscript before distributing it. validate_epub reports the " +
  "condition as empty-spine.",
```

In `src/tools/new-epub.ts`'s `registerTool` call, replace the clause "save_epub adds a single blank chapter automatically if none exist yet" with "the book stays empty until you add a chapter, and save_epub never invents one".

- [ ] **Step 6: Verify and commit**

Run: `bun test && bun run typecheck`
Expected: PASS.

```bash
git add src/tools/save-epub.ts src/tools/save-epub.test.ts src/tools/new-epub.ts
git commit -m "Stop save_epub injecting a blank placeholder chapter"
```

---

### Task 7: Validation check framework and alignment checks

**Files:**
- Create: `src/tools/validate-checks.ts`
- Test: `src/tools/validate-checks.test.ts`

**Interfaces:**
- Consumes: `chapterNumberFromLabel`, `deriveTocLabel` (Task 2), `proseSpineDocuments` (Task 3), plus existing `primaryNavigation`, `ncxItem`, `resolveHref`.
- Produces, from `src/tools/validate-checks.ts`:
  - `interface ValidateEpubFinding { check: string; severity: "error" | "warning"; message: string; ids: string[]; remedy: string }`
  - `type Check = (e: Epub, pkg: Package) => ValidateEpubFinding[]`
  - `tocSpineOrder`, `tocLabelHeadingMismatch`, `chapterNumberSequence`, `ncxTocDivergence` — all of type `Check`
  - internal helpers `stripFragment`, `tocList`, `flattenPoints`, `tocDocumentOrder` (not exported; Tasks 8 and 9 add more checks to this same file and reuse them)

- [ ] **Step 1: Write the failing tests**

Create `src/tools/validate-checks.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { chapterNumberSequence, ncxTocDivergence, tocLabelHeadingMismatch, tocSpineOrder } from "./validate-checks.ts";
import { rebuildToc } from "./nav-rebuild.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { Epub } from "../epub/types.ts";

export function chapterMarkup(heading: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h2>${heading}</h2><p>Text.</p></body></html>`;
}

/** Adds a content document with a manifest item and a spine entry at the end. */
export function addDoc(e: Epub, archivePath: string, opfId: string, markup: string): void {
  const pkg = primaryPackage(e)!;
  pkg.manifest.items.push({ id: `${pkg.manifest.id}/${opfId}`, href: archivePath, mediaType: "application/xhtml+xml", properties: [], fallback: "", mediaOverlay: "" });
  pkg.spine.itemRefs.push({ id: "", idRef: opfId, linear: true, properties: [] });
  e.contentDocuments[archivePath] = { id: archivePath, mediaType: "application/xhtml+xml", markup };
}

/** A two-chapter book whose toc has been rebuilt, so every check should pass. */
export function cleanBook(title: string): Epub {
  const e = newEpub(title, "Author");
  addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1: Dawn"));
  addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2: Dusk"));
  rebuildToc(e, primaryPackage(e)!);
  return e;
}

export function tocOf(e: Epub) {
  return e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
}

describe("tocSpineOrder", () => {
  test("finds nothing wrong with a rebuilt toc", () => {
    const e = cleanBook("Order Clean");
    expect(tocSpineOrder(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a toc entry targeting nothing in the prose spine", () => {
    const e = cleanBook("Order Extra");
    tocOf(e).items.push({ id: "x", label: "Ghost", href: "text/ghost.xhtml", type: "", children: [] });

    const findings = tocSpineOrder(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "toc-spine-order", severity: "error", ids: ["text/ghost.xhtml"] });
    expect(findings[0]!.remedy).toContain("convert_manuscript");
  });

  test("reports a prose document with no toc entry", () => {
    const e = cleanBook("Order Missing");
    tocOf(e).items = tocOf(e).items.slice(0, 1);

    const findings = tocSpineOrder(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.ids).toEqual(["text/ch2.xhtml"]);
  });

  test("reports entries present in both but in a different order", () => {
    const e = cleanBook("Order Swapped");
    tocOf(e).items.reverse();

    const findings = tocSpineOrder(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("different order");
  });

  test("tolerates a nested toc and multiple fragment entries into one document", () => {
    const e = cleanBook("Order Nested");
    tocOf(e).items = [
      {
        id: "a", label: "Part One", href: "text/ch1.xhtml", type: "", children: [
          { id: "a1", label: "Chapter 1: Dawn", href: "text/ch1.xhtml#top", type: "", children: [] },
        ],
      },
      { id: "b", label: "Chapter 2: Dusk", href: "text/ch2.xhtml", type: "", children: [] },
    ];

    expect(tocSpineOrder(e, primaryPackage(e)!)).toEqual([]);
  });

  test("is a no-op for a book with no navigation document", () => {
    const e = cleanBook("Order No Nav");
    delete e.navigation["nav.xhtml"];
    const navItem = primaryPackage(e)!.manifest.items.find((i) => i.properties.includes("nav"));
    if (navItem) navItem.properties = [];

    expect(tocSpineOrder(e, primaryPackage(e)!)).toEqual([]);
  });
});

describe("tocLabelHeadingMismatch", () => {
  test("finds nothing wrong with a rebuilt toc", () => {
    const e = cleanBook("Label Clean");
    expect(tocLabelHeadingMismatch(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a toc entry whose chapter number disagrees with the document's heading", () => {
    const e = cleanBook("Label Mismatch");
    tocOf(e).items[0]!.label = "Chapter 5: Dawn";

    const findings = tocLabelHeadingMismatch(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "toc-label-heading-mismatch", severity: "error" });
    expect(findings[0]!.message).toContain("Chapter 1");
    expect(findings[0]!.ids).toContain("text/ch1.xhtml");
  });

  test("ignores entries whose label names no chapter number", () => {
    const e = cleanBook("Label Unnumbered");
    tocOf(e).items[0]!.label = "Prologue";

    expect(tocLabelHeadingMismatch(e, primaryPackage(e)!)).toEqual([]);
  });

  test("ignores an entry whose target does not exist, leaving that to dangling-href", () => {
    const e = cleanBook("Label Dangling");
    tocOf(e).items[0]!.href = "text/ghost.xhtml";

    expect(tocLabelHeadingMismatch(e, primaryPackage(e)!)).toEqual([]);
  });
});

describe("chapterNumberSequence", () => {
  test("finds nothing wrong with contiguous numbering", () => {
    const e = cleanBook("Seq Clean");
    expect(chapterNumberSequence(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a gap", () => {
    const e = newEpub("Seq Gap", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));
    addDoc(e, "text/ch4.xhtml", "ch4", chapterMarkup("Chapter 4"));

    const findings = chapterNumberSequence(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "chapter-number-sequence", severity: "warning" });
    expect(findings[0]!.message).toContain("2 number(s) missing");
  });

  test("reports a duplicate", () => {
    const e = newEpub("Seq Dupe", "Author");
    addDoc(e, "text/a.xhtml", "a", chapterMarkup("Chapter 1"));
    addDoc(e, "text/b.xhtml", "b", chapterMarkup("Chapter 1"));

    const findings = chapterNumberSequence(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.ids).toEqual(["text/a.xhtml", "text/b.xhtml"]);
  });

  test("reports chapters out of order in the spine", () => {
    const e = newEpub("Seq Backwards", "Author");
    addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2"));
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));

    const findings = chapterNumberSequence(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("comes after");
  });

  test("ignores unnumbered front matter between chapters", () => {
    const e = newEpub("Seq Front Matter", "Author");
    addDoc(e, "text/pro.xhtml", "pro", chapterMarkup("Prologue"));
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));
    addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2"));

    expect(chapterNumberSequence(e, primaryPackage(e)!)).toEqual([]);
  });
});

describe("ncxTocDivergence", () => {
  /** Gives e a legacy NCX wired into the spine and manifest, with the given navMap. */
  function addNCX(e: Epub, navMap: Array<{ label: string; src: string }>): void {
    const pkg = primaryPackage(e)!;
    pkg.spine.tocRef = "ncx";
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ncx`, href: "toc.ncx", mediaType: "application/x-dtbncx+xml", properties: [], fallback: "", mediaOverlay: "" });
    e.nCXs["toc.ncx"] = { id: "toc.ncx", markup: "", navMap: navMap.map((p, i) => ({ id: `np-${i}`, playOrder: i + 1, label: p.label, src: p.src, children: [] })) };
  }

  test("is a no-op for a book with no NCX", () => {
    const e = cleanBook("NCX Absent");
    expect(ncxTocDivergence(e, primaryPackage(e)!)).toEqual([]);
  });

  test("finds nothing wrong when the NCX matches the toc", () => {
    const e = cleanBook("NCX Match");
    addNCX(e, [{ label: "Chapter 1: Dawn", src: "text/ch1.xhtml" }, { label: "Chapter 2: Dusk", src: "text/ch2.xhtml" }]);

    expect(ncxTocDivergence(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a divergent label", () => {
    const e = cleanBook("NCX Diverged");
    addNCX(e, [{ label: "Chapter 1: Old", src: "text/ch1.xhtml" }, { label: "Chapter 2: Dusk", src: "text/ch2.xhtml" }]);

    const findings = ncxTocDivergence(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "ncx-toc-divergence", severity: "warning" });
  });

  test("reports a different entry count", () => {
    const e = cleanBook("NCX Short");
    addNCX(e, [{ label: "Chapter 1: Dawn", src: "text/ch1.xhtml" }]);

    expect(ncxTocDivergence(e, primaryPackage(e)!)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/validate-checks.test.ts`
Expected: FAIL — module `./validate-checks.ts` does not exist.

- [ ] **Step 3: Create `src/tools/validate-checks.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * The checks behind validate_epub: pure functions over an already-loaded
 * Epub that report what's wrong with it and never change it.
 *
 * Two rules hold for every check in this file. First, a defect is a finding,
 * not an exception — a check throws only for input no valid Epub could
 * produce, and a book with no package document is rejected by the tool
 * before any check runs. Second, every finding carries a remedy naming the
 * tool and arguments that would fix it, so the caller can act on the report
 * rather than infer the repair.
 *
 * Checks deliberately overlap as little as possible. Where one condition
 * would trip several, the narrower check stays quiet and lets the one that
 * owns the condition report it — tocLabelHeadingMismatch ignores an entry
 * whose target doesn't exist, for instance, because danglingHref reports it.
 */
import { primaryNavigation } from "./get-navigation.ts";
import { chapterNumberFromLabel, deriveTocLabel } from "../epub/labels.ts";
import { ncxItem, proseSpineDocuments, resolveHref } from "../epub/resolve.ts";
import type { Epub, NCXNavPoint, NavList, NavPoint, Package } from "../epub/types.ts";

/** One problem validate_epub found, with the tool call that would fix it. */
export interface ValidateEpubFinding {
  /** The name of the check that produced this finding, e.g. "toc-spine-order". */
  check: string;
  /** "error" means the book is broken; "warning" means it's suspect but may be deliberate. */
  severity: "error" | "warning";
  /** What is wrong, naming the specific values involved. */
  message: string;
  /** Affected archive paths and structure ids, for the caller to act on. */
  ids: string[];
  /** A sentence naming the tool and arguments that fix it. */
  remedy: string;
}

export type Check = (e: Epub, pkg: Package) => ValidateEpubFinding[];

/** Drops an href's "#fragment", leaving the archive path it targets. */
function stripFragment(href: string): string {
  const i = href.indexOf("#");
  return i === -1 ? href : href.slice(0, i);
}

/** Returns the primary navigation document's "toc" list, or undefined if the book has neither. */
function tocList(e: Epub, pkg: Package): NavList | undefined {
  try {
    return primaryNavigation(e, pkg).lists.find((l) => l.type === "toc");
  } catch {
    return undefined; // missingNav reports a book with no navigation document
  }
}

/** Flattens a NavPoint tree into document order, parents before their children. */
function flattenPoints(points: NavPoint[]): NavPoint[] {
  const out: NavPoint[] = [];
  for (const p of points) {
    out.push(p);
    out.push(...flattenPoints(p.children));
  }
  return out;
}

/** Flattens an NCX navMap into document order, parents before their children. */
function flattenNCX(points: NCXNavPoint[]): NCXNavPoint[] {
  const out: NCXNavPoint[] = [];
  for (const p of points) {
    out.push(p);
    out.push(...flattenNCX(p.children));
  }
  return out;
}

/**
 * The archive paths a toc reaches, in document order, with fragments
 * stripped and consecutive repeats collapsed. Both normalizations matter for
 * comparing a toc against the spine: nesting is a presentation choice that
 * shouldn't count as disorder, and a chapter subdivided into several
 * fragment entries ("#part1", "#part2") is still one document in the spine.
 */
function tocDocumentOrder(points: NavPoint[]): string[] {
  const flat = flattenPoints(points).map((p) => stripFragment(p.href));
  return flat.filter((href, i) => href !== "" && href !== flat[i - 1]);
}

/**
 * The table of contents must reach every prose document in the spine, reach
 * nothing else, and reach them in the same order — the property that makes
 * "chapter 5" mean one thing across the toc, find_text, and a reader's
 * progress bar.
 */
export const tocSpineOrder: Check = (e, pkg) => {
  const list = tocList(e, pkg);
  if (!list) return [];

  const spine = proseSpineDocuments(e, pkg).map((d) => d.archivePath);
  const toc = tocDocumentOrder(list.items);
  const spineSet = new Set(spine);
  const tocSet = new Set(toc);
  const findings: ValidateEpubFinding[] = [];

  const extra = toc.filter((href) => !spineSet.has(href));
  if (extra.length > 0) {
    findings.push({
      check: "toc-spine-order",
      severity: "error",
      message: `${extra.length} table-of-contents entr(ies) target something that is not a prose document in the spine: ${extra.join(", ")}.`,
      ids: extra,
      remedy: 'Rerun convert_manuscript to rebuild the table of contents from the spine, or call edit_navigation with action "remove" on each stale entry.',
    });
  }

  const missing = spine.filter((href) => !tocSet.has(href));
  if (missing.length > 0) {
    findings.push({
      check: "toc-spine-order",
      severity: "error",
      message: `${missing.length} prose document(s) in the spine have no table-of-contents entry: ${missing.join(", ")}.`,
      ids: missing,
      remedy: 'Rerun convert_manuscript to rebuild the table of contents from the spine, or call edit_navigation with action "create" for each missing document.',
    });
  }

  // Order is compared over the intersection only, so a missing or extra
  // entry doesn't also register as every following chapter being misplaced.
  const tocCommon = toc.filter((href) => spineSet.has(href));
  const spineCommon = spine.filter((href) => tocSet.has(href));
  if (tocCommon.some((href, i) => href !== spineCommon[i])) {
    findings.push({
      check: "toc-spine-order",
      severity: "error",
      message: `The table of contents lists chapters in a different order than the spine. Spine order: ${spineCommon.join(", ")}. Table-of-contents order: ${tocCommon.join(", ")}.`,
      ids: tocCommon,
      remedy: "Rerun convert_manuscript to rebuild the table of contents from the spine, or reorder the entries with edit_navigation.",
    });
  }

  return findings;
};

/**
 * A toc entry labelled "Chapter 5" must point at a document whose own
 * heading also says chapter 5. This is the misalignment that survives every
 * structural check: manifest, spine, and toc all internally consistent,
 * every href resolving, and the book still numbered wrong for a reader.
 */
export const tocLabelHeadingMismatch: Check = (e, pkg) => {
  const list = tocList(e, pkg);
  if (!list) return [];

  const findings: ValidateEpubFinding[] = [];
  for (const point of flattenPoints(list.items)) {
    const labelNumber = chapterNumberFromLabel(point.label);
    if (labelNumber === 0) continue;

    const archivePath = stripFragment(point.href);
    const doc = e.contentDocuments[archivePath];
    if (!doc) continue; // danglingHref reports this

    const headingNumber = chapterNumberFromLabel(deriveTocLabel(doc.markup, archivePath));
    if (headingNumber === 0 || headingNumber === labelNumber) continue;

    findings.push({
      check: "toc-label-heading-mismatch",
      severity: "error",
      message: `Table-of-contents entry ${JSON.stringify(point.label)} points at ${archivePath}, whose own heading reads "Chapter ${headingNumber}".`,
      ids: [point.id, archivePath],
      remedy: `Rerun convert_manuscript to rebuild the table of contents, or call edit_navigation with action "edit" on ${JSON.stringify(point.id)} to relabel the entry, or edit_chapter with action "edit" on ${JSON.stringify(archivePath)} to correct the heading.`,
    });
  }
  return findings;
};

/**
 * Chapter numbers read from prose documents' own headings should run 1, 2,
 * 3... in spine order. A warning rather than an error: unnumbered front
 * matter, interludes, and books that genuinely start at chapter 0 are all
 * legitimate, and only gaps, repeats, and backwards jumps are reported.
 */
export const chapterNumberSequence: Check = (e, pkg) => {
  const numbered: Array<{ archivePath: string; number: number }> = [];
  for (const doc of proseSpineDocuments(e, pkg)) {
    const number = chapterNumberFromLabel(deriveTocLabel(doc.markup, doc.archivePath));
    if (number > 0) numbered.push({ archivePath: doc.archivePath, number });
  }

  const findings: ValidateEpubFinding[] = [];

  const byNumber = new Map<number, string[]>();
  for (const c of numbered) {
    const paths = byNumber.get(c.number) ?? [];
    paths.push(c.archivePath);
    byNumber.set(c.number, paths);
  }
  for (const [number, paths] of [...byNumber].sort((a, b) => a[0] - b[0])) {
    if (paths.length < 2) continue;
    findings.push({
      check: "chapter-number-sequence",
      severity: "warning",
      message: `Chapter ${number} appears in ${paths.length} documents: ${paths.join(", ")}.`,
      ids: paths,
      remedy: 'Call edit_chapter with action "edit" to renumber the duplicate heading(s), then rerun convert_manuscript to rebuild the table of contents.',
    });
  }

  for (let i = 1; i < numbered.length; i++) {
    const prev = numbered[i - 1]!;
    const cur = numbered[i]!;
    if (cur.number === prev.number || cur.number === prev.number + 1) continue;
    if (cur.number < prev.number) {
      findings.push({
        check: "chapter-number-sequence",
        severity: "warning",
        message: `Chapter ${cur.number} (${cur.archivePath}) comes after chapter ${prev.number} (${prev.archivePath}) in the spine.`,
        ids: [prev.archivePath, cur.archivePath],
        remedy: 'Reorder the reading order with edit_spine, or renumber the heading with edit_chapter action "edit".',
      });
    } else {
      findings.push({
        check: "chapter-number-sequence",
        severity: "warning",
        message: `Chapter numbering jumps from ${prev.number} (${prev.archivePath}) to ${cur.number} (${cur.archivePath}) — ${cur.number - prev.number - 1} number(s) missing.`,
        ids: [prev.archivePath, cur.archivePath],
        remedy: 'Add the missing chapter(s) with edit_chapter action "create" or convert_manuscript, or renumber the heading with edit_chapter action "edit".',
      });
    }
  }

  return findings;
};

/**
 * A book carrying the legacy EPUB 2 NCX for older reading systems must keep
 * it saying the same thing as the EPUB 3 navigation document, or the same
 * book navigates differently depending on what opens it.
 */
export const ncxTocDivergence: Check = (e, pkg) => {
  const item = ncxItem(pkg);
  if (!item) return [];
  const ncx = e.nCXs[resolveHref(pkg, item.href)];
  if (!ncx) return []; // manifestMissingFile reports this
  const list = tocList(e, pkg);
  if (!list) return [];

  // Compared as label+target pairs in document order, so a divergence in any
  // of label, target, or order is caught by one comparison.
  const tocPairs = flattenPoints(list.items).map((p) => `${p.label} ${stripFragment(p.href)}`);
  const ncxPairs = flattenNCX(ncx.navMap).map((p) => `${p.label} ${stripFragment(p.src)}`);
  if (tocPairs.length === ncxPairs.length && tocPairs.every((v, i) => v === ncxPairs[i])) return [];

  return [
    {
      check: "ncx-toc-divergence",
      severity: "warning",
      message: `The legacy NCX (${ncx.id}) has ${ncxPairs.length} entr(ies), which differ from the navigation document's ${tocPairs.length} table-of-contents entr(ies) in label, target, or order.`,
      ids: [ncx.id, list.id],
      remedy: "Any convert_manuscript or edit_navigation call regenerates the NCX from the table of contents; rerun one of them to bring the two back into agreement.",
    },
  ];
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/validate-checks.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/validate-checks.ts src/tools/validate-checks.test.ts
git commit -m "Add validate_epub alignment checks"
```

---

### Task 8: Referential integrity checks

**Files:**
- Modify: `src/tools/validate-checks.ts`
- Test: `src/tools/validate-checks.test.ts`

**Interfaces:**
- Consumes: `ValidateEpubFinding`, `Check`, `stripFragment`, `tocList`, `flattenPoints`, `flattenNCX` from Task 7; existing `archiveIdInUse`, `manifestItemById`, `manifestItemByHref`.
- Produces: `danglingHref`, `spineMissingManifestItem`, `manifestMissingFile`, `orphanContentDocument`, `duplicateId` — all of type `Check`, plus the internal helper `manifestOpfId(pkg, item)`.

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/validate-checks.test.ts` (extend the import from `./validate-checks.ts` with the five new names):

```ts
describe("danglingHref", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Dangling Clean");
    expect(danglingHref(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a toc entry targeting a file that does not exist", () => {
    const e = cleanBook("Dangling Toc");
    tocOf(e).items[0]!.href = "text/ghost.xhtml";

    const findings = danglingHref(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "dangling-href", severity: "error" });
    expect(findings[0]!.remedy).toContain("edit_navigation");
  });

  test("ignores the fragment when resolving a target", () => {
    const e = cleanBook("Dangling Fragment");
    tocOf(e).items[0]!.href = "text/ch1.xhtml#section-2";

    expect(danglingHref(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a guide reference targeting a file that does not exist", () => {
    const e = cleanBook("Dangling Guide");
    const pkg = primaryPackage(e)!;
    pkg.guide = { id: `${pkg.id}#guide`, references: [{ id: "g1", type: "cover", title: "Cover", href: "text/ghost.xhtml" }] };

    const findings = danglingHref(e, pkg);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.remedy).toContain("edit_guide");
  });
});

describe("spineMissingManifestItem", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Spine Clean");
    expect(spineMissingManifestItem(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a spine entry naming a manifest item that does not exist", () => {
    const e = cleanBook("Spine Ghost");
    primaryPackage(e)!.spine.itemRefs.push({ id: "sp-ghost", idRef: "ghost", linear: true, properties: [] });

    const findings = spineMissingManifestItem(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "spine-missing-manifest-item", severity: "error", ids: ["sp-ghost"] });
  });
});

describe("manifestMissingFile", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Manifest Clean");
    expect(manifestMissingFile(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a manifest item whose file is absent", () => {
    const e = cleanBook("Manifest Ghost");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ghost`, href: "images/ghost.jpg", mediaType: "image/jpeg", properties: [], fallback: "", mediaOverlay: "" });

    const findings = manifestMissingFile(e, pkg);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "manifest-missing-file", severity: "error" });
    expect(findings[0]!.message).toContain("images/ghost.jpg");
  });
});

describe("orphanContentDocument", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Orphan Clean");
    expect(orphanContentDocument(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a content document missing from the manifest", () => {
    const e = cleanBook("Orphan Unmanifested");
    e.contentDocuments["text/loose.xhtml"] = { id: "text/loose.xhtml", mediaType: "application/xhtml+xml", markup: chapterMarkup("Chapter 9") };

    const findings = orphanContentDocument(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "orphan-content-document", severity: "warning", ids: ["text/loose.xhtml"] });
    expect(findings[0]!.message).toContain("manifest");
  });

  test("reports a manifested content document that the spine never reaches", () => {
    const e = cleanBook("Orphan Unspined");
    const pkg = primaryPackage(e)!;
    pkg.spine.itemRefs = pkg.spine.itemRefs.filter((r) => r.idRef !== "ch2");

    const findings = orphanContentDocument(e, pkg);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.ids).toEqual(["text/ch2.xhtml"]);
    expect(findings[0]!.message).toContain("spine");
  });
});

describe("duplicateId", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Dupe Clean");
    expect(duplicateId(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a manifest id used twice", () => {
    const e = cleanBook("Dupe Manifest Id");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ch1`, href: "text/other.xhtml", mediaType: "application/xhtml+xml", properties: [], fallback: "", mediaOverlay: "" });
    e.contentDocuments["text/other.xhtml"] = { id: "text/other.xhtml", mediaType: "application/xhtml+xml", markup: chapterMarkup("Chapter 3") };

    const findings = duplicateId(e, pkg);

    expect(findings.some((f) => f.message.includes("Manifest id"))).toBe(true);
    expect(findings.every((f) => f.check === "duplicate-id" && f.severity === "error")).toBe(true);
  });

  test("reports a spine entry repeated", () => {
    const e = cleanBook("Dupe Spine");
    primaryPackage(e)!.spine.itemRefs.push({ id: "sp-again", idRef: "ch1", linear: true, properties: [] });

    const findings = duplicateId(e, primaryPackage(e)!);

    expect(findings.some((f) => f.message.includes("more than once"))).toBe(true);
  });

  test("reports two manifest items pointing at the same file", () => {
    const e = cleanBook("Dupe Href");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ch1-again`, href: "text/ch1.xhtml", mediaType: "application/xhtml+xml", properties: [], fallback: "", mediaOverlay: "" });

    const findings = duplicateId(e, pkg);

    expect(findings.some((f) => f.message.includes("text/ch1.xhtml"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/validate-checks.test.ts`
Expected: FAIL — the five check functions are not exported.

- [ ] **Step 3: Implement the checks**

Extend `src/tools/validate-checks.ts`'s imports:

```ts
import { archiveIdInUse } from "./edit-resource.ts";
import { manifestItemByHref, manifestItemById, ncxItem, proseSpineDocuments, resolveHref } from "../epub/resolve.ts";
import type { Epub, ManifestItem, NCXNavPoint, NavList, NavPoint, Package } from "../epub/types.ts";
```

Append:

```ts
/** Strips the "<manifest id>/" prefix from a ManifestItem's ArchiveId, leaving the bare opf:id a spine itemref's idRef would name. */
function manifestOpfId(pkg: Package, item: ManifestItem): string {
  const prefix = pkg.manifest.id + "/";
  return item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
}

/**
 * Every navigational target — table of contents, NCX, guide, landmarks —
 * must name a file the archive actually contains. A dangling target is a
 * dead link in the reader's table of contents, and it hides other problems:
 * checks that compare a toc entry against its document can't run at all.
 */
export const danglingHref: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  const report = (source: string, id: string, target: string, remedy: string): void => {
    const path = stripFragment(target);
    if (path === "" || archiveIdInUse(e, path)) return;
    findings.push({
      check: "dangling-href",
      severity: "error",
      message: `${source} ${JSON.stringify(id)} targets ${JSON.stringify(target)}, which is not a file in this EPUB.`,
      ids: [id],
      remedy,
    });
  };

  try {
    for (const list of primaryNavigation(e, pkg).lists) {
      for (const point of flattenPoints(list.items)) {
        report(
          `Navigation ${JSON.stringify(list.type)} entry`,
          point.id,
          point.href,
          `Call edit_navigation with action "remove" on ${JSON.stringify(point.id)}, or add the missing file with edit_chapter or edit_resource.`,
        );
      }
    }
  } catch {
    // missingNav reports a book with no navigation document
  }

  const item = ncxItem(pkg);
  const ncx = item ? e.nCXs[resolveHref(pkg, item.href)] : undefined;
  if (ncx) {
    for (const point of flattenNCX(ncx.navMap)) {
      report(
        "NCX navPoint",
        point.id || ncx.id,
        point.src,
        "Any convert_manuscript or edit_navigation call regenerates the NCX from the table of contents, dropping targets the table of contents no longer has.",
      );
    }
  }

  for (const ref of pkg.guide?.references ?? []) {
    report(
      "Guide reference",
      ref.id,
      resolveHref(pkg, ref.href),
      `Call edit_guide with action "remove" on ${JSON.stringify(ref.id)}, or add the missing file with edit_chapter or edit_resource.`,
    );
  }

  return findings;
};

/** Every spine entry must name a manifest item; one that doesn't places a file that doesn't exist into the reading order. */
export const spineMissingManifestItem: Check = (_e, pkg) => {
  const findings: ValidateEpubFinding[] = [];
  for (const ref of pkg.spine.itemRefs) {
    if (manifestItemById(pkg, ref.idRef)) continue;
    findings.push({
      check: "spine-missing-manifest-item",
      severity: "error",
      message: `Spine entry ${JSON.stringify(ref.id)} references manifest item id ${JSON.stringify(ref.idRef)}, which does not exist.`,
      ids: [ref.id],
      remedy: `Call edit_spine with action "remove" on ${JSON.stringify(ref.id)}, or edit_manifest with action "create" to add an item with id ${JSON.stringify(ref.idRef)}.`,
    });
  }
  return findings;
};

/** Every manifest item must correspond to a file in the archive — the manifest is the exhaustive list of what the rendition contains, so an entry for a file that isn't there makes the package invalid. */
export const manifestMissingFile: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];
  for (const item of pkg.manifest.items) {
    const path = resolveHref(pkg, item.href);
    if (path !== "" && archiveIdInUse(e, path)) continue;
    findings.push({
      check: "manifest-missing-file",
      severity: "error",
      message: `Manifest item ${JSON.stringify(item.id)} points at ${JSON.stringify(item.href)}, which is not a file in this EPUB.`,
      ids: [item.id],
      remedy: `Call edit_manifest with action "remove" on ${JSON.stringify(item.id)}, or supply the missing file with edit_resource or edit_chapter.`,
    });
  }
  return findings;
};

/**
 * Every content document should be listed in the manifest and placed in the
 * spine. One that isn't still ships inside the archive but no linear read
 * ever reaches it — usually a chapter half-removed, or one added without its
 * wiring. A warning, since a document deliberately reached only by an
 * internal link (a footnotes page) is legitimate.
 */
export const orphanContentDocument: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  const inSpine = new Set<string>();
  for (const ref of pkg.spine.itemRefs) {
    const item = manifestItemById(pkg, ref.idRef);
    if (item) inSpine.add(resolveHref(pkg, item.href));
  }

  for (const path of Object.keys(e.contentDocuments).sort()) {
    const item = manifestItemByHref(pkg, path);
    if (!item) {
      findings.push({
        check: "orphan-content-document",
        severity: "warning",
        message: `Content document ${path} is not listed in the manifest, so it is not part of this rendition.`,
        ids: [path],
        remedy: `Call edit_manifest with action "create" to list it, or edit_chapter with action "remove" on ${JSON.stringify(path)} to delete it.`,
      });
      continue;
    }
    if (inSpine.has(path)) continue;
    findings.push({
      check: "orphan-content-document",
      severity: "warning",
      message: `Content document ${path} is in the manifest but not the spine, so a linear read never reaches it.`,
      ids: [path],
      remedy: `Call edit_spine with action "create" to place it in the reading order, or edit_chapter with action "remove" on ${JSON.stringify(path)} to delete it.`,
    });
  }

  return findings;
};

/** Manifest ids, spine entries, and manifest hrefs must each be unique — a duplicate makes every reference to it ambiguous, and which one wins is up to the reading system. */
export const duplicateId: Check = (_e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  const repeated = (values: string[]): string[] => {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts].filter(([, n]) => n > 1).map(([v]) => v).sort();
  };

  for (const id of repeated(pkg.manifest.items.map((i) => i.id))) {
    findings.push({
      check: "duplicate-id",
      severity: "error",
      message: `Manifest id ${JSON.stringify(id)} is used by more than one item.`,
      ids: [id],
      remedy: `Call edit_manifest with action "remove" on the redundant item, or action "edit" to give it a distinct id.`,
    });
  }

  for (const idRef of repeated(pkg.spine.itemRefs.map((r) => r.idRef))) {
    findings.push({
      check: "duplicate-id",
      severity: "error",
      message: `The spine places manifest item ${JSON.stringify(idRef)} into the reading order more than once.`,
      ids: [idRef],
      remedy: `Call edit_spine with action "remove" on the redundant entry.`,
    });
  }

  for (const href of repeated(pkg.manifest.items.map((i) => resolveHref(pkg, i.href)))) {
    findings.push({
      check: "duplicate-id",
      severity: "error",
      message: `More than one manifest item points at ${href}.`,
      ids: [href],
      remedy: `Call edit_manifest with action "remove" on the redundant item.`,
    });
  }

  return findings;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/validate-checks.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/validate-checks.ts src/tools/validate-checks.test.ts
git commit -m "Add validate_epub referential integrity checks"
```

---

### Task 9: Structure and metadata checks, and the `CHECKS` registry

**Files:**
- Modify: `src/tools/validate-checks.ts`
- Test: `src/tools/validate-checks.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 7 and 8; existing `validateXHTML`, `navItem`, `backCoverGuideRef`, `plainText`.
- Produces: `malformedXHTML`, `missingNav`, `missingMetadata`, `emptySpine`, `coverImageMissing`, `backCoverNotLast`, `emptyChapter` — all of type `Check` — plus `export const CHECKS: Record<string, Check>` holding all sixteen in report order.

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/validate-checks.test.ts` (extend the import with the seven new names and `CHECKS`):

```ts
describe("malformedXHTML", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Malformed Clean");
    expect(malformedXHTML(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a chapter with an unterminated tag", () => {
    const e = cleanBook("Malformed Chapter");
    e.contentDocuments["text/ch1.xhtml"]!.markup = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>broken</body></html>`;

    const findings = malformedXHTML(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "malformed-xhtml", severity: "error", ids: ["text/ch1.xhtml"] });
  });

  test("accepts named entities and unclosed void elements", () => {
    const e = cleanBook("Malformed Tolerant");
    e.contentDocuments["text/ch1.xhtml"]!.markup = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>a&mdash;b<br></p></body></html>`;

    expect(malformedXHTML(e, primaryPackage(e)!)).toEqual([]);
  });
});

describe("missingNav", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Nav Clean");
    expect(missingNav(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a book with no manifest item marked as the navigation document", () => {
    const e = cleanBook("Nav Absent");
    const navManifestItem = primaryPackage(e)!.manifest.items.find((i) => i.properties.includes("nav"));
    if (navManifestItem) navManifestItem.properties = [];

    const findings = missingNav(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "missing-nav", severity: "error" });
  });

  test("reports a spine toc attribute naming nothing", () => {
    const e = cleanBook("Nav Toc Ref");
    primaryPackage(e)!.spine.tocRef = "ghost-ncx";

    const findings = missingNav(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("ghost-ncx");
  });
});

describe("missingMetadata", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Metadata Clean");
    expect(missingMetadata(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports each missing required element", () => {
    const e = cleanBook("Metadata Empty");
    const pkg = primaryPackage(e)!;
    pkg.metadata.identifiers = [];
    pkg.metadata.titles = [];
    pkg.metadata.languages = [];

    const findings = missingMetadata(e, pkg);

    expect(findings.map((f) => f.check)).toEqual(["missing-metadata", "missing-metadata", "missing-metadata", "missing-metadata"]);
    expect(findings.every((f) => f.remedy.includes("edit_metadata"))).toBe(true);
  });

  test("reports a unique-identifier naming no identifier", () => {
    const e = cleanBook("Metadata Uid");
    primaryPackage(e)!.uniqueIdentifierRef = "ghost-id";

    const findings = missingMetadata(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("ghost-id");
  });
});

describe("emptySpine", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Spine Full");
    expect(emptySpine(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a book with no reading order", () => {
    const e = newEpub("Spine Empty", "Author");

    const findings = emptySpine(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "empty-spine", severity: "error" });
    expect(findings[0]!.remedy).toContain("convert_manuscript");
  });
});

describe("coverImageMissing", () => {
  test("finds nothing wrong with a book that has no cover", () => {
    const e = cleanBook("Cover None");
    expect(coverImageMissing(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a cover-image item whose file is absent", () => {
    const e = cleanBook("Cover Ghost");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/cover-img`, href: "images/cover.jpg", mediaType: "image/jpeg", properties: ["cover-image"], fallback: "", mediaOverlay: "" });

    const findings = coverImageMissing(e, pkg);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "cover-image-missing", severity: "warning" });
    expect(findings[0]!.remedy).toContain("edit_cover");
  });

  test("reports a legacy cover meta naming no manifest item", () => {
    const e = cleanBook("Cover Meta");
    const pkg = primaryPackage(e)!;
    pkg.metadata.metas.push({ id: "m1", property: "", refines: "", scheme: "", value: "ghost-img", name: "cover" });

    const findings = coverImageMissing(e, pkg);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("ghost-img");
  });
});

describe("backCoverNotLast", () => {
  test("is a no-op for a book with no back cover", () => {
    const e = cleanBook("Back None");
    expect(backCoverNotLast(e, primaryPackage(e)!)).toEqual([]);
  });

  test("finds nothing wrong when the back cover is last", () => {
    const e = cleanBook("Back Last");
    const pkg = primaryPackage(e)!;
    addDoc(e, "text/back.xhtml", "back", `<body><section epub:type="backmatter cover"><img src="b.jpg"/></section></body>`);
    pkg.guide = { id: `${pkg.id}#guide`, references: [{ id: "g1", type: "other.back-cover", title: "Back Cover", href: "text/back.xhtml" }] };

    expect(backCoverNotLast(e, pkg)).toEqual([]);
  });

  test("reports a back cover that something was appended after", () => {
    const e = cleanBook("Back Not Last");
    const pkg = primaryPackage(e)!;
    addDoc(e, "text/back.xhtml", "back", `<body><section epub:type="backmatter cover"><img src="b.jpg"/></section></body>`);
    pkg.guide = { id: `${pkg.id}#guide`, references: [{ id: "g1", type: "other.back-cover", title: "Back Cover", href: "text/back.xhtml" }] };
    addDoc(e, "text/ch3.xhtml", "ch3", chapterMarkup("Chapter 3"));

    const findings = backCoverNotLast(e, pkg);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "back-cover-not-last", severity: "warning" });
  });
});

describe("emptyChapter", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Empty Clean");
    expect(emptyChapter(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a chapter with no readable text", () => {
    const e = cleanBook("Empty Stub");
    e.contentDocuments["text/ch2.xhtml"]!.markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body></body></html>`;

    const findings = emptyChapter(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "empty-chapter", severity: "warning", ids: ["text/ch2.xhtml"] });
  });
});

describe("CHECKS", () => {
  test("registers all sixteen checks", () => {
    expect(Object.keys(CHECKS)).toEqual([
      "toc-spine-order",
      "toc-label-heading-mismatch",
      "chapter-number-sequence",
      "ncx-toc-divergence",
      "dangling-href",
      "spine-missing-manifest-item",
      "manifest-missing-file",
      "orphan-content-document",
      "duplicate-id",
      "malformed-xhtml",
      "missing-nav",
      "missing-metadata",
      "empty-spine",
      "cover-image-missing",
      "back-cover-not-last",
      "empty-chapter",
    ]);
  });

  test("every check reports findings under its own registered name", () => {
    const e = cleanBook("Registry Names");
    const pkg = primaryPackage(e)!;
    for (const [name, check] of Object.entries(CHECKS)) {
      for (const finding of check(e, pkg)) expect(finding.check).toBe(name);
    }
  });

  test("a clean book trips no check at all", () => {
    const e = cleanBook("Registry Clean");
    const pkg = primaryPackage(e)!;
    expect(Object.values(CHECKS).flatMap((check) => check(e, pkg))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/validate-checks.test.ts`
Expected: FAIL — the seven check functions and `CHECKS` are not exported.

- [ ] **Step 3: Implement the checks and the registry**

Extend `src/tools/validate-checks.ts`'s imports:

```ts
import { backCoverGuideRef, manifestItemByHref, manifestItemById, navItem, ncxItem, proseSpineDocuments, resolveHref } from "../epub/resolve.ts";
import { plainText } from "../epub/text.ts";
import { validateXHTML } from "../epub/validate.ts";
```

Append:

```ts
/**
 * Reduces an ArchiveId to the bare identifier it ends with, so a reference
 * written as a plain opf:id ("bookid") can be matched against a modelled id
 * carrying its owner's path ("OEBPS/content.opf#metadata/bookid") without
 * this file having to know how each layer composes them.
 */
function idTail(id: string): string {
  const i = Math.max(id.lastIndexOf("#"), id.lastIndexOf("/"));
  return i === -1 ? id : id.slice(i + 1);
}

/** Content and navigation documents must be well-formed XHTML, or a reading system may refuse to render them at all. */
export const malformedXHTML: Check = (e, _pkg) => {
  const findings: ValidateEpubFinding[] = [];

  for (const path of Object.keys(e.contentDocuments).sort()) {
    try {
      validateXHTML(e.contentDocuments[path]!.markup);
    } catch (err) {
      findings.push({
        check: "malformed-xhtml",
        severity: "error",
        message: `Content document ${path} is not well-formed XHTML: ${(err as Error).message}`,
        ids: [path],
        remedy: `Call edit_chapter with action "edit" on ${JSON.stringify(path)} and corrected markup.`,
      });
    }
  }

  for (const path of Object.keys(e.navigation).sort()) {
    try {
      validateXHTML(e.navigation[path]!.markup);
    } catch (err) {
      findings.push({
        check: "malformed-xhtml",
        severity: "error",
        message: `Navigation document ${path} is not well-formed XHTML: ${(err as Error).message}`,
        ids: [path],
        remedy: "Any edit_navigation or convert_manuscript call re-renders the navigation document from its structured lists, replacing the broken markup.",
      });
    }
  }

  return findings;
};

/** EPUB 3 requires a navigation document, and it must be findable: declared with properties="nav" in the manifest and present in the archive. */
export const missingNav: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  const item = navItem(pkg);
  if (!item) {
    findings.push({
      check: "missing-nav",
      severity: "error",
      message: 'No manifest item is marked properties="nav", so this book has no EPUB 3 navigation document and no table of contents.',
      ids: [pkg.manifest.id],
      remedy: 'Call edit_manifest with action "edit" to add the "nav" property to the navigation document\'s item, or edit_navigation to build one.',
    });
  } else if (!e.navigation[resolveHref(pkg, item.href)]) {
    findings.push({
      check: "missing-nav",
      severity: "error",
      message: `The manifest item marked as the navigation document (${item.id}) points at ${resolveHref(pkg, item.href)}, which is not a navigation document in this EPUB.`,
      ids: [item.id],
      remedy: `Call edit_manifest with action "edit" on ${JSON.stringify(item.id)} to point it at the real navigation document.`,
    });
  }

  if (pkg.spine.tocRef !== "" && !manifestItemById(pkg, pkg.spine.tocRef)) {
    findings.push({
      check: "missing-nav",
      severity: "error",
      message: `The spine's toc attribute names manifest item ${JSON.stringify(pkg.spine.tocRef)}, which does not exist.`,
      ids: [pkg.spine.id],
      remedy: `Call edit_manifest with action "create" to add the legacy NCX item ${JSON.stringify(pkg.spine.tocRef)}, or edit_spine with action "edit" to clear the toc attribute.`,
    });
  }

  return findings;
};

/** dc:identifier, dc:title, and dc:language are required by the spec, and the package's unique-identifier must name one of the identifiers actually present. */
export const missingMetadata: Check = (_e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  const require = (present: boolean, element: string, field: string): void => {
    if (present) return;
    findings.push({
      check: "missing-metadata",
      severity: "error",
      message: `This book has no ${element}, which EPUB requires.`,
      ids: [pkg.metadata.id],
      remedy: `Call edit_metadata with action "create" and field ${JSON.stringify(field)}.`,
    });
  };

  require(pkg.metadata.identifiers.length > 0, "dc:identifier", "identifier");
  require(pkg.metadata.titles.length > 0, "dc:title", "title");
  require(pkg.metadata.languages.length > 0, "dc:language", "language");

  if (pkg.uniqueIdentifierRef === "") {
    findings.push({
      check: "missing-metadata",
      severity: "error",
      message: "The package's unique-identifier attribute is not set, so no identifier is marked as this book's canonical one.",
      ids: [pkg.id],
      remedy: 'Call edit_metadata with action "create" and field "identifier" to add an identifier, which sets the package\'s unique-identifier to match.',
    });
  } else if (!pkg.metadata.identifiers.some((ident) => idTail(ident.id) === pkg.uniqueIdentifierRef)) {
    findings.push({
      check: "missing-metadata",
      severity: "error",
      message: `The package's unique-identifier names ${JSON.stringify(pkg.uniqueIdentifierRef)}, which is not one of this book's ${pkg.metadata.identifiers.length} identifier(s).`,
      ids: [pkg.id],
      remedy: 'Call edit_metadata with action "create" and field "identifier" to add the missing identifier, or action "edit" to correct an existing one.',
    });
  }

  return findings;
};

/** A spine with no entries has no reading order at all — EPUB 3 requires at least one itemref, and a reading system has nothing to open. */
export const emptySpine: Check = (_e, pkg) => {
  if (pkg.spine.itemRefs.length > 0) return [];
  return [
    {
      check: "empty-spine",
      severity: "error",
      message: "This book's spine has no entries, so it has no reading order. EPUB 3 requires at least one.",
      ids: [pkg.spine.id],
      remedy: 'Call edit_chapter with action "create", or convert_manuscript, to add a chapter.',
    },
  ];
};

/** A declared cover must resolve to a file that exists, or the book shows up in a library with a broken thumbnail. */
export const coverImageMissing: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  for (const item of pkg.manifest.items) {
    if (!item.properties.includes("cover-image")) continue;
    const path = resolveHref(pkg, item.href);
    if (archiveIdInUse(e, path)) continue;
    findings.push({
      check: "cover-image-missing",
      severity: "warning",
      message: `Manifest item ${JSON.stringify(item.id)} is marked as the cover image but points at ${path}, which is not a file in this EPUB.`,
      ids: [item.id],
      remedy: 'Call edit_cover with action "create" and a sourcePath to supply the image, or edit_manifest to remove the item.',
    });
  }

  for (const meta of pkg.metadata.metas) {
    if (meta.name !== "cover" || meta.value === "") continue;
    if (manifestItemById(pkg, meta.value)) continue;
    findings.push({
      check: "cover-image-missing",
      severity: "warning",
      message: `The legacy cover meta names manifest item ${JSON.stringify(meta.value)}, which does not exist.`,
      ids: [meta.id],
      remedy: "Call edit_cover to set a cover, which rewrites the legacy meta to match, or edit_metadata to remove the stale meta.",
    });
  }

  return findings;
};

/**
 * This server's own invariant: insertChapter places new chapters before the
 * back cover (see spineInsertionIndexBeforeBackCover) so a back cover stays
 * the last thing a linear read reaches. A back cover that isn't last means
 * something bypassed that, and readers hit the back cover mid-book.
 */
export const backCoverNotLast: Check = (_e, pkg) => {
  const ref = backCoverGuideRef(pkg);
  if (!ref) return [];

  const path = resolveHref(pkg, ref.href);
  const item = manifestItemByHref(pkg, path);
  if (!item) return []; // danglingHref reports this

  const opfId = manifestOpfId(pkg, item);
  const index = pkg.spine.itemRefs.findIndex((r) => r.idRef === opfId);
  if (index === -1) {
    return [
      {
        check: "back-cover-not-last",
        severity: "warning",
        message: `The back cover (${path}) is not in the spine, so a linear read never reaches it.`,
        ids: [path],
        remedy: 'Call edit_spine with action "create" to place it at the end of the reading order.',
      },
    ];
  }
  if (index === pkg.spine.itemRefs.length - 1) return [];

  return [
    {
      check: "back-cover-not-last",
      severity: "warning",
      message: `The back cover (${path}) is spine entry ${index + 1} of ${pkg.spine.itemRefs.length}, not the last one, so readers reach it before the end of the book.`,
      ids: [path],
      remedy: 'Call edit_spine with action "remove" on the back cover\'s entry, then action "create" to re-add it at the end of the reading order.',
    },
  ];
};

/** A prose document with no readable text is almost always a leftover stub or a chapter whose content failed to land. */
export const emptyChapter: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];
  for (const doc of proseSpineDocuments(e, pkg)) {
    if (plainText(doc.markup).trim() !== "") continue;
    findings.push({
      check: "empty-chapter",
      severity: "warning",
      message: `Chapter ${doc.archivePath} has no readable text.`,
      ids: [doc.archivePath],
      remedy: `Call edit_chapter with action "edit" on ${JSON.stringify(doc.archivePath)} to give it content, or action "remove" to delete it.`,
    });
  }
  return findings;
};

/**
 * Every check validate_epub can run, keyed by the name it reports findings
 * under. Insertion order is the order findings are reported in, so the
 * alignment checks a caller most likely acted on come first.
 */
export const CHECKS: Record<string, Check> = {
  "toc-spine-order": tocSpineOrder,
  "toc-label-heading-mismatch": tocLabelHeadingMismatch,
  "chapter-number-sequence": chapterNumberSequence,
  "ncx-toc-divergence": ncxTocDivergence,
  "dangling-href": danglingHref,
  "spine-missing-manifest-item": spineMissingManifestItem,
  "manifest-missing-file": manifestMissingFile,
  "orphan-content-document": orphanContentDocument,
  "duplicate-id": duplicateId,
  "malformed-xhtml": malformedXHTML,
  "missing-nav": missingNav,
  "missing-metadata": missingMetadata,
  "empty-spine": emptySpine,
  "cover-image-missing": coverImageMissing,
  "back-cover-not-last": backCoverNotLast,
  "empty-chapter": emptyChapter,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/validate-checks.test.ts && bun run typecheck`
Expected: PASS.

If the `"a clean book trips no check at all"` test fails, the fixture is at fault, not the check — `newEpub`'s skeleton may legitimately lack something a check requires. Fix `cleanBook` to supply it and note what was missing in the test's comment; do not weaken the check.

- [ ] **Step 5: Commit**

```bash
git add src/tools/validate-checks.ts src/tools/validate-checks.test.ts
git commit -m "Add validate_epub structure checks and the CHECKS registry"
```

---

### Task 10: The `validate_epub` tool

**Files:**
- Create: `src/tools/validate-epub.ts`
- Test: `src/tools/validate-epub.test.ts`
- Modify: `src/index.ts:40` (add the import)
- Modify: `README.md:118` and the tool list

**Interfaces:**
- Consumes: `CHECKS` and `ValidateEpubFinding` from `src/tools/validate-checks.ts` (Tasks 7–9).
- Produces: `validateEpubTool: EpubTool` and `handleValidateEpub(server, args): Promise<ToolHandlerResult>` from `src/tools/validate-epub.ts`, self-registering via `registerTool` on import.

- [ ] **Step 1: Write the failing tests**

Create `src/tools/validate-epub.test.ts`, following the temp-directory and `fakeServer` conventions of `src/tools/find-text.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { handleValidateEpub } from "./validate-epub.ts";
import { handleConvertManuscript } from "./convert-manuscript.ts";
import { epubCache } from "./epub-cache.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { resolve } from "node:path";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

interface ValidateResult {
  path: string;
  ok: boolean;
  errorCount: number;
  warningCount: number;
  checksRun: string[];
  findings: Array<{ check: string; severity: string; message: string; ids: string[]; remedy: string }>;
}

describe("validate_epub", () => {
  test("errors when path is missing", async () => {
    await expect(handleValidateEpub(fakeServer, {} as never)).rejects.toThrow("path is required");
  });

  test("reports a converted book as clean", async () => {
    const { path, dir } = await newTestEpub("Validate Clean");
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "Chapter 1: Dawn\n\nFirst.\n\nChapter 2: Dusk\n\nSecond.\n", "utf-8");
    await handleConvertManuscript(fakeServer, { path, sourcePath });

    const res = await handleValidateEpub(fakeServer, { path });
    const result = res.structuredContent as unknown as ValidateResult;

    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.findings).toEqual([]);
    expect(res.content[0]!.text).toContain("no problems found");
  });

  test("reports a misaligned toc as an error, with a remedy", async () => {
    const { path, dir } = await newTestEpub("Validate Misaligned");
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "Chapter 1: Dawn\n\nFirst.\n\nChapter 2: Dusk\n\nSecond.\n", "utf-8");
    await handleConvertManuscript(fakeServer, { path, sourcePath });
    const e = epubCache.get(resolve(path))!;
    e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!.items[0]!.label = "Chapter 5: Dawn";

    const result = (await handleValidateEpub(fakeServer, { path })).structuredContent as unknown as ValidateResult;

    expect(result.ok).toBe(false);
    expect(result.errorCount).toBe(1);
    const finding = result.findings[0]!;
    expect(finding.check).toBe("toc-label-heading-mismatch");
    expect(finding.remedy).toContain("edit_navigation");
  });

  test("runs only the requested checks", async () => {
    const { path } = await newTestEpub("Validate Subset");

    const result = (await handleValidateEpub(fakeServer, { path, checks: ["empty-spine"] })).structuredContent as unknown as ValidateResult;

    expect(result.checksRun).toEqual(["empty-spine"]);
    expect(result.findings.map((f) => f.check)).toEqual(["empty-spine"]);
  });

  test("rejects an unknown check name, naming the valid ones", async () => {
    const { path } = await newTestEpub("Validate Unknown Check");

    await expect(handleValidateEpub(fakeServer, { path, checks: ["no-such-check"] })).rejects.toThrow("toc-spine-order");
  });

  test("counts errors and warnings separately", async () => {
    const { path } = await newTestEpub("Validate Counts");
    const e = epubCache.get(resolve(path))!;
    e.contentDocuments["text/loose.xhtml"] = { id: "text/loose.xhtml", mediaType: "application/xhtml+xml", markup: "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>x</p></body></html>" };

    const result = (await handleValidateEpub(fakeServer, { path })).structuredContent as unknown as ValidateResult;

    // An empty spine (error) plus an unmanifested content document (warning).
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.warningCount).toBeGreaterThan(0);
    expect(result.errorCount + result.warningCount).toBe(result.findings.length);
  });

  test("changes nothing — the cache stays clean", async () => {
    const { path } = await newTestEpub("Validate Read Only");
    const before = JSON.stringify(primaryPackage(epubCache.get(resolve(path))!)!.spine);

    await handleValidateEpub(fakeServer, { path });

    expect(epubCache.isDirty(resolve(path))).toBe(false);
    expect(JSON.stringify(primaryPackage(epubCache.get(resolve(path))!)!.spine)).toBe(before);
  });
});
```

Copy `newTestEpub` / `fakeServer` from whatever `src/tools/find-text.test.ts` defines. If `epubCache` exposes the dirty flag under a different name than `isDirty`, use that name — check `src/tools/epub-cache.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/validate-epub.test.ts`
Expected: FAIL — module `./validate-epub.ts` does not exist.

- [ ] **Step 3: Create `src/tools/validate-epub.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * validate_epub — check an already-read EPUB's data structures against each
 * other and against the spec, reporting what's wrong and how to fix it.
 *
 * Read-only by design. Repairs belong to the tools that own them: the table
 * of contents is rebuilt by convert_manuscript, entries are edited by
 * edit_navigation, wiring by edit_manifest and edit_spine. Keeping the
 * validator diagnostic means it's safe to run at any point, and every
 * finding names the tool call that fixes it so a caller can act on the
 * report directly.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { CHECKS, type ValidateEpubFinding } from "./validate-checks.ts";
import { primaryPackage } from "../epub/resolve.ts";

interface ValidateEpubArgs {
  path: string;
  checks?: string[];
}

interface ValidateEpubResult {
  path: string;
  ok: boolean;
  errorCount: number;
  warningCount: number;
  checksRun: string[];
  findings: ValidateEpubFinding[];
}

const CHECK_NAMES = Object.keys(CHECKS);

export const validateEpubTool: EpubTool = {
  name: "validate_epub",
  description:
    "Check an already-read EPUB for misalignment between its table of contents, spine, manifest, and chapter text, plus structural and metadata defects. Every finding names the tool call that fixes it. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      checks: {
        type: "array",
        items: { type: "string" },
        description: `check names to run; omit to run all of them. Valid names: ${CHECK_NAMES.join(", ")}`,
      },
    },
    required: ["path"],
  },
};

export async function handleValidateEpub(_server: Server, args: ValidateEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document to validate`);

  let checksRun = CHECK_NAMES;
  if (args.checks !== undefined) {
    if (!Array.isArray(args.checks) || args.checks.length === 0) {
      throw new Error(`checks must be a non-empty array of check names; valid names are: ${CHECK_NAMES.join(", ")}`);
    }
    for (const name of args.checks) {
      if (!(name in CHECKS)) throw new Error(`unknown check ${JSON.stringify(name)}; valid names are: ${CHECK_NAMES.join(", ")}`);
    }
    // Filtered from CHECK_NAMES rather than mapped from args.checks, so the
    // report order is always the registry's regardless of argument order.
    checksRun = CHECK_NAMES.filter((name) => args.checks!.includes(name));
  }

  const findings = checksRun.flatMap((name) => CHECKS[name]!(e, pkg));
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.length - errorCount;

  const result: ValidateEpubResult = { path: abs, ok: errorCount === 0, errorCount, warningCount, checksRun, findings };

  let summary =
    findings.length === 0
      ? `Validated ${JSON.stringify(abs)}: no problems found across ${checksRun.length} check(s).`
      : `Validated ${JSON.stringify(abs)}: ${errorCount} error(s) and ${warningCount} warning(s) across ${checksRun.length} check(s).`;
  for (const f of findings) {
    summary += `\n  [${f.severity}] ${f.check}: ${f.message}\n    Fix: ${f.remedy}`;
  }
  summary += evictionNote(eviction);

  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  validateEpubTool,
  "Takes path, the same .epub filesystem path passed to read_epub, and an optional checks array naming a " +
    "subset of checks to run (omit it to run all of them; an unrecognized name is an error listing the " +
    "valid ones). Loads the EPUB through the same cache read_epub uses.\n\n" +
    "Read-only: it never changes the book, never marks the cache dirty, and never writes to disk. It " +
    "reports problems and names the repair; you make the repair with the tool that owns it.\n\n" +
    "Returns ok (true when nothing of severity \"error\" was found), errorCount, warningCount, checksRun, " +
    "and findings. Each finding carries check (the check's name), severity (\"error\" or \"warning\"), " +
    "message (what is wrong, naming the values involved), ids (the affected archive paths and structure " +
    "ids), and remedy (a sentence naming the tool and arguments that fix it). An EPUB with nothing wrong " +
    "returns ok true and an empty findings array.\n\n" +
    "-- Alignment checks --\n\n" +
    "toc-spine-order (error): the table of contents must reach every prose document in the spine, reach " +
    "nothing else, and reach them in the same order. Nesting and multiple fragment entries into one " +
    "document are tolerated.\n" +
    "toc-label-heading-mismatch (error): a toc entry labelled \"Chapter 5\" points at a document whose " +
    "own heading says a different chapter number. This is the misalignment that survives every structural " +
    "check.\n" +
    "chapter-number-sequence (warning): chapter numbers read from chapter headings, in spine order, have " +
    "a gap, a repeat, or run backwards. Unnumbered front matter is ignored.\n" +
    "ncx-toc-divergence (warning): the legacy EPUB 2 NCX disagrees with the navigation document's table " +
    "of contents in label, target, or order.\n\n" +
    "-- Referential integrity checks --\n\n" +
    "dangling-href (error): a table-of-contents, NCX, landmarks, or guide target names a file the archive " +
    "does not contain.\n" +
    "spine-missing-manifest-item (error): a spine entry names a manifest item that does not exist.\n" +
    "manifest-missing-file (error): a manifest item names a file the archive does not contain.\n" +
    "orphan-content-document (warning): a chapter absent from the manifest, or in the manifest but not " +
    "the spine, so a linear read never reaches it.\n" +
    "duplicate-id (error): a manifest id, spine entry, or manifest href appears more than once.\n\n" +
    "-- Structure and metadata checks --\n\n" +
    "malformed-xhtml (error): a chapter or the navigation document is not well-formed XHTML.\n" +
    "missing-nav (error): no manifest item is marked properties=\"nav\", the item marked as such points " +
    "at no navigation document, or the spine's toc attribute names nothing.\n" +
    "missing-metadata (error): no dc:identifier, dc:title, or dc:language, or the package's " +
    "unique-identifier names no identifier that exists.\n" +
    "empty-spine (error): the book has no reading order at all. EPUB 3 requires at least one spine " +
    "entry, so a book still empty at save time is not yet a valid EPUB.\n" +
    "cover-image-missing (warning): a cover-image manifest item or legacy cover meta names something " +
    "absent.\n" +
    "back-cover-not-last (warning): the book has a back cover that is not the last thing in the reading " +
    "order.\n" +
    "empty-chapter (warning): a chapter in the reading order has no readable text.",
  handleValidateEpub as never,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/validate-epub.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Register the tool with the server**

In `src/index.ts`, add after the `get-cache-status.ts` import on line 40:

```ts
import "./tools/validate-epub.ts";
```

- [ ] **Step 6: Update the README**

In `README.md`, change line 118 from `**27 MCP tools**` to `**28 MCP tools**`, and add to the same category block that lists `find_text`:

```markdown
- **`validate_epub`** — Check an EPUB for misalignment between its table of contents, spine, manifest, and chapter text (e.g. a toc entry labelled "Chapter 5" pointing at chapter 7), plus dangling references, duplicate ids, malformed XHTML, and missing required metadata. Read-only; every finding names the tool call that fixes it. Optionally limit the run to specific checks.
```

- [ ] **Step 7: Verify the whole suite and commit**

Run: `bun test && bun run typecheck`
Expected: PASS, all files.

```bash
git add src/tools/validate-epub.ts src/tools/validate-epub.test.ts src/index.ts README.md
git commit -m "Add validate_epub tool"
```

---

### Task 11: Release

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: version `0.1.0`.

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "0.0.5"` to `"version": "0.1.0"`. A minor rather than a patch bump: `validate_epub` is a new tool, and `save_epub` and `convert_manuscript` both changed behavior a caller can observe.

- [ ] **Step 2: Write the changelog entry**

Add a new section at the top of `CHANGELOG.md`, matching the format of the existing entries:

```markdown
## 0.1.0

### Added

- `validate_epub`: a read-only tool that checks an EPUB's table of contents, spine, manifest, and chapter text against each other and against the spec. Reports misalignment (a toc entry labelled "Chapter 5" pointing at chapter 7), dangling references, duplicate ids, orphaned chapters, malformed XHTML, and missing required metadata. Every finding names the tool call that fixes it. Runs all 16 checks by default, or a named subset.

### Changed

- `convert_manuscript` now rebuilds the table of contents from scratch when it finishes, instead of patching it chapter by chapter: one flat entry per chapter, in spine reading order, labelled from each chapter's own heading. Cover pages are skipped and the legacy NCX is regenerated to match. This fixes tables of contents that drifted out of spine order in books with a back cover, and chapters whose title changed but whose toc entry didn't. Manual nesting or renaming applied with `edit_navigation` does not survive a conversion — use `edit_chapter` for incremental changes that preserve a curated table of contents.
- `convert_manuscript` matches manuscript chapters against existing ones by the chapter number in each chapter's own heading, rather than by its table-of-contents label, which could be stale.
- `edit_chapter` is unchanged: `create` and `remove` still sync the table of contents incrementally.

### Fixed

- `save_epub` no longer inserts a blank placeholder chapter into a book that has none. Saving a new EPUB before adding content used to create `text/chapter-1.xhtml`, which then collided with the real chapter 1 on the next `convert_manuscript` — pushing it to `chapter-1-2.xhtml` and leaving a blank chapter at the head of the book and its table of contents. A book now stays empty until you add a chapter. Note that a spine with no entries is not valid EPUB 3; `validate_epub` reports it as `empty-spine`.
```

- [ ] **Step 3: Verify and commit**

Run: `bun test && bun run typecheck && bun run build`
Expected: PASS.

```bash
git add package.json CHANGELOG.md
git commit -m "Release 0.1.0"
```

---

## Self-Review Notes

Checked against the spec:

- **Part 1 (toc rebuild)** — Tasks 1–5. `rebuildToc` (Task 4), label derivation with the `"Chapter"` placeholder skip (Task 2), cover-page exclusion shared with `find_text` (Tasks 1, 3), `convert_manuscript` integration and the `existingChaptersByNumber` rewrite (Task 5). `edit_chapter` is deliberately untouched, per the user's direction that only conversion rebuilds.
- **Part 2 (blank chapter)** — Task 6, including both corrected tool descriptions and the collision regression test that reproduces the reported bug.
- **Part 3 (`validate_epub`)** — Tasks 7–10, all 16 named checks with the spec's severities, the `remedy` field on every finding, the `checks` argument, read-only verification, and registration.
- **Spec deviation** — the module layout differs from the spec's, to keep `src/epub/` from importing `src/tools/`. Documented under Global Constraints.
- **Naming consistency** — `deriveTocLabel`, `defaultChapterLabel`, `chapterNumberFromLabel`, `proseSpineDocuments`, `rebuildToc`, `ValidateEpubFinding`, `Check`, `CHECKS`, `handleValidateEpub` are used identically everywhere they appear.
- **Spec's `src/epub/checks.test.ts` and `src/epub/text.test.ts` items** — the former became `src/tools/validate-checks.test.ts` with the module move; the latter is Task 1 Step 1.
