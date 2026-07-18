# Phase 6: Chapter and Manuscript Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port chapter content-document editing (`get_chapter`, `edit_chapter`) and whole-manuscript ingestion (`convert_manuscript`), plus the markdown/manuscript text-splitting logic both depend on. This is the phase that finally delivers the tool this entire porting effort started from: building `The Magic Hower.epub` from `The Magic Hower.md` via `convert_manuscript`.

**Architecture:** Five files under `src/tools/`, matching the Go reference's file boundaries: `chapter-markdown.ts`, `edit-chapter.ts`, `get-chapter.ts`, `manuscript-parse.ts`, `convert-manuscript.ts`. Builds on Phase 4's `edit-resource.ts` (`archiveIdInUse`, `manifestIdCandidate`, `uniqueManifestId`) and Phase 5's `get-navigation.ts` (`primaryNavigation`) and `nav-sync.ts` (`syncTocOnChapterCreate`/`syncTocOnChapterRemove`).

**Source of record:** `G:\_GoProjects\epub-novel-mcp-server\tools\{chapter_markdown,edit_chapter,get_chapter,manuscript_parse,convert_manuscript}.go`.

## Global Constraints

- Every exported name mirrors its Go counterpart's meaning, translated to camelCase.
- All relative imports use explicit `.ts` extensions; SDK imports keep `.js`.
- `verbatimModuleSyntax` is on: import types with `import type { ... }`.
- Every tool self-registers via a top-level `registerTool(...)` call.
- Every tool handler that omits a required string arg resolves it via `resolveArg(server, current, field, message)`.
- Every tool handler that loads a book calls `epubCache.load(abs)` and appends `evictionNote(evicted)` to its summary; every mutating tool calls `epubCache.markDirty(abs)` after a successful edit and appends "Call save_epub to persist this to disk." to its summary.
- Every tool handler returns `{ content: [{ type: "text", text: summary }], structuredContent: result }`.
- **Handlers throw on error; only `registry.ts`'s `dispatchTool` wrapper converts a throw to `{isError:true}`.** Tests calling a handler directly use `.rejects.toThrow(...)`.
- **`manifestIdCandidate`/`uniqueManifestId` live in `src/tools/edit-resource.ts` (Phase 4), not `edit-chapter.ts`, despite Go defining them in `tools/edit_chapter.go`.** In the Go reference, `edit_resource.go`'s `createResource` calls `uniqueManifestID(pkg, manifestIDCandidate(id))` — functions actually defined in `edit_chapter.go`, reachable only because Go's flat package namespace lets any file call any other file's functions. This TS port already placed both functions in `edit-resource.ts` during Phase 4 (before this phase's Go source had been re-read in full), and since they're already merged, tested, and reviewed there, this plan keeps them there rather than relocating already-shipped code — `edit-chapter.ts` (this phase) imports them from `./edit-resource.ts` instead of redefining them. Document this reasoning in `edit-chapter.ts`'s header comment so a future reader isn't confused by the file-boundary mismatch with Go.
- **A real bug in Go's `extractChapterTitle` is deliberately NOT ported.** Go's implementation calls `strings.ToLower(line)` on the *entire* marker-title line before stripping the `"## "` prefix and extracting the quoted content — meaning the extracted chapter title itself gets silently lowercased (e.g. `## "The Mage Who Didn't Need a Wand"` would produce the title `the mage who didn't need a wand"`, missing even the closing-quote strip since the lowercase pass also breaks the trailing-quote index math in edge cases). This contradicts the file's own doc comment, which documents `chapterFragment.Title` with a title-cased example (`"The Mage Who Didn't Need a Wand"`). There's no Go test for this function that would have caught it. This plan's `extractChapterTitle` strips the `"## "` prefix via a case-*insensitive* check but preserves the original case of everything after it — Task 1 must add a test asserting a mixed-case title round-trips unchanged, specifically to lock in this deviation.

---

### Task 1: `chapter-markdown.ts` — plaintext-to-XHTML chapter splitting

**Files:**
- Create: `src/tools/chapter-markdown.ts`
- Test: `src/tools/chapter-markdown.test.ts`

**No `src/index.ts` change** — pure text-processing helpers, no MCP tool.

**Interfaces:**
- Consumes: nothing outside this file (pure string/array manipulation).
- Produces: `ChapterFragment` interface (`{ number: number; title: string; body: string[] }`); `parseChaptersFromMarkdown(raw: string): [ChapterFragment[], number]` (chapters + duplicate-marker count); `splitProseParagraphs(text: string): string[]`; `fragmentToXHTML(f: ChapterFragment): string`; `chaptersToXHTML(frags: ChapterFragment[]): string`; `autoDetectMarkdown(content: string): boolean`; `isXHTML(content: string): boolean`; `escapeXHTML(s: string): string`; `isChapterMarker(line: string): boolean` — all consumed by `edit-chapter.ts` (this phase) and `manuscript-parse.ts`/`convert-manuscript.ts` (this phase, for `splitProseParagraphs`/`chaptersToXHTML`/`ChapterFragment`).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/chapter-markdown.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/chapter-markdown.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/chapter-markdown.ts`**

```typescript
/**
 * Plaintext-markdown-to-XHTML chapter splitting: the "# Chapter N" /
 * "## \"Title\"" marker format edit_chapter's create action parses when
 * given prose instead of pre-formatted XHTML. Mirrors Go's
 * tools/chapter_markdown.go.
 */

/** The parsed contents of a single chapter from raw prose text. number is 0 if no "# Chapter N" marker was found. */
export interface ChapterFragment {
  number: number;
  title: string;
  body: string[];
}

/**
 * Splits raw prose text into per-chapter fragments, deduplicating any
 * repeated "# Chapter N" markers so at most one chapter heading is kept
 * per number. Returns the ordered fragments and the number of duplicate
 * markers removed (0 if none were found).
 */
export function parseChaptersFromMarkdown(raw: string): [ChapterFragment[], number] {
  const [deduped, duplicates] = deduplicateChapterMarkers(raw);
  const chapters = splitIntoChapters(deduped);
  return [chapters, duplicates];
}

/** Splits text that already has unique "# Chapter N" markers into per-chapter fragments. */
function splitIntoChapters(text: string): ChapterFragment[] {
  const lines = text.split("\n");

  interface ChapterPos {
    markerLine: number;
    titleLine: number; // -1 if none
  }
  const positions: ChapterPos[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isChapterMarker(lines[i]!)) {
      const pos: ChapterPos = { markerLine: i, titleLine: -1 };
      if (i + 1 < lines.length && isChapterTitle(lines[i + 1]!)) pos.titleLine = i + 1;
      positions.push(pos);
    }
  }

  if (positions.length === 0) {
    return [{ number: 0, title: "", body: splitProseParagraphs(text) }];
  }

  const chapters: ChapterFragment[] = [];
  for (let pi = 0; pi < positions.length; pi++) {
    const { markerLine, titleLine } = positions[pi]!;
    const bodyStart = titleLine >= 0 ? titleLine + 1 : markerLine + 1;
    const endLine = pi + 1 < positions.length ? positions[pi + 1]!.markerLine : lines.length;

    const body = splitProseParagraphs(lines.slice(bodyStart, endLine).join("\n"));
    const frag: ChapterFragment = { number: extractChapterNumber(lines[markerLine]!), title: "", body };
    if (titleLine >= 0) frag.title = extractChapterTitle(lines[titleLine]!);
    chapters.push(frag);
  }

  return chapters;
}

/** Reports whether line starts with "# Chapter" followed by a digit. */
export function isChapterMarker(line: string): boolean {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("# chapter")) return false;
  const rest = lower.slice("# chapter".length);
  return rest.length > 0 && rest[0]! >= "0" && rest[0]! <= "9";
}

