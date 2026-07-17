# EPUB Core — Read Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the read half of the Go `epub/` package (data model, href resolution, zip/XML parsing, bounded LRU cache, empty-EPUB constructor) to TypeScript, so later phases have a working in-memory representation of a real `.epub` file to build tools on.

**Architecture:** Five new files under `src/epub/` — `types.ts` (data model), `resolve.ts` (href<->archive-path helpers), `parse.ts` (zip -> in-memory model via `fflate` + `@xmldom/xmldom`), `cache.ts` (bounded LRU `path -> Epub` cache), `new-epub.ts` (minimal valid EPUB 3 skeleton) — plus one `*.test.ts` per file and a real sample `.epub` fixture. This is **Phase 1** of the full port described in `docs/superpowers/specs/2026-07-17-full-tool-port-design.md`; write path (`write.ts`, `validate.ts`, `text.ts`, `render-nav.ts`) is Phase 2, a separate plan.

**Tech Stack:** TypeScript on Bun (bun:test), `fflate` for zip read, `@xmldom/xmldom` for XML DOM parsing. Both already installed (`package.json` dependencies).

**Source of record:** `G:\_GoProjects\epub-novel-mcp-server\epub\{epub,resolve,parse,cache,new_epub}.go` — every task below is a direct translation of one of these files. Where Go's design doesn't map 1:1 onto TypeScript (methods on structs, multi-value returns, Go's `ID` type), the translation choice is called out explicitly in that task.

## Global Constraints

- Every exported name and field mirrors the Go source's meaning, translated to camelCase (Go's `Epub.ID` -> TS `Epub.id`, `Package.BaseDir` -> `Package.baseDir`, etc.).
- `type ArchiveId = string` replaces Go's `type ID string` locator type.
- Go pointer fields (`*Guide`) become optional TS fields (`guide?: Guide`); Go slices become arrays; Go's `map[string]*T` becomes `Record<string, T>`.
- `epub/` code never imports from `tools/` (one-way dependency, per the spec).
- Portable across Bun and Deno: prefer Web-standard/runtime globals (`fetch`, `crypto`, `TextEncoder`/`TextDecoder`) where available. `node:path` and `node:fs` are fine — both runtimes implement them natively — but no npm package beyond the two already installed (`fflate`, `@xmldom/xmldom`) and no native/binary dependencies.
- All relative imports use explicit `.ts` extensions (`tsconfig.json` has `allowImportingTsExtensions: true`; the existing `src/index.ts` already does this).
- `verbatimModuleSyntax` is on: import types with `import type { ... }`.
- Go methods on `*Package`/`*Epub` (e.g. `func (p *Package) ResolveHref(...)`) become plain exported functions taking the receiver as the first argument (`resolveHref(pkg, href)`), since the TS data model is plain interfaces, not classes.
- Tests use `bun:test` (`describe`/`test`/`expect`), matching `src/tools/get-context.test.ts`'s existing style.

---

### Task 1: Confirm zip/XML dependencies

**Files:**
- Modify: `package.json` (verify only — dependencies already present)

**Interfaces:**
- Consumes: nothing.
- Produces: `fflate` (`unzipSync`) and `@xmldom/xmldom` (`DOMParser`, `onErrorStopParsing`) importable from any new file under `src/epub/`.

- [ ] **Step 1: Verify the dependencies are installed**

Run: `cat package.json`
Expected: `dependencies` includes `"@xmldom/xmldom": "^0.9.10"` and `"fflate": "^0.8.3"` alongside the existing `"@modelcontextprotocol/sdk"`. If either is missing, run `bun add @xmldom/xmldom fflate` to add it.

- [ ] **Step 2: Confirm the existing suite still passes with the deps present**

Run: `bun test`
Expected: PASS (the two existing test files, `check-update.test.ts` and `get-context.test.ts`, both green — this step just establishes a clean baseline before new code lands).

- [ ] **Step 3: Commit (only if package.json/bun.lock changed)**

```bash
git add package.json bun.lock
git commit -m "Add fflate and @xmldom/xmldom for EPUB zip/XML handling"
```

If Step 1 found the dependencies already present and `git status` shows no changes, skip this commit — there's nothing to record.

---

### Task 2: Core data model

**Files:**
- Create: `src/epub/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every interface below, all exported, for every later task to import.

- [ ] **Step 1: Write the data model**

```typescript
/**
 * The in-memory EPUB data model, mirroring the OCF/OPF layers defined by
 * the EPUB 3.3 specification (https://www.w3.org/TR/epub-33/). Nothing in
 * this file touches disk or XML — it's the plain-data shape parse.ts fills
 * in and write.ts serializes back out.
 *
 * Every interface carries an `id` that doubles as a locator: an
 * archive-relative path ("OEBPS/chapter1.xhtml") for whole-file entries,
 * or that path plus a "#fragment" built from the identifying reference the
 * EPUB/OPF spec already defines for that node (a manifest item's own id, a
 * spine itemref's idref, ...) for data that lives inside a file.
 */

/** Locates a piece of EPUB data as it would appear on disk. The root Epub itself uses "". */
export type ArchiveId = string;

export interface Epub {
  id: ArchiveId; // always ""
  /** The literal contents of the required OCF "mimetype" entry, always "application/epub+zip". */
  mimetype: string;
  container: Container;
  /** Every package document (rendition), keyed by archive path. Most EPUBs have exactly one. */
  packages: Record<string, Package>;
  /** Every EPUB 3 navigation document (manifest item with properties="nav"), keyed by archive path. */
  navigation: Record<string, Navigation>;
  /** Every legacy EPUB 2 NCX table of contents, keyed by archive path. */
  nCXs: Record<string, NCX>;
  /** Every XHTML content document — the chapter/section text — keyed by archive path. */
  contentDocuments: Record<string, ContentDocument>;
  /** Every other manifest resource (stylesheets, images, fonts, ...), keyed by archive path. */
  resources: Record<string, Resource>;
}

/** The parsed META-INF/container.xml: locates every rootfile (package document) in the archive. */
export interface Container {
  id: ArchiveId; // "META-INF/container.xml"
  version: string;
  rootfiles: Rootfile[];
}

/** One <rootfile> entry in container.xml, pointing at a package document elsewhere in the archive. */
export interface Rootfile {
  id: ArchiveId;
  /** Archive-relative path to the package document, e.g. "OEBPS/content.opf". Keys Epub.packages. */
  fullPath: string;
  mediaType: string;
}

/** A parsed OPF package document: metadata, manifest of resources, and reading order. */
export interface Package {
  id: ArchiveId; // archive path of the package document
  /** Directory portion of id (e.g. "OEBPS/") that every ManifestItem's href resolves against. */
  baseDir: string;
  version: string;
  /** package/@unique-identifier: an IDREF naming the canonical entry in metadata.identifiers. */
  uniqueIdentifierRef: string;
  lang: string;
  metadata: Metadata;
  manifest: Manifest;
  spine: Spine;
  /** The legacy EPUB 2 <guide> element, kept for backward-compatibility. Absent if the doc has none. */
  guide?: Guide;
}

/** The OPF <metadata> element: Dublin Core and EPUB-specific descriptive metadata. */
export interface Metadata {
  id: ArchiveId;
  identifiers: Identifier[];
  titles: Title[];
  languages: Language[];
  creators: Contributor[];
  contributors: Contributor[];
  publishers: string[];
  dates: EpubDate[];
  subjects: Subject[];
  description: string;
  rights: string;
  /** Catch-all for <meta> elements not modeled above (dcterms:modified, cover ref, series, ...). */
  metas: Meta[];
}

export interface Identifier {
  id: ArchiveId;
  /** opf:scheme (or identifier-type refine), e.g. "ISBN", "UUID". Empty if unspecified. */
  scheme: string;
  value: string;
}

