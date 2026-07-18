# Phase 5: Navigation Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the EPUB 3 navigation document / legacy NCX tooling: `get_navigation`, `edit_navigation`, and the chapter-lifecycle-to-navigation syncing helpers (`nav_sync.go` in the Go reference — no MCP tool of its own, just internal plumbing `edit_chapter`, Phase 6, will call). This is the foundation Phase 6 (chapters/manuscript) and Phase 8 (covers) both depend on.

**Architecture:** Three files under `src/tools/`, matching the Go reference's file boundaries 1:1: `get-navigation.ts`, `edit-navigation.ts`, `nav-sync.ts`. Builds on Phase 4's `src/tools/idlist.ts` (`removeAt`) and `src/tools/edit-spine.ts` (`insertAt`, `clampPosition` — these two generic helpers are reused here for nav-point tree editing, exactly as Go's `edit_spine.go` versions are reused by `edit_navigation.go`).

**Source of record:** `G:\_GoProjects\epub-novel-mcp-server\tools\{get_navigation,edit_navigation,nav_sync}.go`.

## Global Constraints

- Every exported name mirrors its Go counterpart's meaning, translated to camelCase.
- All relative imports use explicit `.ts` extensions; SDK imports keep `.js`.
- `verbatimModuleSyntax` is on: import types with `import type { ... }`.
- Every tool self-registers via a top-level `registerTool(...)` call, matching every tool file since Phase 3.
- Every tool handler that omits a required string arg resolves it via `resolveArg(server, current, field, message)` from `./elicit.ts`; `edit_navigation`'s `labelPrompt` field is never itself resolved via `resolveArg` — it only enriches the message passed when `label` needs prompting, via `withHint(message, hint)` (also from `./elicit.ts`, already used since Phase 3).
- Every tool handler that loads a book calls `epubCache.load(abs)` and appends `evictionNote(evicted)` to its summary text; every mutating tool calls `epubCache.markDirty(abs)` after a successful edit and appends "Call save_epub to persist this to disk." to its summary.
- Every tool handler returns `{ content: [{ type: "text", text: summary }], structuredContent: result }`.
- **Handlers throw on error; they never self-catch and return `{isError: true}`.** Only `registry.ts`'s `dispatchTool` wrapper converts a thrown error into an `isError` result. Tests calling a handler directly and expecting an error use `.rejects.toThrow(...)`.
- **Tree mutation uses direct object-reference mutation, matching Go's pointer semantics exactly — no impedance mismatch here, unlike array fields.** `NavPoint`/`NavList`/`Navigation` are plain TS objects (reference types), so a function that finds a `NavPoint` deep inside a tree and returns a reference to it (e.g. `findNavPointRec`) lets the caller mutate its `label`/`href`/`type` fields in place — this is the direct equivalent of Go's `*epub.NavPoint` return value, not a divergence requiring an immutable-update workaround. Only *array* fields (a `NavList.items` slice, a `NavPoint.children` slice) need the `insertAt`/`removeAt` immutable-replace pattern already established in `edit-spine.ts`/`idlist.ts`, because reassigning which elements an array holds can't be done through a reference the way mutating an object's scalar fields can.
- **`nav-sync.ts`'s two chapter-lifecycle helpers (`syncTocOnChapterCreate`, `syncTocOnChapterRemove`) are an intentional, narrow exception to the throw-only-in-tool-handlers rule above.** They are not MCP tool handlers — no tool in this phase or `registry.ts` ever calls them directly; Phase 6's `edit_chapter` tool will call them as internal helpers with a **best-effort, boolean-return contract**, mirroring Go's own `(bool)` return (not `(bool, error)`) for these two functions specifically: if the book has no EPUB 3 navigation document, or the "toc" list can't be found/created, the sync silently does nothing and returns `false`, rather than failing the chapter creation/removal that triggered it. Since `primaryNavigation` and `findOrCreateNavList` both throw (per every other convention in this codebase), these two functions must wrap those calls in `try`/`catch` internally to convert a thrown error into a `false` return — this is correct and required here, not a violation of the throw-only convention, which applies to tool-handler-facing error propagation, not to every internal helper's contract.
- Path resolution: `path.resolve()` from `node:path`, matching every tool since Phase 4.
- Tests use `bun:test`.

---

### Task 1: `get_navigation` tool + navigation tree-building helpers

**Files:**
- Create: `src/tools/get-navigation.ts`
- Test: `src/tools/get-navigation.test.ts`
- Modify: `src/index.ts` (add `import "./tools/get-navigation.ts";`)

**Interfaces:**
- Consumes: `epubCache` (`./epub-cache.ts`); `evictionNote` (`./eviction.ts`); `registerTool`, `EpubTool`, `ToolHandlerResult` (`./registry.ts`); `primaryPackage`, `navItem`, `ncxItem`, `resolveHref` (`../epub/resolve.ts`); `Epub`, `Package`, `Navigation`, `NavPoint`, `NCXNavPoint` types (`../epub/types.ts`).
- Produces: `getNavigationTool`/`handleGetNavigation` (registered as `get_navigation`); `primaryNavigation(e: Epub, pkg: Package): Navigation` (throws if the book has no EPUB 3 nav document — consumed by `edit-navigation.ts` (this phase's Task 2), `nav-sync.ts` (Task 3), and `edit-cover.ts`/`edit-back-cover.ts` in Phase 8); `navPointsToTOC(points: NavPoint[]): TocEntry[]` and `ncxPointsToTOC(points: NCXNavPoint[]): TocEntry[]` (consumed by this file and, for `tableOfContents`, by `read-epub.ts` in Phase 7); `tableOfContents(e: Epub, pkg: Package): TocEntry[] | undefined` (the EPUB-3-nav-preferred, NCX-fallback tree builder Phase 7's `read_epub`/`reload_epub` need for their own summary — relocated here from where Go's `read_epub.go` happens to define it, matching this port's established pattern of placing shared logic where it conceptually belongs rather than mirroring Go's incidental file boundaries); `TocEntry` interface (`{ id: string; label: string; href?: string; children?: TocEntry[] }`).

**A Go zero-value subtlety to get right:** Go's `navPointsToTOC`/`ncxPointsToTOC` always return a non-nil (possibly empty) slice, and the result struct's `Items any` field has a `json:"items,omitempty"` tag that does **not** actually omit it in practice — `omitempty` on an `any`-typed field only omits a literal Go `nil` interface value, and a non-nil interface wrapping an empty slice still serializes as `"items": []`. So `get_navigation`'s per-list `items` field is **always present** in the real Go output, even for an empty list — never conditionally omitted. Call `navPointsToTOC(list.items)` unconditionally (it naturally produces `[]` for an empty array); do not make the `items` field conditionally `undefined`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/get-navigation.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetNavigation, navPointsToTOC, ncxPointsToTOC, primaryNavigation, tableOfContents } from "./get-navigation.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_navigation", () => {
  test("returns the toc list with hasNcx false for a fresh book", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-navigation-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Nav Test", "Author"), path);

    const result = await handleGetNavigation(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.hasNcx).toBe(false);
    const lists = result.structuredContent?.lists as Array<{ type?: string; items: unknown[] }>;
    const toc = lists.find((l) => l.type === "toc");
    expect(toc).toBeDefined();
    expect(toc?.items).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  test("listType filters to one list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-navigation-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Nav Filter Test", "Author"), path);

    const result = await handleGetNavigation(fakeServer, { path, listType: "landmarks" });

    const lists = result.structuredContent?.lists as unknown[];
    expect(lists).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path is missing", async () => {
    await expect(handleGetNavigation(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });
});

describe("navPointsToTOC", () => {
  test("maps id/label/href and recurses into children", () => {
    const result = navPointsToTOC([
      { id: "a", label: "Chapter 1", href: "ch1.xhtml", type: "", children: [] },
      { id: "b", label: "Part", href: "", type: "", children: [{ id: "b1", label: "Chapter 2", href: "ch2.xhtml", type: "", children: [] }] },
    ]);

    expect(result).toEqual([
      { id: "a", label: "Chapter 1", href: "ch1.xhtml" },
      { id: "b", label: "Part", children: [{ id: "b1", label: "Chapter 2", href: "ch2.xhtml" }] },
    ]);
  });
});

describe("ncxPointsToTOC", () => {
  test("maps id/label/src(as href) and recurses", () => {
    const result = ncxPointsToTOC([{ id: "n1", playOrder: 1, label: "Chapter 1", src: "ch1.xhtml", children: [] }]);
    expect(result).toEqual([{ id: "n1", label: "Chapter 1", href: "ch1.xhtml" }]);
  });
});

describe("tableOfContents", () => {
  test("prefers the EPUB 3 nav document's toc list", async () => {
    const e = newEpub("TOC Test", "Author");
    const pkg = primaryPackage(e)!;
    const nav = e.navigation["nav.xhtml"]!;
    nav.lists.find((l) => l.type === "toc")!.items.push({ id: "x", label: "Chapter 1", href: "ch1.xhtml", type: "", children: [] });

    const toc = tableOfContents(e, pkg);
    expect(toc).toEqual([{ id: "x", label: "Chapter 1", href: "ch1.xhtml" }]);
  });

  test("returns undefined when there is no nav document and no NCX", async () => {
    const e = newEpub("No Nav Test", "Author");
    const pkg = primaryPackage(e)!;
    // newEpub()'s skeleton always includes a nav document; clear its toc
    // list's items and confirm an empty (not missing) toc list still
    // yields an empty array, not undefined, since the list itself exists.
    const nav = e.navigation["nav.xhtml"]!;
    expect(tableOfContents(e, pkg)).toEqual([]);
    void nav;
  });
});

describe("primaryNavigation", () => {
  test("returns the book's Navigation object", () => {
    const e = newEpub("Primary Nav Test", "Author");
    const pkg = primaryPackage(e)!;
    expect(primaryNavigation(e, pkg)).toBe(e.navigation["nav.xhtml"]);
  });
});
```

Note on the second `tableOfContents` test: since `newEpub()`'s skeleton always creates a navigation document with an (initially empty) "toc" list, there is no way to construct, via public API, an `Epub` with neither a nav document nor an NCX without manually deleting `e.navigation` entries — the test above was drafted assuming that case but `newEpub()` doesn't produce it. Fix this during implementation: either delete `e.navigation[navPath]` from the test fixture directly (constructing the "genuinely no nav, no NCX" case by hand) and confirm `tableOfContents` returns `undefined`, or simplify the test to what's actually reachable (an empty "toc" list yields `[]`, as already covered by the first assertion) and drop the redundant/misleading second half. Use your judgment on which better documents the function's real contract — favor a test that actually exercises the `undefined`-returning branch, since that's the more interesting, less-obviously-correct path.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/get-navigation.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/get-navigation.ts`**

```typescript
/**
 * get_navigation — read the EPUB 3 navigation document (table of
 * contents, landmarks, page-list). Mirrors Go's tools/get_navigation.go.
 *
 * Also hosts primaryNavigation and the nav-tree-to-TOC builders
 * (navPointsToTOC/ncxPointsToTOC/tableOfContents) — shared logic
 * consumed by nav-sync.ts, edit-navigation.ts, edit-cover.ts/
 * edit-back-cover.ts (Phase 8), and read-epub.ts (Phase 7). Go defines
 * tableOfContents/navPointsToTOC/ncxPointsToTOC in read_epub.go instead;
 * relocated here since they're fundamentally about navigation trees, and
 * get_navigation needs navPointsToTOC/ncxPointsToTOC regardless — keeping
 * all three together avoids a circular file-ordering dependency between
 * this file and a not-yet-built read-epub.ts.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { ncxItem, navItem, primaryPackage, resolveHref } from "../epub/resolve.ts";
import type { Epub, NavPoint, NCXNavPoint, Navigation, Package } from "../epub/types.ts";

interface GetNavigationArgs {
  path: string;
  listType?: string;
}

export interface TocEntry {
  id: string;
  label: string;
  href?: string;
  children?: TocEntry[];
}

export const getNavigationTool: EpubTool = {
  name: "get_navigation",
  description: "Read the navigation document (table of contents, landmarks, page-list) of an already-read EPUB. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      listType: { type: "string", description: 'restrict the result to one nav list by type ("toc", "landmarks", "page-list", ...); omit for all lists' },
    },
    required: ["path"],
  },
};

/** Returns e's EPUB 3 navigation document, throwing if the book has none. */
export function primaryNavigation(e: Epub, pkg: Package): Navigation {
  const item = navItem(pkg);
  if (!item) throw new Error(`${JSON.stringify(pkg.id)} has no EPUB 3 navigation document`);
  const nav = e.navigation[resolveHref(pkg, item.href)];
  if (!nav) throw new Error(`navigation item ${JSON.stringify(item.id)} resolves to a path not in navigation`);
  return nav;
}

export function navPointsToTOC(points: NavPoint[]): TocEntry[] {
  return points.map((p) => {
    const entry: TocEntry = { id: p.id, label: p.label };
    if (p.href) entry.href = p.href;
    if (p.children.length > 0) entry.children = navPointsToTOC(p.children);
    return entry;
  });
}

export function ncxPointsToTOC(points: NCXNavPoint[]): TocEntry[] {
  return points.map((p) => {
    const entry: TocEntry = { id: p.id, label: p.label };
    if (p.src) entry.href = p.src;
    if (p.children.length > 0) entry.children = ncxPointsToTOC(p.children);
    return entry;
  });
}

/** Prefers the EPUB 3 nav document's "toc" list, falling back to the legacy NCX for EPUB 2 books. */
export function tableOfContents(e: Epub, pkg: Package): TocEntry[] | undefined {
  const item = navItem(pkg);
  if (item) {
    const nav = e.navigation[resolveHref(pkg, item.href)];
    if (nav) {
      const list = nav.lists.find((l) => l.type === "toc");
      if (list) return navPointsToTOC(list.items);
    }
  }
  const ncx = ncxItem(pkg);
  if (ncx) {
    const doc = e.nCXs[resolveHref(pkg, ncx.href)];
    if (doc) return ncxPointsToTOC(doc.navMap);
  }
  return undefined;
}

export async function handleGetNavigation(_server: Server, args: GetNavigationArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);
  const nav = primaryNavigation(e, pkg);

  const lists = nav.lists
    .filter((list) => !args.listType || list.type === args.listType)
    .map((list) => ({
      id: list.id,
      type: list.type || undefined,
      heading: list.heading || undefined,
      items: navPointsToTOC(list.items),
    }));

  const structuredContent = { lists, hasNcx: ncxItem(pkg) !== undefined };
  const summary = `Read navigation of ${JSON.stringify(abs)} (${lists.length} lists).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getNavigationTool,
  "Takes path, the same .epub filesystem path passed to read_epub, and an optional listType to restrict " +
    'the result to one nav list ("toc", "landmarks", "page-list", or a custom epub:type); omit it to get ' +
    "every list the navigation document has. Each list's items form a tree of id/label/href/children " +
    'entries — the same shape as read_epub\'s tableOfContents, which is always this tool\'s "toc" list. ' +
    "hasNcx reports whether the book also has a legacy EPUB 2 NCX; if so, edit_navigation keeps it " +
    "mirroring the \"toc\" list automatically, so this tool doesn't expose it separately. Use a returned " +
    "item's id with edit_navigation to edit/remove it, or as the parent id to nest a new one under it.",
  handleGetNavigation as never,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/get-navigation.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/get-navigation.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/get-navigation.ts src/tools/get-navigation.test.ts src/index.ts
git commit -m "Add get_navigation tool and navigation tree-building helpers"
```

---

### Task 2: `edit_navigation` tool + nav-point tree editing helpers

**Files:**
- Create: `src/tools/edit-navigation.ts`
- Test: `src/tools/edit-navigation.test.ts`
- Modify: `src/index.ts` (add `import "./tools/edit-navigation.ts";`)

**Interfaces:**
- Consumes: `epubCache`, `evictionNote`, `resolveArg`/`withHint` (`./elicit.ts`), `insertAt`/`clampPosition` (`./edit-spine.ts`, Phase 4 Task 3), `removeAt`/`verbPast` (`./idlist.ts`, Phase 4 Task 1), `primaryNavigation` (`./get-navigation.ts`, this phase's Task 1), `registerTool`/`EpubTool`/`ToolHandlerResult` (`./registry.ts`), `primaryPackage`/`ncxItem`/`resolveHref` (`../epub/resolve.ts`), `renderNavigationDocument`/`renderNCXDocument` (`../epub/render-nav.ts`, Phase 2), `ArchiveId`/`NavList`/`NavPoint`/`Navigation`/`NCXNavPoint`/`Package` types (`../epub/types.ts`).
- Produces: `editNavigationTool`/`handleEditNavigation` (registered as `edit_navigation`); `findOrCreateNavList(nav, listType, action): NavList` (throws if not found and `action !== "create"` — consumed by `nav-sync.ts`, this phase's Task 3); `bookTitle(pkg): string`, `bookUID(pkg): string`, `toNCXPoints(points): NCXNavPoint[]`, `renumberNavPoints(base, points): void` (all consumed by `nav-sync.ts` and, in Phase 8, `edit-cover.ts`/`edit-back-cover.ts`); `addLandmarkEntry(pkg, nav, label, href, navType): boolean` (consumed by `edit-cover.ts`/`edit-back-cover.ts` in Phase 8, to register a cover/back-cover page's landmark).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/edit-navigation.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { addLandmarkEntry, bookTitle, bookUID, findOrCreateNavList, handleEditNavigation, renumberNavPoints, toNCXPoints } from "./edit-navigation.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-navigation-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Navigation Test", "Author"), path);
  return { dir, path };
}

describe("edit_navigation", () => {
  test("create adds a top-level toc entry", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 1", href: "ch1.xhtml" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.listType).toBe("toc");

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    const nav = cached!.navigation["nav.xhtml"]!;
    const toc = nav.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(1);
    expect(toc.items[0]).toMatchObject({ label: "Chapter 1", href: "ch1.xhtml" });
    void pkg;

    await rm(dir, { recursive: true, force: true });
  });

  test("create nests a child under a given parent id", async () => {
    const { dir, path } = await writeTempBook();
    const first = await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Part One", href: "" });
    const parentId = first.structuredContent?.id as string;

    await handleEditNavigation(fakeServer, { action: "create", path, id: parentId, label: "Chapter 1", href: "ch1.xhtml" });

    const cached = epubCache.get(resolve(path));
    const nav = cached!.navigation["nav.xhtml"]!;
    const toc = nav.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(1);
    expect(toc.items[0]?.children).toHaveLength(1);
    expect(toc.items[0]?.children[0]).toMatchObject({ label: "Chapter 1", href: "ch1.xhtml" });

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails on a duplicate href among siblings", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 1", href: "ch1.xhtml" });

    await expect(
      handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 1 Again", href: "ch1.xhtml" }),
    ).rejects.toThrow("already has an entry");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces label/href/type and can reposition", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 1", href: "ch1.xhtml" });
    await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 2", href: "ch2.xhtml" });

    const cachedBefore = epubCache.get(resolve(path))!;
    const tocBefore = cachedBefore.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    const secondId = tocBefore.items[1]!.id;

    await handleEditNavigation(fakeServer, { action: "edit", path, id: secondId, label: "Chapter Two", href: "ch2.xhtml", position: "0" });

    const cached = epubCache.get(resolve(path))!;
    const toc = cached.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items[0]?.label).toBe("Chapter Two");

    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes an entry and its children", async () => {
    const { dir, path } = await writeTempBook();
    const created = await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Part One", href: "" });
    const parentId = created.structuredContent?.id as string;
    await handleEditNavigation(fakeServer, { action: "create", path, id: parentId, label: "Chapter 1", href: "ch1.xhtml" });

    await handleEditNavigation(fakeServer, { action: "remove", path, id: parentId });

    const cached = epubCache.get(resolve(path))!;
    const toc = cached.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("syncs the legacy NCX when listType is toc and the book has one", async () => {
    const { dir, path } = await writeTempBook();
    const cached = (await epubCache.load(resolve(path))).epub;
    const pkg = primaryPackage(cached)!;
    // newEpub()'s skeleton has no NCX; add one directly to exercise the
    // sync path, mirroring how a real EPUB 2-compat book would already
    // have one on disk.
    pkg.spine.tocRef = "ncx";
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ncx`, href: "toc.ncx", mediaType: "application/x-dtbncx+xml", properties: [], fallback: "", mediaOverlay: "" });
    cached.nCXs["toc.ncx"] = { id: "toc.ncx", markup: "", navMap: [] };

    const result = await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 1", href: "ch1.xhtml" });

    expect(result.structuredContent?.ncxSynced).toBe(true);
    expect(cached.nCXs["toc.ncx"]!.navMap).toHaveLength(1);
    expect(cached.nCXs["toc.ncx"]!.markup).toContain("Chapter 1");

    await rm(dir, { recursive: true, force: true });
  });

  test("creating a landmarks entry doesn't sync the NCX", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Cover", href: "cover.xhtml", listType: "landmarks", type: "cover" });
    expect(result.structuredContent?.ncxSynced).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("findOrCreateNavList", () => {
  test("creates a new list on demand and finds it again", () => {
    const e = newEpub("Find Or Create Test", "Author");
    const nav = e.navigation["nav.xhtml"]!;
    const created = findOrCreateNavList(nav, "landmarks", "create");
    expect(created.type).toBe("landmarks");
    expect(created.heading).toBe("Landmarks");
    expect(findOrCreateNavList(nav, "landmarks", "edit")).toBe(created);
  });

  test("throws for a missing list when action isn't create", () => {
    const e = newEpub("Find Or Create Throw Test", "Author");
    const nav = e.navigation["nav.xhtml"]!;
    expect(() => findOrCreateNavList(nav, "page-list", "edit")).toThrow();
  });
});

describe("bookTitle / bookUID", () => {
  test("bookTitle falls back to \"Navigation\" when there's no title", () => {
    const e = newEpub("", "Author");
    const pkg = primaryPackage(e)!;
    pkg.metadata.titles = [];
    expect(bookTitle(pkg)).toBe("Navigation");
  });

  test("bookUID falls back to empty string when there's no identifier", () => {
    const e = newEpub("UID Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.metadata.identifiers = [];
    expect(bookUID(pkg)).toBe("");
  });
});

describe("toNCXPoints", () => {
  test("maps label/href(as src) and recurses, leaving id/playOrder blank for the renderer to fill in", () => {
    const result = toNCXPoints([{ id: "x", label: "Chapter 1", href: "ch1.xhtml", type: "", children: [] }]);
    expect(result).toEqual([{ id: "", playOrder: 0, label: "Chapter 1", src: "ch1.xhtml", children: [] }]);
  });
});

describe("renumberNavPoints", () => {
  test("assigns positional ids recursively", () => {
    const points = [
      { id: "old", label: "A", href: "", type: "", children: [{ id: "old-child", label: "A1", href: "", type: "", children: [] }] },
    ];
    renumberNavPoints("base", points);
    expect(points[0]?.id).toBe("base/item[0]");
    expect(points[0]?.children[0]?.id).toBe("base/item[0]/item[0]");
  });
});

describe("addLandmarkEntry", () => {
  test("appends to the landmarks list, creating it if absent, and renders markup", () => {
    const e = newEpub("Landmark Test", "Author");
    const pkg = primaryPackage(e)!;
    const nav = e.navigation["nav.xhtml"]!;
    const added = addLandmarkEntry(pkg, nav, "Cover", "cover.xhtml", "cover");
    expect(added).toBe(true);
    const list = nav.lists.find((l) => l.type === "landmarks")!;
    expect(list.items).toHaveLength(1);
    expect(nav.markup).toContain("Cover");
  });

  test("returns false without duplicating an entry that already targets href", () => {
    const e = newEpub("Landmark Dup Test", "Author");
    const pkg = primaryPackage(e)!;
    const nav = e.navigation["nav.xhtml"]!;
    addLandmarkEntry(pkg, nav, "Cover", "cover.xhtml", "cover");
    const addedAgain = addLandmarkEntry(pkg, nav, "Cover Again", "cover.xhtml", "cover");
    expect(addedAgain).toBe(false);
    expect(nav.lists.find((l) => l.type === "landmarks")!.items).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/edit-navigation.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/edit-navigation.ts`**

```typescript
/**
 * edit_navigation — create, edit, or remove one entry of the EPUB 3
 * navigation document (table of contents, landmarks, page-list),
 * keeping a legacy NCX in sync for "toc" changes. Mirrors Go's
 * tools/edit_navigation.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg, withHint } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { clampPosition, insertAt } from "./edit-spine.ts";
import { removeAt, verbPast } from "./idlist.ts";
import { primaryNavigation } from "./get-navigation.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { ncxItem, primaryPackage, resolveHref } from "../epub/resolve.ts";
import { renderNavigationDocument, renderNCXDocument } from "../epub/render-nav.ts";
import type { NavList, NavPoint, Navigation, NCXNavPoint, Package } from "../epub/types.ts";

interface EditNavigationArgs {
  action?: string;
  path?: string;
  id?: string;
  label?: string;
  labelPrompt?: string;
  listType?: string;
  href?: string;
  type?: string;
  position?: string;
}

interface EditNavigationResult {
  action: string;
  listType: string;
  id: string;
  ncxSynced: boolean;
}

export const editNavigationTool: EpubTool = {
  name: "edit_navigation",
  description:
    "Create, edit, or remove one entry of an already-read EPUB's navigation document (table of contents, landmarks, page-list). Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a new entry, "edit" an existing one, or "remove" one' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: {
        type: "string",
        description:
          'for create: the parent entry\'s id to nest the new one under, or "" for a top-level entry; for edit/remove: the target entry\'s id, from get_navigation',
      },
      label: { type: "string", description: "the entry's display text; used by create and edit, ignored by remove" },
      labelPrompt: {
        type: "string",
        description:
          "extra context to show the user if label is omitted and they must be prompted for it — e.g. what this entry is for, or its current label; ignored if label is given directly, and never itself prompted for",
      },
      listType: {
        type: "string",
        description: 'which nav list this entry belongs to ("toc", "landmarks", "page-list", ...); defaults to "toc", creating the list if it doesn\'t exist yet',
      },
      href: { type: "string", description: 'target archive path, optionally with a "#fragment"; empty makes a heading-only entry that exists only to hold children' },
      type: {
        type: "string",
        description:
          'this entry\'s own epub:type attribute, distinct from listType — meaningful mainly in the "landmarks" list, e.g. "cover" or "afterword"; replaced wholesale like label/href on edit, so pass the current value back if only something else is changing',
      },
      position: { type: "string", description: "0-based index among its siblings to insert/move this entry to; omit to append at the end" },
    },
  },
};

/** Finds nav's list of the given type, or — if action is "create" — creates and appends it. Throws if not found and action isn't "create". */
export function findOrCreateNavList(nav: Navigation, listType: string, action: string): NavList {
  const existing = nav.lists.find((l) => l.type === listType);
  if (existing) return existing;
  if (action !== "create") throw new Error(`navigation document has no list of type ${JSON.stringify(listType)}`);
  const list: NavList = {
    id: `${nav.id}#${listType}`,
    type: listType,
    heading: listType.charAt(0).toUpperCase() + listType.slice(1),
    items: [],
  };
  nav.lists.push(list);
  return list;
}

/** Returns pkg's first title, or "Navigation" if it has none/an empty one. */
export function bookTitle(pkg: Package): string {
  const first = pkg.metadata.titles[0];
  if (first && first.value) return first.value;
  return "Navigation";
}

/** Returns pkg's first identifier's value, or "" if it has none. */
export function bookUID(pkg: Package): string {
  const first = pkg.metadata.identifiers[0];
  return first ? first.value : "";
}

/** Converts a NavPoint tree to an NCXNavPoint tree; id/playOrder are left blank for renderNCXDocument to fill in. */
export function toNCXPoints(points: NavPoint[]): NCXNavPoint[] {
  return points.map((p) => ({ id: "", playOrder: 0, label: p.label, src: p.href, children: toNCXPoints(p.children) }));
}

/**
 * Appends a new top-level entry to nav's "landmarks" list (creating the
 * list if it doesn't exist yet), tagged with navType as its epub:type —
 * used to auto-register the "cover"/"afterword" landmark edit_cover and
 * edit_back_cover wire up for their pages (Phase 8). Renders nav's markup
 * to match (landmarks has no NCX equivalent to sync). A no-op, returning
 * false, if an entry already targets href, so re-running the caller
 * doesn't duplicate it; callers should still call save_epub as usual
 * afterwards regardless of the return value.
 */
export function addLandmarkEntry(pkg: Package, nav: Navigation, label: string, href: string, navType: string): boolean {
  const list = findOrCreateNavList(nav, "landmarks", "create");
  if (findDuplicateNavPoint(list.items, label, href) !== "") return false;
  list.items.push({ id: "", label, href, type: navType, children: [] });
  renumberNavPoints(list.id, list.items);
  renderNavigationDocument(nav, bookTitle(pkg));
  return true;
}

/**
 * Returns the id of the sibling in siblings that already targets href
 * (or, for a heading-only entry with href === "", already carries the
 * same label), or "" if none matches. Siblings are compared at one
 * nesting level only, matching where create would insert.
 */
function findDuplicateNavPoint(siblings: NavPoint[], label: string, href: string): string {
  for (const s of siblings) {
    if (href !== "" && s.href === href) return s.id;
    if (href === "" && s.href === "" && s.label === label) return s.id;
  }
  return "";
}

/** Returns the NavPoint with the given id anywhere in points (searching children too), or undefined. Mutating fields on the returned object mutates the tree, matching Go's *NavPoint semantics. */
function findNavPointRec(points: NavPoint[], id: string): NavPoint | undefined {
  for (const p of points) {
    if (p.id === id) return p;
    const found = findNavPointRec(p.children, id);
    if (found) return found;
  }
  return undefined;
}

/** Inserts np at index at among parentId's children (top-level siblings if parentId is ""), reporting whether parentId was found (top-level insertion always succeeds). */
function insertNavPointRec(points: NavPoint[], parentId: string, at: number, np: NavPoint): [NavPoint[], boolean] {
  if (parentId === "") {
    return [insertAt(points, clampPosition(at, points.length), np), true];
  }
  for (const p of points) {
    if (p.id === parentId) {
      p.children = insertAt(p.children, clampPosition(at, p.children.length), np);
      return [points, true];
    }
    const [children, ok] = insertNavPointRec(p.children, parentId, at, np);
    if (ok) {
      p.children = children;
      return [points, true];
    }
  }
  return [points, false];
}

/** Deletes the NavPoint with the given id from points (searching children too), reporting whether it was found. */
function removeNavPointRec(points: NavPoint[], id: string): [NavPoint[], boolean] {
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.id === id) return [removeAt(points, i), true];
  }
  for (const p of points) {
    const [children, ok] = removeNavPointRec(p.children, id);
    if (ok) {
      p.children = children;
      return [points, true];
    }
  }
  return [points, false];
}

/** Relocates the NavPoint with the given id to index at among its current siblings, reporting whether it was found. */
function moveNavPointRec(points: NavPoint[], id: string, at: number): [NavPoint[], boolean] {
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.id === id) {
      const p = points[i]!;
      const rest = removeAt(points, i);
      return [insertAt(rest, clampPosition(at, rest.length), p), true];
    }
  }
  for (const p of points) {
    const [children, ok] = moveNavPointRec(p.children, id, at);
    if (ok) {
      p.children = children;
      return [points, true];
    }
  }
  return [points, false];
}

/** Reassigns positional ids ("<base>/item[<index>]") to every NavPoint in points after a structural change, so every entry keeps a valid, collision-free id. */
export function renumberNavPoints(base: string, points: NavPoint[]): void {
  points.forEach((p, i) => {
    p.id = `${base}/item[${i}]`;
    renumberNavPoints(p.id, p.children);
  });
}

/** Builds the elicitation message used when label is omitted, working in whatever context is already available. */
function labelPromptMessage(action: string, listType: string, id: string, href: string): string {
  if (action === "create") {
    if (href !== "") return `What should the display text be for this new ${JSON.stringify(listType)} entry, linking to ${JSON.stringify(href)}?`;
    if (id !== "") return `What should the display text be for this new ${JSON.stringify(listType)} entry, nested under entry ${JSON.stringify(id)}?`;
    return `What should the display text be for this new top-level ${JSON.stringify(listType)} entry?`;
  }
  if (href !== "") {
    return `What should the display text be for the ${JSON.stringify(listType)} entry ${JSON.stringify(id)} (which targets ${JSON.stringify(href)})? This replaces its current label.`;
  }
  return `What should the display text be for the ${JSON.stringify(listType)} entry ${JSON.stringify(id)}? This replaces its current label.`;
}

export async function handleEditNavigation(server: Server, args: EditNavigationArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const idPromptMsg =
    action === "create"
      ? 'Which entry should the new one be nested under? Provide its id, or "" for a top-level entry.'
      : "Which entry should be affected? Provide its id from get_navigation.";
  const id = await resolveArg(server, args.id, "id", idPromptMsg);

  const listType = args.listType || "toc";

  let label = "";
  if (action !== "remove") {
    let labelMsg = labelPromptMessage(action, listType, id, args.href ?? "");
    if (args.labelPrompt) labelMsg = withHint(labelMsg, args.labelPrompt);
    label = await resolveArg(server, args.label, "label", labelMsg);
  }

  let position: number | undefined;
  if (args.position) {
    const p = Number.parseInt(args.position, 10);
    if (Number.isNaN(p)) throw new Error(`position must be an integer, got ${JSON.stringify(args.position)}`);
    position = p;
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);
  const nav = primaryNavigation(e, pkg);

  const list = findOrCreateNavList(nav, listType, action);

  switch (action) {
    case "create": {
      let siblings: NavPoint[];
      let at = list.items.length;
      if (id !== "") {
        const target = findNavPointRec(list.items, id);
        if (!target) throw new Error(`no navigation entry with id ${JSON.stringify(id)} in list ${JSON.stringify(listType)}`);
        siblings = target.children;
        at = target.children.length;
      } else {
        siblings = list.items;
      }
      const href = args.href ?? "";
      const dupId = findDuplicateNavPoint(siblings, label, href);
      if (dupId !== "") {
        throw new Error(`list ${JSON.stringify(listType)} already has an entry with this href/label (id ${JSON.stringify(dupId)}); use action "edit" instead`);
      }

      const np: NavPoint = { id: "", label, href, type: args.type ?? "", children: [] };
      if (position !== undefined) at = position;
      const [items, ok] = insertNavPointRec(list.items, id, at, np);
      if (!ok) throw new Error(`no navigation entry with id ${JSON.stringify(id)} in list ${JSON.stringify(listType)}`);
      list.items = items;
      renumberNavPoints(list.id, list.items);
      break;
    }
    case "edit": {
      const target = findNavPointRec(list.items, id);
      if (!target) throw new Error(`no navigation entry with id ${JSON.stringify(id)} in list ${JSON.stringify(listType)}`);
      target.label = label;
      target.href = args.href ?? "";
      target.type = args.type ?? "";
      if (position !== undefined) {
        const [items, moved] = moveNavPointRec(list.items, id, position);
        if (!moved) throw new Error(`no navigation entry with id ${JSON.stringify(id)} in list ${JSON.stringify(listType)}`);
        list.items = items;
      }
      break;
    }
    case "remove": {
      const [items, ok] = removeNavPointRec(list.items, id);
      if (!ok) throw new Error(`no navigation entry with id ${JSON.stringify(id)} in list ${JSON.stringify(listType)}`);
      list.items = items;
      renumberNavPoints(list.id, list.items);
      break;
    }
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  const docTitle = bookTitle(pkg);
  renderNavigationDocument(nav, docTitle);

  let ncxSynced = false;
  if (listType === "toc") {
    const ncxManifestItem = ncxItem(pkg);
    if (ncxManifestItem) {
      const ncx = e.nCXs[resolveHref(pkg, ncxManifestItem.href)];
      if (ncx) {
        ncx.navMap = toNCXPoints(list.items);
        renderNCXDocument(ncx, docTitle, bookUID(pkg));
        ncxSynced = true;
      }
    }
  }

  epubCache.markDirty(abs);
  const result: EditNavigationResult = { action, listType, id, ncxSynced };
  const summary = `${verbPast(action)}d navigation entry in list ${JSON.stringify(listType)} of ${JSON.stringify(abs)}. Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  editNavigationTool,
  'Takes action ("create", "edit", or "remove"), path, id, and label; any of these may be omitted to be ' +
    "prompted for (see edit_chapter's description for the general elicitation rules every edit_ tool " +
    "follows). If label is omitted, pass labelPrompt with context the user needs to answer sensibly — what " +
    'this entry is for, what it currently says, what it links to — since the bare question "what should ' +
    'this entry\'s display text be?" gives them nothing to go on; labelPrompt is folded into the prompt and ' +
    'is never itself elicited. listType picks which nav list is affected (default "toc", the same list ' +
    "read_epub's tableOfContents and edit_chapter's create/remove keep updated as chapters come and go, " +
    "appending/removing a top-level entry automatically — use edit_navigation instead when you want to " +
    "reorder, rename, nest, or add a heading-only entry rather than accept the auto-generated one).\n\n" +
    'action "create": id is the parent entry to nest the new one under, or "" for a top-level entry in the ' +
    "list; href is the target (leave empty for a heading-only entry meant to hold children, e.g. a part or " +
    "section heading); position controls where among its siblings it lands. create never touches an " +
    "existing entry — it only inserts a brand-new sibling, so it cannot be used to retitle, move, or " +
    "retarget one that's already there. It fails if a sibling at the same nesting level already targets " +
    "the same href (or, for a heading-only entry, already has the same label) — call get_navigation first " +
    'to check, and use "edit" on that entry\'s id instead of "create" if it already exists.\n\naction ' +
    '"edit": id is the entry to change; label, href, and type are replaced wholesale (pass their current ' +
    "values back if only one is changing); position, if given, moves it among its current siblings.\n\n" +
    'action "remove": id is the entry to delete, along with any children it has.\n\nWhen listType is "toc" ' +
    "(the default) and the book also has a legacy EPUB 2 NCX, edit_navigation regenerates the NCX's navMap " +
    "and markup to match automatically — there's no separate NCX tool. Only touches the in-memory cache; " +
    "call save_epub afterwards to persist.",
  handleEditNavigation as never,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/edit-navigation.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/edit-navigation.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/edit-navigation.ts src/tools/edit-navigation.test.ts src/index.ts
git commit -m "Add edit_navigation tool and nav-point tree editing helpers"
```

---

### Task 3: `nav-sync.ts` — chapter-lifecycle-to-navigation syncing

**Files:**
- Create: `src/tools/nav-sync.ts`
- Test: `src/tools/nav-sync.test.ts`

**No `src/index.ts` change** — this file registers no MCP tool; it's internal plumbing Phase 6's `edit_chapter` tool will import and call directly when a chapter is created/removed via markdown or plain XHTML input.

**Interfaces:**
- Consumes: `removeAt` (`./idlist.ts`); `primaryNavigation` (`./get-navigation.ts`); `bookTitle`, `bookUID`, `findOrCreateNavList`, `renumberNavPoints`, `toNCXPoints` (`./edit-navigation.ts`, this phase's Task 2); `ncxItem`, `resolveHref` (`../epub/resolve.ts`); `renderNavigationDocument`, `renderNCXDocument` (`../epub/render-nav.ts`); `Epub`, `NavList`, `NavPoint`, `Navigation`, `Package` types (`../epub/types.ts`).
- Produces: `syncTocOnChapterCreate(e, pkg, archivePath, label): boolean`, `syncTocOnChapterRemove(e, pkg, archivePath): boolean`, `syncNavRender(e, pkg, nav, list): void`, `defaultChapterLabel(archivePath): string` — all four consumed by Phase 6's `edit-chapter.ts`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/nav-sync.test.ts
import { describe, expect, test } from "bun:test";
import { defaultChapterLabel, syncNavRender, syncTocOnChapterCreate, syncTocOnChapterRemove } from "./nav-sync.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";

describe("syncTocOnChapterCreate", () => {
  test("appends a top-level toc entry with a derived label when none is given", () => {
    const e = newEpub("Sync Create Test", "Author");
    const pkg = primaryPackage(e)!;

    const synced = syncTocOnChapterCreate(e, pkg, "text/chapter-1.xhtml", "");

    expect(synced).toBe(true);
    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(1);
    expect(toc.items[0]).toMatchObject({ label: "Chapter 1", href: "text/chapter-1.xhtml" });
  });

  test("uses the given label when one is provided", () => {
    const e = newEpub("Sync Create Label Test", "Author");
    const pkg = primaryPackage(e)!;

    syncTocOnChapterCreate(e, pkg, "ch1.xhtml", "My Custom Title");

    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items[0]?.label).toBe("My Custom Title");
  });

  test("is a no-op returning false when the book has no EPUB 3 navigation document", () => {
    const e = newEpub("Sync No Nav Test", "Author");
    const pkg = primaryPackage(e)!;
    delete e.navigation["nav.xhtml"];
    // Also remove the nav manifest item's "nav" property so navItem(pkg)
    // finds nothing, matching a book genuinely without a nav document.
    const navManifestItem = pkg.manifest.items.find((i) => i.properties.includes("nav"));
    if (navManifestItem) navManifestItem.properties = [];

    expect(syncTocOnChapterCreate(e, pkg, "ch1.xhtml", "Chapter 1")).toBe(false);
  });
});

describe("syncTocOnChapterRemove", () => {
  test("removes the matching top-level entry and returns true", () => {
    const e = newEpub("Sync Remove Test", "Author");
    const pkg = primaryPackage(e)!;
    syncTocOnChapterCreate(e, pkg, "ch1.xhtml", "Chapter 1");

    const removed = syncTocOnChapterRemove(e, pkg, "ch1.xhtml");

    expect(removed).toBe(true);
    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(0);
  });

  test("returns false when no entry targets the given href", () => {
    const e = newEpub("Sync Remove Miss Test", "Author");
    const pkg = primaryPackage(e)!;
    expect(syncTocOnChapterRemove(e, pkg, "does-not-exist.xhtml")).toBe(false);
  });
});

describe("syncNavRender", () => {
  test("re-renders the navigation document's markup", () => {
    const e = newEpub("Sync Render Test", "Author");
    const pkg = primaryPackage(e)!;
    const nav = e.navigation["nav.xhtml"]!;
    const toc = nav.lists.find((l) => l.type === "toc")!;
    toc.items.push({ id: "x", label: "Chapter 1", href: "ch1.xhtml", type: "", children: [] });

    syncNavRender(e, pkg, nav, toc);

    expect(nav.markup).toContain("Chapter 1");
  });
});

describe("defaultChapterLabel", () => {
  test("derives a title-cased label from a hyphenated file name", () => {
    expect(defaultChapterLabel("text/chapter-18.xhtml")).toBe("Chapter 18");
  });

  test("handles underscores and no directory", () => {
    expect(defaultChapterLabel("chapter_two.xhtml")).toBe("Chapter Two");
  });

  test('falls back to "Untitled" for a name with no word characters', () => {
    expect(defaultChapterLabel("---.xhtml")).toBe("Untitled");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/nav-sync.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/nav-sync.ts`**

```typescript
/**
 * Chapter-lifecycle <-> navigation syncing: keeps the "toc" nav list
 * (and legacy NCX, if present) up to date as chapters are created or
 * removed via edit_chapter (Phase 6), without requiring a separate
 * edit_navigation call for the common case. Mirrors Go's
 * tools/nav_sync.go.
 *
 * syncTocOnChapterCreate/syncTocOnChapterRemove are deliberately
 * best-effort (boolean return, no throw): a book with no EPUB 3
 * navigation document has nothing to sync, and that's not an error
 * condition for the chapter create/remove that triggered the sync
 * attempt — it's simply skipped. This means catching the throwing
 * primaryNavigation/findOrCreateNavList calls internally, converting
 * them to a false return, rather than propagating per this codebase's
 * usual throw-only convention (which governs MCP tool handlers'
 * error-vs-user contract, not every internal helper's own contract).
 */
import { removeAt } from "./idlist.ts";
import { primaryNavigation } from "./get-navigation.ts";
import { bookTitle, bookUID, findOrCreateNavList, renumberNavPoints, toNCXPoints } from "./edit-navigation.ts";
import { ncxItem, resolveHref } from "../epub/resolve.ts";
import { renderNavigationDocument, renderNCXDocument } from "../epub/render-nav.ts";
import type { Epub, NavList, NavPoint, Navigation, Package } from "../epub/types.ts";

/** Appends a top-level "toc" entry for archivePath, best-effort. Returns whether the sync happened. */
export function syncTocOnChapterCreate(e: Epub, pkg: Package, archivePath: string, label: string): boolean {
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
    return false;
  }
  const resolvedLabel = label || defaultChapterLabel(archivePath);
  list.items.push({ id: "", label: resolvedLabel, href: archivePath, type: "", children: [] });
  renumberNavPoints(list.id, list.items);
  syncNavRender(e, pkg, nav, list);
  return true;
}

/** Deletes the top-level "toc" entry targeting archivePath, if any. Best-effort. Returns whether an entry was found and removed. */
export function syncTocOnChapterRemove(e: Epub, pkg: Package, archivePath: string): boolean {
  let nav: Navigation;
  try {
    nav = primaryNavigation(e, pkg);
  } catch {
    return false;
  }
  for (const list of nav.lists) {
    if (list.type !== "toc") continue;
    const [items, ok] = removeNavPointByHref(list.items, archivePath);
    if (!ok) return false;
    list.items = items;
    renumberNavPoints(list.id, list.items);
    syncNavRender(e, pkg, nav, list);
    return true;
  }
  return false;
}

/** Re-renders nav's markup and, if the book also has a legacy NCX, regenerates it from list's current items — the same pairing edit_navigation performs after every structural change to the toc list. */
export function syncNavRender(e: Epub, pkg: Package, nav: Navigation, list: NavList): void {
  const docTitle = bookTitle(pkg);
  renderNavigationDocument(nav, docTitle);
  const item = ncxItem(pkg);
  if (item) {
    const ncx = e.nCXs[resolveHref(pkg, item.href)];
    if (ncx) {
      ncx.navMap = toNCXPoints(list.items);
      renderNCXDocument(ncx, docTitle, bookUID(pkg));
    }
  }
}

/** Derives a human-readable toc label from an archive path's file name, e.g. "text/chapter-18.xhtml" -> "Chapter 18", for create calls that don't supply an explicit label. */
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

/** Deletes the first top-level NavPoint in points whose href matches href, reporting whether one was found. Doesn't recurse into children, since syncTocOnChapterCreate only ever inserts top-level entries. */
function removeNavPointByHref(points: NavPoint[], href: string): [NavPoint[], boolean] {
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.href === href) return [removeAt(points, i), true];
  }
  return [points, false];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/nav-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 6: Commit**

```bash
git add src/tools/nav-sync.ts src/tools/nav-sync.test.ts
git commit -m "Add chapter-lifecycle-to-navigation syncing helpers (nav-sync.ts)"
```

---

## Definition of done

- `bun run typecheck` exits 0.
- `bun test` passes for every file under `src/`.
- `src/tools/` additionally contains `get-navigation.ts`, `edit-navigation.ts`, `nav-sync.ts`, each (except `nav-sync.ts`) with a matching `*.test.ts` and wired into `src/index.ts`; `nav-sync.ts` has its own `*.test.ts` but registers no tool.
- A manual smoke test (`tools/list` over stdio) lists 13 tools: the 11 from Phase 3-4 plus `get_navigation` and `edit_navigation`.
- Phase 6 (chapters/manuscript tools) can begin — it depends on `nav-sync.ts`'s four exports, all done here.