/** Reports whether line matches `## "Title"`. */
function isChapterTitle(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.toLowerCase().startsWith("## ")) return false;
  const content = trimmed.slice(3).trim();
  return content.length > 0 && content[0] === '"';
}

/** Parses the chapter number from a marker line like "# Chapter 1". */
function extractChapterNumber(line: string): number {
  let s = line.trim().replace(/^#+/, "").trim().toLowerCase();
  if (s.startsWith("chapter")) s = s.slice("chapter".length);
  s = s.trim();
  const match = /^\d+/.exec(s);
  return match ? Number.parseInt(match[0], 10) : 0;
}

/**
 * Parses the title from a line like `## "The Title"`. Strips the `## `
 * prefix case-insensitively but preserves the original case of the
 * extracted content — see Global Constraints for why this deviates from
 * a literal port of Go's extractChapterTitle, which silently lowercases
 * the whole title.
 */
function extractChapterTitle(line: string): string {
  const trimmed = line.trim();
  const withoutPrefix = trimmed.toLowerCase().startsWith("## ") ? trimmed.slice(3) : trimmed;
  const content = withoutPrefix.trim();
  if (content.length >= 2 && content[0] === '"' && content[content.length - 1] === '"') {
    return content.slice(1, -1);
  }
  return content;
}

/** Collapses repeated "# Chapter N" lines so each number appears at most once, keeping the first occurrence. */
function deduplicateChapterMarkers(text: string): [string, number] {
  const lines = text.split("\n");
  const seen = new Set<number>();
  const out: string[] = [];
  let duplicates = 0;

  for (const line of lines) {
    if (isChapterMarker(line)) {
      const num = extractChapterNumber(line);
      if (seen.has(num)) {
        duplicates++;
        continue;
      }
      seen.add(num);
    }
    out.push(line);
  }
  return [out.join("\n"), duplicates];
}

/**
 * Splits prose text into body paragraphs. Blank lines, "***"/"*****"
 * separators, and "---" horizontal rules become paragraph boundaries.
 * Leading whitespace — &nbsp;&nbsp;, regular spaces, or non-breaking
 * spaces — is stripped so paragraphs don't start with indentation
 * artifacts.
 */
export function splitProseParagraphs(text: string): string[] {
  const lines = text.split("\n");
  const paragraphs: string[] = [];
  let buf = "";

  for (const rawLine of lines) {
    let line = rawLine;
    let trimmed = line.trim();
    if (trimmed === "" || trimmed === "***" || trimmed === "*****" || trimmed === "---") {
      if (buf.length > 0) {
        paragraphs.push(flushParagraph(buf));
        buf = "";
      }
      continue;
    }

    while (true) {
      if (line.startsWith("&nbsp;&nbsp;")) {
        line = line.slice(12);
        continue;
      }
      if (line.length >= 2 && line[0] === " " && line[1] === " ") {
        line = line.slice(2);
        continue;
      }
      break;
    }

    trimmed = line.trim();
    if (trimmed === "") continue;

    if (buf.length > 0) buf += " ";
    buf += trimmed;
  }

  if (buf.length > 0) paragraphs.push(flushParagraph(buf));

  return paragraphs;
}

/** Collapses internal whitespace (spaces and tabs) into single spaces while preserving HTML entities like &mdash; or &nbsp;. */
function flushParagraph(s: string): string {
  s = s.trim();
  let out = "";
  let inEntity = false;
  for (const ch of s) {
    if (ch === "&") {
      inEntity = true;
      out += ch;
      continue;
    }
    if (inEntity) {
      out += ch;
      if (ch === ";") inEntity = false;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (out.length > 0 && out[out.length - 1] !== " ") out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Converts a single ChapterFragment into XHTML markup for an EPUB content document. The heading is optional — only body paragraphs are required. */
export function fragmentToXHTML(f: ChapterFragment): string {
  let b = "";
  if (f.number > 0 || f.title !== "") {
    b += "<h2>";
    if (f.number > 0) {
      b += `Chapter ${f.number}`;
      if (f.title !== "") b += ": ";
    }
    if (f.title !== "") b += f.title;
    b += "</h2>\n";
  }
  for (const para of f.body) {
    b += `<p>${escapeXHTML(para)}</p>\n`;
  }
  return b;
}

/** Converts a list of ChapterFragments into a complete XHTML document for an EPUB content page. */
export function chaptersToXHTML(frags: ChapterFragment[]): string {
  let b = "";
  for (const f of frags) b += fragmentToXHTML(f);

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n` +
    `<head>\n<meta charset="UTF-8"/>\n<title>Chapter</title>\n` +
    `<link rel="stylesheet" type="text/css" href="../styles/style.css"/>\n</head>\n<body>\n` +
    b +
    `</body>\n</html>`
  );
}

/** Reports whether content looks like the plaintext-markdown chapter format — at least one "# Chapter N" marker. */
export function autoDetectMarkdown(content: string): boolean {
  return content.split("\n").some((line) => isChapterMarker(line));
}

/** Reports whether content is (already) XHTML markup, detected by its first non-whitespace character being "<". */
export function isXHTML(content: string): boolean {
  return content.trim().startsWith("<");
}

/** Escapes only the characters illegal in XHTML text content: < becomes &lt;, & becomes &amp;. Other entities pass through unchanged. */
export function escapeXHTML(s: string): string {
  let out = "";
  let inEntity = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "&" && !inEntity) {
      out += "&amp;";
      inEntity = true;
      continue;
    }
    if (inEntity) {
      if (ch === ";") inEntity = false;
      out += ch;
      continue;
    }
    if (ch === "<") {
      out += "&lt;";
      continue;
    }
    out += ch;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/chapter-markdown.test.ts`
Expected: PASS, including the mixed-case-title test — this is the test that proves the deliberate deviation from Go's buggy `extractChapterTitle`.

- [ ] **Step 5: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 6: Commit**

```bash
git add src/tools/chapter-markdown.ts src/tools/chapter-markdown.test.ts
git commit -m "Add plaintext-markdown-to-XHTML chapter splitting (chapter-markdown.ts)"
```

---

### Task 2: `edit_chapter` tool

**Files:**
- Create: `src/tools/edit-chapter.ts`
- Test: `src/tools/edit-chapter.test.ts`
- Modify: `src/index.ts` (add `import "./tools/edit-chapter.ts";`)

**Interfaces:**
- Consumes: `epubCache`, `evictionNote`, `resolveArg`, `removeMatching` (`./idlist.ts`), `archiveIdInUse`/`manifestIdCandidate`/`uniqueManifestId` (`./edit-resource.ts`, Phase 4 — see Global Constraints), `syncTocOnChapterCreate`/`syncTocOnChapterRemove` (`./nav-sync.ts`, Phase 5), `autoDetectMarkdown`/`isXHTML`/`parseChaptersFromMarkdown`/`chaptersToXHTML`/`ChapterFragment` (`./chapter-markdown.ts`, this phase's Task 1), `primaryPackage`/`manifestItemByHref`/`relativeHref` (`../epub/resolve.ts`), `validateXHTML` (`../epub/validate.ts`, Phase 2), `Epub`/`Package` types (`../epub/types.ts`).
- Produces: `editChapterTool`/`handleEditChapter` (registered as `edit_chapter`); `insertChapter(e, pkg, id, content, label): boolean` (consumed by `convert-manuscript.ts`, this phase's Task 5, and a future phase's `save-epub.ts`); `deleteChapterDocument(e, pkg, id): { previousLength: number; tocSynced: boolean; ok: boolean }` (consumed by `convert-manuscript.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/edit-chapter.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { deleteChapterDocument, handleEditChapter, insertChapter } from "./edit-chapter.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-chapter-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Chapter Test", "Author"), path);
  return { dir, path };
}

const VALID_XHTML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>C</title></head><body><p>Hello.</p></body></html>';

describe("edit_chapter", () => {
  test("create with XHTML content adds a chapter and a matching toc entry", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.tocSynced).toBe(true);

    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments["text/ch1.xhtml"]?.markup).toBe(VALID_XHTML);
    const toc = cached.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(1);
    expect(toc.items[0]?.href).toBe("text/ch1.xhtml");

    await rm(dir, { recursive: true, force: true });
  });

  test("create rejects malformed XHTML with no chapter markers", async () => {
    const { dir, path } = await writeTempBook();
    await expect(
      handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: "<p>unclosed" }),
    ).rejects.toThrow("not well-formed XHTML");
    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if id already exists", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML });
    await expect(
      handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML }),
    ).rejects.toThrow("already exists");
    await rm(dir, { recursive: true, force: true });
  });

  test("create with markdown content auto-detects and splits into multiple chapters", async () => {
    const { dir, path } = await writeTempBook();
    const markdown = ["# Chapter 1", "First body.", "", "# Chapter 2", "Second body."].join("\n");

    const result = await handleEditChapter(fakeServer, { action: "create", path, id: "text/chapter-1.xhtml", content: markdown });

    const createdIds = result.structuredContent?.createdIds as string[];
    expect(createdIds).toHaveLength(2);

    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[createdIds[0]!]?.markup).toContain("First body.");
    expect(cached.contentDocuments[createdIds[1]!]?.markup).toContain("Second body.");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces an existing chapter's markup", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML });
    const updated = VALID_XHTML.replace("Hello.", "Updated.");

    const result = await handleEditChapter(fakeServer, { action: "edit", path, id: "text/ch1.xhtml", content: updated });

    expect(result.structuredContent?.previousLength).toBe(VALID_XHTML.length);
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments["text/ch1.xhtml"]?.markup).toBe(updated);

    await rm(dir, { recursive: true, force: true });
  });

  test("edit fails for an unknown id", async () => {
    const { dir, path } = await writeTempBook();
    await expect(
      handleEditChapter(fakeServer, { action: "edit", path, id: "no/such.xhtml", content: VALID_XHTML }),
    ).rejects.toThrow("no/such.xhtml");
    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes the chapter, its manifest/spine entries, and its toc entry", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML });

    const result = await handleEditChapter(fakeServer, { action: "remove", path, id: "text/ch1.xhtml" });

    expect(result.structuredContent?.tocSynced).toBe(true);
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments["text/ch1.xhtml"]).toBeUndefined();
    const pkg = primaryPackage(cached)!;
    expect(pkg.manifest.items.some((i) => i.href === "text/ch1.xhtml")).toBe(false);
    const toc = cached.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("insertChapter", () => {
  test("adds a manifest item, spine entry, content document, and toc entry", () => {
    const e = newEpub("Insert Chapter Test", "Author");
    const pkg = primaryPackage(e)!;

    const tocSynced = insertChapter(e, pkg, "text/ch1.xhtml", VALID_XHTML, "My Chapter");

    expect(tocSynced).toBe(true);
    expect(pkg.manifest.items.some((i) => i.href === "text/ch1.xhtml")).toBe(true);
    expect(pkg.spine.itemRefs).toHaveLength(2); // nav + new chapter
    expect(e.contentDocuments["text/ch1.xhtml"]?.markup).toBe(VALID_XHTML);
  });
});

describe("deleteChapterDocument", () => {
  test("returns ok:false for an id that doesn't exist", () => {
    const e = newEpub("Delete Chapter Test", "Author");
    const pkg = primaryPackage(e)!;
    expect(deleteChapterDocument(e, pkg, "no/such.xhtml")).toEqual({ previousLength: 0, tocSynced: false, ok: false });
  });

  test("removes the document, manifest item, and spine entry", () => {
    const e = newEpub("Delete Chapter Test 2", "Author");
    const pkg = primaryPackage(e)!;
    insertChapter(e, pkg, "text/ch1.xhtml", VALID_XHTML, "My Chapter");

    const del = deleteChapterDocument(e, pkg, "text/ch1.xhtml");

    expect(del.ok).toBe(true);
    expect(del.previousLength).toBe(VALID_XHTML.length);
    expect(e.contentDocuments["text/ch1.xhtml"]).toBeUndefined();
    expect(pkg.manifest.items.some((i) => i.href === "text/ch1.xhtml")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/edit-chapter.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/edit-chapter.ts`**

```typescript
/**
 * edit_chapter — create, edit, or remove one content document (chapter/
 * section). Mirrors Go's tools/edit_chapter.go.
 *
 * manifestIdCandidate/uniqueManifestId are imported from ./edit-resource.ts
 * rather than defined here, even though Go defines them in
 * tools/edit_chapter.go (edit_resource.go's createResource calls them
 * cross-file via Go's flat package namespace). This TS port already placed
 * both in edit-resource.ts during Phase 4; since that's already merged and
 * tested, this file imports from there instead of relocating shipped code.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  autoDetectMarkdown,
  chaptersToXHTML,
  isXHTML,
  parseChaptersFromMarkdown,
  type ChapterFragment,
} from "./chapter-markdown.ts";
import { resolveArg } from "./elicit.ts";
import { archiveIdInUse, manifestIdCandidate, uniqueManifestId } from "./edit-resource.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { removeMatching } from "./idlist.ts";
import { syncTocOnChapterCreate, syncTocOnChapterRemove } from "./nav-sync.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemByHref, primaryPackage, relativeHref } from "../epub/resolve.ts";
import { validateXHTML } from "../epub/validate.ts";
import type { Epub, Package } from "../epub/types.ts";

interface EditChapterArgs {
  action?: string;
  path?: string;
  id?: string;
  content?: string;
  label?: string;
}

interface EditChapterResult {
  action: string;
  id: string;
  previousLength?: number;
  newLength?: number;
  tocSynced?: boolean;
  createdIds?: string[];
}

export const editChapterTool: EpubTool = {
  name: "edit_chapter",
  description: "Create, edit, or remove one content document (chapter/section) of an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a new chapter, "edit" an existing one, or "remove" one' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: "content document id: the new chapter's archive path for create, or an existing one's id for edit/remove" },
      content: { type: "string", description: "new XHTML markup for the chapter; used by create and edit, ignored by remove" },
      label: { type: "string", description: "table-of-contents entry text for this chapter; used only by create, auto-derived from id if omitted" },
    },
  },
};

function idPrompt(action: string): string {
  if (action === "create") return 'What archive path should the new chapter be saved at (e.g. "OEBPS/text/chapter-18.xhtml")?';
  return "Which chapter should be affected? Provide its content document id (see read_epub's contentDocuments list).";
}

export async function handleEditChapter(server: Server, args: EditChapterArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const id = await resolveArg(server, args.id, "id", idPrompt(action));

  let content = "";
  if (action !== "remove") {
    content = await resolveArg(server, args.content, "content", "What should this chapter's content be? Leave blank if you don't have text yet.");
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);

  let outcome: { summary: string; result: EditChapterResult };
  switch (action) {
    case "create":
      if (autoDetectMarkdown(content) && !isXHTML(content)) {
        outcome = createChaptersFromMarkdown(e, abs, id, content, eviction);
      } else {
        try {
          validateXHTML(content);
        } catch {
          throw new Error(
            'content is not well-formed XHTML and does not contain "# Chapter N" markers — either provide valid XHTML or markdown with chapter headers',
          );
        }
        outcome = createChapter(e, abs, id, content, args.label ?? "", eviction);
      }
      break;
    case "edit":
      outcome = editExistingChapter(e, abs, id, content, eviction);
      break;
    case "remove":
      outcome = removeChapter(e, abs, id, eviction);
      break;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  epubCache.markDirty(abs);
  return {
    content: [{ type: "text", text: outcome.summary }],
    structuredContent: outcome.result as unknown as Record<string, unknown>,
  };
}

function createChapter(
  e: Epub,
  absPath: string,
  id: string,
  content: string,
  label: string,
  eviction: import("../epub/cache.ts").Eviction | undefined,
): { summary: string; result: EditChapterResult } {
  if (archiveIdInUse(e, id)) throw new Error(`${JSON.stringify(id)} already exists in this book; use action "edit" instead`);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(absPath)} has no package document to add a chapter to`);

  const tocSynced = insertChapter(e, pkg, id, content, label);

  const result: EditChapterResult = { action: "create", id, newLength: content.length, tocSynced };
  const tocNote = tocSynced ? " Added a matching toc entry to the navigation document." : " No navigation document to add a toc entry to.";
  const summary = `Created ${JSON.stringify(id)} in ${JSON.stringify(absPath)} (${content.length} characters), appended to the end of the manifest and spine.${tocNote} Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { summary, result };
}

function editExistingChapter(
  e: Epub,
  absPath: string,
  id: string,
  content: string,
  eviction: import("../epub/cache.ts").Eviction | undefined,
): { summary: string; result: EditChapterResult } {
  const doc = e.contentDocuments[id];
  if (!doc) throw new Error(`no content document with id ${JSON.stringify(id)} in ${JSON.stringify(absPath)}; call read_epub to list valid ids`);

  const previousLength = doc.markup.length;
  doc.markup = content;

  const result: EditChapterResult = { action: "edit", id, previousLength, newLength: content.length };
  const summary = `Updated ${JSON.stringify(id)} in ${JSON.stringify(absPath)} (${previousLength} -> ${content.length} characters). Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { summary, result };
}

function removeChapter(
  e: Epub,
  absPath: string,
  id: string,
  eviction: import("../epub/cache.ts").Eviction | undefined,
): { summary: string; result: EditChapterResult } {
  const del = deleteChapterDocument(e, primaryPackage(e), id);
  if (!del.ok) throw new Error(`no content document with id ${JSON.stringify(id)} in ${JSON.stringify(absPath)}; call read_epub to list valid ids`);

  const result: EditChapterResult = { action: "remove", id, previousLength: del.previousLength, tocSynced: del.tocSynced };
  const tocNote = del.tocSynced ? " Removed its matching toc entry from the navigation document." : "";
  const summary = `Removed ${JSON.stringify(id)} from ${JSON.stringify(absPath)} (${del.previousLength} characters).${tocNote} Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { summary, result };
}

function createChaptersFromMarkdown(
  e: Epub,
  absPath: string,
  id: string,
  content: string,
  eviction: import("../epub/cache.ts").Eviction | undefined,
): { summary: string; result: EditChapterResult } {
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(absPath)} has no package document to add chapters to`);

  const [fragments, duplicatesRemoved] = parseChaptersFromMarkdown(content);
  if (fragments.length === 0) throw new Error('no chapters found in content — does it contain "# Chapter N" markers?');

  const baseId = deriveChapterBase(id);
  const createdIds: string[] = [];
  let totalChars = 0;

  fragments.forEach((frag, i) => {
    let chapterId = baseId;
    if (fragments.length > 1 || (frag.number > 0 && baseHasNoNumber(baseId))) {
      const stem = stripExtension(basename(id));
      let dir = "";
      const slash = id.lastIndexOf("/");
      if (slash >= 0) dir = id.slice(0, slash);
      chapterId = `${dir}/${stem}-${i + 1}.xhtml`;
    }

    const markup = chaptersToXHTML([frag]);
    const tocSynced = insertChapter(e, pkg, chapterId, markup, "");
    totalChars += markup.length;
    createdIds.push(chapterId);

    if (tocSynced && i === 0) {
      let label = `Chapter ${frag.number}`;
      if (frag.title !== "") {
        label += `: ${frag.title}`;
      } else if (!baseHasNoNumber(baseId) && baseId !== "") {
        label = stripExtension(basename(id));
      }
      syncTocOnChapterCreate(e, pkg, chapterId, label);
    }
  });

  const result: EditChapterResult = {
    action: "create",
    id: createdIds[0]!,
    createdIds,
    newLength: totalChars,
    tocSynced: true,
  };

  let summary = `Parsed ${fragments.length} chapters from markdown (removed ${duplicatesRemoved} duplicate markers). Created:`;
  for (const cid of createdIds) summary += `\n  - ${JSON.stringify(cid)}`;
  summary += `\nTotal: ${totalChars} characters. Call save_epub to persist this to disk.${evictionNote(eviction)}`;

  return { summary, result };
}

function basename(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Extracts the "stem" from an id like "OEBPS/text/chapter-1.xhtml" -> "chapter". */
function deriveChapterBase(id: string): string {
  const name = stripExtension(basename(id));
  let out = "";
  for (const ch of name) {
    if (/[a-zA-Z_]/.test(ch)) {
      out += ch;
    } else {
      break;
    }
  }
  return out.length > 0 ? out : name;
}

/** Reports whether a chapter stem (like "chapter" or "text") has no digits. */
function baseHasNoNumber(stem: string): boolean {
  return !/\d/.test(stem);
}

/**
 * Removes id's content document, manifest entry, spine entry, and any toc
 * entry targeting it from e — the shared core of removeChapter and
 * convert_manuscript's leftover-chapter cleanup. Returns the content
 * document's markup length and whether its toc entry was synced, plus
 * whether id was found at all.
 */
export function deleteChapterDocument(e: Epub, pkg: Package | undefined, id: string): { previousLength: number; tocSynced: boolean; ok: boolean } {
  const doc = e.contentDocuments[id];
  if (!doc) return { previousLength: 0, tocSynced: false, ok: false };
  const previousLength = doc.markup.length;

  let tocSynced = false;
  if (pkg) {
    tocSynced = syncTocOnChapterRemove(e, pkg, id);
    const item = manifestItemByHref(pkg, id);
    if (item) {
      const prefix = pkg.manifest.id + "/";
      const opfId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
      pkg.manifest.items = removeMatching(pkg.manifest.items, (it) => it.id !== item.id);
      pkg.spine.itemRefs = removeMatching(pkg.spine.itemRefs, (ref) => ref.idRef !== opfId);
    }
  }

  delete e.contentDocuments[id];
  return { previousLength, tocSynced, ok: true };
}

/**
 * Adds a new content document at id, with the given content and (if a
 * navigation document exists) a matching top-level toc entry, to e's
 * manifest and spine. Shared by createChapter and a future save_epub's
 * fallback that ensures a book being saved has at least one content
 * document. Returns whether the toc entry was added.
 */
export function insertChapter(e: Epub, pkg: Package, id: string, content: string, label: string): boolean {
  const opfId = uniqueManifestId(pkg, manifestIdCandidate(id));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${opfId}`,
    href: relativeHref(pkg, id),
    mediaType: "application/xhtml+xml",
    properties: [],
    fallback: "",
    mediaOverlay: "",
  });
  pkg.spine.itemRefs.push({
    id: `${pkg.spine.id}/itemref[${pkg.spine.itemRefs.length}]`,
    idRef: opfId,
    linear: true,
    properties: [],
  });
  e.contentDocuments[id] = { id, mediaType: "application/xhtml+xml", markup: content };
  return syncTocOnChapterCreate(e, pkg, id, label);
}

registerTool(
  editChapterTool,
  "Converting a whole existing manuscript file (.txt/.md/.html) into a book's chapters in one call is what " +
    "convert_manuscript is for — it's the more expedient tool when the goal is ingesting an entire book at " +
    "once, rather than looping edit_chapter create calls one chapter at a time.\n\n" +
    'Takes action ("create", "edit", or "remove"), path (the .epub filesystem path passed to read_epub), ' +
    "id, and content. Any of these may be omitted, in which case the user is prompted for it directly; a " +
    "blank answer to that prompt is accepted as given rather than re-prompted or rejected, since it means " +
    "the user doesn't have that information yet — it then fails validation just as a directly-passed blank " +
    "value would (e.g. action must still end up one of the three valid choices).\n\n" +
    'action "create": id is the archive path the new chapter should be saved at (e.g. ' +
    '"OEBPS/text/chapter-18.xhtml"). It\'s added to the manifest and appended to the end of the spine ' +
    "reading order, content becomes its initial markup, and it's appended as a new entry to the navigation " +
    'document\'s "toc" list (label, if given, or else auto-derived from id, e.g. "chapter-18.xhtml" -> ' +
    '"Chapter 18") — the same list read_epub\'s tableOfContents and get_navigation report. Use ' +
    "edit_navigation afterwards if you want to rename, reorder, or nest that entry instead of accepting " +
    "the default. create only ever adds a brand-new chapter — it never updates one that already exists, so " +
    'it fails outright if id is already in use; use "edit" instead to change that chapter\'s content.\n\n' +
    'When creating chapters from raw text (not pre-formatted XHTML), pass the prose with "# Chapter N" ' +
    "markers — one per chapter. The parser deduplicates any repeated \"# Chapter N\" markers, extracts " +
    'each chapter\'s optional title line ("## Title") and body paragraphs, then creates a separate XHTML ' +
    'document for every chapter it finds using id as a template (e.g. id="chapter-1.xhtml" produces ' +
    'chapter-1.xhtml, chapter-2.xhtml, ...). An explicit label overrides the auto-derived one.\n\n' +
    "-- Submission Formatting --\n\n" +
    'The chapter\'s "content" argument accepts two formats: plaintext markdown or full XHTML. The server ' +
    'auto-detects which format you\'re using based on whether it finds a "# Chapter N" marker.\n\n' +
    'Plaintext — pass raw prose with "# Chapter N" markers:\n\n' +
    "# Chapter N              <- chapter marker; only the first occurrence of each number is kept\n" +
    '## "Chapter Title"       <- optional title line on the next row, wrapped in double quotes\n\n' +
    "Body paragraph text begins here. Leading spaces or tabs on every row are stripped automatically and " +
    "consecutive lines are joined into a single <p> element.\n\n" +
    "Additional paragraphs (repeat as needed)...\n\n" +
    "<empty line or any separator ends this chapter body>\n\n" +
    "Rules for plaintext:\n" +
    '- Each "# Chapter N" marker starts a new chapter document. If the same number appears more than once ' +
    "only the first is kept — duplicates are silently removed.\n" +
    '- The optional "## Title" on the row immediately after the marker becomes an <h2> heading; omit it ' +
    "for chapters without titles.\n" +
    '- Everything between the (optional) title and the next "# Chapter N" (or EOF) is body text. Blank ' +
    "lines produce paragraph boundaries — consecutive non-blank lines are joined into a single <p>.\n" +
    "- Leading whitespace on every line is stripped so paragraphs don't start with indentation artifacts. " +
    "Whether that whitespace is regular spaces, tabs, &nbsp;&nbsp; (HTML entity), or non-breaking-space " +
    "characters doesn't matter — all leading whitespace is removed.\n" +
    '- If no "# Chapter N" markers are found the entire input is treated as a single chapter with no ' +
    "heading — just <p> elements.\n\n" +
    "HTML submissions — pass complete XHTML, e.g.:\n\n" +
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n' +
    "<head>\n<meta charset=\"UTF-8\"/>\n<title>Chapter Title</title>\n" +
    '<link rel="stylesheet" type="text/css" href="../styles/style.css"/>\n</head>\n<body>\n' +
    "<h1>Chapter Heading (optional)</h1>\n<p>First paragraph of body text.</p>\n</body>\n</html>\n\n" +
    "Rules for HTML:\n" +
    "- Content must be well-formed XHTML — it is validated before acceptance. Self-closing tags (<br/>, " +
    "<img .../>) and named entities (&mdash;, &amp;) are supported because real EPUB content documents " +
    "use them.\n" +
    "- The entire markup replaces the chapter's existing document verbatim — no automatic heading or " +
    "paragraph wrapping is applied. You control every element yourself.\n" +
    "- No chapter-marker parsing occurs; everything you pass is treated as one complete XHTML document.\n\n" +
    "action \"edit\": id must be an existing content document id, from read_epub's contentDocuments list; " +
    "content entirely replaces its markup. The toc entry (if any) is left untouched — use edit_navigation " +
    "to rename it.\n\n" +
    'action "remove": id must be an existing content document id; content is ignored. Its content ' +
    "document, manifest entry, spine entry, and any top-level toc entry targeting it are all deleted.\n\n" +
    "All three actions only touch the in-memory cache; call save_epub afterwards to write the result to disk.",
  handleEditChapter as never,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/edit-chapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/edit-chapter.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/edit-chapter.ts src/tools/edit-chapter.test.ts src/index.ts
git commit -m "Add edit_chapter tool"
```

---

### Task 3: `get_chapter` tool

**Files:**
- Create: `src/tools/get-chapter.ts`
- Test: `src/tools/get-chapter.test.ts`
- Modify: `src/index.ts` (add `import "./tools/get-chapter.ts";`)

**Interfaces:**
- Consumes: `epubCache`, `evictionNote`, `plainText` (`../epub/text.ts`, Phase 2).
- Produces: `getChapterTool`/`handleGetChapter` (registered as `get_chapter`). No further exports consumed elsewhere.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/get-chapter.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetChapter } from "./get-chapter.ts";
import { handleEditChapter } from "./edit-chapter.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

const VALID_XHTML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>C</title></head><body><h1>Chapter 1</h1><p>Hello world.</p></body></html>';

describe("get_chapter", () => {
  test("returns both text and markup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-chapter-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Get Chapter Test", "Author"), path);
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML });

    const result = await handleGetChapter(fakeServer, { path, id: "text/ch1.xhtml" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.markup).toBe(VALID_XHTML);
    expect(result.structuredContent?.text).toContain("Hello world.");
    expect(result.structuredContent?.mediaType).toBe("application/xhtml+xml");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when id doesn't name a content document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-chapter-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Get Chapter Missing Test", "Author"), path);

    await expect(handleGetChapter(fakeServer, { path, id: "no/such.xhtml" })).rejects.toThrow("no/such.xhtml");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path or id is missing", async () => {
    await expect(handleGetChapter(fakeServer, { path: "", id: "x" })).rejects.toThrow("path is required");
    await expect(handleGetChapter(fakeServer, { path: "x", id: "" })).rejects.toThrow("id is required");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/get-chapter.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/get-chapter.ts`**

```typescript
/**
 * get_chapter — read one content document by its id. Mirrors Go's
 * tools/get_chapter.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { plainText } from "../epub/text.ts";

interface GetChapterArgs {
  path: string;
  id: string;
}

interface GetChapterResult {
  id: string;
  mediaType: string;
  text: string;
  markup: string;
}

export const getChapterTool: EpubTool = {
  name: "get_chapter",
  description: "Read one content document (chapter/section) of an already-read EPUB by its id. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: 'content document id (archive path) to read, e.g. one of the entries in read_epub\'s contentDocuments list' },
    },
    required: ["path", "id"],
  },
};

export async function handleGetChapter(_server: Server, args: GetChapterArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  if (!args.id?.trim()) throw new Error("id is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const doc = e.contentDocuments[args.id];
  if (!doc) throw new Error(`no content document with id ${JSON.stringify(args.id)} in ${JSON.stringify(abs)}; call read_epub to list valid ids`);

  const text = plainText(doc.markup);
  const result: GetChapterResult = { id: args.id, mediaType: doc.mediaType, text, markup: doc.markup };
  const summary = `Read ${JSON.stringify(args.id)} (${text.length} characters).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  getChapterTool,
  "Takes path, the same .epub filesystem path passed to read_epub, and id, one of the archive-path ids " +
    "from that call's contentDocuments list (or from a table-of-contents entry's href, with any " +
    "\"#fragment\" removed). Loads the EPUB through the same cache read_epub uses, so calling read_epub " +
    "first isn't required but is cheap either way. Returns both text — the chapter's prose with markup " +
    "stripped, paragraphs separated by blank lines — and markup — the raw XHTML, for when exact markup is " +
    "needed rather than plain reading text. Fails if id doesn't name a content document in this book; " +
    "re-check the ids from read_epub if so.",
  handleGetChapter as never,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/get-chapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/get-chapter.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/get-chapter.ts src/tools/get-chapter.test.ts src/index.ts
git commit -m "Add get_chapter tool"
```

---

### Task 4: `manuscript-parse.ts` — whole-manuscript chapter splitting

**Files:**
- Create: `src/tools/manuscript-parse.ts`
- Test: `src/tools/manuscript-parse.test.ts`

**No `src/index.ts` change** — pure text-processing helpers, no MCP tool.

**Interfaces:**
- Consumes: `ChapterFragment`, `splitProseParagraphs` (`./chapter-markdown.ts`, this phase's Task 1).
- Produces: `detectManuscriptFormat(sourcePath): "html" | "text"`, `stripHtmlTags(raw): string`, `splitManuscriptChapters(text): ChapterFragment[]` — all consumed by `convert-manuscript.ts` (this phase's Task 5).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/manuscript-parse.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/manuscript-parse.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/manuscript-parse.ts`**

```typescript
/**
 * Whole-manuscript chapter splitting for convert_manuscript: looser
 * chapter-marker matching than chapter-markdown.ts's "# Chapter N" (which
 * requires a leading "# " and nothing else) — real manuscripts number
 * chapters as bare lines ("Chapter 12", "Chapter 12: The Storm") in plain
 * text, or as markdown ATX headings ("# Chapter 12") when the source is a
 * .md file. Mirrors Go's tools/manuscript_parse.go.
 */
import { extname } from "node:path";
import { splitProseParagraphs, type ChapterFragment } from "./chapter-markdown.ts";

const MANUSCRIPT_CHAPTER_MARKER = /^#*\s*chapter\s+(\d+)\b\.?:?\s*(.*)$/i;
const HTML_SCRIPT_STYLE = /<(script|style)[^>]*>[\s\S]*?<\/(script|style)>/gi;
const HTML_BLOCK_BREAK = /<\/(p|div|h[1-6]|li|br|tr)\s*>/gi;
const HTML_TAG = /<[^>]+>/g;
const MANUSCRIPT_TITLE_HEADING = /^#+\s*(.+)$/;

/** Classifies sourcePath by extension: "html" for .html/.htm, "text" for everything else. */
export function detectManuscriptFormat(sourcePath: string): "html" | "text" {
  const ext = extname(sourcePath).toLowerCase();
  return ext === ".html" || ext === ".htm" ? "html" : "text";
}

/**
 * Reduces raw HTML to plain text suitable for splitManuscriptChapters:
 * <script>/<style> blocks are dropped entirely, block-level closing tags
 * become line breaks (so paragraphs don't run together), and every
 * remaining tag is removed. Named entities are left alone.
 */
export function stripHtmlTags(raw: string): string {
  let s = raw.replace(HTML_SCRIPT_STYLE, "");
  s = s.replace(HTML_BLOCK_BREAK, "\n");
  s = s.replace(HTML_TAG, "");
  return s;
}

/**
 * Splits raw manuscript text into ChapterFragments wherever a line looks
 * like "Chapter <number>". If no marker is found, the entire text becomes
 * a single fragment with no chapter number. Repeated markers for the same
 * chapter number are deduplicated, keeping only the first occurrence.
 */
export function splitManuscriptChapters(text: string): ChapterFragment[] {
  const lines = text.split("\n");

  interface Marker {
    markerLine: number;
    bodyStart: number;
    number: number;
    title: string;
  }
  const markers: Marker[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = MANUSCRIPT_CHAPTER_MARKER.exec(lines[i]!.trim());
    if (!m) continue;

    const num = Number.parseInt(m[1]!, 10);
    let title = trimQuotesAndSpaces(m[2]!);
    let bodyStart = i + 1;

    if (title === "") {
      let j = i + 1;
      if (j < lines.length && lines[j]!.trim() === "") j++;
      if (j < lines.length) {
        const tm = MANUSCRIPT_TITLE_HEADING.exec(lines[j]!.trim());
        if (tm) {
          title = trimQuotesAndSpaces(tm[1]!);
          bodyStart = j + 1;
        }
      }
    }

    markers.push({ markerLine: i, bodyStart, number: num, title });
  }

  if (markers.length === 0) {
    return [{ number: 0, title: "", body: splitProseParagraphs(text) }];
  }

  const fragments: ChapterFragment[] = [];
  for (let mi = 0; mi < markers.length; mi++) {
    const mk = markers[mi]!;
    const end = mi + 1 < markers.length ? markers[mi + 1]!.markerLine : lines.length;
    const body = splitProseParagraphs(lines.slice(mk.bodyStart, end).join("\n"));
    fragments.push({ number: mk.number, title: mk.title, body });
  }

  return dedupeFragmentsByNumber(fragments);
}

function trimQuotesAndSpaces(s: string): string {
  return s.replace(/^["' ]+|["' ]+$/g, "");
}

/** Drops every fragment whose number repeats one already seen, keeping the first occurrence. Fragments with number 0 always pass through. */
function dedupeFragmentsByNumber(fragments: ChapterFragment[]): ChapterFragment[] {
  const seen = new Set<number>();
  const out: ChapterFragment[] = [];
  for (const f of fragments) {
    if (f.number > 0) {
      if (seen.has(f.number)) continue;
      seen.add(f.number);
    }
    out.push(f);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/manuscript-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 6: Commit**

```bash
git add src/tools/manuscript-parse.ts src/tools/manuscript-parse.test.ts
git commit -m "Add whole-manuscript chapter splitting (manuscript-parse.ts)"
```

---

### Task 5: `convert_manuscript` tool

**Files:**
- Create: `src/tools/convert-manuscript.ts`
- Test: `src/tools/convert-manuscript.test.ts`
- Modify: `src/index.ts` (add `import "./tools/convert-manuscript.ts";`)

**Interfaces:**
- Consumes: `epubCache`, `evictionNote`, `resolveArg` (`./elicit.ts`), `archiveIdInUse` (`./edit-resource.ts`), `insertChapter`/`deleteChapterDocument` (`./edit-chapter.ts`, this phase's Task 2), `primaryNavigation` (`./get-navigation.ts`, Phase 5), `chaptersToXHTML` (`./chapter-markdown.ts`), `detectManuscriptFormat`/`stripHtmlTags`/`splitManuscriptChapters` (`./manuscript-parse.ts`, this phase's Task 4), `primaryPackage`/`resolveHref` (`../epub/resolve.ts`).
- Produces: `convertManuscriptTool`/`handleConvertManuscript` (registered as `convert_manuscript`). No further exports consumed elsewhere — this is the last tool in the dependency chain this phase builds.

**A note on the "keep or delete leftover chapters" elicitation:** unlike every other tool so far, this one needs a custom elicitation schema (an enum `"keep"`/`"delete"`, not the plain string field `resolveArg` provides) for its one non-`resolveArg` prompt. Call `server.elicitInput` directly for this one case, following `resolveArg`'s own implementation in `src/tools/elicit.ts` as the template for how to shape the call and read back `result.action`/`result.content`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/convert-manuscript.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleConvertManuscript } from "./convert-manuscript.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

function makeFakeServer(elicitResponse?: { action: string; content?: Record<string, unknown> }): Server {
  return {
    elicitInput: async () => elicitResponse ?? { action: "accept", content: { leftoverAction: "keep" } },
  } as unknown as Server;
}

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-convert-manuscript-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Convert Manuscript Test", "Author"), path);
  return { dir, path };
}

describe("convert_manuscript", () => {
  test("splits a manuscript file into chapters and inserts them", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1: The Beginning", "", "First paragraph.", "", "Chapter 2", "", "Second paragraph."].join("\n"));

    const result = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.chaptersFound).toBe(2);
    const createdIds = result.structuredContent?.createdIds as string[];
    expect(createdIds).toHaveLength(2);

    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[createdIds[0]!]?.markup).toContain("First paragraph.");
    expect(cached.contentDocuments[createdIds[1]!]?.markup).toContain("Second paragraph.");

    await rm(dir, { recursive: true, force: true });
  });

  test("strips HTML tags for .html sources", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.html");
    await writeFile(sourcePath, "<html><body><h1>Chapter 1</h1><p>Body text.</p></body></html>");

    const result = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    expect(result.structuredContent?.chaptersFound).toBe(1);
    const createdIds = result.structuredContent?.createdIds as string[];
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[createdIds[0]!]?.markup).toContain("Body text.");

    await rm(dir, { recursive: true, force: true });
  });

  test("replaces an existing chapter in place when its number already exists", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1", "", "Original text."].join("\n"));
    const first = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });
    const originalId = (first.structuredContent?.createdIds as string[])[0]!;

    await writeFile(sourcePath, ["Chapter 1", "", "Replacement text."].join("\n"));
    const second = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    expect(second.structuredContent?.replacedIds).toEqual([originalId]);
    expect(second.structuredContent?.createdIds).toBeUndefined();
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[originalId]?.markup).toContain("Replacement text.");

    await rm(dir, { recursive: true, force: true });
  });

  test("reports leftover chapters and keeps them by default", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1", "", "First.", "", "Chapter 2", "", "Second."].join("\n"));
    await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    await writeFile(sourcePath, ["Chapter 1", "", "Only one chapter now."].join("\n"));
    const result = await handleConvertManuscript(makeFakeServer({ action: "accept", content: { leftoverAction: "" } }), { path, sourcePath });

    expect(result.structuredContent?.leftoverAction).toBe("keep");
    const leftoverIds = result.structuredContent?.leftoverIds as string[];
    expect(leftoverIds).toHaveLength(1);
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[leftoverIds[0]!]).toBeDefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("deletes leftover chapters when the user chooses delete", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1", "", "First.", "", "Chapter 2", "", "Second."].join("\n"));
    await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    await writeFile(sourcePath, ["Chapter 1", "", "Only one chapter now."].join("\n"));
    const result = await handleConvertManuscript(makeFakeServer({ action: "accept", content: { leftoverAction: "delete" } }), { path, sourcePath });

    const leftoverIds = result.structuredContent?.leftoverIds as string[];
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[leftoverIds[0]!]).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when the leftover-action prompt is declined", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1", "", "First.", "", "Chapter 2", "", "Second."].join("\n"));
    await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    await writeFile(sourcePath, ["Chapter 1", "", "Only one now."].join("\n"));
    await expect(
      handleConvertManuscript(makeFakeServer({ action: "decline" }), { path, sourcePath }),
    ).rejects.toThrow("leftover chapter action was not provided");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when the source file has no readable chapters and is empty", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "");

    // An empty file still produces one untitled fragment via
    // splitProseParagraphs/splitManuscriptChapters's no-marker fallback,
    // so this exercises the fallback path rather than a true error —
    // confirm it creates exactly one (empty-bodied) chapter rather than
    // throwing, matching splitManuscriptChapters's documented behavior.
    const result = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });
    expect(result.structuredContent?.chaptersFound).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/convert-manuscript.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/convert-manuscript.ts`**

```typescript
/**
 * convert_manuscript — convert an entire local .txt/.md/.html manuscript
 * file into an EPUB's chapters in one call. Mirrors Go's
 * tools/convert_manuscript.go.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { chaptersToXHTML } from "./chapter-markdown.ts";
import { resolveArg } from "./elicit.ts";
import { archiveIdInUse } from "./edit-resource.ts";
import { deleteChapterDocument, insertChapter } from "./edit-chapter.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { primaryNavigation } from "./get-navigation.ts";
import { detectManuscriptFormat, splitManuscriptChapters, stripHtmlTags } from "./manuscript-parse.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage, resolveHref } from "../epub/resolve.ts";
import type { Epub, Package } from "../epub/types.ts";

interface ConvertManuscriptArgs {
  path?: string;
  sourcePath?: string;
}

interface ConvertManuscriptResult {
  path: string;
  sourcePath: string;
  chaptersFound: number;
  createdIds?: string[];
  replacedIds?: string[];
  leftoverIds?: string[];
  leftoverAction?: string;
}

export const convertManuscriptTool: EpubTool = {
  name: "convert_manuscript",
  description:
    "Convert an entire local .txt/.md/.html manuscript file into an EPUB's chapters in one call. This is the expedient tool when converting a whole book to EPUB — prefer it over looping edit_chapter create calls one chapter at a time.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      sourcePath: { type: "string", description: "filesystem path to the .txt, .md, or .html manuscript file to convert into chapters, read directly from disk (not sent through MCP)" },
    },
  },
};

const MANUSCRIPT_TOC_CHAPTER_LABEL = /^chapter\s+(\d+)\b/i;

export async function handleConvertManuscript(server: Server, args: ConvertManuscriptArgs): Promise<ToolHandlerResult> {
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be converted into? Provide its filesystem path.");
  const sourcePath = await resolveArg(server, args.sourcePath, "sourcePath", "What is the filesystem path to the manuscript file (.txt, .md, or .html) to convert?");

  const raw = await readFile(sourcePath, "utf-8");
  const text = detectManuscriptFormat(sourcePath) === "html" ? stripHtmlTags(raw) : raw;

  const fragments = splitManuscriptChapters(text);
  if (fragments.length === 0) throw new Error(`no chapters found in ${JSON.stringify(sourcePath)}`);

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document to add chapters to`);

  const existingByNumber = existingChaptersByNumber(e, pkg);
  const baseId = deriveManuscriptBaseId(e, pkg);

  const createdIds: string[] = [];
  const replacedIds: string[] = [];
  let maxNewNumber = 0;

  for (let i = 0; i < fragments.length; i++) {
    const frag = fragments[i]!;
    if (frag.number > maxNewNumber) maxNewNumber = frag.number;
    const markup = chaptersToXHTML([frag]);

    const existingId = frag.number > 0 ? existingByNumber.get(frag.number) : undefined;
    if (existingId !== undefined) {
      const doc = e.contentDocuments[existingId];
      if (doc) {
        doc.markup = markup;
        replacedIds.push(existingId);
        continue;
      }
    }

    let chapterId = `${baseId}-${i + 1}.xhtml`;
    let label = "";
    if (frag.number > 0) {
      chapterId = `${baseId}-${frag.number}.xhtml`;
      label = `Chapter ${frag.number}`;
      if (frag.title !== "") label += `: ${frag.title}`;
    }
    chapterId = uniqueArchiveId(e, chapterId);

    insertChapter(e, pkg, chapterId, markup, label);
    createdIds.push(chapterId);
  }

  const leftoverIds = leftoverChapterIds(existingByNumber, maxNewNumber);
  let leftoverAction = "";
  if (leftoverIds.length > 0) {
    leftoverAction = await elicitLeftoverAction(server, leftoverIds);
    if (leftoverAction === "delete") {
      for (const id of leftoverIds) deleteChapterDocument(e, pkg, id);
    }
  }

  epubCache.markDirty(abs);

  const result: ConvertManuscriptResult = {
    path: abs,
    sourcePath,
    chaptersFound: fragments.length,
    createdIds: createdIds.length > 0 ? createdIds : undefined,
    replacedIds: replacedIds.length > 0 ? replacedIds : undefined,
    leftoverIds: leftoverIds.length > 0 ? leftoverIds : undefined,
    leftoverAction: leftoverIds.length > 0 ? leftoverAction : undefined,
  };

  let summary = `Converted ${JSON.stringify(sourcePath)} into ${JSON.stringify(abs)}: ${fragments.length} chapter(s) found (${createdIds.length} created, ${replacedIds.length} replaced).`;
  if (leftoverIds.length > 0) {
    summary += ` ${leftoverIds.length} existing chapter(s) past the new source's range were ${leftoverVerb(leftoverAction)}.`;
  }
  summary += ` Call save_epub to persist this to disk.${evictionNote(eviction)}`;

  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

/** Scans e's primary "toc" navigation list for entries whose label names a chapter number, mapping that number to the content document it targets. Returns an empty map if the book has no EPUB 3 navigation document. */
function existingChaptersByNumber(e: Epub, pkg: Package): Map<number, string> {
  const result = new Map<number, string>();
  let nav;
  try {
    nav = primaryNavigation(e, pkg);
  } catch {
    return result;
  }
  for (const list of nav.lists) {
    if (list.type !== "toc") continue;
    for (const item of list.items) {
      const m = MANUSCRIPT_TOC_CHAPTER_LABEL.exec(item.label.trim());
      if (!m || item.href === "") continue;
      const num = Number.parseInt(m[1]!, 10);
      const archivePath = resolveHref(pkg, item.href);
      if (archivePath) result.set(num, archivePath);
    }
  }
  return result;
}