export interface Title {
  id: ArchiveId;
  value: string;
  /** title-type refine property, e.g. "main", "subtitle". Empty if unspecified (implies "main"). */
  type: string;
  lang: string;
}

export interface Language {
  id: ArchiveId;
  value: string;
}

/** A dc:creator or dc:contributor element (author, translator, illustrator, ...). */
export interface Contributor {
  id: ArchiveId;
  name: string;
  /** MARC relator code (e.g. "aut", "trl"), from the role refine or legacy opf:role attribute. */
  role: string;
  /** Sort-friendly form of name, from the file-as refine or legacy opf:file-as attribute. */
  fileAs: string;
  lang: string;
}

export interface EpubDate {
  id: ArchiveId;
  /** ISO 8601 string, as stored in the document. */
  value: string;
  /** dcterms event refine property (e.g. "publication", "modification"). Empty if unspecified. */
  event: string;
}

export interface Subject {
  id: ArchiveId;
  value: string;
  /** Subject authority (authority refine or opf:authority attribute), e.g. "BISAC". */
  scheme: string;
  /** Authority-specific term code (term refine or opf:term attribute). */
  code: string;
}

/** A generic OPF <meta> element: either the EPUB 3 property/refines form or legacy name/content form. */
export interface Meta {
  id: ArchiveId;
  /** meta/@property, e.g. "belongs-to-collection", "dcterms:modified". Empty for legacy metas. */
  property: string;
  /** meta/@refines IDREF (e.g. "#bookid") naming the element this meta describes. */
  refines: string;
  scheme: string;
  value: string;
  /** Legacy EPUB 2 meta/@name attribute (e.g. "calibre:series"). Empty for EPUB 3 property-form metas. */
  name: string;
}

/** The OPF <manifest> element: the exhaustive list of every file that belongs to the rendition. */
export interface Manifest {
  id: ArchiveId;
  items: ManifestItem[];
}

/** One <item> in the manifest, describing a single file in the archive. */
export interface ManifestItem {
  /** "<manifest id>/<opf:id>", reusing the item's own required id attribute. */
  id: ArchiveId;
  /** Path relative to the owning Package's baseDir. Resolve via resolveHref() to get the archive path. */
  href: string;
  mediaType: string;
  /** Manifest properties, e.g. "nav", "cover-image", "scripted", "svg", "mathml", "remote-resources". */
  properties: string[];
  /** IDREF to another manifest item to use as a fallback. Empty if absent. */
  fallback: string;
  /** IDREF to this item's SMIL media overlay (narrated audio sync). Empty if absent. */
  mediaOverlay: string;
}

/** The OPF <spine> element: the default linear reading order. */
export interface Spine {
  id: ArchiveId;
  /** Legacy spine/@toc attribute: an IDREF to the manifest item for the EPUB 2 NCX. */
  tocRef: string;
  /** spine/@page-progression-direction ("ltr", "rtl", or "" for unspecified). */
  pageProgressionDirection: string;
  itemRefs: SpineItemRef[];
}

/** One <itemref> in the spine, placing one manifest item into the reading order. */
export interface SpineItemRef {
  id: ArchiveId;
  /** The manifest item this entry places into the reading order. */
  idRef: string;
  /** False only when explicitly marked linear="no". Defaults to true. */
  linear: boolean;
  /** Itemref properties, e.g. "page-spread-left", "page-spread-right". */
  properties: string[];
}

/** The legacy EPUB 2 <guide> element, superseded by EPUB 3 navigation landmarks. */
export interface Guide {
  id: ArchiveId;
  references: GuideReference[];
}

/** One <reference> in the guide, e.g. pointing at the cover page or table of contents. */
export interface GuideReference {
  id: ArchiveId;
  /** e.g. "cover", "toc", "text". */
  type: string;
  title: string;
  /** Target, relative to the owning Package's baseDir, as an archive path plus optional "#fragment". */
  href: string;
}

/** An EPUB 3 navigation document: table of contents, landmarks, and (optionally) a page list. */
export interface Navigation {
  /** The navigation document's archive path, e.g. "OEBPS/nav.xhtml". */
  id: ArchiveId;
  mediaType: string;
  /** Raw serialized XHTML, kept for full-fidelity editing alongside the structured lists below. */
  markup: string;
  /** Every <nav> element in the document: toc, landmarks, page-list, or any custom epub:type nav. */
  lists: NavList[];
}

/** One <nav> element within a Navigation document. */
export interface NavList {
  id: ArchiveId; // "<navigation id>#<type>"
  /** The nav's epub:type (e.g. "toc", "landmarks", "page-list") or, absent that, its own xml:id. */
  type: string;
  /** The nav's heading text (h1-h6 child), if present. */
  heading: string;
  items: NavPoint[];
}

/** One <li> entry in a Navigation NavList, possibly with nested children forming a sub-list. */
export interface NavPoint {
  id: ArchiveId;
  label: string;
  /** Target: an archive path plus optional "#fragment". Empty for a heading-only entry. */
  href: string;
  /** The entry's own epub:type attribute, distinct from the NavList's type. */
  type: string;
  children: NavPoint[];
}

/** A legacy EPUB 2 "toc.ncx" table of contents, kept for reading systems predating EPUB 3 nav. */
export interface NCX {
  /** Archive path, e.g. "OEBPS/toc.ncx". */
  id: ArchiveId;
  markup: string;
  navMap: NCXNavPoint[];
}

/** One <navPoint> in an NCX's navMap, possibly nested. */
export interface NCXNavPoint {
  id: ArchiveId;
  playOrder: number;
  label: string;
  /** Target: an archive path plus optional "#fragment". */
  src: string;
  children: NCXNavPoint[];
}

/** One XHTML content document: a chapter, front-matter page, or other section of the novel's text. */
export interface ContentDocument {
  /** The document's archive path, e.g. "OEBPS/chapter1.xhtml". */
  id: ArchiveId;
  mediaType: string;
  /** Raw serialized XHTML content. */
  markup: string;
}

