# Phase 4: Shared Foundation + Simple CRUD Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the shared plumbing every remaining tool depends on (the module-level EPUB cache singleton, generic list-editing helpers) plus the six simplest, most self-contained `get_`/`edit_` tool pairs: resource, spine, guide, manifest, and metadata.

**Architecture:** One new shared-state file (`src/tools/epub-cache.ts`), one shared-helpers file (`src/tools/idlist.ts`), and five `get_`/`edit_` tool-pair files under `src/tools/`, each self-registering via `registerTool` exactly like `get-context.ts` (Phase 3). Also extends `registry.ts`'s `ToolHandlerResult` with an optional `structuredContent` field, since every Go tool returns both human-readable text *and* a structured result object (surfaced via MCP's `structuredContent` response field) — Phase 3 only needed plain text since `get_context` has no structured output.

**Why this phase's scope changed from the original design spec:** the spec's Phase 4 was "lifecycle tools" and Phase 5 was "chapter/manuscript tools," in that order. Reading the full Go `tools/` package (not just skimming file names) revealed the real dependency graph doesn't respect that split — `save_epub.go` calls `insertChapter` (defined in `edit_chapter.go`) and `defaultChapterLabel` (defined in `nav_sync.go`); `edit_cover.go`/`edit_back_cover.go` call helpers from `edit_resource.go`, `edit_navigation.go`, `edit_spine.go`, and `edit_guide.go`; and virtually every tool needs the `epubCache` singleton Go happens to define inside `read_epub.go`. Building strictly by the spec's category order would mean discovering a missing dependency mid-task, repeatedly. The remaining work is now sequenced by actual topological dependency instead:

- **Phase 4 (this plan):** shared foundation + the tools with the fewest cross-file dependencies (resource, spine, guide, manifest, metadata — none of these need chapters, navigation, or covers to exist first).
- **Phase 5:** navigation infrastructure (`get_navigation`/`edit_navigation`/`nav_sync`) — needed by chapters, covers, *and* lifecycle.
- **Phase 6:** chapter + manuscript tools (`edit_chapter`/`get_chapter`/`convert_manuscript`) — needed by lifecycle (`save_epub`'s empty-book fallback).
- **Phase 7:** lifecycle tools (`new_epub`/`read_epub`/`save_epub`/`close_epub`/`reload_epub`/`get_cache_status`/`get_epubs_list`) — now correctly ordered *after* chapters, since `save_epub` depends on them.
- **Phase 8:** cover tools (`get_cover`/`edit_cover`/`edit_back_cover`) — depend on nearly everything above.
- **Phase 9:** finalize (`get_context` already lists every tool dynamically as of Phase 3 — no work needed there; this phase is verification, README, and the end-to-end build of `The Magic Hower.epub`).

One further deliberate deviation, explained in Task 1: Go's `verbPast`/`contains` helpers live in `edit_metadata.go` but are called from `edit_resource.go`, `edit_cover.go`, `edit_back_cover.go`, `edit_spine.go`, `edit_guide.go`, and `edit_navigation.go` — a happenstance of Go's flat single-package namespace. Forcing `edit-metadata.ts` to be built before all six of those (metadata has nothing to do with them conceptually) would be an arbitrary, confusing build order. This plan relocates `verbPast`/`contains` into `idlist.ts` alongside the other small generic helpers every `edit_` tool shares — a minimal, well-justified reorganization, not a new abstraction.

**Tech Stack:** TypeScript on Bun (bun:test), building on Phases 1-3's `epub/` core package and `tools/registry.ts`/`elicit.ts`/`eviction.ts`.

**Source of record:** `G:\_GoProjects\epub-novel-mcp-server\tools\{idlist,get_resource,edit_resource,get_spine,edit_spine,get_guide,edit_guide,get_manifest,edit_manifest,get_metadata,edit_metadata,read_epub}.go` (the last one only for the `epubCache` singleton declaration, which this port relocates — see Task 1).

## Global Constraints

- Every exported name mirrors its Go counterpart's meaning, translated to camelCase.
- All relative imports use explicit `.ts` extensions; SDK imports keep `.js`.
- `verbatimModuleSyntax` is on: import types with `import type { ... }`.
- Every tool self-registers via a top-level `registerTool(...)` call (an import side effect), exactly like `src/tools/get-context.ts` (Phase 3) — no `Register(server)` entry point. `src/index.ts` needs one new `import "./tools/<name>.ts";` line per tool file registered in this phase.
- Every tool handler resolves omittable string arguments via `resolveArg(server, current, field, message)` from `./elicit.ts` (Phase 3), matching Go's `resolveArg(ctx, req, args.X, "x", "message")` calls exactly — same fields treated as omittable-and-promptable, same fields required-and-erroring-if-blank.
- Every tool handler that loads a book calls `epubCache.load(abs)` (this phase's Task 1) and appends `evictionNote(evicted)` (Phase 3) to its summary text.
- Every mutating (`edit_`) tool calls `epubCache.markDirty(abs)` after a successful edit and appends "Call save_epub to persist this to disk." to its summary, matching Go.
- Every tool handler returns `{ content: [{ type: "text", text: summary }], structuredContent: result }` (this phase's Task 1 extends `ToolHandlerResult` to support this) — the text summary is for a human/AI reading the response, `structuredContent` is the machine-parseable result object Go's second return value produces.
- Tests use `bun:test` (`describe`/`test`/`expect`), matching prior phases' style.
- Path resolution: Go's `filepath.Abs` becomes `path.resolve()` from `node:path` (both resolve a relative path against the process's current working directory into an absolute one — the direct TS equivalent). This port does **not** canonicalize every tool's path the way `read_epub`/`new_epub` do (`epub.CanonicalPath` — symlink resolution + case folding) for every single tool; only `epubCache`'s internal keying does that (via `Cache`'s own `canonicalPath`, Phase 1), matching Go's actual behavior: most Go tool files call `filepath.Abs` only, and rely on `Cache.Get`/`Cache.Load`'s internal `CanonicalPath` normalization to unify differently-spelled paths — they don't canonicalize before calling into the cache. This port mirrors that exactly: tools call `path.resolve()`, then pass the result straight to `epubCache`.

---

### Task 1: Shared cache singleton, list helpers, and structured-output support

**Files:**
- Create: `src/tools/epub-cache.ts`
- Create: `src/tools/idlist.ts`
- Test: `src/tools/epub-cache.test.ts`
- Test: `src/tools/idlist.test.ts`
- Modify: `src/tools/registry.ts` (extend `ToolHandlerResult` with optional `structuredContent`)
- Test: extend `src/tools/registry.test.ts` with one new case

**Interfaces:**
- Consumes: `Cache`, `DEFAULT_CACHE_SIZE` (from `../epub/cache.ts`, Phase 1).
- Produces: `epubCache: Cache` (a module-level singleton instance, consumed by every tool in this phase and beyond); `findIndex<T>`, `removeAt<T>`, `removeMatching<T>`, `contains`, `verbPast` (all exported from `idlist.ts`, consumed by every `edit_` tool); `ToolHandlerResult.structuredContent?: Record<string, unknown>` (registry.ts, consumed by every tool's return value from this phase onward).

- [ ] **Step 1: Write the failing tests**

`src/tools/epub-cache.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { epubCache } from "./epub-cache.ts";

describe("epubCache", () => {
  test("is a singleton Cache instance with the default capacity", () => {
    expect(epubCache.capacity).toBe(4);
  });

  test("is the same instance across multiple imports", async () => {
    const { epubCache: again } = await import("./epub-cache.ts");
    expect(again).toBe(epubCache);
  });
});
```

`src/tools/idlist.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { contains, findIndex, removeAt, removeMatching, verbPast } from "./idlist.ts";

interface Item {
  id: string;
  value: number;
}

describe("findIndex", () => {
  test("returns the index of the matching item", () => {
    const items: Item[] = [{ id: "a", value: 1 }, { id: "b", value: 2 }];
    expect(findIndex(items, "b", (i) => i.id)).toBe(1);
  });

  test("returns -1 when no item matches", () => {
    const items: Item[] = [{ id: "a", value: 1 }];
    expect(findIndex(items, "z", (i) => i.id)).toBe(-1);
  });
});

describe("removeAt", () => {
  test("removes the element at the given index, preserving order", () => {
    expect(removeAt([1, 2, 3], 1)).toEqual([1, 3]);
  });

  test("does not mutate the original array", () => {
    const original = [1, 2, 3];
    removeAt(original, 0);
    expect(original).toEqual([1, 2, 3]);
  });
});

describe("removeMatching", () => {
  test("keeps only elements for which keep returns true", () => {
    expect(removeMatching([1, 2, 3, 4], (n) => n % 2 === 0)).toEqual([2, 4]);
  });

  test("preserves order", () => {
    const items: Item[] = [{ id: "a", value: 1 }, { id: "b", value: 2 }, { id: "c", value: 3 }];
    expect(removeMatching(items, (i) => i.id !== "b").map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("contains", () => {
  test("returns true when the value is in the list", () => {
    expect(contains(["a", "b", "c"], "b")).toBe(true);
  });

  test("returns false when it isn't", () => {
    expect(contains(["a", "b", "c"], "z")).toBe(false);
  });
});

describe("verbPast", () => {
  test('returns "Update" for action "edit"', () => {
    expect(verbPast("edit")).toBe("Update");
  });

  test('capitalizes "create" to "Create"', () => {
    expect(verbPast("create")).toBe("Create");
  });

  test('capitalizes "remove" to "Remove"', () => {
    expect(verbPast("remove")).toBe("Remove");
  });
});
```

Extend `src/tools/registry.test.ts` by adding this new `describe` block (do not modify the existing 5 tests):

```typescript
describe("dispatchTool with structuredContent", () => {
  test("passes structuredContent through in the result", async () => {
    const name = uniqueName("structured-tool");
    registerTool({ name, description: "", inputSchema: {} }, "", async () => ({
      content: [{ type: "text", text: "done" }],
      structuredContent: { foo: "bar", count: 3 },
    }));

    const result = await dispatchTool(fakeServer, name, undefined);

    expect(result.structuredContent).toEqual({ foo: "bar", count: 3 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/epub-cache.test.ts src/tools/idlist.test.ts src/tools/registry.test.ts`
Expected: the new `epub-cache.test.ts`/`idlist.test.ts` files FAIL with `Cannot find module`; the extended `registry.test.ts` FAILS its new case only (`structuredContent` isn't in the type / isn't returned) — the 5 pre-existing cases still pass.

- [ ] **Step 3: Write `src/tools/epub-cache.ts`**

```typescript
/**
 * epubCache — the bounded LRU cache every tool shares, so repeated reads
 * of the same file across tool calls don't re-parse it. Mirrors Go's
 * package-level `var epubCache = epub.NewCache(epub.DefaultCacheSize)`,
 * but lives in its own module here rather than inside read-epub.ts (where
 * Go happens to declare it): almost every tool needs epubCache, including
 * ones that must exist before read_epub's own equivalent conceptually
 * would, so a dedicated module avoids an arbitrary "read-epub.ts must be
 * built first" ordering constraint.
 */
import { Cache, DEFAULT_CACHE_SIZE } from "../epub/cache.ts";

export const epubCache = new Cache(DEFAULT_CACHE_SIZE);
```

- [ ] **Step 4: Write `src/tools/idlist.ts`**

```typescript
/**
 * Small generic helpers shared by every edit_ tool that addresses one
 * entry of an array-valued field by id, or needs the same tiny bit of
 * action-name string formatting. Mirrors Go's tools/idlist.go (findIndex,
 * removeAt, removeMatching) plus verbPast/contains — in Go those two live
 * in tools/edit_metadata.go, called from six other tool files as a
 * happenstance of Go's flat single-package namespace; relocated here
 * since they're conceptually generic, not metadata-specific, and every
 * edit_ tool in this port already imports idlist.ts for the other three.
 */

/** Returns the index of the item in items whose id (via getId) equals id, or -1 if none matches. */
export function findIndex<T>(items: T[], id: string, getId: (item: T) => string): number {
  return items.findIndex((item) => getId(item) === id);
}

/** Returns items with the element at index i removed, preserving order. Does not mutate items. */
export function removeAt<T>(items: T[], i: number): T[] {
  return [...items.slice(0, i), ...items.slice(i + 1)];
}

/** Returns items with every element for which keep returns false removed, preserving order. */
export function removeMatching<T>(items: T[], keep: (item: T) => boolean): T[] {
  return items.filter(keep);
}

/** Reports whether v is present in list. */
export function contains(list: string[], v: string): boolean {
  return list.includes(v);
}

/** Returns the capitalized past-tense-ready verb for an edit_ action: "create"->"Create", "edit"->"Update", "remove"->"Remove". Callers append "d". */
export function verbPast(action: string): string {
  if (action === "edit") return "Update";
  return action.charAt(0).toUpperCase() + action.slice(1);
}
```

- [ ] **Step 5: Extend `src/tools/registry.ts`'s `ToolHandlerResult`**

Find the current declaration:

```typescript
export type ToolHandlerResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};
```

Replace with:

```typescript
export type ToolHandlerResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
```

No other change to `registry.ts` is needed — `dispatchTool`/`registerTool`'s bodies already pass the whole result object through untouched, so a new optional field flows through automatically.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/tools/epub-cache.test.ts src/tools/idlist.test.ts src/tools/registry.test.ts`
Expected: PASS — 2 + 12 + 6 (5 existing + 1 new) tests green.

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 8: Commit**

```bash
git add src/tools/epub-cache.ts src/tools/epub-cache.test.ts src/tools/idlist.ts src/tools/idlist.test.ts src/tools/registry.ts src/tools/registry.test.ts
git commit -m "Add shared EPUB cache singleton, list helpers, and structuredContent support"
```

---

### Task 2: Resource tools (get_resource, edit_resource)

**Files:**
- Create: `src/tools/get-resource.ts`
- Create: `src/tools/edit-resource.ts`
- Test: `src/tools/get-resource.test.ts`
- Test: `src/tools/edit-resource.test.ts`
- Modify: `src/index.ts` (add `import "./tools/get-resource.ts";` and `import "./tools/edit-resource.ts";`)

**Interfaces:**
- Consumes: `epubCache` (Task 1); `Server`, `ToolHandlerResult`, `EpubTool`, `registerTool` (`./registry.ts`); `resolveArg` (`./elicit.ts`); `evictionNote` (`./eviction.ts`); `Epub`, `Package`, `Resource` types (`../epub/types.ts`).
- Produces: `getResourceTool`/`handleGetResource` (registered as `get_resource`), `editResourceTool`/`handleEditResource` (registered as `edit_resource`), and `archiveIdInUse(e: Epub, archivePath: string): boolean` — exported from `edit-resource.ts`, consumed by `edit-chapter.ts` (Phase 6), `edit-cover.ts`/`edit-back-cover.ts` (Phase 8).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/get-resource.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { handleGetResource } from "./get-resource.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-get-resource-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Resource Test", "Author"), path);
  return { dir, path };
}

describe("get_resource", () => {
  test("returns a text resource inline", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleGetResource(fakeServer, { path, id: "styles/style.css" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.isText).toBe(true);
    expect(result.structuredContent?.mediaType).toBe("text/css");
    expect(typeof result.structuredContent?.text).toBe("string");
    expect(result.structuredContent?.data).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("writes to sourcePath instead of returning inline content when given", async () => {
    const { dir, path } = await writeTempBook();
    const outPath = join(dir, "out.css");
    const result = await handleGetResource(fakeServer, { path, id: "styles/style.css", sourcePath: outPath });

    expect(result.structuredContent?.sourcePath).toBe(outPath);
    expect(result.structuredContent?.text).toBeUndefined();
    const written = await readFile(outPath, "utf-8");
    expect(written.length).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when id doesn't name a resource", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleGetResource(fakeServer, { path, id: "no/such/resource.css" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no/such/resource.css");

    await rm(dir, { recursive: true, force: true });
  });

  afterEachClearCache();
});

function afterEachClearCache() {
  // epubCache is a shared singleton across every test file in this bun
  // test run; each test above uses a fresh temp path, so no explicit
  // cleanup is required for correctness, only to keep the cache from
  // growing across the whole suite. Bounded at 4 entries with LRU
  // eviction (Phase 1), so unbounded growth isn't a real risk either.
}
```

```typescript
// src/tools/edit-resource.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { archiveIdInUse, handleEditResource } from "./edit-resource.ts";
import { parseEpub } from "../epub/parse.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-resource-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Resource Test", "Author"), path);
  return { dir, path };
}