/** Returns the content document ids of every existing chapter numbered higher than maxNewNumber, sorted for deterministic output. */
function leftoverChapterIds(existing: Map<number, string>, maxNewNumber: number): string[] {
  const ids: string[] = [];
  for (const [num, id] of existing) {
    if (num > maxNewNumber) ids.push(id);
  }
  ids.sort();
  return ids;
}

/**
 * Prompts the user once, asking whether to keep or delete leftoverIds. A
 * blank accepted answer defaults to "keep" — the non-destructive choice.
 * An explicit decline or cancellation is an error. Uses a custom
 * elicitation schema (an enum) rather than resolveArg's plain string
 * field, following resolveArg's own implementation as the template.
 */
async function elicitLeftoverAction(server: Server, leftoverIds: string[]): Promise<string> {
  const message = `The manuscript has fewer chapters than the book already has. ${leftoverIds.length} existing chapter(s) past its range were left untouched: ${leftoverIds.join(", ")}. Keep or delete them?`;

  const res = await server.elicitInput({
    message,
    requestedSchema: {
      type: "object",
      properties: {
        leftoverAction: { type: "string", enum: ["keep", "delete"] },
      },
    },
  });

  if (res.action !== "accept") {
    throw new Error(`leftover chapter action was not provided (prompt was ${res.action})`);
  }

  const value = res.content?.leftoverAction;
  if (value === "" || value === undefined || value === "keep") return "keep";
  if (value === "delete") return "delete";
  throw new Error(`leftover chapter action must be "keep" or "delete", got ${JSON.stringify(value)}`);
}