/** Any manifest file not modeled as a Package, Navigation, NCX, or ContentDocument. */
export interface Resource {
  /** The resource's archive path, e.g. "OEBPS/styles/main.css" or "OEBPS/images/cover.jpg". */
  id: ArchiveId;
  mediaType: string;
  /** Raw bytes (text resources such as CSS are simply valid UTF-8 in this array). */
  data: Uint8Array;
}
```

- [ ] **Step 2: Typecheck**

Types have no runtime behavior to unit-test — the correct verification here is that the file compiles cleanly and every interface is structurally sound, which `tsc --noEmit` checks directly.

Run: `bun run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/epub/types.ts
git commit -m "Add EPUB in-memory data model (types.ts)"
```

---

### Task 3: Href resolution helpers

**Files:**
- Create: `src/epub/resolve.ts`
- Test: `src/epub/resolve.test.ts`

**Interfaces:**
- Consumes: `Epub`, `Package`, `ManifestItem` (type-only) from `./types.ts` (Task 2).
- Produces: `relativeArchiveHref`, `resolveHref`, `relativeHref`, `manifestItemByHref`, `primaryPackage`, `manifestItemById`, `navItem`, `ncxItem` — all exported, all consumed by `parse.ts` (Task 5) and every tool task in later phases.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import {
  relativeArchiveHref,
  resolveHref,
  relativeHref,
  manifestItemByHref,
  primaryPackage,
  manifestItemById,
  navItem,
  ncxItem,
} from "./resolve.ts";
import type { Epub, Package } from "./types.ts";

function emptyPackage(baseDir: string): Package {
  return {
    id: `${baseDir}content.opf`,
    baseDir,
    version: "3.0",
    uniqueIdentifierRef: "uid",
    lang: "en",
    metadata: {
      id: "meta",
      identifiers: [],
      titles: [],
      languages: [],
      creators: [],
      contributors: [],
      publishers: [],
      dates: [],
      subjects: [],
      description: "",
      rights: "",
      metas: [],
    },
    manifest: { id: "manifest", items: [] },
    spine: { id: "spine", tocRef: "", pageProgressionDirection: "", itemRefs: [] },
  };
}

describe("relativeArchiveHref", () => {
  test("same directory", () => {
    expect(relativeArchiveHref("OEBPS/chapter1.xhtml", "OEBPS/chapter2.xhtml")).toBe("chapter2.xhtml");
  });

  test("target in a subdirectory", () => {
    expect(relativeArchiveHref("OEBPS/chapter1.xhtml", "OEBPS/images/cover.jpg")).toBe("images/cover.jpg");
  });

  test("target requires walking up a directory", () => {
    expect(relativeArchiveHref("OEBPS/text/chapter1.xhtml", "OEBPS/styles/style.css")).toBe(
      "../styles/style.css",
    );
  });

  test("source at archive root", () => {
    expect(relativeArchiveHref("nav.xhtml", "OEBPS/chapter1.xhtml")).toBe("OEBPS/chapter1.xhtml");
  });
});

describe("resolveHref", () => {
  test("resolves against baseDir", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(resolveHref(pkg, "chapter1.xhtml")).toBe("OEBPS/chapter1.xhtml");
  });

  test("strips a fragment", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(resolveHref(pkg, "chapter1.xhtml#section2")).toBe("OEBPS/chapter1.xhtml");
  });

  test("empty baseDir resolves relative to archive root", () => {
    const pkg = emptyPackage("");
    expect(resolveHref(pkg, "chapter1.xhtml")).toBe("chapter1.xhtml");
  });

  test("empty href returns empty string", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(resolveHref(pkg, "")).toBe("");
  });

  test("cleans a relative path", () => {
    const pkg = emptyPackage("OEBPS/text/");
    expect(resolveHref(pkg, "../images/cover.jpg")).toBe("OEBPS/images/cover.jpg");
  });
});

describe("relativeHref", () => {
  test("strips baseDir prefix", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(relativeHref(pkg, "OEBPS/chapter1.xhtml")).toBe("chapter1.xhtml");
  });

  test("returns unchanged if archivePath doesn't fall under baseDir", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(relativeHref(pkg, "META-INF/container.xml")).toBe("META-INF/container.xml");
  });
});

describe("manifestItemByHref", () => {
  test("finds the item whose resolved href matches", () => {
    const pkg = emptyPackage("OEBPS/");
    pkg.manifest.items.push({
      id: "manifest/chap1",
      href: "chapter1.xhtml",
      mediaType: "application/xhtml+xml",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    expect(manifestItemByHref(pkg, "OEBPS/chapter1.xhtml")?.id).toBe("manifest/chap1");
  });

  test("returns undefined when no item matches", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(manifestItemByHref(pkg, "OEBPS/missing.xhtml")).toBeUndefined();
  });
});

describe("primaryPackage", () => {
  test("returns the package for the first rootfile", () => {
    const pkg = emptyPackage("");
    const e: Epub = {
      id: "",
      mimetype: "application/epub+zip",
      container: {
        id: "META-INF/container.xml",
        version: "1.0",
        rootfiles: [{ id: "r0", fullPath: "content.opf", mediaType: "application/oebps-package+xml" }],
      },
      packages: { "content.opf": pkg },
      navigation: {},
      nCXs: {},
      contentDocuments: {},
      resources: {},
    };
    expect(primaryPackage(e)).toBe(pkg);
  });

  test("returns undefined when there are no rootfiles", () => {
    const e: Epub = {
      id: "",
      mimetype: "application/epub+zip",
      container: { id: "META-INF/container.xml", version: "1.0", rootfiles: [] },
      packages: {},
      navigation: {},
      nCXs: {},
      contentDocuments: {},
      resources: {},
    };
    expect(primaryPackage(e)).toBeUndefined();
  });
});

describe("manifestItemById", () => {
  test("finds the item whose id ends with /<id>", () => {
    const pkg = emptyPackage("");
    pkg.manifest.items.push({
      id: "content.opf#manifest/nav",
      href: "nav.xhtml",
      mediaType: "application/xhtml+xml",
      properties: ["nav"],
      fallback: "",
      mediaOverlay: "",
    });
    expect(manifestItemById(pkg, "nav")?.href).toBe("nav.xhtml");
  });

  test("returns undefined for an empty id", () => {
    const pkg = emptyPackage("");
    expect(manifestItemById(pkg, "")).toBeUndefined();
  });
});

describe("navItem", () => {
  test("finds the item with a nav property", () => {
    const pkg = emptyPackage("");
    pkg.manifest.items.push({
      id: "content.opf#manifest/style",
      href: "style.css",
      mediaType: "text/css",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    pkg.manifest.items.push({
      id: "content.opf#manifest/nav",
      href: "nav.xhtml",
      mediaType: "application/xhtml+xml",
      properties: ["nav"],
      fallback: "",
      mediaOverlay: "",
    });
    expect(navItem(pkg)?.href).toBe("nav.xhtml");
  });

  test("returns undefined when no item is marked nav", () => {
    const pkg = emptyPackage("");
    expect(navItem(pkg)).toBeUndefined();
  });
});

describe("ncxItem", () => {
  test("finds the item referenced by spine.tocRef", () => {
    const pkg = emptyPackage("");
    pkg.spine.tocRef = "ncx";
    pkg.manifest.items.push({
      id: "content.opf#manifest/ncx",
      href: "toc.ncx",
      mediaType: "application/x-dtbncx+xml",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    expect(ncxItem(pkg)?.href).toBe("toc.ncx");
  });

  test("falls back to media-type search when tocRef is unset", () => {
    const pkg = emptyPackage("");
    pkg.manifest.items.push({
      id: "content.opf#manifest/ncx",
      href: "toc.ncx",
      mediaType: "application/x-dtbncx+xml",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    expect(ncxItem(pkg)?.href).toBe("toc.ncx");
  });

  test("returns undefined when there is no NCX", () => {
    const pkg = emptyPackage("");
    expect(ncxItem(pkg)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/resolve.test.ts`