describe("edit_resource", () => {
  test("create adds a new resource to the manifest", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditResource(fakeServer, {
      action: "create",
      path,
      id: "styles/notes.css",
      content: "body { color: red; }",
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.action).toBe("create");
    expect(result.structuredContent?.mediaType).toBe("text/css");

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if id already exists", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditResource(fakeServer, {
      action: "create",
      path,
      id: "styles/style.css", // already exists in newEpub()'s skeleton
      content: "body {}",
    });

    expect(result.isError).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces an existing resource's content", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditResource(fakeServer, {
      action: "edit",
      path,
      id: "styles/style.css",
      content: "body { color: blue; }",
    });

    const reparsed = await (async () => {
      // Confirm via cache dirty state rather than a fresh parse, since the
      // in-memory edit hasn't been saved to disk yet.
      return null;
    })();
    expect(reparsed).toBeNull(); // placeholder removed below by real assertion

    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes a resource from the manifest", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditResource(fakeServer, { action: "create", path, id: "styles/notes.css", content: "x" });
    const result = await handleEditResource(fakeServer, { action: "remove", path, id: "styles/notes.css" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.action).toBe("remove");

    await rm(dir, { recursive: true, force: true });
  });

  test("remove fails on the cover image", async () => {
    const { dir, path } = await writeTempBook();
    // newEpub()'s skeleton has no cover; create one as a manifest item
    // with the cover-image property directly via a resource create, then
    // hand-verify edit_resource refuses to remove it — this test exists
    // to lock in the guard even though full cover creation is Phase 8's
    // edit_cover, not this tool.
    await handleEditResource(fakeServer, { action: "create", path, id: "images/cover.jpg", content: "x" });
    // Directly mutate the cached epub to add the cover-image property,
    // simulating what edit_cover will do in Phase 8.
    const cached = (await import("./epub-cache.ts")).epubCache.get(
      (await import("node:path")).resolve(path),
    );
    const pkg = cached ? (await import("../epub/resolve.ts")).primaryPackage(cached) : undefined;
    const item = pkg?.manifest.items.find((i) => i.href === "images/cover.jpg");
    if (item) item.properties = ["cover-image"];

    const result = await handleEditResource(fakeServer, { action: "remove", path, id: "images/cover.jpg" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("edit_cover");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("archiveIdInUse", () => {
  test("returns true for an existing resource, false for an unused path", async () => {
    const { dir, path } = await writeTempBook();
    const e = await parseEpub(path);
    expect(archiveIdInUse(e, "styles/style.css")).toBe(true);
    expect(archiveIdInUse(e, "does/not/exist.css")).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/get-resource.test.ts src/tools/edit-resource.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write `src/tools/get-resource.ts`**

```typescript
/**
 * get_resource — read one non-content manifest resource (stylesheet,
 * image, font, audio/video) by its archive-path id. Mirrors Go's
 * tools/get_resource.go.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

interface GetResourceArgs {
  path: string;
  id: string;
  sourcePath?: string;
}

export const getResourceTool: EpubTool = {
  name: "get_resource",
  description:
    "Read one non-content manifest resource (stylesheet, image, font, audio/video) of an already-read EPUB by its id. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: 'resource id (archive path), e.g. "OEBPS/styles/style.css"' },
      sourcePath: {
        type: "string",
        description:
          "optional filesystem path to write the resource's raw bytes to directly; if given, the response omits inline text/data and instead reports where the file was written",
      },
    },
    required: ["path", "id"],
  },
};

/** Reports whether mediaType's bytes should be surfaced as a UTF-8 string rather than base64. */
export function isTextMediaType(mediaType: string): boolean {
  if (mediaType.startsWith("text/")) return true;
  return (
    mediaType === "image/svg+xml" ||
    mediaType === "application/xml" ||
    mediaType === "application/javascript" ||
    mediaType === "application/ecmascript" ||
    mediaType === "application/json"
  );
}

export async function handleGetResource(_server: Server, args: GetResourceArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  if (!args.id?.trim()) throw new Error("id is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const res = e.resources[args.id];
  if (!res) {
    throw new Error(`no resource with id ${JSON.stringify(args.id)} in ${JSON.stringify(abs)}; call read_epub or get_manifest to list valid ids`);
  }

  const isText = isTextMediaType(res.mediaType);
  const structuredContent: Record<string, unknown> = {
    id: args.id,
    mediaType: res.mediaType,
    sizeBytes: res.data.length,
    isText,
  };

  if (args.sourcePath) {
    await writeFile(args.sourcePath, res.data);
    structuredContent.sourcePath = args.sourcePath;
  } else if (isText) {
    structuredContent.text = new TextDecoder().decode(res.data);
  } else {
    structuredContent.data = Buffer.from(res.data).toString("base64");
  }

  const summary = `Read resource ${JSON.stringify(args.id)} from ${JSON.stringify(abs)} (${res.data.length} bytes, ${res.mediaType}).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getResourceTool,
  "Takes path, the same .epub filesystem path passed to read_epub, and id, the resource's archive path. " +
    "Covers everything in the manifest that isn't a chapter (see get_chapter/edit_chapter), the navigation " +
    "document, or an NCX — stylesheets, images, fonts, audio, video, and anything else. Returns isText " +
    "(true for text media types like CSS, in which case text holds the content as a string) or, for binary " +
    "media types, data holding the raw bytes as base64. Pass sourcePath to instead write the raw bytes " +
    "directly to that filesystem path on the machine running this server — the response then omits " +
    "text/data and reports sourcePath instead, avoiding sending large binary resources through MCP. Fails " +
    "if id isn't a resource in this book; a chapter, cover, navigation, or NCX id will also fail here — use " +
    "get_chapter, get_cover, or get_navigation for those instead.",
  handleGetResource as never,
);
```

Note on the `as never` cast: `registerTool`'s `ToolHandler` type is `(server: Server, args: Record<string, unknown> | undefined) => ToolHandlerResult | Promise<ToolHandlerResult>`, but `handleGetResource` takes a specific `GetResourceArgs` shape for type-safety within this file and its tests. Every tool in this and later phases follows this same pattern: a strongly-typed `handle*` function, registered with a cast, since the MCP protocol itself doesn't statically type incoming arguments (they arrive as `Record<string, unknown>` from JSON-RPC) — the cast is the seam between "what the wire actually sends" and "what this handler assumes it received," matching Go's own args-struct-plus-JSON-unmarshalling pattern where the SDK does the equivalent coercion via reflection.

- [ ] **Step 4: Write `src/tools/edit-resource.ts`**

```typescript
/**
 * edit_resource — create, edit, or remove one non-content manifest
 * resource. Mirrors Go's tools/edit_resource.go.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage, relativeHref } from "../epub/resolve.ts";
import type { Epub, ManifestItem, Package } from "../epub/types.ts";

interface EditResourceArgs {
  action?: string;
  path?: string;
  id?: string;
  content?: string;
  sourcePath?: string;
  mediaType?: string;
}

interface EditResourceResult {
  action: string;
  id: string;
  mediaType?: string;
  sizeBytes?: number;
}

export const editResourceTool: EpubTool = {
  name: "edit_resource",
  description:
    "Create, edit, or remove one non-content manifest resource (stylesheet, image, font, audio/video) of an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a new resource, "edit" an existing one, or "remove" one' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: "resource id: the new resource's archive path for create, or an existing one's id for edit/remove" },
      content: { type: "string", description: "the resource's new text content; used by create and edit when sourcePath isn't given, ignored by remove" },
      sourcePath: { type: "string", description: "filesystem path to a file to use as the resource's content, read directly from disk (not sent through MCP); for binary resources, pass this instead of content" },
      mediaType: { type: "string", description: 'media type, e.g. "text/css" or "image/png"; guessed from id\'s extension if omitted on create' },
    },
  },
};

/** Reports whether archivePath already names a resource, content document, navigation document, or NCX in e. */
export function archiveIdInUse(e: Epub, archivePath: string): boolean {
  return (
    archivePath in e.resources ||
    archivePath in e.contentDocuments ||
    archivePath in e.navigation ||
    archivePath in e.nCXs
  );
}

/** Guesses a resource's media type from its archive path's extension. */
export function guessResourceMediaType(archivePath: string): string {
  switch (extname(archivePath).toLowerCase()) {
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
      return "application/javascript";
    case ".xhtml":
    case ".html":
    case ".htm":
      return "application/xhtml+xml";
    case ".xml":
      return "application/xml";
    case ".ttf":
    case ".otf":
      return "application/font-sfnt";
    case ".woff":
      return "application/font-woff";
    case ".woff2":
      return "font/woff2";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".m4a":
      return "audio/mp4";
    default:
      return guessImageMediaType(archivePath);
  }
}

/** Guesses an image's media type from its archive path's extension. */
export function guessImageMediaType(archivePath: string): string {
  switch (extname(archivePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** Derives a candidate NCName manifest item id from archivePath's last segment, stripped of its extension. */
export function manifestIdCandidate(archivePath: string): string {
  const slash = archivePath.lastIndexOf("/");
  let name = slash >= 0 ? archivePath.slice(slash + 1) : archivePath;
  const dot = name.lastIndexOf(".");
  if (dot > 0) name = name.slice(0, dot);

  let out = "";
  let first = true;
  for (const ch of name) {
    if (/[a-zA-Z_]/.test(ch)) {
      out += ch;
    } else if (/[0-9]/.test(ch)) {
      if (first) out += "x";
      out += ch;
    } else {
      out += "-";
    }
    first = false;
  }
  return out || "chapter";
}

/** Returns candidate, or candidate with a numeric suffix, whichever isn't already used by a manifest item id in pkg. */
export function uniqueManifestId(pkg: Package, candidate: string): string {
  let id = candidate;
  for (let n = 2; pkg.manifest.items.some((item) => item.id.endsWith("/" + id)); n++) {
    id = `${candidate}-${n}`;
  }
  return id;
}

export async function handleEditResource(server: Server, args: EditResourceArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const idPromptMsg =
    action === "create" ? 'What archive path should the new resource be saved at (e.g. "OEBPS/styles/notes.css")?' : "Which resource should be affected? Provide its archive path.";
  const id = await resolveArg(server, args.id, "id", idPromptMsg);

  let data = new Uint8Array(0);
  if (action !== "remove") {
    if (args.sourcePath !== undefined) {
      const sourcePath = await resolveArg(server, args.sourcePath, "sourcePath", "What is the filesystem path to the file to use as this resource's content?");
      data = await readFile(sourcePath);
    } else {
      const content = await resolveArg(server, args.content, "content", "What should this resource's content be?");
      data = new TextEncoder().encode(content);
    }
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  let result: EditResourceResult;
  switch (action) {
    case "create":
      result = createResource(e, pkg, id, data, args.mediaType ?? "");
      break;
    case "edit":
      result = editExistingResource(e, pkg, id, data, args.mediaType ?? "");
      break;
    case "remove":
      result = removeResource(e, pkg, id);
      break;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  epubCache.markDirty(abs);
  const summary = `${verbPast(action)}d resource ${JSON.stringify(result.id)} in ${JSON.stringify(abs)} (${result.sizeBytes} bytes). Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

function createResource(e: Epub, pkg: Package, id: string, data: Uint8Array, mediaType: string): EditResourceResult {
  if (archiveIdInUse(e, id)) throw new Error(`${JSON.stringify(id)} already exists in this book; use action "edit" instead`);
  const resolvedMediaType = mediaType || guessResourceMediaType(id);

  const opfId = uniqueManifestId(pkg, manifestIdCandidate(id));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${opfId}`,
    href: relativeHref(pkg, id),
    mediaType: resolvedMediaType,
    properties: [],
    fallback: "",
    mediaOverlay: "",
  });
  e.resources[id] = { id, mediaType: resolvedMediaType, data };

  return { action: "create", id, mediaType: resolvedMediaType, sizeBytes: data.length };
}

function editExistingResource(e: Epub, pkg: Package, id: string, data: Uint8Array, mediaType: string): EditResourceResult {
  const res = e.resources[id];
  if (!res) throw new Error(`no resource with id ${JSON.stringify(id)} in ${JSON.stringify(pkg.id)}; call get_manifest to list valid ids`);
  res.data = data;
  if (mediaType) {
    res.mediaType = mediaType;
    const item = pkg.manifest.items.find((i) => i.href === id);
    if (item) item.mediaType = mediaType;
  }
  return { action: "edit", id, mediaType: res.mediaType, sizeBytes: data.length };
}

function removeResource(e: Epub, pkg: Package, id: string): EditResourceResult {
  const res = e.resources[id];
  if (!res) throw new Error(`no resource with id ${JSON.stringify(id)} in ${JSON.stringify(pkg.id)}; call get_manifest to list valid ids`);
  const item = pkg.manifest.items.find((i) => i.href === id);
  if (item) {
    if (item.properties.includes("cover-image")) {
      throw new Error(`${JSON.stringify(id)} is the cover image; use edit_cover instead`);
    }
    pkg.manifest.items = pkg.manifest.items.filter((i) => i.id !== item.id);
  }
  const sizeBytes = res.data.length;
  delete e.resources[id];

  return { action: "remove", id, sizeBytes };
}

registerTool(
  editResourceTool,
  'Takes action ("create", "edit", or "remove"), path, id, and content; any of these may be omitted to ' +
    "be prompted for (see edit_chapter's description for the general elicitation rules every edit_ tool " +
    "follows). content is text, used as-is. For binary resources such as images or fonts, pass sourcePath " +
    "instead — a filesystem path read directly from disk on the machine running this server, never sent " +
    "through MCP as bytes; when sourcePath is given, content is ignored and not prompted for.\n\n" +
    'action "create": id is the archive path to save the new resource at. mediaType is guessed from id\'s ' +
    "file extension if omitted. Added to the manifest but not the spine (resources aren't reading " +
    "content). create only ever adds a brand-new resource — it never updates one that already exists, so " +
    'it fails outright if id already names anything; use "edit" instead to replace that resource\'s ' +
    'bytes.\n\naction "edit": id must be an existing resource id; content replaces its bytes entirely, and ' +
    'mediaType replaces its media type if given.\n\naction "remove": id must be an existing resource id; ' +
    "content is ignored. Fails if id is the book's cover image (use edit_cover instead).\n\nAll three " +
    "actions only touch the in-memory cache; call save_epub afterwards to persist.",
  handleEditResource as never,
);
```

- [ ] **Step 5: Fix the "edit replaces content" placeholder test**

The brief above included a placeholder assertion in `edit-resource.test.ts`'s "edit replaces an existing resource's content" test (an `expect(reparsed).toBeNull()` against a function that always returns `null` — this is a no-op left over from drafting and must not ship). Replace that test with a real assertion using the already-imported `epubCache` and `primaryPackage`:

```typescript
  test("edit replaces an existing resource's content", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditResource(fakeServer, {
      action: "edit",
      path,
      id: "styles/style.css",
      content: "body { color: blue; }",
    });

    const cached = epubCache.get(resolve(path));
    expect(cached?.resources["styles/style.css"]?.data).toBeDefined();
    const text = new TextDecoder().decode(cached!.resources["styles/style.css"]!.data);
    expect(text).toBe("body { color: blue; }");

    await rm(dir, { recursive: true, force: true });
  });
```

This requires adding `import { epubCache } from "./epub-cache.ts";` and `import { resolve } from "node:path";` to the top of `edit-resource.test.ts` (both already used elsewhere in the file via dynamic `import()` in the cover-guard test — replace those dynamic imports with these two static ones at the top of the file instead, since there's no reason for them to be dynamic).

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/tools/get-resource.test.ts src/tools/edit-resource.test.ts`
Expected: PASS.

- [ ] **Step 7: Wire into `src/index.ts`**

Add two import lines alongside the existing `import "./tools/get-context.ts";`:

```typescript
import "./tools/get-context.ts"; // self-registers get_context as an import side effect
import "./tools/get-resource.ts";
import "./tools/edit-resource.ts";
```

- [ ] **Step 8: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 9: Commit**

```bash
git add src/tools/get-resource.ts src/tools/get-resource.test.ts src/tools/edit-resource.ts src/tools/edit-resource.test.ts src/index.ts
git commit -m "Add get_resource and edit_resource tools"
```

---

### Task 3: Spine tools (get_spine, edit_spine)

**Files:**
- Create: `src/tools/get-spine.ts`
- Create: `src/tools/edit-spine.ts`
- Test: `src/tools/get-spine.test.ts`
- Test: `src/tools/edit-spine.test.ts`
- Modify: `src/index.ts` (add two imports)

**Interfaces:**
- Consumes: `epubCache` (Task 1); `resolveArg` (`./elicit.ts`); `evictionNote` (`./eviction.ts`); `verbPast`, `findIndex`, `removeAt` (Task 1's `idlist.ts`); `primaryPackage`, `manifestItemByHref`, `manifestItemById` (`../epub/resolve.ts`).
- Produces: `getSpineTool`/`handleGetSpine`, `editSpineTool`/`handleEditSpine`, plus `insertAt<T>`, `clampPosition`, `renumberSpine` — exported from `edit-spine.ts`, consumed by `edit-navigation.ts` (Phase 5, `insertAt`/`clampPosition` for nav-point tree editing) and `edit-cover.ts`/`edit-back-cover.ts` (Phase 8, `insertAt`/`renumberSpine`).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/get-spine.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetSpine } from "./get-spine.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_spine", () => {
  test("lists spine entries with linear/properties", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-spine-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Spine Test", "Author"), path);

    const result = await handleGetSpine(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    const items = result.structuredContent?.items as Array<{ id: string; linear: boolean }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "nav.xhtml", linear: true });

    await rm(dir, { recursive: true, force: true });
  });
});
```

```typescript
// src/tools/edit-spine.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { clampPosition, handleEditSpine, insertAt, renumberSpine } from "./edit-spine.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";
import { epubCache } from "./epub-cache.ts";
import { resolve } from "node:path";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-spine-test-"));
  const path = join(dir, "book.epub");
  const e = newEpub("Edit Spine Test", "Author");
  // Add a second manifest item (a resource, not in the spine yet) to
  // exercise create/edit/remove without needing a full chapter tool.
  const pkg = primaryPackage(e)!;
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/extra`,
    href: "extra.xhtml",
    mediaType: "application/xhtml+xml",
    properties: [],
    fallback: "",
    mediaOverlay: "",
  });
  e.contentDocuments["extra.xhtml"] = { id: "extra.xhtml", mediaType: "application/xhtml+xml", markup: "<html/>" };
  await writeEpub(e, path);
  return { dir, path };
}

describe("insertAt", () => {
  test("inserts at the given index without mutating the original array", () => {
    const original = [1, 2, 4];
    const result = insertAt(original, 2, 3);
    expect(result).toEqual([1, 2, 3, 4]);
    expect(original).toEqual([1, 2, 4]);
  });
});

describe("clampPosition", () => {
  test("clamps below zero to zero", () => {
    expect(clampPosition(-5, 10)).toBe(0);
  });
  test("clamps above length to length", () => {
    expect(clampPosition(50, 10)).toBe(10);
  });
  test("passes through an in-range value", () => {
    expect(clampPosition(3, 10)).toBe(3);
  });
});

describe("edit_spine", () => {
  test("create adds an existing manifest item to the reading order", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditSpine(fakeServer, { action: "create", path, id: "extra.xhtml" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.index).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if the item is already in the spine", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditSpine(fakeServer, { action: "create", path, id: "nav.xhtml" });
    expect(result.isError).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("edit changes linear and position", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditSpine(fakeServer, { action: "create", path, id: "extra.xhtml" });
    const result = await handleEditSpine(fakeServer, { action: "edit", path, id: "extra.xhtml", linear: "false", position: "0" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.index).toBe(0);

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.spine.itemRefs[0]).toMatchObject({ linear: false });

    await rm(dir, { recursive: true, force: true });
  });

  test("remove takes an entry out of the spine", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditSpine(fakeServer, { action: "create", path, id: "extra.xhtml" });
    const result = await handleEditSpine(fakeServer, { action: "remove", path, id: "extra.xhtml" });

    expect(result.isError).toBeUndefined();

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.spine.itemRefs.some((r) => r.idRef === "extra")).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  test("renumberSpine refreshes ids to match position", () => {
    const pkg = primaryPackage(newEpub("Renumber Test", "Author"))!;
    pkg.spine.itemRefs.push({ id: "stale", idRef: "extra", linear: true, properties: [] });
    renumberSpine(pkg);
    expect(pkg.spine.itemRefs[1]?.id).toBe(`${pkg.spine.id}/itemref[1]`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/get-spine.test.ts src/tools/edit-spine.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write `src/tools/get-spine.ts`**

```typescript
/**
 * get_spine — read the reading order (spine) of an already-read EPUB.
 * Mirrors Go's tools/get_spine.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemById, primaryPackage } from "../epub/resolve.ts";

interface GetSpineArgs {
  path: string;
}

export const getSpineTool: EpubTool = {
  name: "get_spine",
  description: "Read the reading order (spine) of an already-read EPUB. Read-only.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" } },
    required: ["path"],
  },
};

export async function handleGetSpine(_server: Server, args: GetSpineArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const items = pkg.spine.itemRefs.map((ref) => {
    const item = manifestItemById(pkg, ref.idRef);
    const id = item ? pkg.resolveHref?.(item.href) ?? item.href : ref.idRef;
    return { id, linear: ref.linear, properties: ref.properties };
  });

  const structuredContent = { pageProgressionDirection: pkg.spine.pageProgressionDirection, items };
  const summary = `Read spine of ${JSON.stringify(abs)} (${items.length} entries).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getSpineTool,
  'Takes path, the same .epub filesystem path passed to read_epub. Returns pageProgressionDirection ("ltr", ' +
    '"rtl", or empty for unspecified) and items, the ordered list of manifest entries in the default reading ' +
    "order, each with its id (archive path), linear (false for auxiliary content skipped by default linear " +
    'reading, e.g. a pop-up footnote), and properties (e.g. "page-spread-left"/"page-spread-right"). This is ' +
    "the same order read_epub's contentDocuments list reflects for linear content documents, but also " +
    "includes non-linear and non-chapter entries.",
  handleGetSpine as never,
);
```

Note: `pkg.resolveHref` doesn't exist as a method (Phase 1's `resolve.ts` uses free functions, not methods) — this is a mistake in the draft above that Step 3's actual implementation must fix. Use the free function `resolveHref(pkg, item.href)` (imported from `../epub/resolve.ts`) instead of `pkg.resolveHref?.(item.href)`. Import `resolveHref` alongside `manifestItemById`/`primaryPackage`.

- [ ] **Step 4: Write `src/tools/edit-spine.ts`**

```typescript
/**
 * edit_spine — add, change, or remove one entry of an already-read EPUB's
 * reading order. Mirrors Go's tools/edit_spine.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { findIndex, removeAt, verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemByHref, primaryPackage } from "../epub/resolve.ts";
import type { Package, SpineItemRef } from "../epub/types.ts";

interface EditSpineArgs {
  action?: string;
  path?: string;
  id?: string;
  linear?: string;
  properties?: string;
  position?: string;
  pageProgressionDirection?: string;
}

interface EditSpineResult {
  action: string;
  id: string;
  index: number;
}

export const editSpineTool: EpubTool = {
  name: "edit_spine",
  description: "Add, change, or remove one entry of an already-read EPUB's reading order (spine). Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" adds an existing manifest item to the reading order, "edit" changes an entry already in it, or "remove" takes one out' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: "archive path of the manifest item (chapter or resource) this entry targets" },
      linear: { type: "string", description: '"true" or "false"; omit to leave unchanged (edit) or default to true (create)' },
      properties: { type: "string", description: 'space-separated itemref properties, e.g. "page-spread-left"; omit to leave unchanged (edit) or unset (create); pass "none" to clear on edit' },
      position: { type: "string", description: "0-based index to insert/move this entry to; omit to append at the end (create) or leave its position unchanged (edit)" },
      pageProgressionDirection: { type: "string", description: 'if given, sets the spine\'s page-progression-direction ("ltr" or "rtl") regardless of action' },
    },
  },
};

/** Returns items with v inserted at index at, without mutating items. */
export function insertAt<T>(items: T[], at: number, v: T): T[] {
  return [...items.slice(0, at), v, ...items.slice(at)];
}

/** Clamps p into [0, length]. */
export function clampPosition(p: number, length: number): number {
  if (p < 0) return 0;
  if (p > length) return length;
  return p;
}

/** Refreshes every SpineItemRef's id to reflect its current position. */
export function renumberSpine(pkg: Package): void {
  pkg.spine.itemRefs.forEach((ref, i) => {
    ref.id = `${pkg.spine.id}/itemref[${i}]`;
  });
}

function spineIndexFor(pkg: Package, id: string): { index: number; opfId: string; item: ReturnType<typeof manifestItemByHref> } {
  const item = manifestItemByHref(pkg, id);
  if (!item) return { index: -1, opfId: "", item: undefined };
  const prefix = pkg.manifest.id + "/";
  const opfId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
  const index = findIndex(pkg.spine.itemRefs, opfId, (r) => r.idRef);
  return { index, opfId, item };
}

export async function handleEditSpine(server: Server, args: EditSpineArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const id = await resolveArg(server, args.id, "id", "Which manifest item (archive path) should this spine entry target?");

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

  if (args.pageProgressionDirection) pkg.spine.pageProgressionDirection = args.pageProgressionDirection;

  let result: EditSpineResult;
  switch (action) {
    case "create":
      result = createSpineEntry(pkg, id, args.linear ?? "", args.properties ?? "", position);
      break;
    case "edit":
      result = editSpineEntry(pkg, id, args.linear ?? "", args.properties ?? "", position);
      break;
    case "remove":
      result = removeSpineEntry(pkg, id);
      break;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  epubCache.markDirty(abs);
  const summary = `${verbPast(action)}d spine entry ${JSON.stringify(result.id)} in ${JSON.stringify(abs)} (index ${result.index}). Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

function createSpineEntry(pkg: Package, id: string, linear: string, properties: string, position: number | undefined): EditSpineResult {
  const { index, opfId, item } = spineIndexFor(pkg, id);
  if (!item) throw new Error(`no manifest item with archive path ${JSON.stringify(id)}; call get_manifest to list valid ids`);
  if (index >= 0) throw new Error(`${JSON.stringify(id)} is already in the spine at index ${index}; use action "edit" instead`);

  const ref: SpineItemRef = { id: "", idRef: opfId, linear: linear !== "false", properties: [] };
  if (properties && properties !== "none") ref.properties = properties.split(/\s+/).filter(Boolean);

  const at = position !== undefined ? clampPosition(position, pkg.spine.itemRefs.length) : pkg.spine.itemRefs.length;
  pkg.spine.itemRefs = insertAt(pkg.spine.itemRefs, at, ref);
  renumberSpine(pkg);

  return { action: "create", id, index: at };
}

function editSpineEntry(pkg: Package, id: string, linear: string, properties: string, position: number | undefined): EditSpineResult {
  const { index, item } = spineIndexFor(pkg, id);
  if (!item) throw new Error(`no manifest item with archive path ${JSON.stringify(id)}; call get_manifest to list valid ids`);
  if (index < 0) throw new Error(`${JSON.stringify(id)} is not in the spine; use action "create" instead`);

  const ref = { ...pkg.spine.itemRefs[index]! };
  if (linear) ref.linear = linear !== "false";
  if (properties === "none") ref.properties = [];
  else if (properties) ref.properties = properties.split(/\s+/).filter(Boolean);

  pkg.spine.itemRefs = removeAt(pkg.spine.itemRefs, index);
  const at = position !== undefined ? clampPosition(position, pkg.spine.itemRefs.length) : index;
  pkg.spine.itemRefs = insertAt(pkg.spine.itemRefs, at, ref);
  renumberSpine(pkg);

  return { action: "edit", id, index: at };
}

function removeSpineEntry(pkg: Package, id: string): EditSpineResult {
  const { index, item } = spineIndexFor(pkg, id);
  if (!item) throw new Error(`no manifest item with archive path ${JSON.stringify(id)}; call get_manifest to list valid ids`);
  if (index < 0) throw new Error(`${JSON.stringify(id)} is not in the spine`);
  pkg.spine.itemRefs = removeAt(pkg.spine.itemRefs, index);
  renumberSpine(pkg);
  return { action: "remove", id, index };
}

registerTool(
  editSpineTool,
  'Takes action ("create", "edit", or "remove"), path, and id; any of these may be omitted to be prompted ' +
    "for (see edit_chapter's description for the general elicitation rules every edit_ tool follows). id " +
    "names a manifest item by its archive path (see get_manifest) — this tool only reorders/retargets the " +
    "reading order, it doesn't create or delete the underlying chapter or resource (use edit_chapter/" +
    'edit_resource/edit_cover for that).\n\naction "create": adds id to the spine at position if given, ' +
    "otherwise appended at the end. create only ever adds a brand-new entry — it never updates one that's " +
    'already in the reading order, so it fails outright if id is already there; use "edit" instead to ' +
    'change its linear/properties/position.\n\naction "edit": id must already be in the spine; updates ' +
    'linear/properties/position as given, leaving anything omitted unchanged.\n\naction "remove": takes id ' +
    "out of the spine's reading order; the manifest item itself is untouched, so it still exists as a " +
    "resource, just no longer read in default order.\n\npageProgressionDirection, if given, always updates " +
    "the spine's direction regardless of action. Only touches the in-memory cache; call save_epub " +
    "afterwards to persist.",
  handleEditSpine as never,
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/tools/get-spine.test.ts src/tools/edit-spine.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire into `src/index.ts`**

Add:

```typescript
import "./tools/get-spine.ts";
import "./tools/edit-spine.ts";
```

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 8: Commit**

```bash
git add src/tools/get-spine.ts src/tools/get-spine.test.ts src/tools/edit-spine.ts src/tools/edit-spine.test.ts src/index.ts
git commit -m "Add get_spine and edit_spine tools"
```

---

### Task 4: Guide tools (get_guide, edit_guide)

**Files:**
- Create: `src/tools/get-guide.ts`
- Create: `src/tools/edit-guide.ts`
- Test: `src/tools/get-guide.test.ts`
- Test: `src/tools/edit-guide.test.ts`
- Modify: `src/index.ts` (add two imports)

**Interfaces:**
- Consumes: `epubCache` (Task 1); `resolveArg` (`./elicit.ts`); `evictionNote` (`./eviction.ts`); `verbPast`, `findIndex`, `removeAt` (Task 1's `idlist.ts`); `primaryPackage` (`../epub/resolve.ts`).
- Produces: `getGuideTool`/`handleGetGuide`, `editGuideTool`/`handleEditGuide`, plus `applyGuideEdit(pkg: Package, action: string, type: string, title: string, href: string): void` — exported from `edit-guide.ts`, consumed by `edit-cover.ts`/`edit-back-cover.ts` (Phase 8).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/get-guide.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetGuide } from "./get-guide.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_guide", () => {
  test("reports present=false for a book with no guide", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-guide-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Guide Test", "Author"), path);

    const result = await handleGetGuide(fakeServer, { path });

    expect(result.structuredContent?.present).toBe(false);
    expect(result.structuredContent?.references).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});
```

```typescript
// src/tools/edit-guide.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { applyGuideEdit, handleEditGuide } from "./edit-guide.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-guide-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Guide Test", "Author"), path);
  return { dir, path };
}

describe("edit_guide", () => {
  test("create adds a reference, creating the guide element if absent", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditGuide(fakeServer, { action: "create", path, id: "toc", href: "nav.xhtml" });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.guide?.references).toHaveLength(1);
    expect(pkg.guide?.references[0]).toMatchObject({ type: "toc", href: "nav.xhtml" });

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if a reference of that type already exists", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditGuide(fakeServer, { action: "create", path, id: "toc", href: "nav.xhtml" });
    const result = await handleEditGuide(fakeServer, { action: "create", path, id: "toc", href: "other.xhtml" });

    expect(result.isError).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces href and title", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditGuide(fakeServer, { action: "create", path, id: "toc", href: "nav.xhtml" });
    await handleEditGuide(fakeServer, { action: "edit", path, id: "toc", href: "toc2.xhtml", title: "Contents" });

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.guide?.references[0]).toMatchObject({ href: "toc2.xhtml", title: "Contents" });

    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes the reference", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditGuide(fakeServer, { action: "create", path, id: "toc", href: "nav.xhtml" });
    await handleEditGuide(fakeServer, { action: "remove", path, id: "toc" });

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.guide?.references).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("applyGuideEdit", () => {
  test("edit on a nonexistent reference throws", () => {
    const pkg = primaryPackage(newEpub("Direct Test", "Author"))!;
    expect(() => applyGuideEdit(pkg, "edit", "cover", "", "cover.xhtml")).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/get-guide.test.ts src/tools/edit-guide.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/tools/get-guide.ts`**

```typescript
/**
 * get_guide — read the legacy EPUB 2 guide landmarks. Mirrors Go's
 * tools/get_guide.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage } from "../epub/resolve.ts";

interface GetGuideArgs {
  path: string;
}

export const getGuideTool: EpubTool = {
  name: "get_guide",
  description: "Read the legacy EPUB 2 guide landmarks of an already-read EPUB, if it has any. Read-only.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" } },
    required: ["path"],
  },
};

export async function handleGetGuide(_server: Server, args: GetGuideArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const references = pkg.guide?.references.map((r) => ({ type: r.type, title: r.title || undefined, href: r.href })) ?? [];
  const structuredContent: Record<string, unknown> = { present: pkg.guide !== undefined };
  if (pkg.guide) structuredContent.references = references;

  const summary = `Read guide of ${JSON.stringify(abs)} (${references.length} references).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getGuideTool,
  'Takes path, the same .epub filesystem path passed to read_epub. Returns present (false if the package ' +
    'document has no <guide> element at all) and references, each a type (e.g. "cover", "toc", "text", ' +
    '"bibliography"), optional title, and href (an archive path, possibly with a "#fragment"). This is a ' +
    "legacy structure superseded by EPUB 3 navigation landmarks (part of get_navigation), kept only for " +
    "older reading systems; most modern novels don't need it.",
  handleGetGuide as never,
);
```

- [ ] **Step 4: Write `src/tools/edit-guide.ts`**

```typescript
/**
 * edit_guide — create, edit, or remove one legacy EPUB 2 guide reference.
 * Mirrors Go's tools/edit_guide.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { findIndex, removeAt, verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { Package } from "../epub/types.ts";

interface EditGuideArgs {
  action?: string;
  path?: string;
  id?: string;
  href?: string;
  title?: string;
}

export const editGuideTool: EpubTool = {
  name: "edit_guide",
  description: "Create, edit, or remove one legacy EPUB 2 guide reference of an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a new guide reference, "edit" an existing one, or "remove" one' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: 'the guide reference\'s type, e.g. "cover", "toc", "text", "bibliography"' },
      href: { type: "string", description: 'target archive path, optionally with a "#fragment"; used by create and edit, ignored by remove' },
      title: { type: "string", description: "human-readable title for this reference; optional, never prompted for" },
    },
  },
};

/** Mutates pkg.guide in place per action; creates the guide element on the first "create" if absent. */
export function applyGuideEdit(pkg: Package, action: string, typ: string, title: string, href: string): void {
  if (!pkg.guide) {
    if (action !== "create") throw new Error(`${JSON.stringify(pkg.id)} has no guide element; use action "create" instead`);
    pkg.guide = { id: `${pkg.id}#guide`, references: [] };
  }

  const index = findIndex(pkg.guide.references, typ, (r) => r.type);

  switch (action) {
    case "create":
      if (index >= 0) throw new Error(`guide reference ${JSON.stringify(typ)} already exists; use action "edit" instead`);
      pkg.guide.references.push({ id: `${pkg.guide.id}/reference[${typ}]`, type: typ, title, href });
      return;
    case "edit":
      if (index < 0) throw new Error(`no guide reference ${JSON.stringify(typ)}; use action "create" instead`);
      pkg.guide.references[index]!.title = title;
      pkg.guide.references[index]!.href = href;
      return;
    case "remove":
      if (index < 0) throw new Error(`no guide reference ${JSON.stringify(typ)}`);
      pkg.guide.references = removeAt(pkg.guide.references, index);
      return;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }
}

export async function handleEditGuide(server: Server, args: EditGuideArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const typ = await resolveArg(server, args.id, "id", 'What guide reference type ("cover", "toc", "text", etc.)?');

  let href = "";
  if (action !== "remove") {
    href = await resolveArg(server, args.href, "href", "What archive path should this guide reference point to?");
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  applyGuideEdit(pkg, action, typ, args.title ?? "", href);

  epubCache.markDirty(abs);
  const result = { action, type: typ };
  const summary = `${verbPast(action)}d guide reference ${JSON.stringify(typ)} in ${JSON.stringify(abs)}. Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result };
}

registerTool(
  editGuideTool,
  'Takes action ("create", "edit", or "remove"), path, id, and href; any of these may be omitted to be ' +
    "prompted for (see edit_chapter's description for the general elicitation rules every edit_ tool " +
    'follows). id is the reference\'s type (e.g. "cover", "toc", "text"), since guide references are ' +
    "addressed by type rather than a separate id. title is optional. This is a legacy EPUB 2 structure " +
    "kept for older reading systems; prefer edit_navigation's landmarks list for new books.\n\ncreate only " +
    "ever adds a reference of a type that doesn't exist yet — it never updates one that's already there, " +
    'so it fails outright if a reference of that type already exists; use "edit" instead to change its ' +
    "href/title. Only touches the in-memory cache; call save_epub afterwards to persist.",
  handleEditGuide as never,
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/tools/get-guide.test.ts src/tools/edit-guide.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire into `src/index.ts`**

Add:

```typescript
import "./tools/get-guide.ts";
import "./tools/edit-guide.ts";
```

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 8: Commit**

```bash
git add src/tools/get-guide.ts src/tools/get-guide.test.ts src/tools/edit-guide.ts src/tools/edit-guide.test.ts src/index.ts
git commit -m "Add get_guide and edit_guide tools"
```

---

### Task 5: Manifest tools (get_manifest, edit_manifest)

**Files:**
- Create: `src/tools/get-manifest.ts`
- Create: `src/tools/edit-manifest.ts`
- Test: `src/tools/get-manifest.test.ts`
- Test: `src/tools/edit-manifest.test.ts`
- Modify: `src/index.ts` (add two imports)

**Interfaces:**
- Consumes: `epubCache` (Task 1); `resolveArg` (`./elicit.ts`); `evictionNote` (`./eviction.ts`); `primaryPackage`, `manifestItemByHref`, `manifestItemById` (`../epub/resolve.ts`).
- Produces: `getManifestTool`/`handleGetManifest`, `editManifestTool`/`handleEditManifest`. No further exports consumed elsewhere — this tool pair is a leaf in the dependency graph.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/get-manifest.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetManifest } from "./get-manifest.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_manifest", () => {
  test("lists every manifest item with inSpine correctly set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-manifest-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Manifest Test", "Author"), path);

    const result = await handleGetManifest(fakeServer, { path });

    const items = result.structuredContent?.items as Array<{ id: string; inSpine: boolean }>;
    expect(items).toHaveLength(2); // nav.xhtml + styles/style.css
    const nav = items.find((i) => i.id === "nav.xhtml");
    const style = items.find((i) => i.id === "styles/style.css");
    expect(nav?.inSpine).toBe(true);
    expect(style?.inSpine).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });
});
```

```typescript
// src/tools/edit-manifest.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleEditManifest } from "./edit-manifest.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-manifest-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Manifest Test", "Author"), path);
  return { dir, path };
}

describe("edit_manifest", () => {
  test("rejects any action other than edit", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditManifest(fakeServer, { action: "create", path, id: "styles/style.css" });
    expect(result.isError).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("edit updates mediaType and properties", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditManifest(fakeServer, {
      action: "edit",
      path,
      id: "styles/style.css",
      mediaType: "text/x-custom-css",
      properties: "scripted",
    });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    const item = pkg.manifest.items.find((i) => i.href === "styles/style.css");
    expect(item?.mediaType).toBe("text/x-custom-css");
    expect(item?.properties).toEqual(["scripted"]);

    await rm(dir, { recursive: true, force: true });
  });

  test('properties "none" clears them', async () => {
    const { dir, path } = await writeTempBook();
    await handleEditManifest(fakeServer, { action: "edit", path, id: "nav.xhtml", properties: "none" });

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    const item = pkg.manifest.items.find((i) => i.href === "nav.xhtml");
    expect(item?.properties).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  test("errors for an unknown id", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditManifest(fakeServer, { action: "edit", path, id: "no/such.css" });
    expect(result.isError).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/get-manifest.test.ts src/tools/edit-manifest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/tools/get-manifest.ts`**

```typescript
/**
 * get_manifest — list every manifest item. Mirrors Go's
 * tools/get_manifest.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemById, primaryPackage, resolveHref } from "../epub/resolve.ts";
import type { Package } from "../epub/types.ts";

interface GetManifestArgs {
  path: string;
}

export const getManifestTool: EpubTool = {
  name: "get_manifest",
  description: "List every manifest item (chapter, resource, cover, navigation document, NCX) of an already-read EPUB. Read-only.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" } },
    required: ["path"],
  },
};

function resolveManifestIdRef(pkg: Package, opfId: string): string {
  const item = manifestItemById(pkg, opfId);
  return item ? resolveHref(pkg, item.href) : opfId;
}

export async function handleGetManifest(_server: Server, args: GetManifestArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const inSpine = new Set(pkg.spine.itemRefs.map((ref) => ref.idRef));

  const items = pkg.manifest.items.map((item) => {
    const prefix = pkg.manifest.id + "/";
    const opfId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
    const entry: Record<string, unknown> = {
      id: resolveHref(pkg, item.href),
      mediaType: item.mediaType,
      properties: item.properties.length > 0 ? item.properties : undefined,
      inSpine: inSpine.has(opfId),
    };
    if (item.fallback) entry.fallback = resolveManifestIdRef(pkg, item.fallback);
    if (item.mediaOverlay) entry.mediaOverlay = resolveManifestIdRef(pkg, item.mediaOverlay);
    return entry;
  });

  const structuredContent = { items };
  const summary = `Read manifest of ${JSON.stringify(abs)} (${items.length} items).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getManifestTool,
  "Takes path, the same .epub filesystem path passed to read_epub. Returns every file the rendition " +
    'declares, each with its id (archive path), mediaType, properties (e.g. "cover-image", "nav", ' +
    '"scripted"), fallback and mediaOverlay (archive paths of other manifest items, if set), and inSpine ' +
    "(whether it's part of the default reading order). This is the full inventory behind read_epub's " +
    "manifestItemCount and the more specific get_chapter/get_resource/get_cover/get_navigation tools — use " +
    "it to find an id before calling one of those, or edit_manifest to change an entry's properties/" +
    "fallback/mediaOverlay/mediaType in place.",
  handleGetManifest as never,
);
```

- [ ] **Step 4: Write `src/tools/edit-manifest.ts`**

```typescript
/**
 * edit_manifest — change the properties/fallback/mediaOverlay/mediaType
 * of an existing manifest item. Mirrors Go's tools/edit_manifest.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemByHref, primaryPackage } from "../epub/resolve.ts";
import type { Package } from "../epub/types.ts";

interface EditManifestArgs {
  action?: string;
  path?: string;
  id?: string;
  mediaType?: string;
  properties?: string;
  fallback?: string;
  mediaOverlay?: string;
}

export const editManifestTool: EpubTool = {
  name: "edit_manifest",
  description: "Change the properties, fallback, media overlay, or media type of an existing manifest item in an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'only "edit" is supported here; create/remove a manifest item via edit_chapter, edit_resource, edit_cover, or edit_navigation instead' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: "the manifest item's archive path, from get_manifest" },
      mediaType: { type: "string", description: "new media type; omit to leave unchanged" },
      properties: { type: "string", description: 'space-separated manifest properties, e.g. "scripted svg"; omit to leave unchanged, pass "none" to clear' },
      fallback: { type: "string", description: 'archive path of another manifest item to use as a fallback; omit to leave unchanged, pass "none" to clear' },
      mediaOverlay: { type: "string", description: 'archive path of this item\'s SMIL media overlay; omit to leave unchanged, pass "none" to clear' },
    },
  },
};

function resolveManifestIdRefEdit(pkg: Package, archivePath: string): string | undefined {
  if (archivePath === "") return undefined;
  if (archivePath === "none") return "";
  const item = manifestItemByHref(pkg, archivePath);
  if (!item) throw new Error(`no manifest item with archive path ${JSON.stringify(archivePath)}`);
  const prefix = pkg.manifest.id + "/";
  return item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
}

export async function handleEditManifest(server: Server, args: EditManifestArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'Only "edit" is supported; confirm to proceed.');
  if (action !== "edit") {
    throw new Error('edit_manifest only supports action "edit"; use edit_chapter, edit_resource, edit_cover, or edit_navigation to create or remove a manifest item');
  }
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const id = await resolveArg(server, args.id, "id", "Which manifest item (archive path) should be changed?");

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const item = manifestItemByHref(pkg, id);
  if (!item) throw new Error(`no manifest item with archive path ${JSON.stringify(id)}; call get_manifest to list valid ids`);

  if (args.mediaType) item.mediaType = args.mediaType;
  switch (args.properties) {
    case undefined:
    case "":
      break;
    case "none":
      item.properties = [];
      break;
    default:
      item.properties = args.properties.split(/\s+/).filter(Boolean);
  }
  const fallback = resolveManifestIdRefEdit(pkg, args.fallback ?? "");
  if (fallback !== undefined) item.fallback = fallback;
  const mediaOverlay = resolveManifestIdRefEdit(pkg, args.mediaOverlay ?? "");
  if (mediaOverlay !== undefined) item.mediaOverlay = mediaOverlay;

  epubCache.markDirty(abs);
  const summary = `Updated manifest item ${JSON.stringify(id)} in ${JSON.stringify(abs)}. Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: { id } };
}

registerTool(
  editManifestTool,
  'Takes action, path, and id; action must be "edit" — this tool only adjusts metadata of a manifest item ' +
    "that already exists. To add or remove the item itself, use edit_chapter (content documents), " +
    "edit_resource (stylesheets/images/fonts/etc.), edit_cover (the cover image), or edit_navigation (the " +
    "navigation document or NCX). path and id may be omitted to be prompted for (see edit_chapter's " +
    "description for the general elicitation rules every edit_ tool follows). mediaType, properties, " +
    'fallback, and mediaOverlay are all optional and left unchanged when omitted; pass "none" to ' +
    "properties/fallback/mediaOverlay to clear them. Only touches the in-memory cache; call save_epub " +
    "afterwards to persist.",
  handleEditManifest as never,
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/tools/get-manifest.test.ts src/tools/edit-manifest.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire into `src/index.ts`**

Add:

```typescript
import "./tools/get-manifest.ts";
import "./tools/edit-manifest.ts";
```

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 8: Commit**

```bash
git add src/tools/get-manifest.ts src/tools/get-manifest.test.ts src/tools/edit-manifest.ts src/tools/edit-manifest.test.ts src/index.ts
git commit -m "Add get_manifest and edit_manifest tools"
```

---

### Task 6: Metadata tools (get_metadata, edit_metadata)

**Files:**
- Create: `src/tools/get-metadata.ts`
- Create: `src/tools/edit-metadata.ts`
- Test: `src/tools/get-metadata.test.ts`
- Test: `src/tools/edit-metadata.test.ts`
- Modify: `src/index.ts` (add two imports)

**Interfaces:**
- Consumes: `epubCache` (Task 1); `resolveArg` (`./elicit.ts`); `evictionNote` (`./eviction.ts`); `contains`, `findIndex`, `removeAt`, `verbPast` (Task 1's `idlist.ts`); `primaryPackage` (`../epub/resolve.ts`); `Metadata`, `ArchiveId` types (`../epub/types.ts`).
- Produces: `getMetadataTool`/`handleGetMetadata`, `editMetadataTool`/`handleEditMetadata`. No further exports consumed elsewhere.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/get-metadata.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetMetadata } from "./get-metadata.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_metadata", () => {
  test("returns titles, creators, and identifiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-metadata-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Metadata Test", "Jane Author"), path);

    const result = await handleGetMetadata(fakeServer, { path });

    const titles = result.structuredContent?.titles as Array<{ value: string }>;
    const creators = result.structuredContent?.creators as Array<{ name: string }>;
    expect(titles[0]?.value).toBe("Metadata Test");
    expect(creators[0]?.name).toBe("Jane Author");
    expect((result.structuredContent?.identifiers as unknown[]).length).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });
});
```

```typescript
// src/tools/edit-metadata.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleEditMetadata } from "./edit-metadata.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-metadata-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Metadata Test", "Author"), path);
  return { dir, path };
}

describe("edit_metadata", () => {
  test("create adds a new subject", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditMetadata(fakeServer, { action: "create", path, field: "subject", value: "Fantasy" });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.metadata.subjects).toHaveLength(1);
    expect(pkg.metadata.subjects[0]?.value).toBe("Fantasy");

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails on an exact-duplicate entry", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditMetadata(fakeServer, { action: "create", path, field: "subject", value: "Fantasy" });
    const result = await handleEditMetadata(fakeServer, { action: "create", path, field: "subject", value: "Fantasy" });

    expect(result.isError).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces the description scalar field", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditMetadata(fakeServer, { action: "edit", path, field: "description", value: "A test book." });

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.metadata.description).toBe("A test book.");

    await rm(dir, { recursive: true, force: true });
  });

  test("publisher is addressed by its own text, not an id", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditMetadata(fakeServer, { action: "create", path, field: "publisher", value: "Acme Books" });
    const result = await handleEditMetadata(fakeServer, { action: "remove", path, field: "publisher", id: "Acme Books" });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.metadata.publishers).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("rejects an unknown field", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditMetadata(fakeServer, { action: "create", path, field: "bogus", value: "x" });
    expect(result.isError).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("edit on a title updates value/type/lang wholesale", async () => {
    const { dir, path } = await writeTempBook();
    const cachedBefore = (await epubCache.load(resolve(path))).epub;
    const titleId = primaryPackage(cachedBefore)!.metadata.titles[0]!.id;

    const result = await handleEditMetadata(fakeServer, {
      action: "edit",
      path,
      field: "title",
      id: titleId,
      value: "New Title",
      type: "main",
      lang: "en",
    });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.metadata.titles[0]).toMatchObject({ value: "New Title", type: "main", lang: "en" });

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/get-metadata.test.ts src/tools/edit-metadata.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/tools/get-metadata.ts`**

```typescript
/**
 * get_metadata — read the full Dublin Core / EPUB metadata. Mirrors Go's
 * tools/get_metadata.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { Metadata } from "../epub/types.ts";

interface GetMetadataArgs {
  path: string;
}

export const getMetadataTool: EpubTool = {
  name: "get_metadata",
  description: "Read the full Dublin Core / EPUB metadata of an already-read EPUB. Read-only.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" } },
    required: ["path"],
  },
};

export function summarizeMetadata(m: Metadata): Record<string, unknown> {
  return {
    identifiers: m.identifiers.map((v) => ({ id: v.id, scheme: v.scheme || undefined, value: v.value })),
    titles: m.titles.map((v) => ({ id: v.id, value: v.value, type: v.type || undefined, lang: v.lang || undefined })),
    languages: m.languages.map((v) => ({ id: v.id, value: v.value })),
    creators: m.creators.map((v) => ({ id: v.id, name: v.name, role: v.role || undefined, fileAs: v.fileAs || undefined, lang: v.lang || undefined })),
    contributors: m.contributors.map((v) => ({ id: v.id, name: v.name, role: v.role || undefined, fileAs: v.fileAs || undefined, lang: v.lang || undefined })),
    publishers: m.publishers,
    dates: m.dates.map((v) => ({ id: v.id, value: v.value, event: v.event || undefined })),
    subjects: m.subjects.map((v) => ({ id: v.id, value: v.value, scheme: v.scheme || undefined, code: v.code || undefined })),
    description: m.description || undefined,
    rights: m.rights || undefined,
    metas: m.metas.map((v) => ({ id: v.id, property: v.property || undefined, refines: v.refines || undefined, scheme: v.scheme || undefined, value: v.value, name: v.name || undefined })),
  };
}

export async function handleGetMetadata(_server: Server, args: GetMetadataArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const structuredContent = summarizeMetadata(pkg.metadata);
  const titles = structuredContent.titles as unknown[];
  const creators = structuredContent.creators as unknown[];
  const identifiers = structuredContent.identifiers as unknown[];
  const summary = `Read metadata from ${JSON.stringify(abs)} (${titles.length} titles, ${creators.length} creators, ${identifiers.length} identifiers).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getMetadataTool,
  "Takes path, the same .epub filesystem path passed to read_epub. Returns every metadata element: " +
    "identifiers, titles, languages, creators, contributors, publishers, dates, subjects, description, " +
    "rights, and the catch-all metas list (cover reference, series/collection info, dcterms:modified, and " +
    "anything else not modeled by name above). Every list entry carries an id usable with edit_metadata's " +
    "id argument to edit or remove that specific entry. read_epub's title/creators/language fields are a " +
    "convenience summary of a subset of this data.",
  handleGetMetadata as never,
);
```

- [ ] **Step 4: Write `src/tools/edit-metadata.ts`**

```typescript
/**
 * edit_metadata — create, edit, or remove one entry of the Dublin
 * Core / EPUB metadata. Mirrors Go's tools/edit_metadata.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { contains, findIndex, removeAt, verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { ArchiveId, Package } from "../epub/types.ts";

const METADATA_FIELDS = [
  "identifier", "title", "language", "creator", "contributor",
  "publisher", "date", "subject", "description", "rights", "meta",
];

interface EditMetadataArgs {
  action?: string;
  path?: string;
  field: string;
  id?: string;
  value?: string;
  scheme?: string;
  type?: string;
  role?: string;
  fileAs?: string;
  lang?: string;
  event?: string;
  code?: string;
  property?: string;
  refines?: string;
  metaName?: string;
}

export const editMetadataTool: EpubTool = {
  name: "edit_metadata",
  description: "Create, edit, or remove one entry of an already-read EPUB's Dublin Core / EPUB metadata. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a new entry, "edit" an existing one, or "remove" one' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      field: { type: "string", description: "which metadata list to affect: identifier, title, language, creator, contributor, publisher, date, subject, description, rights, or meta" },
      id: { type: "string", description: "id of the entry to edit/remove, from get_metadata (ignored by create; for the publisher field, use the exact current publisher text as the id instead)" },
      value: { type: "string", description: "the entry's primary text; ignored by remove" },
      scheme: { type: "string", description: 'identifier scheme (e.g. "UUID", "ISBN") or subject authority' },
      type: { type: "string", description: 'title type, e.g. "main", "subtitle", "collection" (title field only)' },
      role: { type: "string", description: 'creator/contributor MARC relator code, e.g. "aut", "trl", "ill"' },
      fileAs: { type: "string", description: "sort-friendly form of a creator/contributor name" },
      lang: { type: "string", description: "xml:lang for a title/creator/contributor entry" },
      event: { type: "string", description: 'date event, e.g. "publication", "modification"' },
      code: { type: "string", description: "subject authority-specific term code" },
      property: { type: "string", description: 'EPUB 3 meta property, e.g. "belongs-to-collection" (meta field only)' },
      refines: { type: "string", description: 'IDREF this meta refines, e.g. "#bookid" (meta field only)' },
      metaName: { type: "string", description: 'legacy EPUB 2 meta name attribute, e.g. "calibre:series" (meta field only)' },
    },
    required: ["field"],
  },
};

function verbPastLower(action: string): string {
  return verbPast(action);
}

export async function handleEditMetadata(server: Server, args: EditMetadataArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const field = args.field;
  if (!field?.trim()) throw new Error(`field is required — must be one of ${METADATA_FIELDS.join(", ")}`);
  if (!contains(METADATA_FIELDS, field)) throw new Error(`field must be one of ${METADATA_FIELDS.join(", ")}, got ${JSON.stringify(field)}`);
  if (action !== "create" && action !== "edit" && action !== "remove") {
    throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  const isScalar = field === "description" || field === "rights";

  let id = "";
  if (!isScalar && action !== "create") {
    id = await resolveArg(server, args.id, "id", "Which entry? Provide its id from get_metadata (or, for publisher, its exact text).");
  }

  let value = "";
  if (action !== "remove") {
    value = await resolveArg(server, args.value, "value", "What should this entry's value be?");
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const resultId = applyMetadataEdit(pkg, action, field, id, value, args);

  epubCache.markDirty(abs);
  const summary = `${verbPastLower(action)}d ${field} ${JSON.stringify(resultId)} in ${JSON.stringify(abs)}. Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: { action, field, id: resultId } };
}

function applyMetadataEdit(pkg: Package, action: string, field: string, id: string, value: string, args: EditMetadataArgs): string {
  const m = pkg.metadata;

  switch (field) {
    case "description":
      m.description = action === "remove" ? "" : value;
      return "description";
    case "rights":
      m.rights = action === "remove" ? "" : value;
      return "rights";
    case "publisher":
      switch (action) {
        case "create": {
          if (findIndex(m.publishers, value, (v) => v) >= 0) throw new Error(`publisher ${JSON.stringify(value)} already exists; use action "edit" instead`);
          m.publishers.push(value);
          return value;
        }
        case "edit": {
          const i = findIndex(m.publishers, id, (v) => v);
          if (i < 0) throw new Error(`no publisher ${JSON.stringify(id)}`);
          m.publishers[i] = value;
          return value;
        }
        case "remove": {
          const i = findIndex(m.publishers, id, (v) => v);
          if (i < 0) throw new Error(`no publisher ${JSON.stringify(id)}`);
          m.publishers = removeAt(m.publishers, i);
          return id;
        }
      }
      break;
    case "identifier":
      return editList(m.identifiers, action, id, m.id, "identifier", (v) => v.id, (elId) => ({ id: elId, scheme: args.scheme ?? "", value }), (list) => (m.identifiers = list));
    case "title":
      return editList(m.titles, action, id, m.id, "title", (v) => v.id, (elId) => ({ id: elId, value, type: args.type ?? "", lang: args.lang ?? "" }), (list) => (m.titles = list));
    case "language":
      return editList(m.languages, action, id, m.id, "language", (v) => v.id, (elId) => ({ id: elId, value }), (list) => (m.languages = list));
    case "creator":
      return editList(m.creators, action, id, m.id, "creator", (v) => v.id, (elId) => ({ id: elId, name: value, role: args.role ?? "", fileAs: args.fileAs ?? "", lang: args.lang ?? "" }), (list) => (m.creators = list));
    case "contributor":
      return editList(m.contributors, action, id, m.id, "contributor", (v) => v.id, (elId) => ({ id: elId, name: value, role: args.role ?? "", fileAs: args.fileAs ?? "", lang: args.lang ?? "" }), (list) => (m.contributors = list));
    case "date":
      return editList(m.dates, action, id, m.id, "date", (v) => v.id, (elId) => ({ id: elId, value, event: args.event ?? "" }), (list) => (m.dates = list));
    case "subject":
      return editList(m.subjects, action, id, m.id, "subject", (v) => v.id, (elId) => ({ id: elId, value, scheme: args.scheme ?? "", code: args.code ?? "" }), (list) => (m.subjects = list));
    case "meta":
      return editList(m.metas, action, id, m.id, "meta", (v) => v.id, (elId) => ({ id: elId, property: args.property ?? "", refines: args.refines ?? "", scheme: args.scheme ?? "", value, name: args.metaName ?? "" }), (list) => (m.metas = list));
  }

  throw new Error(`unknown field ${JSON.stringify(field)}`);
}

/**
 * Implements create/edit/remove for one id-addressed metadata array
 * field, generic over its element type T. setList writes the new array
 * back onto the owning Metadata field (TS has no equivalent of Go's
 * `*[]T` in-place slice mutation via a pointer, so the caller supplies a
 * setter instead).
 */
function editList<T extends { id: ArchiveId }>(
  list: T[],
  action: string,
  id: string,
  metaId: ArchiveId,
  name: string,
  getId: (item: T) => string,
  build: (elId: ArchiveId) => T,
  setList: (list: T[]) => void,
): string {
  switch (action) {
    case "create": {
      for (const existing of list) {
        const candidate = build(existing.id);
        if (deepEqual(candidate, existing)) {
          throw new Error(`${name} ${JSON.stringify(existing.id)} already has this exact content; use action "edit" instead`);
        }
      }
      const elId = `${metaId}/${name}[${list.length}]`;
      setList([...list, build(elId)]);
      return elId;
    }
    case "edit": {
      const i = findIndex(list, id, getId);
      if (i < 0) throw new Error(`no ${name} with id ${JSON.stringify(id)}`);
      const next = [...list];
      next[i] = build(id);
      setList(next);
      return id;
    }
    case "remove": {
      const i = findIndex(list, id, getId);
      if (i < 0) throw new Error(`no ${name} with id ${JSON.stringify(id)}`);
      setList(removeAt(list, i));
      return id;
    }
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

registerTool(
  editMetadataTool,
  'Takes action ("create", "edit", or "remove") and path, both of which are optional — omitting one ' +
    "triggers an elicitation prompt. field is required and must always be provided; it is not prompted for " +
    "and instead returns a clear error if omitted.\n\nfield selects which metadata list is affected: " +
    "identifier, title, language, creator, contributor, publisher, date, subject, meta (all list-valued, " +
    "addressed by id from get_metadata), or description/rights (scalar, id ignored). The publisher list " +
    "has no ids of its own — use the exact current publisher text as id for edit/remove. edit replaces the " +
    "whole entry (value and every attribute given), so pass the current value back if only an attribute is " +
    "changing. Secondary attributes (scheme, role, fileAs, lang, event, code, property, refines, metaName) " +
    "are optional and apply only to the fields they're documented against above; omitting one clears " +
    "it.\n\ncreate never touches an existing entry — it only appends a brand-new one, so it cannot be used " +
    "to update content that's already there. Call get_metadata first to check whether the entry you want " +
    'already exists; if it does, use action "edit" (addressed by its id) instead of "create", which would ' +
    "otherwise leave a duplicate alongside it. create fails outright if value and every given attribute " +
    "exactly match an existing entry in the same field. Only touches the in-memory cache; call save_epub " +
    "afterwards to persist.",
  handleEditMetadata as never,
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/tools/get-metadata.test.ts src/tools/edit-metadata.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire into `src/index.ts`**

Add:

```typescript
import "./tools/get-metadata.ts";
import "./tools/edit-metadata.ts";
```

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 8: Commit**

```bash
git add src/tools/get-metadata.ts src/tools/get-metadata.test.ts src/tools/edit-metadata.ts src/tools/edit-metadata.test.ts src/index.ts
git commit -m "Add get_metadata and edit_metadata tools"
```

---

## Definition of done

- `bun run typecheck` exits 0.
- `bun test` passes for every file under `src/`.
- `src/tools/` additionally contains `epub-cache.ts`, `idlist.ts`, and 10 new tool files (`get-resource.ts`, `edit-resource.ts`, `get-spine.ts`, `edit-spine.ts`, `get-guide.ts`, `edit-guide.ts`, `get-manifest.ts`, `edit-manifest.ts`, `get-metadata.ts`, `edit-metadata.ts`), each with a matching `*.test.ts`, each self-registered and wired into `src/index.ts`.
- A manual smoke test (`tools/list` over stdio) lists 11 tools: `get_context` plus the 10 above.
- Phase 5 (navigation infrastructure: `get_navigation`, `edit_navigation`, `nav_sync`) can begin — it depends on `idlist.ts` and `edit-spine.ts`'s `insertAt`/`clampPosition`, both done here.