function leftoverVerb(action: string): string {
  return action === "delete" ? "deleted" : "kept";
}

/** Picks a directory + stem to build new chapter archive paths from: borrows an existing content document's directory if the book has one, falling back to the package's own baseDir. */
function deriveManuscriptBaseId(e: Epub, pkg: Package): string {
  let dir = pkg.baseDir;
  for (const id of Object.keys(e.contentDocuments)) {
    const slash = id.lastIndexOf("/");
    dir = slash >= 0 ? id.slice(0, slash + 1) : "";
    break;
  }
  return dir + "chapter";
}

/** Returns candidate, or candidate with a numeric suffix inserted before its extension, whichever isn't already used by a resource, content document, navigation document, or NCX in e. */
function uniqueArchiveId(e: Epub, candidate: string): string {
  if (!archiveIdInUse(e, candidate)) return candidate;
  const ext = extname(candidate);
  const stem = candidate.slice(0, candidate.length - ext.length);
  for (let n = 2; ; n++) {
    const id = `${stem}-${n}${ext}`;
    if (!archiveIdInUse(e, id)) return id;
  }
}

registerTool(
  convertManuscriptTool,
  "Takes path (the .epub file, as previously passed to read_epub) and sourcePath (the manuscript file to " +
    "ingest, read directly from disk on the machine running this server, never sent through MCP as bytes). " +
    "Either may be omitted, in which case the user is prompted for it directly (see edit_chapter's " +
    "description for the general elicitation rules every tool on this server follows).\n\n" +
    'Reads sourcePath in full and splits it into chapters wherever a line looks like "Chapter <number>" ' +
    '(case-insensitive, optionally followed by a title on the same line, e.g. "Chapter 12: The Storm") — ' +
    'looser than edit_chapter\'s markdown path, which requires a leading "# ". No markers found means the ' +
    "whole file becomes a single chapter. .html sources are stripped of tags (and <script>/<style> " +
    "blocks) before splitting. Each chapter chunk is rendered into an XHTML content document the same way " +
    "edit_chapter's markdown parsing does.\n\n" +
    'If a parsed chapter\'s number matches an existing chapter already in the book (matched against the ' +
    'navigation document\'s "toc" entries, e.g. a "Chapter 12" or "Chapter 12: Old Title" label), that ' +
    "existing content document's markup is replaced in place rather than duplicated. Numbers not already " +
    "present are appended as new chapters, manifest/spine/toc wiring included, same as edit_chapter's " +
    "create action.\n\n" +
    "If the source has fewer chapters than the book already had — its highest chapter number is lower " +
    "than some existing chapter's — those existing chapters past that range are left untouched by default " +
    "and reported as leftover. The user is prompted once, asking whether to keep or delete all of them; a " +
    'blank accepted answer defaults to "keep" (nothing destroyed by default), while an explicit decline of ' +
    "the prompt is an error.\n\n" +
    "Only touches the in-memory cache; call save_epub afterwards to persist the result to disk.",
  handleConvertManuscript as never,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/convert-manuscript.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/convert-manuscript.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/convert-manuscript.ts src/tools/convert-manuscript.test.ts src/index.ts
git commit -m "Add convert_manuscript tool"
```

---

## Definition of done

- `bun run typecheck` exits 0.
- `bun test` passes for every file under `src/`.
- `src/tools/` additionally contains `chapter-markdown.ts`, `edit-chapter.ts`, `get-chapter.ts`, `manuscript-parse.ts`, `convert-manuscript.ts`, each with a matching `*.test.ts` (except `chapter-markdown.ts`/`manuscript-parse.ts`, which register no tool but still have tests), and `edit-chapter.ts`/`get-chapter.ts`/`convert-manuscript.ts` wired into `src/index.ts`.
- A manual smoke test (`tools/list` over stdio) lists 16 tools: the 13 from Phase 3-5 plus `edit_chapter`, `get_chapter`, `convert_manuscript`.
- `convert_manuscript` can be manually exercised end-to-end against a real file (e.g. a `The Magic Hower.md` manuscript) once Phase 7's `new_epub`/`save_epub` tools exist to create and persist the target `.epub` — that full round-trip is Phase 9's job, but this phase's `convert_manuscript` tool is functionally complete on its own (it already works against any `.epub` already loaded via the existing `epub/` core library, independent of the lifecycle tools).
- Phase 7 (lifecycle tools) can begin — it depends on `insertChapter` (this phase's `edit-chapter.ts`) and `defaultChapterLabel` (Phase 5's `nav-sync.ts`), both complete.