Expected: FAIL — `error: Cannot find module './resolve.ts'` (or similar), since `resolve.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
import { posix } from "node:path";
import type { Epub, ManifestItem, Package } from "./types.ts";

/**
 * Returns the href, relative to the directory containing fromArchivePath,
 * that reaches toArchivePath — both full archive paths (always
 * "/"-separated). Unlike resolveHref/relativeHref (which are relative to
 * a package document's baseDir, the convention this module's own href
 * fields use), this is genuine document-relative resolution: the kind an
 * <img src="..."> or <a href="..."> written inside one content document
 * needs to reach another archive member, wherever each one lives.
 */
export function relativeArchiveHref(fromArchivePath: string, toArchivePath: string): string {
  const slash = fromArchivePath.lastIndexOf("/");
  const fromDir = slash === -1 ? "" : fromArchivePath.slice(0, slash);
  const fromParts = fromDir ? fromDir.split("/") : [];
  const toParts = toArchivePath.split("/");

  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) i++;

  const rel = "../".repeat(fromParts.length - i) + toParts.slice(i).join("/");
  return rel === "" ? toParts[toParts.length - 1] : rel;
}

/**
 * Turns an href as stored in a ManifestItem, SpineItemRef, GuideReference,
 * or nav/NCX target (relative to pkg.baseDir, possibly carrying a
 * "#fragment") into the archive path used to key Epub.resources,
 * Epub.contentDocuments, Epub.navigation, and Epub.nCXs.
 */
export function resolveHref(pkg: Package, href: string): string {
  const hashIndex = href.indexOf("#");
  const h = hashIndex === -1 ? href : href.slice(0, hashIndex);
  if (h === "") return "";
  const joined = pkg.baseDir ? pkg.baseDir + h : h;
  return posix.normalize(joined);
}

/**
 * The inverse of resolveHref: turns an archive path back into an href
 * relative to pkg.baseDir, suitable for a new ManifestItem's href. If
 * archivePath doesn't fall under baseDir, it's returned unchanged.
 */
export function relativeHref(pkg: Package, archivePath: string): string {
  if (pkg.baseDir && archivePath.startsWith(pkg.baseDir)) {
    return archivePath.slice(pkg.baseDir.length);
  }
  return archivePath;
}

/** Returns the manifest item whose href resolves to archivePath, or undefined if there is none. */
export function manifestItemByHref(pkg: Package, archivePath: string): ManifestItem | undefined {
  return pkg.manifest.items.find((item) => resolveHref(pkg, item.href) === archivePath);
}

/**
 * Returns the Package for the first rootfile listed in the container, or
 * undefined if e has none. Most EPUBs have exactly one rendition; this is
 * the one tools operate on unless told otherwise.
 */
export function primaryPackage(e: Epub): Package | undefined {
  if (e.container.rootfiles.length === 0) return undefined;
  return e.packages[e.container.rootfiles[0].fullPath];
}

/**
 * Returns the manifest item whose own opf:id attribute equals id — the
 * same id a SpineItemRef.idRef, ManifestItem.fallback, or Spine.tocRef
 * would reference — or undefined if there is none.
 */
export function manifestItemById(pkg: Package, id: string): ManifestItem | undefined {
  if (!id) return undefined;
  const suffix = "/" + id;
  return pkg.manifest.items.find((item) => item.id.endsWith(suffix));
}

/** Returns the manifest item marked as the EPUB 3 navigation document (properties="nav"). */
export function navItem(pkg: Package): ManifestItem | undefined {
  return pkg.manifest.items.find((item) => item.properties.includes("nav"));
}

/**
 * Returns the manifest item for the legacy EPUB 2 NCX, found via the
 * spine's toc attribute, falling back to a media-type search for
 * producers that omit it. Returns undefined if the rendition has no NCX.
 */
export function ncxItem(pkg: Package): ManifestItem | undefined {
  const byTocRef = manifestItemById(pkg, pkg.spine.tocRef);
  if (byTocRef) return byTocRef;
  return pkg.manifest.items.find((item) => item.mediaType === "application/x-dtbncx+xml");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/resolve.test.ts`
Expected: PASS, all 15 tests green.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/epub/resolve.ts src/epub/resolve.test.ts
git commit -m "Add EPUB href resolution helpers (resolve.ts)"
```

---

### Task 4: Add a real-EPUB parser fixture

**Files:**
- Create: `src/epub/testdata/the-magic-hower.epub` (binary copy)

**Interfaces:**
- Consumes: nothing.
- Produces: a real, slightly messy `.epub` file (9 out-of-order chapters, a blank first creator, no NCX) at `src/epub/testdata/the-magic-hower.epub`, used by `parse.test.ts` (Task 5) and `cache.test.ts` (Task 6).

- [ ] **Step 1: Copy the fixture from the Go reference project**

```bash
mkdir -p src/epub/testdata
cp "G:/_GoProjects/epub-novel-mcp-server/example/The Magic Hower.epub" "src/epub/testdata/the-magic-hower.epub"
```

- [ ] **Step 2: Verify it copied correctly**

Run: `ls -la src/epub/testdata/the-magic-hower.epub`
Expected: file exists, non-zero size.

- [ ] **Step 3: Commit**

```bash
git add src/epub/testdata/the-magic-hower.epub
git commit -m "Add real-EPUB fixture for parser/cache tests"
```

---

### Task 5: EPUB archive parser

**Files:**
- Create: `src/epub/parse.ts`
- Test: `src/epub/parse.test.ts`

**Interfaces:**
- Consumes: `ArchiveId`, `Epub`, `Package`, `Metadata`, `Manifest`, `Spine`, `Guide`, `Navigation`, `NavList`, `NavPoint`, `NCX`, `NCXNavPoint`, `ContentDocument`, `Resource` from `./types.ts` (Task 2); `resolveHref` from `./resolve.ts` (Task 3); `unzipSync` from `fflate`; `DOMParser`, `onErrorStopParsing` from `@xmldom/xmldom`. Uses the fixture from Task 4.
- Produces: `parseEpub(filename: string): Promise<Epub>` — the sole export, consumed by `cache.ts` (Task 6) and every later tool that reads a `.epub` from disk.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEpub } from "./parse.ts";
import { primaryPackage } from "./resolve.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "testdata", "the-magic-hower.epub");

describe("parseEpub", () => {
  test("parses the OCF container and mimetype", async () => {
    const e = await parseEpub(fixturePath);
    expect(e.mimetype).toBe("application/epub+zip");
    expect(e.container.rootfiles).toEqual([
      { id: "META-INF/container.xml#rootfiles[0]", fullPath: "content.opf", mediaType: "application/oebps-package+xml" },
    ]);
  });

  test("parses package metadata", async () => {
    const e = await parseEpub(fixturePath);
    const pkg = primaryPackage(e)!;
    expect(pkg.baseDir).toBe("");
    expect(pkg.metadata.identifiers[0]).toEqual({
      id: "content.opf#metadata/identifier[bookid]",
      scheme: "UUID",
      value: "a1af6a9864bf4a04b38d8da7336dabe4",
    });
    expect(pkg.metadata.titles[0].value).toBe("The Magic Hower");
    expect(pkg.metadata.creators).toHaveLength(2);
    expect(pkg.metadata.creators[0].name).toBe("");
    expect(pkg.metadata.creators[1]).toMatchObject({ name: "Unknown", role: "aut" });
  });

  test("parses the manifest and spine", async () => {
    const e = await parseEpub(fixturePath);
    const pkg = primaryPackage(e)!;
    expect(pkg.manifest.items).toHaveLength(11);
    expect(pkg.spine.itemRefs).toHaveLength(10);
    expect(pkg.spine.itemRefs[0]).toMatchObject({ idRef: "nav", linear: false });
    expect(pkg.spine.itemRefs[1]).toMatchObject({ idRef: "chapter-03", linear: true });
  });

  test("files content documents, resources, and navigation into the epub by role", async () => {
    const e = await parseEpub(fixturePath);
    expect(Object.keys(e.contentDocuments)).toHaveLength(9);
    expect(e.contentDocuments["OEBPS/text/chapter-03.xhtml"]).toBeDefined();
    expect(e.resources["styles/style.css"]?.mediaType).toBe("text/css");
    expect(Object.keys(e.nCXs)).toHaveLength(0);

    const nav = e.navigation["nav.xhtml"];
    expect(nav).toBeDefined();
    expect(nav!.lists).toHaveLength(1);
    expect(nav!.lists[0]).toMatchObject({ type: "toc", heading: "Contents" });
    expect(nav!.lists[0].items).toHaveLength(9);
    expect(nav!.lists[0].items[0]).toMatchObject({ label: "Chapter 03", href: "OEBPS/text/chapter-03.xhtml" });
  });

  test("rejects a path that doesn't exist", async () => {
    await expect(parseEpub("src/epub/testdata/does-not-exist.epub")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/parse.test.ts`
