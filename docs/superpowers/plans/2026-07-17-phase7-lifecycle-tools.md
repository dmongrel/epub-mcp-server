# Phase 7: EPUB Lifecycle Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the EPUB lifecycle tools: `new_epub`, `read_epub`, `save_epub`, `close_epub`, `reload_epub`, `get_epubs_list`, `get_cache_status`. This is the phase that completes the tool this entire project set out to deliver — `The Magic Hower.epub` can only be built end-to-end from `The Magic Hower.md` once `new_epub` (creates the target file) and `save_epub` (persists `convert_manuscript`'s in-memory edits) both exist.

**Architecture:** Six files under `src/tools/`, matching the Go reference's file boundaries: `new-epub.ts` (tool), `read-epub.ts` (tool — note this is a NEW file distinct from Phase 1's `src/epub/new-epub.ts`/no `src/epub/read-epub.ts`; the core `epub/` library's `parseEpub` already exists from Phase 1, this task is the MCP tool wrapper), `save-epub.ts`, `close-epub.ts`, `reload-epub.ts`, `get-epubs-list.ts`, `get-cache-status.ts`.

**Why this phase comes after chapters/navigation, not before:** `save_epub`'s `ensureAtLeastOneChapter` fallback (a book saved with zero content documents automatically gets one blank chapter, since EPUB requires at least one) depends on `insertChapter` (Phase 6's `edit-chapter.ts`) and `defaultChapterLabel` (Phase 5's `nav-sync.ts`) — this was the original discovery, back at the start of Phase 4, that forced restructuring the whole remaining build order away from the initial category-based design spec.

**Source of record:** `G:\_GoProjects\epub-novel-mcp-server\tools\{new_epub,read_epub,save_epub,close_epub,reload_epub,get_epubs_list,get_cache_status}.go`.

## Global Constraints

- Every exported name mirrors its Go counterpart's meaning, translated to camelCase.
- All relative imports use explicit `.ts` extensions; SDK imports keep `.js`.
- `verbatimModuleSyntax` is on: import types with `import type { ... }`.
- Every tool self-registers via a top-level `registerTool(...)` call.
- Every tool handler that omits a required string arg resolves it via `resolveArg(server, current, field, message)`.
- Every tool handler that loads a book calls `epubCache.load(abs)` and appends `evictionNote(evicted)` to its summary; every mutating tool calls `epubCache.markDirty(abs)` after a successful edit.
- **Handlers throw on error; only `registry.ts`'s `dispatchTool` wrapper converts a throw to `{isError:true}`.** Tests calling a handler directly use `.rejects.toThrow(...)`.
- Every tool handler returns `{ content: [{ type: "text", text: summary }], structuredContent: result }`.
- **`new_epub`/`read_epub`/`reload_epub` key the cache by `canonicalPath(abs)`, not just `path.resolve()`.** This is a deliberate divergence from every tool since Phase 4, which resolves the argument path and passes it straight to `epubCache` without pre-canonicalizing (relying on the cache's own internal `canonicalPath` keying to unify different spellings). Go's `read_epub.go`/`new_epub.go`/`reload_epub.go` explicitly call `epub.CanonicalPath(abs)` themselves and **return that canonical form to the caller** as the `path` field in their result — the whole point being that a client which calls `read_epub` once and reuses the returned canonical path in every later tool call is guaranteed to hit the same cache entry regardless of how differently the file's actual path could be spelled (symlinks, case folding). `close_epub`/`get_cache_status` don't do this since they only look up an already-cached entry rather than establishing a new canonical identity for one. Import `canonicalPath` from `../epub/cache.ts` for this.
- `new_epub` builds the blank EPUB in memory via `newEpub(title, author)` (`../epub/new-epub.ts`, Phase 1) and persists it via `writeEpub(e, abs)` (`../epub/write.ts`, Phase 2) BEFORE loading it into the cache — this ensures `canonicalPath` has a real file to resolve symlinks against, and ensures the cache's copy is loaded via the exact same `parseEpub` path every other tool uses (rather than caching the in-memory `newEpub()` object directly), so `new_epub`'s cached entry behaves identically to one produced by `read_epub`.
- Tests use `bun:test`.

---

### Task 1: `read_epub` tool + `summarizeEpub`/`tableOfContents`-adjacent result shaping

**Files:**
- Create: `src/tools/read-epub.ts`
- Test: `src/tools/read-epub.test.ts`
- Modify: `src/index.ts` (add `import "./tools/read-epub.ts";`)

**Interfaces:**
- Consumes: `epubCache`, `evictionNote`, `canonicalPath` (`../epub/cache.ts`), `primaryPackage` (`../epub/resolve.ts`), `resolveHref`/`manifestItemById` (`../epub/resolve.ts`), `tableOfContents` (`./get-navigation.ts`, Phase 5 — the TOC-tree builder already relocated there).
- Produces: `readEpubTool`/`handleReadEpub` (registered as `read_epub`); `summarizeEpub(canonicalAbs: string, e: Epub): ReadEpubResult` (exported, consumed by this phase's Task 4 `reload-epub.ts`, which needs the identical summary shape after a fresh re-parse); `ReadEpubResult` interface (`{ path: string; title?: string; creators?: string[]; language?: string; manifestItemCount: number; contentDocuments: string[]; tableOfContents?: TocEntry[] }`).

**A note on why this is a new task rather than "already done in Phase 4":** Phase 4's `epub-cache.ts` created the `epubCache` singleton itself, but no tool ever called `epubCache.load` with the intent of exposing a fresh top-level summary the way Go's `read_epub.go` does — every Phase 4-6 tool assumes a book is already loaded and only needs the parsed `Epub` object, not a serialized summary of it. This task is the first to build that summary shape.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/read-epub.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleReadEpub, summarizeEpub } from "./read-epub.ts";
import { canonicalPath } from "../epub/cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("read_epub", () => {
  test("returns title, creators, language, manifestItemCount, contentDocuments, and tableOfContents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-read-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Read Epub Test", "Jane Author"), path);

    const result = await handleReadEpub(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.title).toBe("Read Epub Test");
    expect(result.structuredContent?.creators).toEqual(["Jane Author"]);
    expect(result.structuredContent?.language).toBe("en");
    expect(result.structuredContent?.manifestItemCount).toBe(2); // nav.xhtml + styles/style.css
    expect(result.structuredContent?.contentDocuments).toEqual([]);
    expect(result.structuredContent?.path).toBe(canonicalPath(path));

    await rm(dir, { recursive: true, force: true });
  });

  test("returns the canonical path as the result's path field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-read-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Canonical Path Test", "Author"), path);

    const result = await handleReadEpub(fakeServer, { path: path.toUpperCase() });

    expect(result.structuredContent?.path).toBe(canonicalPath(path));

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path is missing", async () => {
    await expect(handleReadEpub(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });
});

