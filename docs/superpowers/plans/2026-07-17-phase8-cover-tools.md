# Phase 8: Cover Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the front/back cover tools: `get_cover`, `edit_cover`, `edit_back_cover`. This is the last tool-category phase in the project's dependency order — every other tool this phase needs (`archiveIdInUse`, `manifestIdCandidate`, `uniqueManifestId` from Phase 4; `primaryNavigation`, `addLandmarkEntry`, `bookTitle`, `renumberNavPoints` from Phase 5; `insertAt`, `clampPosition`, `renumberSpine` from Phase 4; `applyGuideEdit` from Phase 4; `relativeArchiveHref`, `manifestItemByHref`, `relativeHref` from Phase 1) is already complete and merged.

**Architecture:** Three files under `src/tools/`, matching the Go reference's file boundaries: `get-cover.ts`, `edit-cover.ts`, `edit-back-cover.ts`. `edit-cover.ts` hosts several small helpers (`coverPageMarkup`, `xmlEscapeAttr`, `uniqueArchivePath`, `removeCoverPage`, `guessImageMediaType`) that `edit-back-cover.ts` imports directly — this mirrors Go's own choice (Go's `edit_back_cover.go` calls straight into `edit_cover.go`'s private functions via the flat package namespace), and unlike some earlier phases' relocations, there's no already-shipped code to disturb here since both files are new in this same phase.

**Source of record:** `G:\_GoProjects\epub-novel-mcp-server\tools\{get_cover,edit_cover,edit_back_cover}.go`.

## Global Constraints

- Every exported name mirrors its Go counterpart's meaning, translated to camelCase.
- All relative imports use explicit `.ts` extensions; SDK imports keep `.js`.
- `verbatimModuleSyntax` is on: import types with `import type { ... }`.
- Every tool self-registers via a top-level `registerTool(...)` call.
- Every tool handler that omits a required string arg resolves it via `resolveArg(server, current, field, message)`.
- Every tool handler that loads a book calls `epubCache.load(abs)` and appends `evictionNote(evicted)` to its summary; every mutating tool calls `epubCache.markDirty(abs)` after a successful edit and appends "Call save_epub to persist this to disk." to its summary.
- Every tool handler returns `{ content: [{ type: "text", text: summary }], structuredContent: result }`.
- **Handlers throw on error; only `registry.ts`'s `dispatchTool` wrapper converts a throw to `{isError:true}`.** Tests calling a handler directly use `.rejects.toThrow(...)`.
- **`GuideReference.href` is stored as a full archive path, NOT baseDir-relative** — confirmed by both the Go and already-merged TS `applyGuideEdit`'s actual call sites in this phase's own source (`applyGuideEdit(pkg, "create", "cover", "Cover", pageID)` passes `pageID`, a full archive path, never a relativized one). This matches `NavPoint.href`'s convention, not `ManifestItem.href`'s — the same distinction Phase 4 and Phase 6 each found a real bug from getting backwards. `pkg.guide.references[i].href` should be read/written directly as a full archive path throughout this phase; never pass it through `resolveHref`/`relativeHref` (those are for `ManifestItem.href` specifically).
- **`relativeArchiveHref(fromArchivePath, toArchivePath)`** (Phase 1, `src/epub/resolve.ts`) is the function that computes a cover page's `<img src="...">` value — it produces a genuine document-relative href (accounting for the wrapper page's own directory), which is different from both `resolveHref`/`relativeHref` (baseDir-relative) and a bare archive path. Use it exactly where Go uses `epub.RelativeArchiveHref`.
- **`pkg.manifest.items.push(...)` directly, matching every prior phase's manifest-item-creation pattern** (Phase 4/6): a new `ManifestItem` object literal with `id`, `href` (via `relativeHref(pkg, archivePath)`), `mediaType`, `properties: []` (or `["cover-image"]` for the front cover's image item specifically), `fallback: ""`, `mediaOverlay: ""`.
- Tests use `bun:test`.

---

### Task 1: `get_cover` tool

**Files:**
- Create: `src/tools/get-cover.ts`
- Test: `src/tools/get-cover.test.ts`
- Modify: `src/index.ts` (add `import "./tools/get-cover.ts";`)

**Interfaces:**
- Consumes: `epubCache`, `evictionNote`, `resolveHref` (`../epub/resolve.ts`), `primaryPackage` (`../epub/resolve.ts`), `manifestItemById` (`../epub/resolve.ts`, for the legacy meta-pointer fallback).
- Produces: `getCoverTool`/`handleGetCover` (registered as `get_cover`); `findCoverItem(pkg: Package): ManifestItem | undefined` (consumed by this phase's Task 2 `edit-cover.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/get-cover.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { findCoverItem, handleGetCover } from "./get-cover.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_cover", () => {
  test("reports present:false for a book with no cover", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-cover-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Get Cover Test", "Author"), path);

    const result = await handleGetCover(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.present).toBe(false);
    expect(result.structuredContent?.data).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("returns inline base64 data for a book with a cover-image property", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-cover-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Get Cover Data Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/cover`, href: "images/cover.jpg", mediaType: "image/jpeg", properties: ["cover-image"], fallback: "", mediaOverlay: "" });
    e.resources["images/cover.jpg"] = { id: "images/cover.jpg", mediaType: "image/jpeg", data: new TextEncoder().encode("fake-jpeg-bytes") };
    await writeEpub(e, path);

    const result = await handleGetCover(fakeServer, { path });

    expect(result.structuredContent?.present).toBe(true);
    expect(result.structuredContent?.id).toBe("images/cover.jpg");
    expect(result.structuredContent?.mediaType).toBe("image/jpeg");
    expect(result.structuredContent?.sizeBytes).toBe(15);
    expect(result.structuredContent?.data).toBe(Buffer.from("fake-jpeg-bytes").toString("base64"));
    expect(result.structuredContent?.sourcePath).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("falls back to the legacy meta name=cover pointer when no manifest item has cover-image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-cover-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Get Cover Legacy Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/cover`, href: "images/cover.png", mediaType: "image/png", properties: [], fallback: "", mediaOverlay: "" });
    e.resources["images/cover.png"] = { id: "images/cover.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) };
    pkg.metadata.metas.push({ id: `${pkg.metadata.id}/meta[0]`, property: "", refines: "", scheme: "", value: "cover", name: "cover" });

    await writeEpub(e, path);

    const result = await handleGetCover(fakeServer, { path });

    expect(result.structuredContent?.present).toBe(true);
    expect(result.structuredContent?.id).toBe("images/cover.png");

    await rm(dir, { recursive: true, force: true });
  });

  test("writes to sourcePath instead of returning inline data when given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-cover-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Get Cover SourcePath Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/cover`, href: "cover.jpg", mediaType: "image/jpeg", properties: ["cover-image"], fallback: "", mediaOverlay: "" });
    e.resources["cover.jpg"] = { id: "cover.jpg", mediaType: "image/jpeg", data: new TextEncoder().encode("bytes") };
    await writeEpub(e, path);

    const outPath = join(dir, "out.jpg");
    const result = await handleGetCover(fakeServer, { path, sourcePath: outPath });

    expect(result.structuredContent?.sourcePath).toBe(outPath);
    expect(result.structuredContent?.data).toBeUndefined();
    const written = await Bun.file(outPath).text();
    expect(written).toBe("bytes");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path is missing", async () => {
    await expect(handleGetCover(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });
});