Expected: FAIL — `error: Cannot find module './parse.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";
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

const textDecoder = new TextDecoder("utf-8");
const strictParser = new DOMParser({ onError: onErrorStopParsing });

function parseXML(data: Uint8Array): Document {
  return strictParser.parseFromString(textDecoder.decode(data), "text/xml");
}

function localName(tagName: string): string {
  const i = tagName.indexOf(":");
  return i === -1 ? tagName : tagName.slice(i + 1);
}

function directChildren(parent: Element | Document, local: string): Element[] {
  const out: Element[] = [];
  for (const child of parent.children) {
    if (localName(child.tagName) === local) out.push(child);
  }
  return out;
}

function firstChild(parent: Element | Document, local: string): Element | null {
  for (const child of parent.children) {
    if (localName(child.tagName) === local) return child;
  }
  return null;
}

/** All <local> elements anywhere under parent, depth-first — mirrors Go's findAllLocal. */
function descendants(parent: Element, local: string): Element[] {
  const out: Element[] = [];
  for (const child of parent.children) {
    if (localName(child.tagName) === local) out.push(child);
    out.push(...descendants(child, local));
  }
  return out;
}

function attr(el: Element, name: string): string {
  return el.getAttribute(name) ?? "";
}

/** el's own direct text content, trimmed — mirrors Go's xml:",chardata". */
function chardata(el: Element): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) text += node.nodeValue ?? ""; // TEXT_NODE
  }
  return text.trim();
}

/** All text within el, in document order, including nested inline elements, whitespace-collapsed. */
function chardataDeep(el: Element): string {
  const text = el.textContent ?? "";
  return text.split(/\s+/).filter(Boolean).join(" ");
}

function isHeadingTag(local: string): boolean {
  return /^h[1-6]$/.test(local);
}

function fragId(parent: ArchiveId, name: string, xmlId: string, index: number): ArchiveId {
  return xmlId ? `${parent}/${name}[${xmlId}]` : `${parent}/${name}[${index}]`;
}

export async function parseEpub(filename: string): Promise<Epub> {
  const raw = await readBinaryPortable(filename);
  const files = unzipSync(raw);
  return parseArchive(files);
}

function readZipFile(files: Record<string, Uint8Array>, name: string): Uint8Array {
  const data = files[name];
  if (!data) throw new Error(`${name}: not found in archive`);
  return data;
}

function parseArchive(files: Record<string, Uint8Array>): Epub {
  const mimetype = files["mimetype"] ? textDecoder.decode(files["mimetype"]) : "";

  const containerData = readZipFile(files, "META-INF/container.xml");
  const containerEl = parseXML(containerData).documentElement;
  if (!containerEl) throw new Error("parse container.xml: no root element");

  const e: Epub = {
    id: "",
    mimetype,
    container: { id: "META-INF/container.xml", version: attr(containerEl, "version"), rootfiles: [] },
    packages: {},
    navigation: {},
    nCXs: {},
    contentDocuments: {},
    resources: {},
  };

  const rootfilesEl = firstChild(containerEl, "rootfiles");
  const rootfileEls = rootfilesEl ? directChildren(rootfilesEl, "rootfile") : [];

  rootfileEls.forEach((rf, i) => {
    const fullPath = attr(rf, "full-path");
    e.container.rootfiles.push({
      id: `META-INF/container.xml#rootfiles[${i}]`,
      fullPath,
      mediaType: attr(rf, "media-type"),
    });

    const pkg = parsePackage(files, fullPath);
    e.packages[fullPath] = pkg;
    loadManifestResources(files, pkg, e);
  });

  return e;
}

function parsePackage(files: Record<string, Uint8Array>, fullPath: string): Package {
  const data = readZipFile(files, fullPath);
  const root = parseXML(data).documentElement;
  if (!root) throw new Error(`parse package ${fullPath}: no root element`);

  const pkgId: ArchiveId = fullPath;
  const slash = fullPath.lastIndexOf("/");
  const baseDir = slash >= 0 ? fullPath.slice(0, slash + 1) : "";

  return {
    id: pkgId,
    baseDir,
    version: attr(root, "version"),
    uniqueIdentifierRef: attr(root, "unique-identifier"),
    lang: attr(root, "lang"),
    metadata: buildMetadata(firstChild(root, "metadata"), pkgId),
    manifest: buildManifest(firstChild(root, "manifest"), pkgId),
    spine: buildSpine(firstChild(root, "spine"), pkgId),
    guide: buildGuide(firstChild(root, "guide"), pkgId),
  };
}

function buildMetadata(el: Element | null, pkgId: ArchiveId): Metadata {
  const metaId: ArchiveId = `${pkgId}#metadata`;
  const m: Metadata = {
    id: metaId,
    identifiers: [],
    titles: [],
    languages: [],
    creators: [],
    contributors: [],
    publishers: [],
    dates: [],
    subjects: [],
    description: "",
    rights: "",
    metas: [],
  };
  if (!el) return m;

  directChildren(el, "identifier").forEach((v, i) => {
    m.identifiers.push({ id: fragId(metaId, "identifier", attr(v, "id"), i), scheme: attr(v, "scheme"), value: chardata(v) });
  });
  directChildren(el, "title").forEach((v, i) => {
    m.titles.push({ id: fragId(metaId, "title", attr(v, "id"), i), value: chardata(v), type: "", lang: attr(v, "lang") });
  });
  directChildren(el, "language").forEach((v, i) => {
    m.languages.push({ id: fragId(metaId, "language", attr(v, "id"), i), value: chardata(v) });
  });
  directChildren(el, "creator").forEach((v, i) => {
    m.creators.push({
      id: fragId(metaId, "creator", attr(v, "id"), i),
      name: chardata(v),
      role: attr(v, "role"),
      fileAs: attr(v, "file-as"),
      lang: attr(v, "lang"),
    });
  });
  directChildren(el, "contributor").forEach((v, i) => {
    m.contributors.push({
      id: fragId(metaId, "contributor", attr(v, "id"), i),
      name: chardata(v),
      role: attr(v, "role"),
      fileAs: attr(v, "file-as"),
      lang: attr(v, "lang"),
    });
  });
  directChildren(el, "publisher").forEach((v) => m.publishers.push(chardata(v)));
  directChildren(el, "date").forEach((v, i) => {
    m.dates.push({ id: fragId(metaId, "date", attr(v, "id"), i), value: chardata(v), event: attr(v, "event") });
  });
  directChildren(el, "subject").forEach((v, i) => {
    m.subjects.push({
      id: fragId(metaId, "subject", attr(v, "id"), i),
      value: chardata(v),
      scheme: attr(v, "authority"),
      code: attr(v, "term"),
    });
  });
  const descriptions = directChildren(el, "description");
  if (descriptions.length > 0) m.description = chardata(descriptions[0]);
  const rights = directChildren(el, "rights");
  if (rights.length > 0) m.rights = chardata(rights[0]);
  directChildren(el, "meta").forEach((v, i) => {
    const name = attr(v, "name");
    const value = name ? attr(v, "content") : chardata(v);
    m.metas.push({
      id: fragId(metaId, "meta", attr(v, "id"), i),
      property: attr(v, "property"),
      refines: attr(v, "refines"),
      scheme: attr(v, "scheme"),
      value,
      name,
    });
  });

  return m;
}

function buildManifest(el: Element | null, pkgId: ArchiveId): Manifest {
  const manifestId: ArchiveId = `${pkgId}#manifest`;
  const man: Manifest = { id: manifestId, items: [] };
  if (!el) return man;

  directChildren(el, "item").forEach((v, i) => {
    const opfId = attr(v, "id") || `item[${i}]`;
    man.items.push({
      id: `${manifestId}/${opfId}`,
      href: attr(v, "href"),
      mediaType: attr(v, "media-type"),
      properties: attr(v, "properties").split(/\s+/).filter(Boolean),
      fallback: attr(v, "fallback"),
      mediaOverlay: attr(v, "media-overlay"),
    });
  });
  return man;
}

