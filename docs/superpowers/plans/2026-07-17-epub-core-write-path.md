# EPUB Core — Write Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the write half of the Go `epub/` package (zip serialization, XHTML validation, plain-text extraction, navigation/NCX markup regeneration) to TypeScript, so an `Epub` built or edited in memory (via `newEpub`/`parseEpub` plus, in later phases, tool edits) can be persisted back to a real `.epub` file and read back correctly.

**Architecture:** Four new files under `src/epub/` — `runtime.ts` (a new shared module consolidating Bun/Deno portability helpers that Phase 1 duplicated across `parse.ts` and `cache.ts`), `write.ts` (`writeEpub`, regenerating container.xml/package documents from structured data while writing content documents/navigation/NCX/resources back verbatim), `validate.ts` (XHTML well-formedness check), `text.ts` (markup → plain text), `render-nav.ts` (regenerates a `Navigation`/`NCX`'s `markup` from its structured `lists`/`navMap` after an edit) — plus one `*.test.ts` per new file. This is **Phase 2** of the full port described in `docs/superpowers/specs/2026-07-17-full-tool-port-design.md`, building directly on Phase 1 (`docs/superpowers/plans/2026-07-17-epub-core-read-path.md`, already complete: `types.ts`, `resolve.ts`, `parse.ts`, `cache.ts`, `new-epub.ts`).

**Tech Stack:** TypeScript on Bun (bun:test), `fflate`'s `zipSync` for zip write, `@xmldom/xmldom`'s `DOMParser` for XHTML well-formedness checking. Both already installed and in use since Phase 1.

**Source of record:** `G:\_GoProjects\epub-novel-mcp-server\epub\{write,validate,text,render_nav}.go` — every task below is a direct translation of one of these files. Where Go's design doesn't map 1:1 onto TypeScript, the translation choice is called out explicitly in that task.

**Context from Phase 1's final review:** the whole-branch review that closed out Phase 1 flagged two follow-ups for this phase, both addressed here: (1) `readBinaryPortable` (in `parse.ts`) and `currentPlatform` (in `cache.ts`) are near-duplicate Bun/Deno detection snippets that should be consolidated once a third site (file *writing*) needs the same pattern — Task 1 does this. (2) The read path has zero test coverage for NCX/guide documents, since the Phase 1 fixture (`the-magic-hower.epub`) has neither — Tasks 2 and 5 close this gap with real write→read round-trip tests that exercise both.

## Global Constraints

- Every exported name and field mirrors the Go source's meaning, translated to camelCase, consistent with Phase 1's `types.ts`.
- `epub/` code never imports from `tools/` (one-way dependency).
- Portable across Bun and Deno: prefer Web-standard/runtime globals; `node:path`, `node:fs`, and `node:fs/promises` are fine — both runtimes implement them — but no npm package beyond the two already installed (`fflate`, `@xmldom/xmldom`) and no native/binary dependencies.
- All relative imports use explicit `.ts` extensions.
- `verbatimModuleSyntax` is on: import types with `import type { ... }`. When importing a type from `@xmldom/xmldom` (e.g. `Document`, `Element`, `Node`), import it explicitly by name — Phase 1's `parse.ts` (Task 5) hit a real bug where a bare `Document`/`Element` type annotation silently resolved to the ambient browser DOM lib instead of xmldom's actual type, because `tsconfig.json` doesn't restrict `lib`. An explicit `import type { Document } from "@xmldom/xmldom"` shadows the ambient global correctly.
- Tests use `bun:test` (`describe`/`test`/`expect`), matching Phase 1's style.
- Functions operating on `Epub`/`Package`/etc. take the data as a parameter (never a class method), consistent with Phase 1.

---

### Task 1: Shared Bun/Deno runtime helpers

**Files:**
- Create: `src/epub/runtime.ts`
- Test: `src/epub/runtime.test.ts`
- Modify: `src/epub/parse.ts` (remove its local `readBinaryPortable`, import from `runtime.ts`)
- Modify: `src/epub/cache.ts` (remove its local `currentPlatform`, import from `runtime.ts`)

**Interfaces:**
- Consumes: nothing new (this task extracts existing Phase 1 logic into a shared location).
- Produces: `readBinaryPortable(path: string): Promise<Uint8Array>`, `writeBinaryPortable(path: string, data: Uint8Array): Promise<void>`, `currentPlatform(): string` — all exported, consumed by `parse.ts` and `cache.ts` (refactored in this task) and by `write.ts` (Task 2).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentPlatform, readBinaryPortable, writeBinaryPortable } from "./runtime.ts";