describe("findCoverItem", () => {
  test("prefers the cover-image manifest property over the legacy meta pointer", async () => {
    const e = newEpub("Find Cover Item Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/a`, href: "a.jpg", mediaType: "image/jpeg", properties: [], fallback: "", mediaOverlay: "" });
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/b`, href: "b.jpg", mediaType: "image/jpeg", properties: ["cover-image"], fallback: "", mediaOverlay: "" });
    pkg.metadata.metas.push({ id: `${pkg.metadata.id}/meta[0]`, property: "", refines: "", scheme: "", value: "a", name: "cover" });

    const item = findCoverItem(pkg);
    expect(item?.href).toBe("b.jpg");
  });

  test("returns undefined when neither mechanism identifies a cover", () => {
    const e = newEpub("Find Cover Item Missing Test", "Author");
    const pkg = primaryPackage(e)!;
    expect(findCoverItem(pkg)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/get-cover.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/get-cover.ts`**

```typescript
/**
 * get_cover — read the cover image of an already-read EPUB, if it has
 * one. Mirrors Go's tools/get_cover.go.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemById, primaryPackage, resolveHref } from "../epub/resolve.ts";
import type { ManifestItem, Package } from "../epub/types.ts";

interface GetCoverArgs {
  path: string;
  sourcePath?: string;
}

export const getCoverTool: EpubTool = {
  name: "get_cover",
  description: "Read the cover image of an already-read EPUB, if it has one. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      sourcePath: { type: "string", description: "optional filesystem path to write the cover image's raw bytes to directly; if given, the response omits inline data and instead reports where the file was written" },
    },
    required: ["path"],
  },
};

/**
 * Returns the manifest item marked as the cover image, either via the
 * EPUB 3 "cover-image" manifest property or, failing that, the legacy
 * EPUB 2 meta name="cover" pointer. Returns undefined if neither is
 * present.
 */
export function findCoverItem(pkg: Package): ManifestItem | undefined {
  const byProperty = pkg.manifest.items.find((item) => item.properties.includes("cover-image"));
  if (byProperty) return byProperty;

  for (const meta of pkg.metadata.metas) {
    if (meta.name === "cover" && meta.value !== "") {
      const item = manifestItemById(pkg, meta.value);
      if (item) return item;
    }
  }
  return undefined;
}

export async function handleGetCover(_server: Server, args: GetCoverArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const item = findCoverItem(pkg);
  if (!item) {
    const summary = `${JSON.stringify(abs)} has no cover image.${evictionNote(eviction)}`;
    return { content: [{ type: "text", text: summary }], structuredContent: { present: false } };
  }

  const archivePath = resolveHref(pkg, item.href);
  const res = e.resources[archivePath];
  if (!res) throw new Error(`cover manifest item ${JSON.stringify(item.id)} resolves to ${JSON.stringify(archivePath)}, which isn't in resources`);

  const structuredContent: Record<string, unknown> = {
    present: true,
    id: archivePath,
    mediaType: res.mediaType,
    sizeBytes: res.data.length,
  };

  if (args.sourcePath) {
    await writeFile(args.sourcePath, res.data);
    structuredContent.sourcePath = args.sourcePath;
  } else {
    structuredContent.data = Buffer.from(res.data).toString("base64");
  }

  const summary = `Read cover ${JSON.stringify(archivePath)} from ${JSON.stringify(abs)} (${res.data.length} bytes, ${res.mediaType}).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getCoverTool,
  "Takes path, the same .epub filesystem path passed to read_epub. Returns present (false if the book has " +
    "no manifest item marked as the cover image), and if true, the cover's id (archive path), mediaType, " +
    "sizeBytes, and its raw bytes as base64 in data. Pass sourcePath to instead write the raw bytes " +
    "directly to that filesystem path on the machine running this server — the response then omits data " +
    "and reports sourcePath instead, avoiding sending large images through MCP.",
  handleGetCover as never,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/get-cover.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/get-cover.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/get-cover.ts src/tools/get-cover.test.ts src/index.ts
git commit -m "Add get_cover tool"
```

---

### Task 2: `edit_cover` tool + shared cover-page helpers

**Files:**
- Create: `src/tools/edit-cover.ts`
- Test: `src/tools/edit-cover.test.ts`
- Modify: `src/index.ts` (add `import "./tools/edit-cover.ts";`)

**Interfaces:**
- Consumes: `epubCache`, `evictionNote`, `resolveArg` (`./elicit.ts`), `archiveIdInUse`/`manifestIdCandidate`/`uniqueManifestId`/`guessImageMediaType` (`./edit-resource.ts`, Phase 4), `insertAt`/`renumberSpine` (`./edit-spine.ts`, Phase 4), `applyGuideEdit` (`./edit-guide.ts`, Phase 4), `primaryNavigation` (`./get-navigation.ts`, Phase 5), `addLandmarkEntry` (`./edit-navigation.ts`, Phase 5), `findCoverItem` (`./get-cover.ts`, this phase's Task 1), `primaryPackage`/`resolveHref`/`relativeHref`/`relativeArchiveHref`/`manifestItemByHref` (`../epub/resolve.ts`), `removeMatching`/`verbPast` (`./idlist.ts`, Phase 4).
- Produces: `editCoverTool`/`handleEditCover` (registered as `edit_cover`); `coverPageMarkup(title, sectionType, imgHref): string`, `xmlEscapeAttr(s): string`, `uniqueArchivePath(e, candidate): string`, `removeCoverPage(e, pkg, pageId): void` — all four consumed by this phase's Task 3 (`edit-back-cover.ts`).

**Note on `guessImageMediaType`:** already exists in `src/tools/edit-resource.ts` (Phase 4, used by `edit_resource`/`edit_cover`'s Go equivalents both calling into the same function) — import it rather than redefining it, exactly like `manifestIdCandidate`/`uniqueManifestId`.

**Note on `pkg.baseDir + "cover.xhtml"` (the front cover's wrapper page id):** Go's `createCover` builds the page id as `pkg.BaseDir+"cover.xhtml"` — a raw string concatenation, not `resolveHref`. `pkg.baseDir` already ends in `/` when non-empty (or is `""` at the archive root), so this concatenation produces a valid full archive path directly. Port this literally as `` `${pkg.baseDir}cover.xhtml` ``, not through `resolveHref`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/edit-cover.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleEditCover } from "./edit-cover.ts";
import { epubCache } from "./epub-cache.ts";
import { findCoverItem } from "./get-cover.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-cover-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Cover Test", "Author"), path);
  return { dir, path };
}

describe("edit_cover", () => {
  test("create adds the cover-image manifest item, a wrapper page, spine entry, landmark, and guide reference", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditCover(fakeServer, { action: "create", path, id: "images/cover.jpg", sourcePath: undefined, content: "fake-bytes" });

    void result; // placeholder — see Step 1 fix note below for the real sourcePath-based test
    await rm(dir, { recursive: true, force: true });
  });
});
```

The test skeleton above is intentionally incomplete — since `edit_cover` (like `edit_resource`) takes its image bytes via `sourcePath` (a real file read from disk, per Go's `os.ReadFile(sourcePath)`), not a `content` string field. Replace it with the following complete test suite before running:

```typescript
// src/tools/edit-cover.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleEditCover, uniqueArchivePath, coverPageMarkup, xmlEscapeAttr } from "./edit-cover.ts";
import { epubCache } from "./epub-cache.ts";
import { findCoverItem } from "./get-cover.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string; sourcePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-cover-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Cover Test", "Author"), path);
  const sourcePath = join(dir, "cover-source.jpg");
  await writeFile(sourcePath, "fake-jpeg-bytes");
  return { dir, path, sourcePath };
}