function buildSpine(el: Element | null, pkgId: ArchiveId): Spine {
  const spineId: ArchiveId = `${pkgId}#spine`;
  const sp: Spine = { id: spineId, tocRef: "", pageProgressionDirection: "", itemRefs: [] };
  if (!el) return sp;

  sp.tocRef = attr(el, "toc");
  sp.pageProgressionDirection = attr(el, "page-progression-direction");
  directChildren(el, "itemref").forEach((v, i) => {
    sp.itemRefs.push({
      id: `${spineId}/itemref[${i}]`,
      idRef: attr(v, "idref"),
      linear: attr(v, "linear") !== "no",
      properties: attr(v, "properties").split(/\s+/).filter(Boolean),
    });
  });
  return sp;
}

function buildGuide(el: Element | null, pkgId: ArchiveId): Guide | undefined {
  if (!el) return undefined;
  const guideId: ArchiveId = `${pkgId}#guide`;
  const g: Guide = { id: guideId, references: [] };
  directChildren(el, "reference").forEach((v, i) => {
    const type = attr(v, "type");
    const key = type || String(i);
    g.references.push({ id: `${guideId}/reference[${key}]`, type, title: attr(v, "title"), href: attr(v, "href") });
  });
  return g;
}

function loadManifestResources(files: Record<string, Uint8Array>, pkg: Package, e: Epub): void {
  for (const item of pkg.manifest.items) {
    const archivePath = resolveHref(pkg, item.href);
    if (!archivePath) continue;

    const data = readZipFile(files, archivePath);
    const isNav = item.properties.includes("nav");

    if (isNav) {
      e.navigation[archivePath] = parseNavigation(archivePath, item.mediaType, data);
    } else if (item.mediaType === "application/x-dtbncx+xml") {
      e.nCXs[archivePath] = parseNCX(archivePath, data);
    } else if (item.mediaType === "application/xhtml+xml") {
      e.contentDocuments[archivePath] = { id: archivePath, mediaType: item.mediaType, markup: textDecoder.decode(data) };
    } else {
      e.resources[archivePath] = { id: archivePath, mediaType: item.mediaType, data };
    }
  }
}

/** Structured lists are best-effort; markup always holds the full raw document regardless. */
function parseNavigation(archivePath: ArchiveId, mediaType: string, data: Uint8Array): Navigation {
  const markup = textDecoder.decode(data);
  const nav: Navigation = { id: archivePath, mediaType, markup, lists: [] };

  let root: Element | null;
  try {
    root = parseXML(data).documentElement;
  } catch {
    return nav;
  }
  if (!root) return nav;

  descendants(root, "nav").forEach((navEl, i) => {
    nav.lists.push(buildNavList(nav.id, navEl, i));
  });
  return nav;
}

function buildNavList(navId: ArchiveId, n: Element, index: number): NavList {
  const typ = attr(n, "type");
  const xmlId = attr(n, "id");
  const key = typ || xmlId || `list[${index}]`;
  const listId: ArchiveId = `${navId}#${key}`;
  const displayType = typ || xmlId;

  let heading = "";
  for (const child of n.children) {
    if (isHeadingTag(localName(child.tagName))) {
      heading = chardataDeep(child);
      break;
    }
  }

  let items: NavPoint[] = [];
  for (const child of n.children) {
    if (localName(child.tagName) === "ol") {
      items = buildNavPoints(listId, child);
      break;
    }
  }

  return { id: listId, type: displayType, heading, items };
}

function buildNavPoints(listId: ArchiveId, ol: Element): NavPoint[] {
  const points: NavPoint[] = [];
  let index = 0;
  for (const li of ol.children) {
    if (localName(li.tagName) !== "li") continue;

    const xmlId = attr(li, "id");
    const pointId: ArchiveId = xmlId ? `${listId}/${xmlId}` : `${listId}/item[${index}]`;
    index++;

    let label = "";
    let href = "";
    let typ = "";
    let children: NavPoint[] = [];
    for (const child of li.children) {
      const local = localName(child.tagName);
      if (local === "a") {
        href = attr(child, "href");
        label = chardataDeep(child);
        typ = attr(child, "type");
      } else if (local === "span") {
        if (!label) label = chardataDeep(child);
        if (!typ) typ = attr(child, "type");
      } else if (local === "ol") {
        children = buildNavPoints(pointId, child);
      }
    }

    points.push({ id: pointId, label, href, type: typ, children });
  }
  return points;
}

/** navMap is best-effort; markup always holds the full raw document regardless. */
function parseNCX(archivePath: ArchiveId, data: Uint8Array): NCX {
  const markup = textDecoder.decode(data);
  const ncx: NCX = { id: archivePath, markup, navMap: [] };

  let root: Element | null;
  try {
    root = parseXML(data).documentElement;
  } catch {
    return ncx;
  }
  if (!root) return ncx;

  const navMapEl = firstChild(root, "navMap");
  if (!navMapEl) return ncx;

  ncx.navMap = buildNCXNavPoints(ncx.id, directChildren(navMapEl, "navPoint"));
  return ncx;
}