describe("summarizeEpub", () => {
  test("returns zero-valued fields for an epub with no package document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-summarize-test-"));
    // summarizeEpub is exercised indirectly through handleReadEpub above for
    // the normal case; this only needs to confirm the defensive branch for
    // an Epub with no primary package doesn't throw. Build the minimal
    // possible Epub value directly rather than parsing a real (invalid)
    // file from disk.
    const empty = {
      id: "",
      mimetype: "application/epub+zip",
      container: { id: "META-INF/container.xml", version: "1.0", rootfiles: [] },
      packages: {},
      navigation: {},
      nCXs: {},
      contentDocuments: {},
      resources: {},
    };
    const result = summarizeEpub("/tmp/nonexistent.epub", empty as never);
    expect(result.manifestItemCount).toBe(0);
    expect(result.contentDocuments).toEqual([]);
    expect(result.title).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/read-epub.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/read-epub.ts`**

```typescript
/**
 * read_epub — parse a .epub file from disk into memory and return its
 * metadata, reading order, and table of contents. Mirrors Go's
 * tools/read_epub.go.
 *
 * summarizeEpub is exported for reload-epub.ts (this phase's Task 4),
 * which needs the identical summary shape after a fresh re-parse.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { canonicalPath, epubCache as _unused } from "../epub/cache.ts";
import { evictionNote } from "./eviction.ts";
import { epubCache } from "./epub-cache.ts";
import { tableOfContents, type TocEntry } from "./get-navigation.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage, resolveHref } from "../epub/resolve.ts";
import { manifestItemById } from "../epub/resolve.ts";
import type { Epub } from "../epub/types.ts";

interface ReadEpubArgs {
  path: string;
}

export interface ReadEpubResult {
  path: string;
  title?: string;
  creators?: string[];
  language?: string;
  manifestItemCount: number;
  contentDocuments: string[];
  tableOfContents?: TocEntry[];
}

export const readEpubTool: EpubTool = {
  name: "read_epub",
  description: "Parse a .epub file from disk into memory and return its metadata, reading order, and table of contents. Read-only.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path to the .epub file to read" } },
    required: ["path"],
  },
};

/**
 * Builds a ReadEpubResult for an already-loaded Epub. Shared by read_epub
 * and reload_epub, since both need the same title/creators/
 * contentDocuments/table-of-contents summary after (re)loading a book.
 */
export function summarizeEpub(abs: string, e: Epub): ReadEpubResult {
  const result: ReadEpubResult = { path: abs, manifestItemCount: 0, contentDocuments: [] };

  const pkg = primaryPackage(e);
  if (!pkg) return result;

  result.manifestItemCount = pkg.manifest.items.length;
  if (pkg.metadata.titles.length > 0) result.title = pkg.metadata.titles[0]!.value;
  if (pkg.metadata.creators.length > 0) result.creators = pkg.metadata.creators.map((c) => c.name);
  if (pkg.metadata.languages.length > 0) result.language = pkg.metadata.languages[0]!.value;

  for (const ref of pkg.spine.itemRefs) {
    const item = manifestItemById(pkg, ref.idRef);
    if (!item) continue;
    result.contentDocuments.push(resolveHref(pkg, item.href));
  }

  result.tableOfContents = tableOfContents(e, pkg);
  return result;
}

export async function handleReadEpub(_server: Server, args: ReadEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);
  const canonical = canonicalPath(abs);

  const { epub: e, eviction } = await epubCache.load(canonical);

  const result = summarizeEpub(canonical, e);
  const summary = `Loaded ${JSON.stringify(canonical)} (${result.manifestItemCount} manifest items, ${result.contentDocuments.length} spine entries).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  readEpubTool,
  "Takes a single argument, path, the filesystem path to a .epub file. Parses the file and caches the " +
    "parsed result in memory (evicting the least recently used entry when full — see get_cache_status to " +
    "check what's loaded, and close_epub to free a slot deliberately instead of waiting for that eviction), " +
    "keyed by a canonicalized form of the path (symlinks resolved, case folded on filesystems that are " +
    "case-insensitive by default); calling read_epub again with any spelling of the same file is cheap and " +
    "returns the cached parse rather than re-reading it. Returns the book's title, creators, language, " +
    "manifest item count, the content document ids in spine reading order (use these to target a specific " +
    "chapter with other tools), and the table of contents (from the EPUB 3 navigation document, or the " +
    "legacy NCX if that's what the book has) as a tree of id/label/href entries. The returned path is " +
    "already in that canonical form — reuse it verbatim in later tool calls (edit_chapter, save_epub, " +
    "close_epub, etc.) rather than re-typing your own path string, so every call is guaranteed to refer to " +
    "this exact same cache entry.",
  handleReadEpub as never,
);
```

Note on the `canonicalPath, epubCache as _unused` import: this is a copy-paste artifact in the brief's draft and must NOT be included — it's meaningless and would fail lint/typecheck cleanliness expectations even though `noUnusedLocals` isn't strictly enforced. Import only `canonicalPath` from `../epub/cache.ts`; do not import a second, differently-named `epubCache` from there (the real one, used throughout, comes from `./epub-cache.ts` — the Phase 4 singleton wrapper). Fix this import line during implementation:

```typescript
import { canonicalPath } from "../epub/cache.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/read-epub.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/read-epub.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/read-epub.ts src/tools/read-epub.test.ts src/index.ts
git commit -m "Add read_epub tool"
```

---

### Task 2: `new_epub` tool

**Files:**
- Create: `src/tools/new-epub.ts` (tool file — NOT to be confused with the already-existing `src/epub/new-epub.ts` core-library file from Phase 1, which this task imports from)
- Test: `src/tools/new-epub.test.ts`
- Modify: `src/index.ts` (add `import "./tools/new-epub.ts";`)

**Interfaces:**
- Consumes: `epubCache`, `evictionNote`, `resolveArg`, `canonicalPath` (`../epub/cache.ts`), `newEpub as buildNewEpub` (`../epub/new-epub.ts`, Phase 1 — aliased on import since this file's own tool/handler is also conventionally named `newEpub`/`handleNewEpub`), `writeEpub` (`../epub/write.ts`, Phase 2), `primaryPackage` (`../epub/resolve.ts`), `manifestItemById`/`resolveHref` (`../epub/resolve.ts`).
- Produces: `newEpubTool`/`handleNewEpub` (registered as `new_epub`). No further exports consumed elsewhere.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/new-epub.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleNewEpub } from "./new-epub.ts";
import { canonicalPath } from "../epub/cache.ts";
import { epubCache } from "./epub-cache.ts";

const fakeServer = {} as Server;

describe("new_epub", () => {
  test("creates a blank EPUB on disk, caches it, and returns its summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-new-epub-test-"));
    const path = join(dir, "book.epub");

    const result = await handleNewEpub(fakeServer, { path, title: "My New Book", author: "Jane Author" });

    expect(result.isError).toBeUndefined();
    expect(existsSync(path)).toBe(true);
    expect(result.structuredContent?.title).toBe("My New Book");
    expect(result.structuredContent?.creators).toEqual(["Jane Author"]);
    expect(result.structuredContent?.contentDocuments).toEqual([]);
    expect(result.structuredContent?.path).toBe(canonicalPath(path));

    const cached = epubCache.get(canonicalPath(path));
    expect(cached).toBeDefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("defaults title to Untitled and author to Anonymous when omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-new-epub-test-"));
    const path = join(dir, "book.epub");

    const result = await handleNewEpub(fakeServer, { path, title: "", author: "" });

    expect(result.structuredContent?.title).toBe("Untitled");
    expect(result.structuredContent?.creators).toEqual(["Anonymous"]);

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/new-epub.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/new-epub.ts`**

```typescript
/**
 * new_epub — create a blank EPUB file on disk and load it into the
 * server's cache. Mirrors Go's tools/new_epub.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { canonicalPath } from "../epub/cache.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { newEpub as buildNewEpub } from "../epub/new-epub.ts";
import { manifestItemById, primaryPackage, resolveHref } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

interface NewEpubArgs {
  path?: string;
  title?: string;
  author?: string;
}

interface NewEpubResult {
  path: string;
  title?: string;
  creators?: string[];
  language?: string;
  manifestItemCount: number;
  contentDocuments: string[];
}

export const newEpubTool: EpubTool = {
  name: "new_epub",
  description: "Create a blank EPUB file on disk and load it into the server's LRU cache. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path where the new .epub file should be created" },
      title: { type: "string", description: 'EPUB title (defaults to "Untitled")' },
      author: { type: "string", description: 'Creator name (defaults to "Anonymous")' },
    },
  },
};

export async function handleNewEpub(server: Server, args: NewEpubArgs): Promise<ToolHandlerResult> {
  const path = await resolveArg(server, args.path, "path", "Where should the new EPUB file be created? Provide a filesystem path ending in .epub.");
  const titleArg = await resolveArg(server, args.title, "title", "What should the EPUB's title be?");
  const title = titleArg || "Untitled";
  const authorArg = await resolveArg(server, args.author, "author", "Who is the creator/author of this EPUB?");
  const author = authorArg || "Anonymous";

  const abs = resolve(path);

  const e = buildNewEpub(title, author);
  await writeEpub(e, abs);
  const canonical = canonicalPath(abs);

  const { epub: loaded, eviction } = await epubCache.load(canonical);

  const result: NewEpubResult = { path: canonical, manifestItemCount: 0, contentDocuments: [] };
  const pkg = primaryPackage(loaded);
  if (pkg) {
    result.manifestItemCount = pkg.manifest.items.length;
    if (pkg.metadata.titles.length > 0) result.title = pkg.metadata.titles[0]!.value;
    if (pkg.metadata.creators.length > 0) result.creators = pkg.metadata.creators.map((c) => c.name);
    if (pkg.metadata.languages.length > 0) result.language = pkg.metadata.languages[0]!.value;
    for (const ref of pkg.spine.itemRefs) {
      const item = manifestItemById(pkg, ref.idRef);
      if (!item) continue;
      result.contentDocuments.push(resolveHref(pkg, item.href));
    }
  }

  const summary = `Created new EPUB ${JSON.stringify(canonical)} (${result.manifestItemCount} manifest items, ${result.contentDocuments.length} spine entries). Title: ${title}. Call save_epub to persist changes.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  newEpubTool,
  'Takes optional arguments path (filesystem path for the new .epub), title (defaults to "Untitled"), and ' +
    'author (defaults to "Anonymous"). Builds a minimal valid EPUB 3 archive on disk (container.xml, ' +
    "mimetype, navigation document with an empty table of contents, stylesheet) — deliberately with no " +
    "chapters yet, rather than a placeholder one you'd have to remember to delete before adding real " +
    "content. Caches the parsed result in memory — inserting it as the most recently used entry and " +
    "evicting the least recently used if the cache is full — and returns its metadata. After creating an " +
    "EPUB, use edit_chapter to add chapters (each one is added to the table of contents automatically) and " +
    "save_epub to persist changes; save_epub adds a single blank chapter automatically if none exist yet " +
    "by the time it's called, since EPUB requires at least one. The returned path is canonicalized " +
    "(symlinks resolved, case folded on filesystems that are case-insensitive by default) — reuse it " +
    "verbatim in later tool calls rather than re-typing your own path string, so every call is guaranteed " +
    "to refer to this exact same cache entry.",
  handleNewEpub as never,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/new-epub.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/new-epub.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/new-epub.ts src/tools/new-epub.test.ts src/index.ts
git commit -m "Add new_epub tool"
```

---

### Task 3: `save_epub` tool

**Files:**
- Create: `src/tools/save-epub.ts`
- Test: `src/tools/save-epub.test.ts`
- Modify: `src/index.ts` (add `import "./tools/save-epub.ts";`)

**Interfaces:**
- Consumes: `epubCache` (Phase 4), `resolveArg` (only used for `path`, which is actually required-not-omittable per Go's own args struct — see note below), `writeEpub` (Phase 2), `primaryPackage`/`archiveIdInUse` (`./edit-resource.ts`, Phase 4), `insertChapter` (`./edit-chapter.ts`, Phase 6), `defaultChapterLabel` (`./nav-sync.ts`, Phase 5).
- Produces: `saveEpubTool`/`handleSaveEpub` (registered as `save_epub`). No further exports consumed elsewhere.

**A correction to Go's own args shape, worth calling out explicitly:** Go's `saveEpubArgs.Path` is a plain `string` (not `*string`), meaning Go's `save_epub` does NOT go through `resolveArg`'s omit-and-prompt flow — it's validated directly (`strings.TrimSpace(args.Path) == ""` → immediate error, no elicitation) as a required argument, unlike almost every other tool's `path` field in this codebase. Port this faithfully: `handleSaveEpub`'s `path` argument should be validated the same way `get_chapter`'s `path`/`id` are (throw immediately if blank, never prompt) — do NOT route it through `resolveArg`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/save-epub.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleSaveEpub } from "./save-epub.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { parseEpub } from "../epub/parse.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("save_epub", () => {
  test("fails if path isn't currently cached", async () => {
    await expect(handleSaveEpub(fakeServer, { path: "/no/such/cached-book.epub" })).rejects.toThrow("is not currently cached");
  });

  test("errors when path is missing (not elicited)", async () => {
    await expect(handleSaveEpub(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });

  test("writes cached edits back to disk and clears the dirty flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-save-epub-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Save Epub Test", "Author");
    await writeEpub(e, path);
    const { epub: loaded } = await epubCache.load(path);
    const pkg = primaryPackage(loaded)!;
    pkg.metadata.titles[0]!.value = "Edited Title";
    epubCache.markDirty(path);

    const result = await handleSaveEpub(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.savedTo).toBe(path);
    const reparsed = await parseEpub(path);
    expect(primaryPackage(reparsed)?.metadata.titles[0]?.value).toBe("Edited Title");

    const status = epubCache.entries().find((entry) => entry.path === path);
    expect(status?.dirty).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  test("saves to a different 'as' path, leaving the original's dirty flag untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-save-epub-test-"));
    const path = join(dir, "book.epub");
    const asPath = join(dir, "book-copy.epub");
    await writeEpub(newEpub("Save As Test", "Author"), path);
    await epubCache.load(path);
    epubCache.markDirty(path);

    const result = await handleSaveEpub(fakeServer, { path, as: asPath });

    expect(result.structuredContent?.savedTo).toBe(asPath);
    const reparsed = await parseEpub(asPath);
    expect(primaryPackage(reparsed)).toBeDefined();

    const status = epubCache.entries().find((entry) => entry.path === path);
    expect(status?.dirty).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("adds a blank chapter automatically when saving a book with none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-save-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Blank Chapter Test", "Author"), path);
    await epubCache.load(path);

    const result = await handleSaveEpub(fakeServer, { path });

    expect(result.structuredContent?.addedBlankChapter).toBeTruthy();
    const reparsed = await parseEpub(path);
    expect(Object.keys(reparsed.contentDocuments)).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("does not add a blank chapter when one already exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-save-epub-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Has Chapter Test", "Author");
    await writeEpub(e, path);
    const { epub: loaded } = await epubCache.load(path);
    const pkg = primaryPackage(loaded)!;
    const { insertChapter } = await import("./edit-chapter.ts");
    insertChapter(loaded, pkg, "text/ch1.xhtml", "<html><body><p>Hi</p></body></html>", "Chapter 1");

    const result = await handleSaveEpub(fakeServer, { path });

    expect(result.structuredContent?.addedBlankChapter).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/save-epub.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/save-epub.ts`**

```typescript
/**
 * save_epub — write a cached EPUB, including any edit_chapter/edit_*
 * edits, back to disk. Mirrors Go's tools/save_epub.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { archiveIdInUse } from "./edit-resource.ts";
import { insertChapter } from "./edit-chapter.ts";
import { epubCache } from "./epub-cache.ts";
import { defaultChapterLabel } from "./nav-sync.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";
import type { Epub } from "../epub/types.ts";

interface SaveEpubArgs {
  path: string;
  as?: string;
}

interface SaveEpubResult {
  savedTo: string;
  addedBlankChapter?: string;
}

export const saveEpubTool: EpubTool = {
  name: "save_epub",
  description: "Write a cached EPUB, including any edit_chapter edits, back to disk as a .epub file. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path of the cached epub to save, as previously passed to read_epub" },
      as: { type: "string", description: "optional different filesystem path to save to instead of overwriting path" },
    },
    required: ["path"],
  },
};

export async function handleSaveEpub(_server: Server, args: SaveEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const e = epubCache.get(abs);
  if (!e) throw new Error(`${JSON.stringify(args.path)} is not currently cached; call read_epub first`);

  const dest = args.as?.trim() ? resolve(args.as) : abs;

  const addedChapterId = ensureAtLeastOneChapter(e);

  await writeEpub(e, dest);
  if (dest === abs) {
    epubCache.clearDirty(abs);
  } else if (addedChapterId) {
    epubCache.markDirty(abs);
  }

  const result: SaveEpubResult = { savedTo: dest };
  if (addedChapterId) result.addedBlankChapter = addedChapterId;

  const addedNote = addedChapterId
    ? ` The book had no chapters yet, so a blank one (${JSON.stringify(addedChapterId)}) was added automatically — EPUB requires at least one; call edit_chapter to fill it in.`
    : "";
  const summary = `Saved ${JSON.stringify(dest)}.${addedNote}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

/**
 * Adds a single blank chapter to e if it has none, via the same
 * insertChapter path edit_chapter's create action uses, since EPUB
 * requires at least one content document in the spine. new_epub
 * deliberately doesn't create one itself. Returns the new chapter's id,
 * or "" if the book already had at least one.
 */
function ensureAtLeastOneChapter(e: Epub): string {
  if (Object.keys(e.contentDocuments).length > 0) return "";
  const pkg = primaryPackage(e);
  if (!pkg) return "";

  const id = defaultBlankChapterId(e);
  const label = defaultChapterLabel(id);
  const markup = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${label}</title>
</head>
<body>
  <h1>${label}</h1>
</body>
</html>`;

  insertChapter(e, pkg, id, markup, label);
  return id;
}

/** Returns an archive path for ensureAtLeastOneChapter's new chapter that doesn't collide with anything in e. */
function defaultBlankChapterId(e: Epub): string {
  for (let n = 1; ; n++) {
    const id = `text/chapter-${n}.xhtml`;
    if (!archiveIdInUse(e, id)) return id;
  }
}

registerTool(
  saveEpubTool,
  "Takes path, identifying which already-cached EPUB to save (the same path used with read_epub / " +
    "edit_chapter), and an optional as path to save to a different location instead of overwriting the " +
    "original. Fails if path isn't currently cached — call read_epub first. Regenerates container.xml and " +
    "every package document (metadata, manifest, spine) from the in-memory structures, and writes every " +
    "content document, navigation document, NCX, and other resource back using its stored content " +
    "verbatim, including any edits. When saving back to path (no as given), also clears that cache entry's " +
    "unsaved-edits flag, as reported by get_cache_status; saving to a different as path leaves it set, " +
    "since path on disk still doesn't match what's in memory.\n\n" +
    "EPUB requires at least one content document, but new_epub deliberately starts a book with none rather " +
    "than a placeholder chapter you'd have to remember to delete. If the book still has zero chapters when " +
    "save_epub runs, it adds one blank chapter automatically (reported in addedBlankChapter) so the file " +
    "stays valid; call edit_chapter on that id afterwards to fill it in, or edit_chapter/edit_navigation to " +
    "rename or restructure it like any other chapter.",
  handleSaveEpub as never,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/save-epub.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/save-epub.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/save-epub.ts src/tools/save-epub.test.ts src/index.ts
git commit -m "Add save_epub tool"
```

---

### Task 4: `close_epub` and `reload_epub` tools

**Files:**
- Create: `src/tools/close-epub.ts`
- Create: `src/tools/reload-epub.ts`
- Test: `src/tools/close-epub.test.ts`
- Test: `src/tools/reload-epub.test.ts`
- Modify: `src/index.ts` (add two imports)

**Interfaces:**
- Consumes: `epubCache` (Phase 4), `evictionNote` (Phase 3), `canonicalPath` (`../epub/cache.ts`), `summarizeEpub` (`./read-epub.ts`, this phase's Task 1).
- Produces: `closeEpubTool`/`handleCloseEpub` (registered as `close_epub`), `reloadEpubTool`/`handleReloadEpub` (registered as `reload_epub`). No further exports consumed elsewhere.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/close-epub.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleCloseEpub } from "./close-epub.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("close_epub", () => {
  test("removes a cached epub and reports closed:true, hadUnsavedEdits:false when clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-close-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Close Epub Test", "Author"), path);
    await epubCache.load(path);

    const result = await handleCloseEpub(fakeServer, { path });

    expect(result.structuredContent?.closed).toBe(true);
    expect(result.structuredContent?.hadUnsavedEdits).toBeUndefined();
    expect(epubCache.get(path)).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("reports hadUnsavedEdits:true when the closed entry was dirty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-close-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Close Dirty Test", "Author"), path);
    await epubCache.load(path);
    epubCache.markDirty(path);

    const result = await handleCloseEpub(fakeServer, { path });

    expect(result.structuredContent?.hadUnsavedEdits).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("closing an uncached path is not an error; closed is false", async () => {
    const result = await handleCloseEpub(fakeServer, { path: "/no/such/cached-book.epub" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.closed).toBe(false);
  });

  test("errors when path is missing", async () => {
    await expect(handleCloseEpub(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });
});
```

```typescript
// src/tools/reload-epub.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleReloadEpub } from "./reload-epub.ts";
import { epubCache } from "./epub-cache.ts";
import { canonicalPath } from "../epub/cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("reload_epub", () => {
  test("discards in-memory edits and re-parses from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-reload-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Reload Epub Test", "Author"), path);
    const { epub: loaded } = await epubCache.load(path);
    primaryPackage(loaded)!.metadata.titles[0]!.value = "Unsaved Edit";
    epubCache.markDirty(path);

    const result = await handleReloadEpub(fakeServer, { path });

    expect(result.structuredContent?.title).toBe("Reload Epub Test");
    const cached = epubCache.get(canonicalPath(path))!;
    expect(primaryPackage(cached)?.metadata.titles[0]?.value).toBe("Reload Epub Test");

    await rm(dir, { recursive: true, force: true });
  });

  test("behaves like a plain read_epub when path wasn't already cached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-reload-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Reload Fresh Test", "Author"), path);

    const result = await handleReloadEpub(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.title).toBe("Reload Fresh Test");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path is missing", async () => {
    await expect(handleReloadEpub(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/close-epub.test.ts src/tools/reload-epub.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write `src/tools/close-epub.ts`**

```typescript
/**
 * close_epub — remove a cached EPUB from memory, freeing its cache slot.
 * Mirrors Go's tools/close_epub.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

interface CloseEpubArgs {
  path: string;
}

interface CloseEpubResult {
  path: string;
  closed: boolean;
  hadUnsavedEdits?: boolean;
}

export const closeEpubTool: EpubTool = {
  name: "close_epub",
  description: "Remove a cached EPUB from memory, freeing its cache slot. Changing.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path of the cached epub to close, as previously passed to read_epub" } },
    required: ["path"],
  },
};

export async function handleCloseEpub(_server: Server, args: CloseEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { removed, wasDirty } = epubCache.remove(abs);
  const result: CloseEpubResult = { path: abs, closed: removed };
  if (removed && wasDirty) result.hadUnsavedEdits = true;

  let summary: string;
  if (!removed) {
    summary = `${JSON.stringify(abs)} was not cached; nothing to close.`;
  } else if (wasDirty) {
    summary = `Closed ${JSON.stringify(abs)}, discarding unsaved edits. Call save_epub before closing next time if you want to keep them.`;
  } else {
    summary = `Closed ${JSON.stringify(abs)}.`;
  }

  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  closeEpubTool,
  "Takes path, the same .epub filesystem path used with read_epub. Frees that book's slot in the cache " +
    "immediately, rather than waiting for it to be pushed out by loading other books. If the book had " +
    "unsaved edit_chapter edits (see get_cache_status), they're discarded — call save_epub first if you " +
    "want to keep them; the response's hadUnsavedEdits reports whether that happened. A path that isn't " +
    "currently cached isn't an error; closed is simply false. The next read_epub, get_chapter, or " +
    "edit_chapter call for this path re-parses it fresh from disk.",
  handleCloseEpub as never,
);
```

- [ ] **Step 4: Write `src/tools/reload-epub.ts`**

```typescript
/**
 * reload_epub — discard a cached EPUB and re-parse it fresh from disk.
 * Mirrors Go's tools/reload_epub.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { canonicalPath } from "../epub/cache.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { summarizeEpub } from "./read-epub.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

interface ReloadEpubArgs {
  path: string;
}

export const reloadEpubTool: EpubTool = {
  name: "reload_epub",
  description: "Discard a cached EPUB and re-parse it fresh from disk. Changing.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path of the epub to reload, as previously passed to read_epub" } },
    required: ["path"],
  },
};

export async function handleReloadEpub(_server: Server, args: ReloadEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);
  const canonical = canonicalPath(abs);

  const { wasDirty } = epubCache.remove(canonical);

  const { epub: e, eviction } = await epubCache.load(canonical);

  const result = summarizeEpub(canonical, e);

  const discardNote = wasDirty ? " Discarded unsaved edits that were in memory." : "";
  const summary = `Reloaded ${JSON.stringify(canonical)} from disk (${result.manifestItemCount} manifest items, ${result.contentDocuments.length} spine entries).${discardNote}${evictionNote(eviction)}`;

  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  reloadEpubTool,
  "Takes path, the same .epub filesystem path used with read_epub. Drops whatever is currently cached for " +
    "it — including any unsaved edit_chapter edits, which are lost unless already saved — and re-parses " +
    "the file from disk into a clean cache entry. Useful either to intentionally throw away in-memory " +
    "edits since the last save, or to pick up changes made to the file outside this server. Returns the " +
    "same summary as read_epub (title, creators, content document ids, table of contents), reflecting " +
    "whatever is on disk right now. path doesn't need to already be cached; reloading an uncached path " +
    "behaves like a plain read_epub.",
  handleReloadEpub as never,
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/tools/close-epub.test.ts src/tools/reload-epub.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire into `src/index.ts`**

Add:

```typescript
import "./tools/close-epub.ts";
import "./tools/reload-epub.ts";
```

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 8: Commit**

```bash
git add src/tools/close-epub.ts src/tools/close-epub.test.ts src/tools/reload-epub.ts src/tools/reload-epub.test.ts src/index.ts
git commit -m "Add close_epub and reload_epub tools"
```

---

### Task 5: `get_epubs_list` and `get_cache_status` tools

**Files:**
- Create: `src/tools/get-epubs-list.ts`
- Create: `src/tools/get-cache-status.ts`
- Test: `src/tools/get-epubs-list.test.ts`
- Test: `src/tools/get-cache-status.test.ts`
- Modify: `src/index.ts` (add two imports)

**Interfaces:**
- Consumes: `epubCache` (Phase 4, for `get-cache-status.ts` only); `node:fs/promises` (`readdir`), `node:path` (for `get-epubs-list.ts`).
- Produces: `getEpubsListTool`/`handleGetEpubsList` (registered as `get_epubs_list`), `getCacheStatusTool`/`handleGetCacheStatus` (registered as `get_cache_status`). No further exports consumed elsewhere — both are leaves in the dependency graph.

**A note on `get_epubs_list`'s directory walk:** Go's implementation uses `filepath.WalkDir` for the recursive case and a flat `os.ReadDir` for the non-recursive case. Node's `fs.promises.readdir` supports a `{ recursive: true }` option directly (added in Node 20+; Bun supports it), which collapses both cases into one call — use that rather than hand-rolling recursion, since it's simpler and Bun's runtime supports it natively. Confirm this during implementation by checking Bun's actual behavior (the option existing in Node's types doesn't guarantee Bun's `readdir` honors it identically — verify with a real recursive-directory test).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/get-epubs-list.test.ts
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetEpubsList } from "./get-epubs-list.ts";

const fakeServer = {} as Server;

describe("get_epubs_list", () => {
  test("lists .epub files by case-insensitive extension, sorted by path, non-recursive by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-list-test-"));
    await writeFile(join(dir, "b.epub"), "b");
    await writeFile(join(dir, "a.EPUB"), "a");
    await writeFile(join(dir, "not-an-epub.txt"), "x");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "nested.epub"), "n");

    const result = await handleGetEpubsList(fakeServer, { dir });

    const files = result.structuredContent?.files as Array<{ path: string; sizeBytes: number }>;
    expect(files.map((f) => f.path.split(/[\\/]/).pop())).toEqual(["a.EPUB", "b.epub"]);
    expect(files.every((f) => f.sizeBytes > 0)).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("recursive:true also finds files in subdirectories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-list-recursive-test-"));
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "root.epub"), "r");
    await writeFile(join(dir, "sub", "nested.epub"), "n");

    const result = await handleGetEpubsList(fakeServer, { dir, recursive: true });

    const files = result.structuredContent?.files as Array<{ path: string }>;
    expect(files).toHaveLength(2);

    await rm(dir, { recursive: true, force: true });
  });

  test("defaults dir to the current working directory when omitted", async () => {
    const result = await handleGetEpubsList(fakeServer, { dir: "" });
    expect(result.isError).toBeUndefined();
    expect(typeof result.structuredContent?.dir).toBe("string");
  });
});
```

```typescript
// src/tools/get-cache-status.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetCacheStatus } from "./get-cache-status.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_cache_status", () => {
  test("reports capacity and every cached entry's dirty flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-cache-status-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Cache Status Test", "Author"), path);
    await epubCache.load(path);
    epubCache.markDirty(path);

    const result = await handleGetCacheStatus(fakeServer, {});

    expect(result.structuredContent?.capacity).toBe(epubCache.capacity);
    const entries = result.structuredContent?.entries as Array<{ path: string; dirty: boolean }>;
    const entry = entries.find((e) => e.path === path);
    expect(entry?.dirty).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("takes no required arguments", async () => {
    const result = await handleGetCacheStatus(fakeServer, undefined);
    expect(result.isError).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/get-epubs-list.test.ts src/tools/get-cache-status.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write `src/tools/get-epubs-list.ts`**

```typescript
/**
 * get_epubs_list — list .epub files in a directory. Mirrors Go's
 * tools/get_epubs_list.go.
 */
import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

interface GetEpubsListArgs {
  dir?: string;
  recursive?: boolean;
}

interface EpubFileInfo {
  path: string;
  sizeBytes: number;
}

export const getEpubsListTool: EpubTool = {
  name: "get_epubs_list",
  description: "List .epub files in a directory. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "directory to search for .epub files" },
      recursive: { type: "boolean", description: "search subdirectories too (default false)" },
    },
  },
};