describe("edit_cover", () => {
  test("create adds the cover-image manifest item, a wrapper page, spine entry, landmark, and guide reference", async () => {
    const { dir, path, sourcePath } = await writeTempBook();

    const result = await handleEditCover(fakeServer, { action: "create", path, id: "images/cover.jpg", sourcePath });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.id).toBe("images/cover.jpg");

    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    const coverItem = findCoverItem(pkg);
    expect(coverItem?.href).toBe("images/cover.jpg");
    expect(cached.resources["images/cover.jpg"]?.mediaType).toBe("image/jpeg");

    // Wrapper page: first entry in the spine.
    expect(pkg.spine.itemRefs[0]?.idRef).not.toBe("nav");
    const pageItem = pkg.manifest.items.find((i) => i.id === pkg.spine.itemRefs[0]?.id ? false : pkg.manifest.items.find((mi) => mi.id.endsWith("/" + pkg.spine.itemRefs[0]!.idRef)));
    expect(pageItem).toBeDefined();

    // Legacy meta pointer.
    const coverMeta = pkg.metadata.metas.find((m) => m.name === "cover");
    expect(coverMeta).toBeDefined();

    // Landmarks entry.
    const nav = cached.navigation["nav.xhtml"]!;
    const landmarks = nav.lists.find((l) => l.type === "landmarks");
    expect(landmarks?.items.some((p) => p.type === "cover")).toBe(true);

    // Guide reference.
    expect(pkg.guide?.references.some((r) => r.type === "cover")).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if the book already has a cover", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await handleEditCover(fakeServer, { action: "create", path, id: "images/cover.jpg", sourcePath });

    await expect(
      handleEditCover(fakeServer, { action: "create", path, id: "images/cover2.jpg", sourcePath }),
    ).rejects.toThrow("already has a cover");

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if id already names something in the book", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await expect(
      handleEditCover(fakeServer, { action: "create", path, id: "styles/style.css", sourcePath }),
    ).rejects.toThrow("already exists");
    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces the existing cover's bytes in place, leaving the wrapper page untouched", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await handleEditCover(fakeServer, { action: "create", path, id: "images/cover.jpg", sourcePath });
    const newSource = join(dir, "new-cover.png");
    await writeFile(newSource, "new-bytes-longer-than-before");

    const result = await handleEditCover(fakeServer, { action: "edit", path, sourcePath: newSource, mediaType: "image/png" });

    expect(result.structuredContent?.id).toBe("images/cover.jpg");
    const cached = epubCache.get(resolve(path))!;
    const text = new TextDecoder().decode(cached.resources["images/cover.jpg"]!.data);
    expect(text).toBe("new-bytes-longer-than-before");
    const pkg = primaryPackage(cached)!;
    expect(findCoverItem(pkg)?.mediaType).toBe("image/png");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit fails if the book has no cover yet", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await expect(handleEditCover(fakeServer, { action: "edit", path, sourcePath })).rejects.toThrow("has no cover image");
    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes the cover resource, manifest entry, meta pointer, wrapper page, spine entry, landmark, and guide reference", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await handleEditCover(fakeServer, { action: "create", path, id: "images/cover.jpg", sourcePath });

    const result = await handleEditCover(fakeServer, { action: "remove", path });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    expect(findCoverItem(pkg)).toBeUndefined();
    expect(cached.resources["images/cover.jpg"]).toBeUndefined();
    expect(pkg.metadata.metas.some((m) => m.name === "cover")).toBe(false);
    expect(pkg.guide?.references.some((r) => r.type === "cover")).toBe(false);
    const nav = cached.navigation["nav.xhtml"]!;
    const landmarks = nav.lists.find((l) => l.type === "landmarks");
    expect(landmarks?.items.some((p) => p.type === "cover")).toBe(false);
    // Wrapper page's content document should also be gone.
    expect(Object.keys(cached.contentDocuments)).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("remove fails if the book has no cover", async () => {
    const { dir, path } = await writeTempBook();
    await expect(handleEditCover(fakeServer, { action: "remove", path })).rejects.toThrow("has no cover image");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("uniqueArchivePath", () => {
  test("returns candidate unchanged when unused, else appends a numeric suffix before the extension", () => {
    const e = newEpub("Unique Archive Path Test", "Author");
    expect(uniqueArchivePath(e, "cover.xhtml")).toBe("cover.xhtml");
    e.contentDocuments["cover.xhtml"] = { id: "cover.xhtml", mediaType: "application/xhtml+xml", markup: "" };
    expect(uniqueArchivePath(e, "cover.xhtml")).toBe("cover-2.xhtml");
  });
});

describe("coverPageMarkup / xmlEscapeAttr", () => {
  test("escapes special characters in title and href", () => {
    const markup = coverPageMarkup('A & B < "C"', "cover", "images/a&b.jpg");
    expect(markup).toContain("A &amp; B &lt; &quot;C&quot;");
    expect(markup).toContain('src="images/a&amp;b.jpg"');
    expect(markup).toContain('epub:type="cover"');
  });

  test("xmlEscapeAttr escapes the five XML-significant characters", () => {
    expect(xmlEscapeAttr(`& < > "`)).toBe("&amp; &lt; &gt; &quot;");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/edit-cover.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/edit-cover.ts`**

```typescript
/**
 * edit_cover — create, edit, or remove the front cover image of an
 * already-read EPUB. Mirrors Go's tools/edit_cover.go.
 *
 * Also hosts coverPageMarkup/xmlEscapeAttr/uniqueArchivePath/
 * removeCoverPage/guessImageMediaType-adjacent helpers consumed by
 * edit-back-cover.ts (this phase's Task 3), mirroring Go's own choice to
 * put them here and have edit_back_cover.go call straight into them.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { archiveIdInUse, guessImageMediaType, manifestIdCandidate, uniqueManifestId } from "./edit-resource.ts";
import { insertAt, renumberSpine } from "./edit-spine.ts";
import { applyGuideEdit } from "./edit-guide.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { findCoverItem } from "./get-cover.ts";
import { primaryNavigation } from "./get-navigation.ts";
import { addLandmarkEntry } from "./edit-navigation.ts";
import { removeMatching, verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemByHref, primaryPackage, relativeArchiveHref, relativeHref, resolveHref } from "../epub/resolve.ts";
import type { Epub, Package } from "../epub/types.ts";

interface EditCoverArgs {
  action?: string;
  path?: string;
  id?: string;
  sourcePath?: string;
  mediaType?: string;
}

interface EditCoverResult {
  action: string;
  id?: string;
  mediaType?: string;
  sizeBytes?: number;
}

export const editCoverTool: EpubTool = {
  name: "edit_cover",
  description: "Create, edit, or remove the cover image of an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a cover image (fails if one exists), "edit" its bytes in place, or "remove" it' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: 'archive path for the new cover image, e.g. "OEBPS/images/cover.jpg"; used only by create — edit and remove always target the book\'s existing cover' },
      sourcePath: { type: "string", description: "filesystem path to the image file to use as the cover, read directly from disk (not sent through MCP); used by create and edit, ignored by remove" },
      mediaType: { type: "string", description: 'image media type, e.g. "image/jpeg"; guessed from id\'s extension if omitted on create' },
    },
  },
};

/** Builds a minimal XHTML wrapper page that displays a single full-page image, for both front- and back-cover pages. imgHref is document-relative (see relativeArchiveHref), not the package's baseDir. */
export function coverPageMarkup(title: string, sectionType: string, imgHref: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
<meta charset="UTF-8"/>
<title>${xmlEscapeAttr(title)}</title>
<style type="text/css">html,body{margin:0;padding:0;text-align:center;} img{max-width:100%;max-height:100%;}</style>
</head>
<body>
<section epub:type="${xmlEscapeAttr(sectionType)}">
<img src="${xmlEscapeAttr(imgHref)}" alt="${xmlEscapeAttr(title)}"/>
</section>
</body>
</html>
`;
}

/** Escapes text for use inside a double-quoted XML attribute or as element content. */
export function xmlEscapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

/** Returns candidate, or candidate with a numeric suffix inserted before its extension, whichever isn't already used by anything in e. */
export function uniqueArchivePath(e: Epub, candidate: string): string {
  if (!archiveIdInUse(e, candidate)) return candidate;
  const ext = extname(candidate);
  const base = candidate.slice(0, candidate.length - ext.length);
  for (let n = 2; ; n++) {
    const attempt = `${base}-${n}${ext}`;
    if (!archiveIdInUse(e, attempt)) return attempt;
  }
}

export async function handleEditCover(server: Server, args: EditCoverArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");

  let id = "";
  if (action === "create") {
    id = await resolveArg(server, args.id, "id", 'What archive path should the cover image be saved at (e.g. "OEBPS/images/cover.jpg")?');
  }

  let data = new Uint8Array(0);
  if (action !== "remove") {
    const sourcePath = await resolveArg(server, args.sourcePath, "sourcePath", "What is the filesystem path to the image file to use as the cover?");
    data = await readFile(sourcePath);
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  let result: EditCoverResult;
  switch (action) {
    case "create":
      result = createCover(e, pkg, id, data, args.mediaType ?? "");
      break;
    case "edit":
      result = editExistingCover(e, pkg, data, args.mediaType ?? "");
      break;
    case "remove":
      result = removeCover(e, pkg);
      break;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  epubCache.markDirty(abs);
  const summary = `${verbPast(action)}d cover ${JSON.stringify(result.id)} in ${JSON.stringify(abs)} (${result.sizeBytes} bytes). Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

function createCover(e: Epub, pkg: Package, id: string, data: Uint8Array, mediaType: string): EditCoverResult {
  const existing = findCoverItem(pkg);
  if (existing) throw new Error(`${JSON.stringify(pkg.id)} already has a cover image (${JSON.stringify(resolveHref(pkg, existing.href))}); use action "edit" instead`);
  if (archiveIdInUse(e, id)) throw new Error(`${JSON.stringify(id)} already exists in this book; use action "edit" instead`);
  const resolvedMediaType = mediaType || guessImageMediaType(id);

  const opfId = uniqueManifestId(pkg, manifestIdCandidate(id));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${opfId}`,
    href: relativeHref(pkg, id),
    mediaType: resolvedMediaType,
    properties: ["cover-image"],
    fallback: "",
    mediaOverlay: "",
  });
  e.resources[id] = { id, mediaType: resolvedMediaType, data };
  pkg.metadata.metas.push({
    id: `${pkg.metadata.id}/meta[${pkg.metadata.metas.length}]`,
    property: "",
    refines: "",
    scheme: "",
    value: opfId,
    name: "cover",
  });

  const pageId = uniqueArchivePath(e, `${pkg.baseDir}cover.xhtml`);
  e.contentDocuments[pageId] = {
    id: pageId,
    mediaType: "application/xhtml+xml",
    markup: coverPageMarkup("Cover", "cover", relativeArchiveHref(pageId, id)),
  };
  const pageOpfId = uniqueManifestId(pkg, manifestIdCandidate(pageId));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${pageOpfId}`,
    href: relativeHref(pkg, pageId),
    mediaType: "application/xhtml+xml",
    properties: [],
    fallback: "",
    mediaOverlay: "",
  });
  pkg.spine.itemRefs = insertAt(pkg.spine.itemRefs, 0, { id: "", idRef: pageOpfId, linear: true, properties: [] });
  renumberSpine(pkg);

  try {
    applyGuideEdit(pkg, "create", "cover", "Cover", pageId);
  } catch {
    // A pre-existing guide reference of type "cover" without a tracked
    // cover-image manifest item would be unusual; ignore the error rather
    // than fail cover creation over it, matching Go's own `_ = applyGuideEdit(...)`.
  }
  try {
    const nav = primaryNavigation(e, pkg);
    addLandmarkEntry(pkg, nav, "Cover", pageId, "cover");
  } catch {
    // No EPUB 3 navigation document to add a landmark to; best-effort, matching Go.
  }

  return { action: "create", id, mediaType: resolvedMediaType, sizeBytes: data.length };
}

function editExistingCover(e: Epub, pkg: Package, data: Uint8Array, mediaType: string): EditCoverResult {
  const item = findCoverItem(pkg);
  if (!item) throw new Error(`${JSON.stringify(pkg.id)} has no cover image; use action "create" instead`);
  const archivePath = resolveHref(pkg, item.href);
  const res = e.resources[archivePath];
  if (!res) throw new Error(`cover manifest item ${JSON.stringify(item.id)} resolves to ${JSON.stringify(archivePath)}, which isn't in resources`);

  res.data = data;
  if (mediaType) {
    res.mediaType = mediaType;
    item.mediaType = mediaType;
  }

  return { action: "edit", id: archivePath, mediaType: res.mediaType, sizeBytes: data.length };
}

function removeCover(e: Epub, pkg: Package): EditCoverResult {
  const item = findCoverItem(pkg);
  if (!item) throw new Error(`${JSON.stringify(pkg.id)} has no cover image`);
  const archivePath = resolveHref(pkg, item.href);
  const prefix = pkg.manifest.id + "/";
  const opfId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
  const sizeBytes = e.resources[archivePath]?.data.length ?? 0;

  pkg.manifest.items = removeMatching(pkg.manifest.items, (it) => it.id !== item.id);
  delete e.resources[archivePath];
  pkg.metadata.metas = removeMatching(pkg.metadata.metas, (meta) => !(meta.name === "cover" && meta.value === opfId));

  // The front-cover XHTML wrapper page (spine/manifest/landmark) that
  // createCover builds alongside the raw image is tracked via the guide
  // reference of type "cover" pointing at it; clean it up too, if present.
  if (pkg.guide) {
    let pageId = "";
    const keptRefs = pkg.guide.references.filter((r) => {
      if (r.type === "cover") {
        pageId = r.href;
        return false;
      }
      return true;
    });
    pkg.guide.references = keptRefs;
    if (pageId) removeCoverPage(e, pkg, pageId);
  }

  return { action: "remove", id: archivePath, sizeBytes };
}

/**
 * Deletes the cover wrapper page's content document, manifest item,
 * spine entry, and "landmarks" entry — everything createCover (or
 * createBackCover) builds around the raw image besides the image entry
 * itself, which the caller handles separately.
 */
export function removeCoverPage(e: Epub, pkg: Package, pageId: string): void {
  delete e.contentDocuments[pageId];
  const item = manifestItemByHref(pkg, pageId);
  if (item) {
    const prefix = pkg.manifest.id + "/";
    const opfId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
    pkg.manifest.items = removeMatching(pkg.manifest.items, (it) => it.id !== item.id);
    pkg.spine.itemRefs = removeMatching(pkg.spine.itemRefs, (ref) => ref.idRef !== opfId);
    renumberSpine(pkg);
  }

  let nav;
  try {
    nav = primaryNavigation(e, pkg);
  } catch {
    return;
  }
  for (const list of nav.lists) {
    if (list.type !== "landmarks") continue;
    const before = list.items.length;
    list.items = list.items.filter((p) => p.href !== pageId);
    if (list.items.length !== before) {
      // Landmark removal renumbers via the same helper edit_navigation
      // uses after any structural toc/landmarks change.
      renumberNavPointsForLandmarks(list.id, list.items);
    }
  }
}

// Local import alias to avoid a name collision with this file's own
// removeCoverPage while still calling the real renumberNavPoints from
// edit-navigation.ts.
import { renumberNavPoints as renumberNavPointsForLandmarks, bookTitle } from "./edit-navigation.ts";
import { renderNavigationDocument } from "../epub/render-nav.ts";
```

**A note on the `removeCoverPage` landmarks-removal ending, flagged explicitly for the implementer:** Go's version, after filtering the landmarks list and detecting a change, calls `epub.RenderNavigationDocument(nav, bookTitle(pkg))` to re-render the nav document's markup so the removed landmark disappears from the serialized XHTML too — the brief's draft above stops short of this (it renumbers but never re-renders). Fix this before shipping: after `renumberNavPointsForLandmarks(list.id, list.items)`, add `renderNavigationDocument(nav, bookTitle(pkg));` inside the same `if (list.items.length !== before)` block. Also move the two extra imports (`renumberNavPoints as renumberNavPointsForLandmarks`, `bookTitle`, `renderNavigationDocument`) up to the file's normal top-of-file import block — they were written as trailing imports above only to keep this brief's inline diff readable; TypeScript imports must appear at module top level, not after other statements. Verify `bun run typecheck` fails loudly if this ordering mistake ships as-is (imports after executable code are a syntax error in a module), which is itself a useful sanity check that this note was followed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/edit-cover.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/edit-cover.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/edit-cover.ts src/tools/edit-cover.test.ts src/index.ts
git commit -m "Add edit_cover tool"
```

---

### Task 3: `edit_back_cover` tool

**Files:**
- Create: `src/tools/edit-back-cover.ts`
- Test: `src/tools/edit-back-cover.test.ts`
- Modify: `src/index.ts` (add `import "./tools/edit-back-cover.ts";`)

**Interfaces:**
- Consumes: `epubCache`, `evictionNote`, `resolveArg`, `archiveIdInUse`/`manifestIdCandidate`/`uniqueManifestId`/`guessImageMediaType` (`./edit-resource.ts`), `renumberSpine` (`./edit-spine.ts` — note: unlike `edit_cover`, this tool APPENDS to the spine rather than inserting at index 0, so `insertAt`/`clampPosition` aren't needed here, only `renumberSpine`), `applyGuideEdit` (`./edit-guide.ts`), `primaryNavigation` (`./get-navigation.ts`), `addLandmarkEntry` (`./edit-navigation.ts`), `coverPageMarkup`/`xmlEscapeAttr`/`uniqueArchivePath`/`removeCoverPage` (`./edit-cover.ts`, this phase's Task 2), `primaryPackage`/`relativeArchiveHref`/`relativeHref`/`manifestItemByHref` (`../epub/resolve.ts`), `removeMatching`/`verbPast` (`./idlist.ts`).
- Produces: `editBackCoverTool`/`handleEditBackCover` (registered as `edit_back_cover`). No further exports consumed elsewhere — last tool in this phase's (and the project's originally-planned tool-category) dependency chain.

**A key structural difference from `edit_cover`, worth calling out explicitly:** the EPUB 3 spec reserves no manifest property for a back cover — Go's `createBackCover` adds the image as an ordinary manifest item (no `"cover-image"` property, no `meta name="cover"` pointer). What identifies "the" back cover instead is a guide reference of type `"other.back-cover"` pointing at the wrapper page, and `findBackCoverGuideRef`/`backCoverImageID` locate it by reading that guide reference and then parsing the `<img src="...">` back out of the wrapper page's own generated markup (since there's no manifest-property shortcut to the image the way `edit_cover` has). Port `backCoverImageID`'s literal-string-search approach faithfully — it is deliberately not a full XML parse, matching `coverPageMarkup`'s own deliberately-simple, predictable output shape.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/edit-back-cover.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleEditBackCover } from "./edit-back-cover.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string; sourcePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-back-cover-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Back Cover Test", "Author"), path);
  const sourcePath = join(dir, "backcover-source.jpg");
  await writeFile(sourcePath, "fake-back-cover-bytes");
  return { dir, path, sourcePath };
}

describe("edit_back_cover", () => {
  test("create adds an ordinary manifest item (no cover-image property), appends to the spine, and wires landmark/guide", async () => {
    const { dir, path, sourcePath } = await writeTempBook();

    const result = await handleEditBackCover(fakeServer, { action: "create", path, id: "images/backcover.jpg", sourcePath });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    const item = pkg.manifest.items.find((i) => i.href === "images/backcover.jpg");
    expect(item).toBeDefined();
    expect(item?.properties).toEqual([]); // no cover-image property, unlike the front cover

    // Wrapper page is the LAST spine entry (appended, not inserted at 0).
    const lastRef = pkg.spine.itemRefs[pkg.spine.itemRefs.length - 1]!;
    const pageItem = pkg.manifest.items.find((mi) => mi.id.endsWith("/" + lastRef.idRef));
    expect(pageItem?.mediaType).toBe("application/xhtml+xml");

    // No legacy meta name="cover" pointer for a back cover.
    expect(pkg.metadata.metas.some((m) => m.name === "cover")).toBe(false);

    const nav = cached.navigation["nav.xhtml"]!;
    const landmarks = nav.lists.find((l) => l.type === "landmarks");
    expect(landmarks?.items.some((p) => p.type === "afterword")).toBe(true);

    expect(pkg.guide?.references.some((r) => r.type === "other.back-cover")).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if the book already has a back cover", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await handleEditBackCover(fakeServer, { action: "create", path, id: "images/backcover.jpg", sourcePath });

    await expect(
      handleEditBackCover(fakeServer, { action: "create", path, id: "images/bc2.jpg", sourcePath }),
    ).rejects.toThrow("already has a back cover");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces the existing back cover's bytes, located via the guide reference and wrapper page's img src", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    const created = await handleEditBackCover(fakeServer, { action: "create", path, id: "images/backcover.jpg", sourcePath });
    const imageId = created.structuredContent?.id as string;

    const newSource = join(dir, "new-bc.png");
    await writeFile(newSource, "replacement-back-cover-bytes");
    const result = await handleEditBackCover(fakeServer, { action: "edit", path, sourcePath: newSource, mediaType: "image/png" });

    expect(result.structuredContent?.id).toBe(imageId);
    const cached = epubCache.get(resolve(path))!;
    const text = new TextDecoder().decode(cached.resources[imageId]!.data);
    expect(text).toBe("replacement-back-cover-bytes");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit fails if the book has no back cover yet", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await expect(handleEditBackCover(fakeServer, { action: "edit", path, sourcePath })).rejects.toThrow("has no back cover");
    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes the image, wrapper page, spine entry, landmark, and guide reference", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    const created = await handleEditBackCover(fakeServer, { action: "create", path, id: "images/backcover.jpg", sourcePath });
    const imageId = created.structuredContent?.id as string;

    const result = await handleEditBackCover(fakeServer, { action: "remove", path });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    expect(cached.resources[imageId]).toBeUndefined();
    expect(pkg.guide?.references.some((r) => r.type === "other.back-cover")).toBe(false);
    const nav = cached.navigation["nav.xhtml"]!;
    const landmarks = nav.lists.find((l) => l.type === "landmarks");
    expect(landmarks?.items.some((p) => p.type === "afterword")).toBe(false);
    expect(Object.keys(cached.contentDocuments)).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("remove fails if the book has no back cover", async () => {
    const { dir, path } = await writeTempBook();
    await expect(handleEditBackCover(fakeServer, { action: "remove", path })).rejects.toThrow("has no back cover");
    await rm(dir, { recursive: true, force: true });
  });

  test("front cover and back cover can coexist without interfering with each other", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    const { handleEditCover } = await import("./edit-cover.ts");
    await handleEditCover(fakeServer, { action: "create", path, id: "images/front.jpg", sourcePath });
    await handleEditBackCover(fakeServer, { action: "create", path, id: "images/back.jpg", sourcePath });

    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    // Front cover is first in the spine, back cover is last.
    const firstItem = pkg.manifest.items.find((mi) => mi.id.endsWith("/" + pkg.spine.itemRefs[0]!.idRef));
    const lastItem = pkg.manifest.items.find((mi) => mi.id.endsWith("/" + pkg.spine.itemRefs[pkg.spine.itemRefs.length - 1]!.idRef));
    expect(firstItem?.href).toContain("cover.xhtml");
    expect(lastItem?.href).toContain("backcover.xhtml");

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/edit-back-cover.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `src/tools/edit-back-cover.ts`**

```typescript
/**
 * edit_back_cover — create, edit, or remove the back cover image of an
 * already-read EPUB. Mirrors Go's tools/edit_back_cover.go.
 *
 * Unlike the front cover, the EPUB 3 spec reserves no manifest property
 * for a back cover — it's an ordinary image asset. What identifies it is
 * a guide reference of type "other.back-cover" pointing at its wrapper
 * page, plus the page's own <img src> (parsed back out of its generated
 * markup, since there's no manifest-property shortcut to the image).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { archiveIdInUse, guessImageMediaType, manifestIdCandidate, uniqueManifestId } from "./edit-resource.ts";
import { renumberSpine } from "./edit-spine.ts";
import { applyGuideEdit } from "./edit-guide.ts";
import { coverPageMarkup, removeCoverPage, uniqueArchivePath, xmlEscapeAttr } from "./edit-cover.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { primaryNavigation } from "./get-navigation.ts";
import { addLandmarkEntry } from "./edit-navigation.ts";
import { removeMatching, verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemByHref, primaryPackage, relativeArchiveHref, relativeHref } from "../epub/resolve.ts";
import type { Epub, GuideReference, Package } from "../epub/types.ts";

interface EditBackCoverArgs {
  action?: string;
  path?: string;
  id?: string;
  sourcePath?: string;
  mediaType?: string;
}

interface EditBackCoverResult {
  action: string;
  id?: string;
  mediaType?: string;
  sizeBytes?: number;
}

export const editBackCoverTool: EpubTool = {
  name: "edit_back_cover",
  description: "Create, edit, or remove the back cover image of an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a back cover image (fails if one exists), "edit" its bytes in place, or "remove" it' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: 'archive path for the new back cover image, e.g. "OEBPS/images/backcover.jpg"; used only by create — edit and remove always target the book\'s existing back cover' },
      sourcePath: { type: "string", description: "filesystem path to the image file to use as the back cover, read directly from disk (not sent through MCP); used by create and edit, ignored by remove" },
      mediaType: { type: "string", description: 'image media type, e.g. "image/jpeg"; guessed from id\'s extension if omitted on create' },
    },
  },
};

/** Returns pkg's guide reference of type "other.back-cover" — the marker createBackCover leaves behind to find its wrapper page again — or undefined if there is none. */
function findBackCoverGuideRef(pkg: Package): GuideReference | undefined {
  return pkg.guide?.references.find((r) => r.type === "other.back-cover");
}

export async function handleEditBackCover(server: Server, args: EditBackCoverArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");

  let id = "";
  if (action === "create") {
    id = await resolveArg(server, args.id, "id", 'What archive path should the back cover image be saved at (e.g. "OEBPS/images/backcover.jpg")?');
  }

  let data = new Uint8Array(0);
  if (action !== "remove") {
    const sourcePath = await resolveArg(server, args.sourcePath, "sourcePath", "What is the filesystem path to the image file to use as the back cover?");
    data = await readFile(sourcePath);
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  let result: EditBackCoverResult;
  switch (action) {
    case "create":
      result = createBackCover(e, pkg, id, data, args.mediaType ?? "");
      break;
    case "edit":
      result = editExistingBackCover(e, pkg, data, args.mediaType ?? "");
      break;
    case "remove":
      result = removeBackCover(e, pkg);
      break;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  epubCache.markDirty(abs);
  const summary = `${verbPast(action)}d back cover ${JSON.stringify(result.id)} in ${JSON.stringify(abs)} (${result.sizeBytes} bytes). Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

function createBackCover(e: Epub, pkg: Package, id: string, data: Uint8Array, mediaType: string): EditBackCoverResult {
  const existing = findBackCoverGuideRef(pkg);
  if (existing) throw new Error(`${JSON.stringify(pkg.id)} already has a back cover (${JSON.stringify(existing.href)}); use action "edit" instead`);
  if (archiveIdInUse(e, id)) throw new Error(`${JSON.stringify(id)} already exists in this book; use action "edit" instead`);
  const resolvedMediaType = mediaType || guessImageMediaType(id);

  // Deliberately no "cover-image" property and no cover meta pointer: per
  // the EPUB 3 spec, a back cover is an ordinary image asset, not a
  // structural cover.
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

  const pageId = uniqueArchivePath(e, `${pkg.baseDir}backcover.xhtml`);
  e.contentDocuments[pageId] = {
    id: pageId,
    mediaType: "application/xhtml+xml",
    markup: coverPageMarkup("Back Cover", "backmatter cover", relativeArchiveHref(pageId, id)),
  };
  const pageOpfId = uniqueManifestId(pkg, manifestIdCandidate(pageId));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${pageOpfId}`,
    href: relativeHref(pkg, pageId),
    mediaType: "application/xhtml+xml",
    properties: [],
    fallback: "",
    mediaOverlay: "",
  });
  // Appended (not inserted at a fixed index) so it lands after whatever
  // chapters/back-matter already exist — the very last entry, per spec.
  pkg.spine.itemRefs.push({ id: "", idRef: pageOpfId, linear: true, properties: [] });
  renumberSpine(pkg);

  try {
    applyGuideEdit(pkg, "create", "other.back-cover", "Back Cover", pageId);
  } catch {
    // Best-effort, matching Go's `_ = applyGuideEdit(...)`.
  }
  try {
    const nav = primaryNavigation(e, pkg);
    addLandmarkEntry(pkg, nav, "Back Cover", pageId, "afterword");
  } catch {
    // No EPUB 3 navigation document to add a landmark to; best-effort, matching Go.
  }

  return { action: "create", id, mediaType: resolvedMediaType, sizeBytes: data.length };
}

/**
 * Resolves the wrapper page at pageId back to the archive path of the
 * image it displays, by reading the <img src="..."> out of its generated
 * markup (see coverPageMarkup) and resolving that document-relative href
 * against pageId's own directory.
 */
function backCoverImageId(e: Epub, pageId: string): string {
  const doc = e.contentDocuments[pageId];
  if (!doc) throw new Error(`back cover guide reference points at ${JSON.stringify(pageId)}, which isn't a content document`);

  const marker = '<img src="';
  const i = doc.markup.indexOf(marker);
  if (i < 0) throw new Error(`back cover wrapper page ${JSON.stringify(pageId)} has no <img src=...> to resolve`);
  const rest = doc.markup.slice(i + marker.length);
  const j = rest.indexOf('"');
  if (j < 0) throw new Error(`back cover wrapper page ${JSON.stringify(pageId)} has a malformed <img src=...>`);
  const imgHref = rest
    .slice(0, j)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
  return resolveDocumentRelativeHref(pageId, imgHref);
}

/**
 * Resolves href (as written inside the content document at
 * fromArchivePath, e.g. an <img src>) against fromArchivePath's own
 * directory, returning the target's archive path — the inverse of
 * relativeArchiveHref.
 */
function resolveDocumentRelativeHref(fromArchivePath: string, href: string): string {
  const slash = fromArchivePath.lastIndexOf("/");
  const dir = slash === -1 ? "" : fromArchivePath.slice(0, slash);
  const joined = dir === "" ? href : `${dir}/${href}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function editExistingBackCover(e: Epub, pkg: Package, data: Uint8Array, mediaType: string): EditBackCoverResult {
  const ref = findBackCoverGuideRef(pkg);
  if (!ref) throw new Error(`${JSON.stringify(pkg.id)} has no back cover; use action "create" instead`);
  const imgId = backCoverImageId(e, ref.href);
  const res = e.resources[imgId];
  if (!res) throw new Error(`back cover wrapper page ${JSON.stringify(ref.href)} references ${JSON.stringify(imgId)}, which isn't in resources`);

  res.data = data;
  if (mediaType) {
    res.mediaType = mediaType;
    const item = manifestItemByHref(pkg, imgId);
    if (item) item.mediaType = mediaType;
  }

  return { action: "edit", id: imgId, mediaType: res.mediaType, sizeBytes: data.length };
}

function removeBackCover(e: Epub, pkg: Package): EditBackCoverResult {
  const ref = findBackCoverGuideRef(pkg);
  if (!ref) throw new Error(`${JSON.stringify(pkg.id)} has no back cover`);
  const pageId = ref.href;
  const imgId = backCoverImageId(e, pageId);

  const sizeBytes = e.resources[imgId]?.data.length ?? 0;
  const item = manifestItemByHref(pkg, imgId);
  if (item) pkg.manifest.items = removeMatching(pkg.manifest.items, (it) => it.id !== item.id);
  delete e.resources[imgId];

  if (pkg.guide) {
    pkg.guide.references = pkg.guide.references.filter((r) => r.type !== "other.back-cover");
  }

  removeCoverPage(e, pkg, pageId);

  return { action: "remove", id: imgId, sizeBytes };
}

registerTool(
  editBackCoverTool,
  'Takes action ("create", "edit", or "remove"), path, id, and sourcePath; any may be omitted to be ' +
    "prompted for (see edit_chapter's description for the general elicitation rules every edit_ tool " +
    "follows). sourcePath is a filesystem path to the image file to use as the back cover — it's read " +
    "directly from disk on the machine running this server, never sent through MCP as bytes.\n\n" +
    "Unlike edit_cover's front cover, the EPUB 3 spec reserves no manifest property for a back cover — to " +
    "the manifest it's just a regular image asset like any illustration, which is exactly how this tool " +
    'adds it (no "cover-image" property, no cover meta pointer). What identifies it as "the" back cover ' +
    "instead is spine position and a legacy guide reference this tool manages: create builds a minimal " +
    "XHTML wrapper page around the image, appends it as the very last entry in the spine (so it's only " +
    'reached if a linear read continues past the final chapter), tags it epub:type="afterword" in the ' +
    'navigation document\'s "landmarks" list, and records it via a guide reference of type ' +
    '"other.back-cover" — used to find it again on a later edit/remove. create only ever adds a back ' +
    "cover where none exists — it never updates one already there, so it fails outright if the book " +
    'already has one; use "edit" instead to replace its bytes.\n\naction "edit": replaces the existing ' +
    "back cover's bytes (and mediaType, if given) in place. id is ignored — there's only ever one back " +
    'cover, found automatically via the guide reference. The wrapper page, spine entry, landmark, and ' +
    'guide reference from create are left as they are. Fails if the book has no back cover yet (use ' +
    '"create" instead).\n\naction "remove": deletes the back cover image resource and its manifest entry, ' +
    'the wrapper page, its spine entry, its "landmarks" entry, and the guide reference of type ' +
    '"other.back-cover". id and sourcePath are ignored.\n\nAll three actions only touch the in-memory ' +
    "cache; call save_epub afterwards to persist.",
  handleEditBackCover as never,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/edit-back-cover.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

Add `import "./tools/edit-back-cover.ts";` alongside the existing tool imports.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/edit-back-cover.ts src/tools/edit-back-cover.test.ts src/index.ts
git commit -m "Add edit_back_cover tool"
```

---

## Definition of done

- `bun run typecheck` exits 0.
- `bun test` passes for every file under `src/`.
- `src/tools/` additionally contains `get-cover.ts`, `edit-cover.ts`, `edit-back-cover.ts`, each with a matching `*.test.ts`, each wired into `src/index.ts`.
- A manual smoke test (`tools/list` over stdio) lists 26 tools: the 23 from Phase 3-7 plus `get_cover`, `edit_cover`, `edit_back_cover`.
- **This is the last tool-category phase per the original design spec's dependency order.** With this phase complete, every tool in the original 27-tool design (get_context is the 27th, already done in Phase 3) is implemented. What remains is Phase 9: finalize — verification, and (optionally) an actual end-to-end run of `new_epub` → `convert_manuscript` → `save_epub` against a real manuscript file (e.g. the original `The Magic Hower.md` that motivated this entire project) to produce a real, working `.epub`.