function buildNCXNavPoints(ncxId: ArchiveId, els: Element[]): NCXNavPoint[] {
  return els.map((p) => {
    const id = attr(p, "id");
    const playOrder = parseInt(attr(p, "playOrder"), 10) || 0;
    const navLabelEl = firstChild(p, "navLabel");
    const textEl = navLabelEl ? firstChild(navLabelEl, "text") : null;
    const label = textEl ? chardata(textEl) : "";
    const contentEl = firstChild(p, "content");
    const src = contentEl ? attr(contentEl, "src") : "";
    return {
      id: `${ncxId}#${id}`,
      playOrder,
      label,
      src,
      children: buildNCXNavPoints(ncxId, directChildren(p, "navPoint")),
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/parse.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/epub/parse.ts src/epub/parse.test.ts
git commit -m "Add EPUB zip/XML parser (parse.ts)"
```

---

### Task 6: Bounded LRU cache

**Files:**
- Create: `src/epub/cache.ts`
- Test: `src/epub/cache.test.ts`

**Interfaces:**
- Consumes: `Epub` (type-only) from `./types.ts` (Task 2); `parseEpub` from `./parse.ts` (Task 5); uses the fixture from Task 4.
- Produces: `canonicalPath(path: string): string`, `DEFAULT_CACHE_SIZE`, `CacheEntry`, `Eviction`, and class `Cache` with `capacity`, `get(path)`, `put(path, epub)`, `load(path): Promise<{epub, eviction}>`, `markDirty(path)`, `clearDirty(path)`, `remove(path)`, `entries()` — all exported, consumed by every tool task from Phase 4 onward (each wraps a call in `Cache.load`/`markDirty`/etc.).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cache, canonicalPath } from "./cache.ts";
import type { Epub } from "./types.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "testdata", "the-magic-hower.epub");

function fakeEpub(tag: string): Epub {
  return {
    id: "",
    mimetype: tag,
    container: { id: "META-INF/container.xml", version: "1.0", rootfiles: [] },
    packages: {},
    navigation: {},
    nCXs: {},
    contentDocuments: {},
    resources: {},
  };
}

describe("Cache LRU eviction", () => {
  test("evicts the least recently used entry once past capacity", () => {
    const cache = new Cache(4);
    cache.put("a", fakeEpub("a"));
    cache.put("b", fakeEpub("b"));
    cache.put("c", fakeEpub("c"));
    cache.put("d", fakeEpub("d"));

    // touch "a" so "b" becomes least recently used
    expect(cache.get("a")).toBeDefined();

    cache.put("e", fakeEpub("e"));

    expect(cache.get("b")).toBeUndefined();
    for (const k of ["a", "c", "d", "e"]) {
      expect(cache.get(k)).toBeDefined();
    }
  });
});

describe("Cache eviction reports dirty state", () => {
  test("reports the evicted entry's path and dirty flag", () => {
    const cache = new Cache(2);
    expect(cache.put("a", fakeEpub("a"))).toBeUndefined();
    cache.put("b", fakeEpub("b"));
    cache.markDirty("a");

    const evicted = cache.put("c", fakeEpub("c"));
    expect(evicted).toEqual({ path: "a", wasDirty: true });
  });
});

describe("Cache mark and clear dirty", () => {
  test("toggles the dirty flag reported by entries()", () => {
    const cache = new Cache(4);
    cache.put("a", fakeEpub("a"));

    expect(cache.entries()).toEqual([{ path: "a", dirty: false }]);

    cache.markDirty("a");
    expect(cache.entries()).toEqual([{ path: "a", dirty: true }]);

    cache.clearDirty("a");
    expect(cache.entries()).toEqual([{ path: "a", dirty: false }]);
  });
});

describe("Cache entries ordering", () => {
  test("orders most-recently-used first", () => {
    const cache = new Cache(4);
    cache.put("a", fakeEpub("a"));
    cache.put("b", fakeEpub("b"));
    cache.put("c", fakeEpub("c"));

    cache.get("a"); // touch a, moving it to the front

    expect(cache.entries().map((e) => e.path)).toEqual(["a", "c", "b"]);
  });
});

describe("Cache remove", () => {
  test("removes an entry and reports its prior dirty state", () => {
    const cache = new Cache(4);
    cache.put("a", fakeEpub("a"));
    cache.markDirty("a");

    expect(cache.remove("a")).toEqual({ removed: true, wasDirty: true });
    expect(cache.get("a")).toBeUndefined();
    expect(cache.remove("a")).toEqual({ removed: false, wasDirty: false });
  });
});

describe("Cache.load", () => {
  test("parses a real file on first load and returns the cached instance on the next", async () => {
    const cache = new Cache(4);
    const first = await cache.load(fixturePath);
    expect(first.eviction).toBeUndefined();
    expect(first.epub.mimetype).toBe("application/epub+zip");

    const second = await cache.load(fixturePath);
    expect(second.epub).toBe(first.epub);
    expect(second.eviction).toBeUndefined();
  });
});

describe("canonicalPath", () => {
  test("folds differently-cased spellings of the same file to one cache entry, on a case-insensitive filesystem", async () => {
    const altPath = fixturePath.toUpperCase();
    if (canonicalPath(altPath) !== canonicalPath(fixturePath)) {
      return; // case-sensitive filesystem — nothing to test here
    }

    const cache = new Cache(4);
    await cache.load(fixturePath);
    cache.markDirty(fixturePath);

    expect(cache.remove(altPath)).toEqual({ removed: true, wasDirty: true });
    expect(cache.get(fixturePath)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/cache.test.ts`
Expected: FAIL — `error: Cannot find module './cache.ts'`.

- [ ] **Step 3: Write the implementation**

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

/**
 * Returns a best-effort canonical form of path, used as Cache's internal
 * lookup key so two different spellings of the same file (different case
 * on a case-insensitive filesystem, or a symlink) resolve to the same
 * entry instead of silently desyncing. Resolves symlinks via
 * node:fs.realpathSync, falling back to path unresolved if that throws
 * (e.g. the file doesn't exist yet), and folds case on platforms that are
 * case-insensitive by default (Windows, macOS) — a heuristic, not a true
 * filesystem-capability probe.
 */
export function canonicalPath(path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    resolved = path;
  }
  const platform = currentPlatform();
  if (platform === "win32" || platform === "windows" || platform === "darwin") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

export interface CacheEntry {
  path: string;
  dirty: boolean;
}

export interface Eviction {
  path: string;
  wasDirty: boolean;
}

interface InternalEntry {
  path: string;
  epub: Epub;
  dirty: boolean;
}

/**
 * A bounded, LRU path -> Epub cache, keyed by canonicalPath(path). Once
 * full, inserting a new entry evicts the least recently used one.
 *
 * Each entry tracks whether it's dirty: changed in memory since it was
 * last loaded fresh from disk or written back out. Callers that mutate a
 * loaded Epub are responsible for calling markDirty; callers that persist
 * one are responsible for calling clearDirty once the write actually
 * succeeds. The cache itself never inspects an Epub's contents, so it
 * can't detect edits on its own.
 *
 * Backed by a Map, whose iteration order tracks insertion order: deleting
 * and re-inserting a key moves it to the end (most recently used), and
 * eviction removes the first key (least recently used).
 */
export class Cache {
  #capacity: number;
  #items = new Map<string, InternalEntry>();

  constructor(capacity: number = DEFAULT_CACHE_SIZE) {
    this.#capacity = capacity < 1 ? 1 : capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** Returns the cached Epub for path, if present, marking it most recently used. */
  get(path: string): Epub | undefined {
    const key = canonicalPath(path);
    const entry = this.#items.get(key);
    if (!entry) return undefined;
    this.#items.delete(key);
    this.#items.set(key, entry);
    return entry.epub;
  }

  /**
   * Inserts or replaces the cached Epub for path, marking it most recently
   * used and clean. If the cache is already at capacity, the least
   * recently used entry is evicted first; returns that eviction, or
   * undefined if none occurred.
   */
  put(path: string, epub: Epub): Eviction | undefined {
    const key = canonicalPath(path);
    const existing = this.#items.get(key);
    if (existing) {
      existing.epub = epub;
      existing.dirty = false;
      this.#items.delete(key);
      this.#items.set(key, existing);
      return undefined;
    }

    let evicted: Eviction | undefined;
    if (this.#items.size >= this.#capacity) {
      const oldestKey = this.#items.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.#items.get(oldestKey)!;
        evicted = { path: oldest.path, wasDirty: oldest.dirty };
        this.#items.delete(oldestKey);
      }
    }
    this.#items.set(key, { path, epub, dirty: false });
    return evicted;
  }

  /**
   * Returns the cached Epub for path if present; otherwise parses path
   * from disk and caches the result — evicting the least recently used
   * entry if the cache is full. A cache hit always reports no eviction.
   */
  async load(path: string): Promise<{ epub: Epub; eviction: Eviction | undefined }> {
    const cached = this.get(path);
    if (cached) return { epub: cached, eviction: undefined };
    const epub = await parseEpub(path);
    const eviction = this.put(path, epub);
    return { epub, eviction };
  }

  /** Records that the cached Epub for path has changed in memory. No-op if path isn't cached. */
  markDirty(path: string): void {
    const entry = this.#items.get(canonicalPath(path));
    if (entry) entry.dirty = true;
  }

  /** Records that the cached Epub for path now matches what's on disk. No-op if path isn't cached. */
  clearDirty(path: string): void {
    const entry = this.#items.get(canonicalPath(path));
    if (entry) entry.dirty = false;
  }

  /** Evicts path from the cache outright, reporting whether it was present and, if so, whether dirty. */
  remove(path: string): { removed: boolean; wasDirty: boolean } {
    const key = canonicalPath(path);
    const entry = this.#items.get(key);
    if (!entry) return { removed: false, wasDirty: false };
    this.#items.delete(key);
    return { removed: true, wasDirty: entry.dirty };
  }

  /** Returns a snapshot of every cached path and its dirty flag, most- to least-recently-used. */
  entries(): CacheEntry[] {
    const out: CacheEntry[] = [];
    for (const entry of this.#items.values()) out.push({ path: entry.path, dirty: entry.dirty });
    return out.reverse();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/cache.test.ts`
Expected: PASS, all 7 tests green (the `canonicalPath` test may short-circuit with no assertions on a case-sensitive filesystem, which is expected on Linux/most CI but not on this Windows dev machine, where it exercises the real fold).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/epub/cache.ts src/epub/cache.test.ts
git commit -m "Add bounded LRU EPUB cache (cache.ts)"
```

---

### Task 7: New empty EPUB constructor

**Files:**
- Create: `src/epub/new-epub.ts`
- Test: `src/epub/new-epub.test.ts`

**Interfaces:**
- Consumes: `Epub`, `Package` (type-only) from `./types.ts` (Task 2); `primaryPackage` from `./resolve.ts` (Task 3, test-only).
- Produces: `newEpub(title: string, author: string): Epub` — the sole export, consumed by the `new_epub` tool in Phase 4.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { newEpub } from "./new-epub.ts";
import { primaryPackage } from "./resolve.ts";

describe("newEpub", () => {
  test("builds a minimal valid EPUB 3 skeleton with no chapters", () => {
    const e = newEpub("My Book", "Jane Author");

    expect(e.mimetype).toBe("application/epub+zip");
    expect(e.container.rootfiles).toEqual([
      { id: "META-INF/container.xml#rootfiles[0]", fullPath: "content.opf", mediaType: "application/oebps-package+xml" },
    ]);

    const pkg = primaryPackage(e)!;
    expect(pkg.metadata.titles[0].value).toBe("My Book");
    expect(pkg.metadata.creators).toEqual([
      { id: "content.opf#metadata/creator[0]", name: "Jane Author", role: "aut", fileAs: "", lang: "" },
    ]);
    expect(pkg.metadata.identifiers[0].scheme).toBe("UUID");
    expect(pkg.metadata.identifiers[0].value.length).toBeGreaterThan(0);

    expect(pkg.manifest.items.map((i) => i.href)).toEqual(["nav.xhtml", "styles/style.css"]);
    expect(pkg.spine.itemRefs).toEqual([
      { id: "content.opf#spine/itemref[0]", idRef: "nav", linear: true, properties: [] },
    ]);

    expect(Object.keys(e.contentDocuments)).toHaveLength(0);
    expect(e.navigation["nav.xhtml"]?.lists).toEqual([
      { id: "nav.xhtml#toc", type: "toc", heading: "Contents", items: [] },
    ]);
    expect(e.resources["styles/style.css"]?.mediaType).toBe("text/css");
  });

  test("generates a different identifier for each call", () => {
    const a = newEpub("Book A", "Author");
    const b = newEpub("Book B", "Author");
    expect(primaryPackage(a)!.metadata.identifiers[0].value).not.toBe(
      primaryPackage(b)!.metadata.identifiers[0].value,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/epub/new-epub.test.ts`
Expected: FAIL — `error: Cannot find module './new-epub.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { Epub, Package } from "./types.ts";

/**
 * Builds a minimal valid EPUB 3 publication in memory with the given
 * title and author: a container.xml, mimetype, navigation document
 * (nav.xhtml, with an empty toc list), and an empty stylesheet —
 * everything the edit_chapter/save_epub tools (Phase 4/5) need to work
 * immediately after creation. It intentionally has no chapters yet:
 * unlike a real book, there's nothing to place there sight unseen. The
 * save_epub tool fills in a single blank chapter automatically if the
 * book still has none by the time it's saved, since EPUB requires at
 * least one content document.
 */
export function newEpub(title: string, author: string): Epub {
  const now = new Date().toISOString();

  const e: Epub = {
    id: "",
    mimetype: "application/epub+zip",
    container: {
      id: "META-INF/container.xml",
      version: "1.0",
      rootfiles: [{ id: "META-INF/container.xml#rootfiles[0]", fullPath: "content.opf", mediaType: "application/oebps-package+xml" }],
    },
    packages: {},
    navigation: {},
    nCXs: {},
    contentDocuments: {},
    resources: {},
  };

  const pkg: Package = {
    id: "content.opf",
    baseDir: "",
    version: "3.0",
    uniqueIdentifierRef: "uid",
    lang: "en",
    metadata: {
      id: "content.opf#metadata",
      identifiers: [{ id: "content.opf#metadata/identifier[bookid]", scheme: "UUID", value: crypto.randomUUID() }],
      titles: [{ id: "content.opf#metadata/title[0]", value: title, type: "main", lang: "" }],
      languages: [{ id: "content.opf#metadata/language[0]", value: "en" }],
      creators: [],
      contributors: [],
      publishers: [],
      dates: [],
      subjects: [],
      description: "",
      rights: "",
      metas: [{ id: "content.opf#metadata/meta[modified]", property: "dcterms:modified", refines: "", scheme: "", value: now, name: "" }],
    },
    manifest: {
      id: "content.opf#manifest",
      items: [
        { id: "content.opf#manifest/nav", href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: ["nav"], fallback: "", mediaOverlay: "" },
        { id: "content.opf#manifest/style", href: "styles/style.css", mediaType: "text/css", properties: [], fallback: "", mediaOverlay: "" },
      ],
    },
    spine: {
      id: "content.opf#spine",
      tocRef: "nav",
      pageProgressionDirection: "ltr",
      itemRefs: [{ id: "content.opf#spine/itemref[0]", idRef: "nav", linear: true, properties: [] }],
    },
  };

  addCreator(pkg, author, "aut");
  e.packages["content.opf"] = pkg;

  e.navigation["nav.xhtml"] = {
    id: "nav.xhtml",
    mediaType: "application/xhtml+xml",
    markup: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2009/ops" lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Table of Contents</title>
  <link rel="stylesheet" href="styles/style.css" type="text/css"/>
</head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
    </ol>
  </nav>
</body>
</html>`,
    lists: [{ id: "nav.xhtml#toc", type: "toc", heading: "Contents", items: [] }],
  };

  e.resources["styles/style.css"] = {
    id: "styles/style.css",
    mediaType: "text/css",
    data: new TextEncoder().encode(
      "body { font-family: serif; line-height: 1.5; margin: 1em; }\n\nh1 { text-align: center; page-break-before: always; }\n\np { text-indent: 1em; margin: 0; }",
    ),
  };

  return e;
}

function addCreator(pkg: Package, name: string, role: string): void {
  const existing = pkg.metadata.creators.find((c) => c.name === name && c.role === role);
  if (existing) return;
  pkg.metadata.creators.push({
    id: `${pkg.metadata.id}/creator[${pkg.metadata.creators.length}]`,
    name,
    role,
    fileAs: "",
    lang: "",
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/epub/new-epub.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; every test file in `src/` (the two pre-existing ones plus the five new `src/epub/*.test.ts` files) passes.

- [ ] **Step 6: Commit**

```bash
git add src/epub/new-epub.ts src/epub/new-epub.test.ts
git commit -m "Add minimal valid EPUB 3 constructor (new-epub.ts)"
```

---

## Definition of done

- `bun run typecheck` exits 0.
- `bun test` passes for every file under `src/`.
- `src/epub/` contains `types.ts`, `resolve.ts`, `parse.ts`, `cache.ts`, `new-epub.ts`, each with a matching `*.test.ts`, plus `testdata/the-magic-hower.epub`.
- A real `.epub` file (the fixture) can be parsed end-to-end into the in-memory `Epub` model and its metadata, manifest, spine, navigation, and content documents/resources are all correctly populated.
- Phase 2 (write path: `write.ts`, `validate.ts`, `text.ts`, `render-nav.ts`) can begin — it depends only on the types and helpers this plan produces.