describe("writeBinaryPortable / readBinaryPortable", () => {
  test("round-trips bytes through a real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-runtime-test-"));
    const path = join(dir, "data.bin");
    const original = new Uint8Array([1, 2, 3, 4, 250, 251, 252]);

    await writeBinaryPortable(path, original);
    const readBack = await readBinaryPortable(path);

    expect(Array.from(readBack)).toEqual(Array.from(original));
    await rm(dir, { recursive: true, force: true });
  });

  test("overwrites an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-runtime-test-"));
    const path = join(dir, "data.bin");

    await writeBinaryPortable(path, new Uint8Array([1, 1, 1]));
    await writeBinaryPortable(path, new Uint8Array([2, 2]));
    const readBack = await readBinaryPortable(path);

    expect(Array.from(readBack)).toEqual([2, 2]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("currentPlatform", () => {
  test("returns process.platform under Bun", () => {
    expect(currentPlatform()).toBe(process.platform);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/runtime.test.ts`
Expected: FAIL — `error: Cannot find module './runtime.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Bun/Deno portability helpers shared across the epub/ package. Nothing
 * else in this package should reimplement runtime detection locally —
 * Phase 1 briefly had two near-identical copies of this pattern
 * (parse.ts's file read, cache.ts's platform check) before this file
 * consolidated them.
 */

/** Reads a file's bytes in a way that works under Bun and Deno. */
export async function readBinaryPortable(path: string): Promise<Uint8Array> {
  if (typeof Bun !== "undefined") {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  }
  const deno = (globalThis as Record<string, unknown>).Deno as
    | { readFile(path: string): Promise<Uint8Array> }
    | undefined;
  if (deno) return await deno.readFile(path);
  throw new Error("Unsupported runtime — requires Bun or Deno.");
}

/** Writes a file's bytes in a way that works under Bun and Deno, creating or overwriting it. */
export async function writeBinaryPortable(path: string, data: Uint8Array): Promise<void> {
  if (typeof Bun !== "undefined") {
    await Bun.write(path, data);
    return;
  }
  const deno = (globalThis as Record<string, unknown>).Deno as
    | { writeFile(path: string, data: Uint8Array): Promise<void> }
    | undefined;
  if (deno) {
    await deno.writeFile(path, data);
    return;
  }
  throw new Error("Unsupported runtime — requires Bun or Deno.");
}

/** The running platform, spelled the way each runtime reports it ("win32"/"windows", "darwin", "linux", ...). */
export function currentPlatform(): string {
  if (typeof Bun !== "undefined") return process.platform; // "win32" | "darwin" | "linux" | ...
  const deno = (globalThis as Record<string, unknown>).Deno as { build?: { os?: string } } | undefined;
  return deno?.build?.os ?? "linux"; // Deno spells it "windows", not "win32"
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/runtime.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Refactor `parse.ts` to use the shared helper**

In `src/epub/parse.ts`, replace this block (currently lines 1-31):

```typescript
import { DOMParser, onErrorStopParsing, type Document, type Element } from "@xmldom/xmldom";
import { unzipSync } from "fflate";
import { resolveHref } from "./resolve.ts";
import type {
  ArchiveId,
  ContentDocument,
  Epub,
  Guide,
  Manifest,
  Metadata,
  NavList,
  NavPoint,
  Navigation,
  NCX,
  NCXNavPoint,
  Package,
  Resource,
  Spine,
} from "./types.ts";

/** Reads a file's bytes in a way that works under Bun and Deno. */
async function readBinaryPortable(path: string): Promise<Uint8Array> {
  if (typeof Bun !== "undefined") {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  }
  const deno = (globalThis as Record<string, unknown>).Deno as
    | { readFile(path: string): Promise<Uint8Array> }
    | undefined;
  if (deno) return await deno.readFile(path);
  throw new Error("Unsupported runtime — requires Bun or Deno.");
}
```

with:

```typescript
import { DOMParser, onErrorStopParsing, type Document, type Element } from "@xmldom/xmldom";
import { unzipSync } from "fflate";
import { readBinaryPortable } from "./runtime.ts";
import { resolveHref } from "./resolve.ts";
import type {
  ArchiveId,
  ContentDocument,
  Epub,
  Guide,
  Manifest,
  Metadata,
  NavList,
  NavPoint,
  Navigation,
  NCX,
  NCXNavPoint,
  Package,
  Resource,
  Spine,
} from "./types.ts";
```

(i.e., delete the local `readBinaryPortable` function definition entirely and add the import line. The rest of `parse.ts`, which calls `readBinaryPortable(filename)` inside `parseEpub`, is unchanged — it now resolves to the imported function.)

- [ ] **Step 6: Refactor `cache.ts` to use the shared helper**

In `src/epub/cache.ts`, replace this block (currently lines 1-12):

```typescript
import { realpathSync } from "node:fs";
import { parseEpub } from "./parse.ts";
import type { Epub } from "./types.ts";

/** Number of parsed EPUBs a Cache holds by default. */
export const DEFAULT_CACHE_SIZE = 4;

function currentPlatform(): string {
  if (typeof Bun !== "undefined") return process.platform; // "win32" | "darwin" | "linux" | ...
  const deno = (globalThis as Record<string, unknown>).Deno as { build?: { os?: string } } | undefined;
  return deno?.build?.os ?? "linux"; // Deno spells it "windows", not "win32"
}
```

with:

```typescript
import { realpathSync } from "node:fs";
import { currentPlatform } from "./runtime.ts";
import { parseEpub } from "./parse.ts";
import type { Epub } from "./types.ts";

/** Number of parsed EPUBs a Cache holds by default. */
export const DEFAULT_CACHE_SIZE = 4;
```

(i.e., delete the local `currentPlatform` function definition entirely and add the import line. The rest of `cache.ts`, which calls `currentPlatform()` inside `canonicalPath`, is unchanged.)

- [ ] **Step 7: Run the full suite to confirm the refactor didn't change behavior**

Run: `bun test && bun run typecheck`
Expected: every test file passes (Phase 1's 46 tests plus this task's 3 new ones = 49), typecheck exits 0. No test assertions should have needed to change — this step is a pure extraction, not a behavior change.

- [ ] **Step 8: Commit**

```bash
git add src/epub/runtime.ts src/epub/runtime.test.ts src/epub/parse.ts src/epub/cache.ts
git commit -m "Extract shared Bun/Deno runtime helpers (runtime.ts)"
```

---

### Task 2: EPUB archive writer

**Files:**
- Create: `src/epub/write.ts`
- Test: `src/epub/write.test.ts`

**Interfaces:**
- Consumes: `ArchiveId`, `Container`, `Epub`, `Guide`, `Manifest`, `Meta`, `Metadata`, `Package`, `Spine` (type-only) from `./types.ts`; `writeBinaryPortable` from `./runtime.ts` (Task 1); `zipSync`, `Zippable` from `fflate`.
- Produces: `writeEpub(e: Epub, filename: string): Promise<void>`, `escXML(s: string): string`, `idFragmentKey(id: ArchiveId): [key: string, isRealId: boolean]` — all exported. `writeEpub` is consumed by tool tasks from Phase 4 onward (`save_epub`, `new_epub`, etc.). `escXML` and `idFragmentKey` are also consumed by `render-nav.ts` (Task 5), mirroring Go's `write.go` being the single definition site both `write.go` and `render_nav.go` share (same package there).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newEpub } from "./new-epub.ts";
import { parseEpub } from "./parse.ts";
import { primaryPackage } from "./resolve.ts";
import { writeEpub } from "./write.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "testdata", "the-magic-hower.epub");

describe("writeEpub", () => {
  test("round-trips a real, messy EPUB with one edited chapter", async () => {
    const original = await parseEpub(fixturePath);

    const chapterId = "OEBPS/text/chapter-03.xhtml";
    const newMarkup =
      '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Edited &amp; tested</p></body></html>';
    original.contentDocuments[chapterId]!.markup = newMarkup;

    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "edited.epub");
    await writeEpub(original, out);

    const reparsed = await parseEpub(out);

    expect(Object.keys(reparsed.packages)).toHaveLength(Object.keys(original.packages).length);
    expect(Object.keys(reparsed.contentDocuments)).toHaveLength(Object.keys(original.contentDocuments).length);
    expect(reparsed.contentDocuments[chapterId]?.markup).toBe(newMarkup);

    const untouchedId = "OEBPS/text/chapter-04.xhtml";
    expect(reparsed.contentDocuments[untouchedId]?.markup).toBe(original.contentDocuments[untouchedId]?.markup);

    const origPkg = primaryPackage(original)!;
    const newPkg = primaryPackage(reparsed)!;
    expect(newPkg.metadata.titles[0]?.value).toBe(origPkg.metadata.titles[0]?.value);
    expect(newPkg.metadata.creators[1]?.name).toBe(origPkg.metadata.creators[1]?.name);
    expect(newPkg.spine.itemRefs).toHaveLength(origPkg.spine.itemRefs.length);
    expect(newPkg.manifest.items).toHaveLength(origPkg.manifest.items.length);

    await rm(dir, { recursive: true, force: true });
  });

  test("writes mimetype as the first, uncompressed archive entry", async () => {
    const e = newEpub("Mimetype Test", "Author");
    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);

    const raw = await Bun.file(out).arrayBuffer();
    const bytes = new Uint8Array(raw);
    const asLatin1 = Array.from(bytes.slice(0, 80))
      .map((b) => String.fromCharCode(b))
      .join("");

    // A stored (uncompressed) entry has its content readable verbatim in
    // the raw archive bytes, right after its local file header + filename.
    expect(asLatin1).toContain("mimetype");
    expect(asLatin1).toContain("application/epub+zip");

    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips a package's guide", async () => {
    const e = newEpub("Guide Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.guide = {
      id: `${pkg.id}#guide`,
      references: [
        { id: `${pkg.id}#guide/reference[cover]`, type: "cover", title: "Cover", href: "cover.xhtml" },
        { id: `${pkg.id}#guide/reference[toc]`, type: "toc", title: "", href: "nav.xhtml" },
      ],
    };

    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);
    const reparsed = await parseEpub(out);

    const reparsedPkg = primaryPackage(reparsed)!;
    expect(reparsedPkg.guide?.references).toHaveLength(2);
    expect(reparsedPkg.guide?.references[0]).toMatchObject({ type: "cover", title: "Cover", href: "cover.xhtml" });
    expect(reparsedPkg.guide?.references[1]).toMatchObject({ type: "toc", href: "nav.xhtml" });

    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips an NCX document's structure", async () => {
    const e = newEpub("NCX Test", "Author");
    const pkg = primaryPackage(e)!;

    const ncxMarkup = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="test-uid"/>
  </head>
  <docTitle><text>NCX Test</text></docTitle>
  <navMap>
    <navPoint id="chapter-1" playOrder="1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="nav.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
`;
    e.nCXs["toc.ncx"] = { id: "toc.ncx", markup: ncxMarkup, navMap: [] };
    pkg.manifest.items.push({
      id: `${pkg.manifest.id}/ncx`,
      href: "toc.ncx",
      mediaType: "application/x-dtbncx+xml",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    pkg.spine.tocRef = "ncx";

    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);
    const reparsed = await parseEpub(out);

    const ncx = reparsed.nCXs["toc.ncx"];
    expect(ncx).toBeDefined();
    expect(ncx!.navMap).toHaveLength(1);
    expect(ncx!.navMap[0]).toMatchObject({ label: "Chapter 1", src: "nav.xhtml", playOrder: 1 });

    await rm(dir, { recursive: true, force: true });
  });

  test("escapes special characters in rendered metadata", async () => {
    const e = newEpub('Title with <tags> & "quotes"', "Author & Co.");
    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);
    const reparsed = await parseEpub(out);

    const pkg = primaryPackage(reparsed)!;
    expect(pkg.metadata.titles[0]?.value).toBe('Title with <tags> & "quotes"');
    expect(pkg.metadata.creators[0]?.name).toBe("Author & Co.");

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/write.test.ts`
Expected: FAIL — `error: Cannot find module './write.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
import { zipSync, type Zippable } from "fflate";
import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeBinaryPortable } from "./runtime.ts";
import type { ArchiveId, Container, Epub, Guide, Manifest, Meta, Metadata, Package, Spine } from "./types.ts";

/** Escapes s for safe use as either XML element text or an attribute value. */
export function escXML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Extracts the trailing "[...]" token from a fragment id built by parse.ts's
 * fragId, and reports whether it's a real xml:id (recovered so it can be
 * written back out) as opposed to fragId's positional-index fallback. XML
 * NCName ids can't start with a digit, so an all-digit key is unambiguously
 * a synthetic index, not a real id.
 */
export function idFragmentKey(id: ArchiveId): [key: string, isRealId: boolean] {
  const i = id.lastIndexOf("[");
  const j = id.lastIndexOf("]");
  if (i < 0 || j < 0 || j < i) return ["", false];
  const key = id.slice(i + 1, j);
  if (key === "") return ["", false];
  for (const ch of key) {
    if (ch < "0" || ch > "9") return [key, true];
  }
  return [key, false];
}

/**
 * Serializes e as a .epub file at filename. container.xml and every package
 * document are regenerated from the in-memory metadata, manifest, and spine
 * (so edits to those are reflected); every content document, navigation
 * document, NCX, and other resource is written back using its stored raw
 * markup/data verbatim.
 *
 * Builds the archive bytes fully in memory, then writes to a temp file in
 * filename's directory and renames it into place only once fully written,
 * so a failure partway through never corrupts an existing file at filename.
 */
export async function writeEpub(e: Epub, filename: string): Promise<void> {
  const bytes = buildArchive(e);

  const dir = dirname(filename);
  const tmpPath = join(dir, `.epub-tmp-${crypto.randomUUID()}`);
  try {
    await writeBinaryPortable(tmpPath, bytes);
    await rename(tmpPath, filename);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function buildArchive(e: Epub): Uint8Array {
  const mimetype = e.mimetype || "application/epub+zip";
  const files: Zippable = {
    mimetype: [new TextEncoder().encode(mimetype), { level: 0 }],
  };

  files["META-INF/container.xml"] = renderContainer(e.container);

  for (const rf of e.container.rootfiles) {
    const pkg = e.packages[rf.fullPath];
    if (!pkg) continue;
    files[rf.fullPath] = renderPackage(pkg);
  }

  for (const [path, doc] of Object.entries(e.contentDocuments)) {
    files[path] = new TextEncoder().encode(doc.markup);
  }
  for (const [path, nav] of Object.entries(e.navigation)) {
    files[path] = new TextEncoder().encode(nav.markup);
  }
  for (const [path, ncx] of Object.entries(e.nCXs)) {
    files[path] = new TextEncoder().encode(ncx.markup);
  }
  for (const [path, res] of Object.entries(e.resources)) {
    files[path] = res.data;
  }

  return zipSync(files);
}

function renderContainer(c: Container): Uint8Array {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<container version="${escXML(c.version)}" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">`,
    `  <rootfiles>`,
    ...c.rootfiles.map(
      (rf) => `    <rootfile full-path="${escXML(rf.fullPath)}" media-type="${escXML(rf.mediaType)}"/>`,
    ),
    `  </rootfiles>`,
    `</container>`,
  ];
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

function renderPackage(pkg: Package): Uint8Array {
  let b = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  b += `<package xmlns="http://www.idpf.org/2007/opf" version="${escXML(pkg.version)}"`;
  if (pkg.uniqueIdentifierRef) b += ` unique-identifier="${escXML(pkg.uniqueIdentifierRef)}"`;
  if (pkg.lang) b += ` xml:lang="${escXML(pkg.lang)}"`;
  b += `>\n`;

  b += `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n`;
  b += renderMetadata(pkg.metadata);
  b += `  </metadata>\n`;

  b += `  <manifest>\n`;
  b += renderManifest(pkg.manifest);
  b += `  </manifest>\n`;

  b += `  <spine`;
  if (pkg.spine.tocRef) b += ` toc="${escXML(pkg.spine.tocRef)}"`;
  if (pkg.spine.pageProgressionDirection) b += ` page-progression-direction="${escXML(pkg.spine.pageProgressionDirection)}"`;
  b += `>\n`;
  b += renderSpine(pkg.spine);
  b += `  </spine>\n`;

  if (pkg.guide) {
    b += `  <guide>\n`;
    b += renderGuide(pkg.guide);
    b += `  </guide>\n`;
  }

  b += `</package>\n`;
  return new TextEncoder().encode(b);
}

function writeIdElem(tag: string, id: ArchiveId, value: string, attrs: Array<[string, string]> = []): string {
  let s = `    <${tag}`;
  const [key, isRealId] = idFragmentKey(id);
  if (isRealId) s += ` id="${escXML(key)}"`;
  for (const [name, val] of attrs) {
    if (val === "") continue;
    s += ` ${name}="${escXML(val)}"`;
  }
  s += `>${escXML(value)}</${tag}>\n`;
  return s;
}

function renderMetadata(m: Metadata): string {
  let s = "";
  for (const v of m.identifiers) s += writeIdElem("dc:identifier", v.id, v.value, [["opf:scheme", v.scheme]]);
  for (const v of m.titles) s += writeIdElem("dc:title", v.id, v.value, [["xml:lang", v.lang]]);
  for (const v of m.languages) s += writeIdElem("dc:language", v.id, v.value);
  for (const v of m.creators) {
    s += writeIdElem("dc:creator", v.id, v.name, [
      ["opf:role", v.role],
      ["opf:file-as", v.fileAs],
      ["xml:lang", v.lang],
    ]);
  }
  for (const v of m.contributors) {
    s += writeIdElem("dc:contributor", v.id, v.name, [
      ["opf:role", v.role],
      ["opf:file-as", v.fileAs],
      ["xml:lang", v.lang],
    ]);
  }
  for (const v of m.publishers) s += `    <dc:publisher>${escXML(v)}</dc:publisher>\n`;
  for (const v of m.dates) s += writeIdElem("dc:date", v.id, v.value, [["opf:event", v.event]]);
  for (const v of m.subjects) {
    s += writeIdElem("dc:subject", v.id, v.value, [
      ["opf:authority", v.scheme],
      ["opf:term", v.code],
    ]);
  }
  if (m.description) s += `    <dc:description>${escXML(m.description)}</dc:description>\n`;
  if (m.rights) s += `    <dc:rights>${escXML(m.rights)}</dc:rights>\n`;
  for (const v of m.metas) s += writeMetaElem(v);
  return s;
}

function writeMetaElem(m: Meta): string {
  let s = `    <meta`;
  const [key, isRealId] = idFragmentKey(m.id);
  if (isRealId) s += ` id="${escXML(key)}"`;
  if (m.name) {
    s += ` name="${escXML(m.name)}" content="${escXML(m.value)}"/>\n`;
    return s;
  }
  if (m.property) s += ` property="${escXML(m.property)}"`;
  if (m.refines) s += ` refines="${escXML(m.refines)}"`;
  if (m.scheme) s += ` scheme="${escXML(m.scheme)}"`;
  s += `>${escXML(m.value)}</meta>\n`;
  return s;
}

function renderManifest(man: Manifest): string {
  const prefix = man.id + "/";
  let s = "";
  for (const item of man.items) {
    const id = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
    s += `    <item id="${escXML(id)}" href="${escXML(item.href)}" media-type="${escXML(item.mediaType)}"`;
    if (item.properties.length > 0) s += ` properties="${escXML(item.properties.join(" "))}"`;
    if (item.fallback) s += ` fallback="${escXML(item.fallback)}"`;
    if (item.mediaOverlay) s += ` media-overlay="${escXML(item.mediaOverlay)}"`;
    s += `/>\n`;
  }
  return s;
}

function renderSpine(sp: Spine): string {
  let s = "";
  for (const ref of sp.itemRefs) {
    s += `    <itemref idref="${escXML(ref.idRef)}"`;
    if (!ref.linear) s += ` linear="no"`;
    if (ref.properties.length > 0) s += ` properties="${escXML(ref.properties.join(" "))}"`;
    s += `/>\n`;
  }
  return s;
}

function renderGuide(g: Guide): string {
  let s = "";
  for (const r of g.references) {
    s += `    <reference type="${escXML(r.type)}"`;
    if (r.title) s += ` title="${escXML(r.title)}"`;
    s += ` href="${escXML(r.href)}"/>\n`;
  }
  return s;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/write.test.ts`
Expected: PASS, all 5 tests green. If the NCX round-trip test fails on the `playOrder` assertion specifically, check `src/epub/parse.ts`'s `buildNCXNavPoints` — Phase 1's final review flagged that its `parseInt`-based parsing is more lenient than Go's `strconv.Atoi` for malformed values, but `playOrder="1"` here is well-formed and should parse cleanly regardless; a failure here would point at something else.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/epub/write.ts src/epub/write.test.ts
git commit -m "Add EPUB zip writer (write.ts)"
```

---

### Task 3: XHTML well-formedness validator

**Files:**
- Create: `src/epub/validate.ts`
- Test: `src/epub/validate.test.ts`

**Interfaces:**
- Consumes: `DOMParser`, `onErrorStopParsing` from `@xmldom/xmldom`.
- Produces: `validateXHTML(markup: string): void` (throws on malformed markup), `autoCloseVoidElements(markup: string): string` — both exported. `validateXHTML` will be consumed by `edit_chapter`/`convert_manuscript` in Phase 5 to reject malformed chapter content before it's stored. `autoCloseVoidElements` is also consumed by `text.ts` (Task 4).

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/validate.test.ts`
Expected: FAIL — `error: Cannot find module './validate.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";

/**
 * HTML5 void elements Go's xml.HTMLAutoClose tolerates without a closing
 * slash (e.g. <br> rather than <br/>). @xmldom/xmldom has no equivalent
 * auto-close option, so markup is preprocessed to self-close these before
 * parsing. This operates on the raw text, not a tokenizer, so it can be
 * confused by a ">" inside one of these elements' own attribute values —
 * rare in practice for the attributes void elements typically carry
 * (src, alt, href, ...).
 */
const VOID_ELEMENTS = [
  "area",
  "base",
  "br",
  "col",
  "command",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
];
const voidElementPattern = new RegExp(`<(${VOID_ELEMENTS.join("|")})((?:\\s+[^<>]*)?)(?<!/)>`, "gi");

/** Self-closes any of VOID_ELEMENTS not already written with a trailing "/>". */
export function autoCloseVoidElements(markup: string): string {
  return markup.replace(voidElementPattern, "<$1$2/>");
}

const strictParser = new DOMParser({ onError: onErrorStopParsing });

/**
 * Throws if markup is not well-formed XML. Tolerates HTML named entities
 * (&mdash;) and unclosed void elements (<br>) the way real XHTML content
 * documents use them, but genuine structural breakage (unterminated tags,
 * stray & or <) still throws.
 */
export function validateXHTML(markup: string): void {
  const doc = strictParser.parseFromString(autoCloseVoidElements(markup), "application/xhtml+xml");
  if (!doc.documentElement) {
    throw new Error("no root element");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/validate.test.ts`
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/epub/validate.ts src/epub/validate.test.ts
git commit -m "Add XHTML well-formedness validator (validate.ts)"
```

---

### Task 4: Plain-text extraction

**Files:**
- Create: `src/epub/text.ts`
- Test: `src/epub/text.test.ts`

**Interfaces:**
- Consumes: `autoCloseVoidElements` from `./validate.ts` (Task 3); `DOMParser`, and explicit `Node`/`Element` type imports, from `@xmldom/xmldom`.
- Produces: `plainText(markup: string): string` — the sole export, consumed by `get_chapter` in Phase 5.

- [ ] **Step 1: Write the failing tests**

```typescript
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/text.test.ts`
Expected: FAIL — `error: Cannot find module './text.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
import { DOMParser, type Element, type Node } from "@xmldom/xmldom";
import { autoCloseVoidElements } from "./validate.ts";

/** XHTML tags whose boundaries become line breaks when flattening markup to plain text. */
const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "section",
  "article",
  "tr",
]);

// No onError override: unlike validate.ts's strict parser, this one never
// throws on a recoverable error (only a truly fatal one), matching Go's
// PlainText running its xml.Decoder with Strict = false. The no-op callback
// (rather than the default, which console.errors) keeps test/tool output
// pristine.
const lenientParser = new DOMParser({ onError: () => {} });

function localName(tagName: string): string {
  const i = tagName.indexOf(":");
  return i === -1 ? tagName : tagName.slice(i + 1);
}

function collectRawText(node: Node, out: string[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      // TEXT_NODE
      out.push(child.nodeValue ?? "");
    } else if (child.nodeType === 1) {
      // ELEMENT_NODE
      const el = child as Element;
      const isBlock = BLOCK_ELEMENTS.has(localName(el.tagName));
      if (isBlock) out.push("\n");
      collectRawText(el, out);
      if (isBlock) out.push("\n");
    }
  }
}

/**
 * Extracts the readable text from an XHTML content document's markup: tags
 * and attributes are discarded, and line breaks are inserted at block-level
 * element boundaries so paragraphs remain separated.
 */
export function plainText(markup: string): string {
  const doc = lenientParser.parseFromString(autoCloseVoidElements(markup), "application/xhtml+xml");
  const root = doc.documentElement;
  if (!root) return "";

  const parts: string[] = [];
  collectRawText(root, parts);
  const raw = parts.join("");

  const paragraphs: string[] = [];
  for (const line of raw.split("\n")) {
    const collapsed = line.split(/\s+/).filter(Boolean).join(" ");
    if (collapsed !== "") paragraphs.push(collapsed);
  }
  return paragraphs.join("\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/text.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/epub/text.ts src/epub/text.test.ts
git commit -m "Add XHTML-to-plain-text extraction (text.ts)"
```

---

### Task 5: Navigation and NCX markup rendering

**Files:**
- Create: `src/epub/render-nav.ts`
- Test: `src/epub/render-nav.test.ts`

**Interfaces:**
- Consumes: `escXML`, `idFragmentKey` from `./write.ts` (Task 2); `NavPoint`, `Navigation`, `NCX`, `NCXNavPoint` (type-only) from `./types.ts`; `writeEpub` from `./write.ts` and `parseEpub` from `./parse.ts` (test-only, for the end-to-end round trip); `newEpub` from `./new-epub.ts` and `primaryPackage` from `./resolve.ts` (test-only).
- Produces: `renderNavigationDocument(nav: Navigation, docTitle: string): void`, `renderNCXDocument(ncx: NCX, docTitle: string, uid: string): void` — both exported, mutating their first argument in place (consistent with Go's pointer-receiver mutation — since TS interfaces are plain objects passed by reference, direct field assignment achieves the same effect with no special wrapper needed). Consumed by `edit_chapter`/`edit_navigation`/`convert_manuscript` in Phase 5+ whenever a tool changes `Navigation.lists` or `NCX.navMap` and needs `markup` regenerated to match before `save_epub` (Task 2's `writeEpub`) writes it out verbatim.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEpub } from "./new-epub.ts";
import { parseEpub } from "./parse.ts";
import { renderNavigationDocument, renderNCXDocument } from "./render-nav.ts";
import { primaryPackage } from "./resolve.ts";
import type { NCX, Navigation } from "./types.ts";
import { writeEpub } from "./write.ts";

describe("renderNavigationDocument", () => {
  test("regenerates markup from structured lists, including nested items", () => {
    const nav: Navigation = {
      id: "nav.xhtml",
      mediaType: "application/xhtml+xml",
      markup: "",
      lists: [
        {
          id: "nav.xhtml#toc",
          type: "toc",
          heading: "Contents",
          items: [
            {
              id: "nav.xhtml#toc/item[0]",
              label: "Chapter 1",
              href: "chapter1.xhtml",
              type: "",
              children: [
                {
                  id: "nav.xhtml#toc/item[0]/item[0]",
                  label: "Section 1.1",
                  href: "chapter1.xhtml#s1",
                  type: "",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };

    renderNavigationDocument(nav, "Table of Contents");

    expect(nav.markup).toContain("<title>Table of Contents</title>");
    expect(nav.markup).toContain('epub:type="toc"');
    expect(nav.markup).toContain("<h1>Contents</h1>");
    expect(nav.markup).toContain('<a href="chapter1.xhtml">Chapter 1</a>');
    expect(nav.markup).toContain('<a href="chapter1.xhtml#s1">Section 1.1</a>');
  });

  test("escapes special characters in headings and labels", () => {
    const nav: Navigation = {
      id: "nav.xhtml",
      mediaType: "application/xhtml+xml",
      markup: "",
      lists: [
        {
          id: "nav.xhtml#toc",
          type: "toc",
          heading: "A & B",
          items: [{ id: "nav.xhtml#toc/item[0]", label: '<Ch. 1> "intro"', href: "c1.xhtml", type: "", children: [] }],
        },
      ],
    };

    renderNavigationDocument(nav, "Contents");

    expect(nav.markup).toContain("<h1>A &amp; B</h1>");
    expect(nav.markup).toContain("&lt;Ch. 1&gt; &quot;intro&quot;");
  });
});

describe("renderNCXDocument", () => {
  test("regenerates markup and renumbers playOrder sequentially", () => {
    const ncx: NCX = {
      id: "toc.ncx",
      markup: "",
      navMap: [
        {
          id: "toc.ncx#chap1",
          playOrder: 0,
          label: "Chapter 1",
          src: "chapter1.xhtml",
          children: [{ id: "toc.ncx#chap1sec1", playOrder: 0, label: "Section 1.1", src: "chapter1.xhtml#s1", children: [] }],
        },
        { id: "toc.ncx#chap2", playOrder: 0, label: "Chapter 2", src: "chapter2.xhtml", children: [] },
      ],
    };

    renderNCXDocument(ncx, "My Book", "test-uid-123");

    expect(ncx.markup).toContain('<meta name="dtb:uid" content="test-uid-123"/>');
    expect(ncx.markup).toContain("<docTitle><text>My Book</text></docTitle>");
    expect(ncx.navMap[0]!.playOrder).toBe(1);
    expect(ncx.navMap[0]!.children[0]!.playOrder).toBe(2);
    expect(ncx.navMap[1]!.playOrder).toBe(3);
  });
});

describe("navigation and NCX round-trip through a real write/parse cycle", () => {
  test("a rendered nav and NCX survive writeEpub -> parseEpub with structure intact", async () => {
    const e = newEpub("Round Trip Book", "Author");
    const pkg = primaryPackage(e)!;

    const nav = e.navigation["nav.xhtml"]!;
    nav.lists = [
      {
        id: "nav.xhtml#toc",
        type: "toc",
        heading: "Contents",
        items: [
          { id: "nav.xhtml#toc/item[0]", label: "Chapter One", href: "chapter1.xhtml", type: "", children: [] },
          { id: "nav.xhtml#toc/item[1]", label: "Chapter Two", href: "chapter2.xhtml", type: "", children: [] },
        ],
      },
    ];
    renderNavigationDocument(nav, "Table of Contents");

    const ncx: NCX = {
      id: "toc.ncx",
      markup: "",
      navMap: [
        { id: "toc.ncx#chap1", playOrder: 0, label: "Chapter One", src: "chapter1.xhtml", children: [] },
        { id: "toc.ncx#chap2", playOrder: 0, label: "Chapter Two", src: "chapter2.xhtml", children: [] },
      ],
    };
    renderNCXDocument(ncx, "Round Trip Book", "round-trip-uid");
    e.nCXs["toc.ncx"] = ncx;
    pkg.manifest.items.push({
      id: `${pkg.manifest.id}/ncx`,
      href: "toc.ncx",
      mediaType: "application/x-dtbncx+xml",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    pkg.spine.tocRef = "ncx";

    const dir = await mkdtemp(join(tmpdir(), "epub-render-nav-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);
    const reparsed = await parseEpub(out);

    const reparsedNav = reparsed.navigation["nav.xhtml"];
    expect(reparsedNav?.lists[0]?.heading).toBe("Contents");
    expect(reparsedNav?.lists[0]?.items).toHaveLength(2);
    expect(reparsedNav?.lists[0]?.items[0]).toMatchObject({ label: "Chapter One", href: "chapter1.xhtml" });
    expect(reparsedNav?.lists[0]?.items[1]).toMatchObject({ label: "Chapter Two", href: "chapter2.xhtml" });

    const reparsedNcx = reparsed.nCXs["toc.ncx"];
    expect(reparsedNcx?.navMap).toHaveLength(2);
    expect(reparsedNcx?.navMap[0]).toMatchObject({ label: "Chapter One", src: "chapter1.xhtml", playOrder: 1 });
    expect(reparsedNcx?.navMap[1]).toMatchObject({ label: "Chapter Two", src: "chapter2.xhtml", playOrder: 2 });

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/render-nav.test.ts`
Expected: FAIL — `error: Cannot find module './render-nav.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { NavPoint, Navigation, NCX, NCXNavPoint } from "./types.ts";
import { escXML, idFragmentKey } from "./write.ts";

/**
 * Regenerates nav.markup from nav.lists, using docTitle as the XHTML
 * <title>. Callers that mutate Navigation.lists must call this afterwards
 * — unlike the package document, writeEpub serializes a Navigation's markup
 * verbatim, so structured edits are invisible on disk until the markup is
 * regenerated to match.
 */
export function renderNavigationDocument(nav: Navigation, docTitle: string): void {
  let b = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  b += `<!DOCTYPE html>\n`;
  b += `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2009/ops" lang="en">\n`;
  b += `<head>\n  <meta charset="UTF-8"/>\n`;
  b += `  <title>${escXML(docTitle)}</title>\n`;
  b += `</head>\n<body>\n`;

  for (const list of nav.lists) {
    b += `  <nav`;
    if (list.type) b += ` epub:type="${escXML(list.type)}"`;
    const [key, isRealId] = idFragmentKey(list.id);
    if (isRealId) b += ` id="${escXML(key)}"`;
    b += `>\n`;
    if (list.heading) b += `    <h1>${escXML(list.heading)}</h1>\n`;
    b += `    <ol>\n`;
    b += renderNavPoints(list.items, 3);
    b += `    </ol>\n`;
    b += `  </nav>\n`;
  }

  b += `</body>\n</html>\n`;
  nav.markup = b;
}

function renderNavPoints(points: NavPoint[], indent: number): string {
  const pad = "  ".repeat(indent);
  let s = "";
  for (const p of points) {
    s += pad + `<li`;
    const [key, isRealId] = idFragmentKey(p.id);
    if (isRealId) s += ` id="${escXML(key)}"`;
    s += `>`;
    const typeAttr = p.type ? ` epub:type="${escXML(p.type)}"` : "";
    if (p.href) {
      s += `<a${typeAttr} href="${escXML(p.href)}">${escXML(p.label)}</a>`;
    } else {
      s += `<span${typeAttr}>${escXML(p.label)}</span>`;
    }
    if (p.children.length > 0) {
      s += "\n" + pad + "  <ol>\n";
      s += renderNavPoints(p.children, indent + 2);
      s += pad + "  </ol>\n" + pad;
    }
    s += "</li>\n";
  }
  return s;
}

/**
 * Regenerates ncx.markup from ncx.navMap, using docTitle and uid (the
 * book's unique identifier) for the required <docTitle> and dtb:uid meta.
 * Play order is renumbered sequentially in document order, mutating each
 * point's playOrder field. Like renderNavigationDocument, callers that
 * mutate NCX.navMap must call this afterwards since writeEpub serializes
 * markup verbatim.
 */
export function renderNCXDocument(ncx: NCX, docTitle: string, uid: string): void {
  let b = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  b += `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n`;
  b += `  <head>\n`;
  b += `    <meta name="dtb:uid" content="${escXML(uid)}"/>\n`;
  b += `  </head>\n`;
  b += `  <docTitle><text>${escXML(docTitle)}</text></docTitle>\n`;
  b += `  <navMap>\n`;
  const order = { value: 1 };
  b += renderNCXNavPoints(ncx.navMap, 2, order);
  b += `  </navMap>\n`;
  b += `</ncx>\n`;
  ncx.markup = b;
}

function renderNCXNavPoints(points: NCXNavPoint[], indent: number, order: { value: number }): string {
  const pad = "  ".repeat(indent);
  let s = "";
  for (const p of points) {
    let [id, isRealId] = idFragmentKey(p.id);
    if (!isRealId || id === "") id = `navpoint-${order.value}`;
    p.playOrder = order.value;
    s += `${pad}<navPoint id="${escXML(id)}" playOrder="${p.playOrder}">\n`;
    order.value++;
    s += `${pad}  <navLabel><text>${escXML(p.label)}</text></navLabel>\n`;
    s += `${pad}  <content src="${escXML(p.src)}"/>\n`;
    if (p.children.length > 0) {
      s += renderNCXNavPoints(p.children, indent + 1, order);
    }
    s += `${pad}</navPoint>\n`;
  }
  return s;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/render-nav.test.ts`
Expected: PASS, all 4 tests green (the last one exercises a real `writeEpub`/`parseEpub` round trip through a temp file).

- [ ] **Step 5: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file in `src/` passes (Phase 1's 46 + Task 1's 3 + Task 2's 5 + Task 3's 9 + Task 4's 8 + this task's 4 = 75).

- [ ] **Step 6: Commit**

```bash
git add src/epub/render-nav.ts src/epub/render-nav.test.ts
git commit -m "Add navigation/NCX markup rendering (render-nav.ts)"
```

---

## Definition of done

- `bun run typecheck` exits 0.
- `bun test` passes for every file under `src/`.
- `src/epub/` additionally contains `runtime.ts`, `write.ts`, `validate.ts`, `text.ts`, `render-nav.ts`, each with a matching `*.test.ts`; `parse.ts` and `cache.ts` have been refactored to use `runtime.ts` with no behavior change.
- A real `.epub` file can be parsed, edited in memory, written back out, and re-parsed with edits intact and untouched content byte-identical (Task 2).
- A book's guide and NCX table of contents — previously untested in Phase 1 — round-trip correctly through write/parse (Tasks 2 and 5), closing the coverage gap the Phase 1 final review flagged.
- `newEpub()` → `writeEpub()` → `parseEpub()` produces a valid, readable EPUB 3 file end-to-end.
- Phase 3 (tool infrastructure: registry, elicitation, eviction notices) and Phase 4 (lifecycle tools: `new_epub`, `read_epub`, `save_epub`, ...) can begin — they depend only on what Phases 1 and 2 produce.