export async function handleGetEpubsList(_server: Server, args: GetEpubsListArgs): Promise<ToolHandlerResult> {
  const dir = args.dir?.trim() ? args.dir : ".";
  const abs = resolve(dir);

  const entries = await readdir(abs, { recursive: args.recursive === true, withFileTypes: true });

  const files: EpubFileInfo[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (extname(entry.name).toLowerCase() !== ".epub") continue;
    const entryDir = "parentPath" in entry ? (entry as { parentPath: string }).parentPath : abs;
    const fullPath = join(entryDir, entry.name);
    const info = await stat(fullPath);
    files.push({ path: fullPath, sizeBytes: info.size });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  const structuredContent = { dir: abs, files };
  const summary = `Found ${files.length} .epub file(s) in ${JSON.stringify(abs)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getEpubsListTool,
  "Takes dir, the directory to search, and an optional recursive flag (default false) to also search " +
    'subdirectories. Matches files by a case-insensitive ".epub" extension only; it does not open or ' +
    "validate them. Returns each match's absolute path and size in bytes, sorted by path. Feed a returned " +
    "path straight into read_epub to parse that book.",
  handleGetEpubsList as never,
);
```

Implementation note: `node:fs/promises`'s `Dirent` type only reliably exposes `parentPath` (or the older, now-deprecated `path`) when `recursive: true` is combined with `withFileTypes: true` on the Node/Bun versions this project targets — verify during implementation which property is actually present on Bun's runtime by writing a quick manual check (a scratch script, not committed) before relying on `"parentPath" in entry`; if Bun's `Dirent` doesn't populate a directory field reliably in non-recursive mode, join against `abs` directly for the non-recursive case instead of trusting `entry.parentPath`, since a directory entry always lives directly in `abs` when `recursive` is false.

- [ ] **Step 4: Write `src/tools/get-cache-status.ts`**

```typescript
/**
 * get_cache_status — list the EPUBs currently held in memory. Mirrors
 * Go's tools/get_cache_status.go.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

export const getCacheStatusTool: EpubTool = {
  name: "get_cache_status",
  description: "List the EPUBs currently held in memory, most recently used first, and which have unsaved edits. Read-only.",
  inputSchema: { type: "object", properties: {} },
};

export async function handleGetCacheStatus(_server: Server, _args: unknown): Promise<ToolHandlerResult> {
  const entries = epubCache.entries();
  const dirtyCount = entries.filter((e) => e.dirty).length;

  const structuredContent = { capacity: epubCache.capacity, entries };
  const summary = `${entries.length}/${epubCache.capacity} cache slots used (${dirtyCount} with unsaved edits)`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getCacheStatusTool,
  "Takes no arguments. Returns the cache's capacity and every currently-cached EPUB's path and dirty " +
    "flag, ordered most- to least-recently-used. dirty is true when an edit_ tool has changed that book in " +
    "memory since it was last loaded or saved via save_epub with no as argument. Since the cache holds a " +
    "bounded number of books, loading one more than capacity silently evicts the least recently used entry " +
    "(read_epub and get_chapter both note it in their response when it happens) — check here before that " +
    "matters, and use close_epub or save_epub to manage a book proactively instead of letting it happen by " +
    "surprise.",
  handleGetCacheStatus as never,
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/tools/get-epubs-list.test.ts src/tools/get-cache-status.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire into `src/index.ts`**

Add:

```typescript
import "./tools/get-epubs-list.ts";
import "./tools/get-cache-status.ts";
```

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 8: Commit**

```bash
git add src/tools/get-epubs-list.ts src/tools/get-epubs-list.test.ts src/tools/get-cache-status.ts src/tools/get-cache-status.test.ts src/index.ts
git commit -m "Add get_epubs_list and get_cache_status tools"
```

---

## Definition of done

- `bun run typecheck` exits 0.
- `bun test` passes for every file under `src/`.
- `src/tools/` additionally contains `read-epub.ts`, `new-epub.ts`, `save-epub.ts`, `close-epub.ts`, `reload-epub.ts`, `get-epubs-list.ts`, `get-cache-status.ts`, each with a matching `*.test.ts`, each wired into `src/index.ts`.
- A manual smoke test (`tools/list` over stdio) lists 23 tools: the 16 from Phase 3-6 plus these 7.
- **End-to-end capability check**: with this phase complete, the full chain `new_epub` → `convert_manuscript` → `save_epub` is now possible for the first time in this project — a real manuscript file can be converted into a real, persisted `.epub` on disk in three tool calls. This is the point where a manual end-to-end test against a real manuscript (e.g. the original `The Magic Hower.md` that motivated this entire porting project) becomes possible and worth doing, even though it's not a task in this plan.
- Phase 8 (cover tools: `get_cover`/`edit_cover`/`edit_back_cover`) can begin — it depends on `archiveIdInUse` (Phase 4), `primaryNavigation`/`addLandmarkEntry` (Phase 5), `insertAt`/`renumberSpine` (Phase 4), and `applyGuideEdit` (Phase 4), all already complete; this phase's lifecycle tools are not themselves a dependency of Phase 8, but completing them first keeps the project's most user-visible milestone (a working end-to-end manuscript-to-EPUB pipeline) unblocked as early as possible.
