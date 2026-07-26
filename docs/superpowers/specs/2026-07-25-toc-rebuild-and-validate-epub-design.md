# TOC Rebuild, Blank-Chapter Removal, and `validate_epub`

Date: 2026-07-25

Three related changes to the EPUB MCP server:

1. `convert_manuscript` rebuilds the table of contents from scratch instead of patching it incrementally.
2. `save_epub` no longer injects a blank placeholder chapter into an empty book.
3. A new read-only `validate_epub` tool reports misalignment and structural defects across the EPUB's data structures.

## Background

The server keeps four parallel structures that describe the same set of chapters:

- `pkg.spine.itemRefs` — the reading order
- `pkg.manifest.items` — the file list
- the `"toc"` `NavList` inside the EPUB 3 navigation document
- the legacy EPUB 2 NCX `navMap`, when present

Today these are kept in sync incrementally. `insertChapter` (`src/tools/edit-chapter.ts`) inserts into the spine at `spineInsertionIndexBeforeBackCover`, then calls `syncTocOnChapterCreate` (`src/tools/nav-sync.ts`), which **appends** to the end of the toc list. When a book has a back cover, those two positions differ, so spine order and toc order drift apart.

`convert_manuscript` compounds this. Its replace-in-place branch overwrites a chapter's markup but never touches the corresponding toc entry, so a chapter retitled by the new manuscript keeps its old toc label. Its create branch appends, so a source whose chapters arrive in a different order than the book's existing ones produces a toc that no longer matches the spine.

Separately, `save_epub` calls `ensureAtLeastOneChapter`, which injects `text/chapter-1.xhtml` (an `<h1>Chapter 1</h1>` stub) into any book with zero content documents. Since `new_epub` correctly creates a chapter-less book, any `save_epub` before the first real chapter — after `edit_metadata`, say — materializes that stub. A later `convert_manuscript` then finds `text/chapter-1.xhtml` occupied, and `uniqueArchiveId` shunts the real chapter 1 to `chapter-1-2.xhtml`, leaving a blank chapter permanently at the head of the book and its toc.

## Part 1 — Rebuild the TOC on `convert_manuscript`

### Scope

The rebuild applies to `convert_manuscript` only. Converting a manuscript means loading a whole new book's worth of text, so discarding the existing toc and deriving a fresh one is correct.

`edit_chapter`'s `create`, `edit`, and `remove` actions keep today's incremental `syncTocOnChapterCreate` / `syncTocOnChapterRemove` behavior, unchanged. A single-chapter edit must not discard a toc the user curated with `edit_navigation`.

### `rebuildToc`

New module `src/tools/nav-rebuild.ts`, exporting:

```ts
export function rebuildToc(e: Epub, pkg: Package): boolean
```

Algorithm:

1. Resolve the primary navigation document via `primaryNavigation(e, pkg)`. If the book has none, return `false` — the same best-effort contract `nav-sync.ts` already uses. No throw.
2. Find or create the `"toc"` `NavList` via `findOrCreateNavList(nav, "toc", "create")`.
3. Walk `pkg.spine.itemRefs` in order. For each itemref, resolve `idRef` to a manifest item (`manifestItemById`), resolve that item's href to an archive path (`resolveHref`), and look it up in `e.contentDocuments`. Skip any itemref that doesn't resolve to a content document.
4. Skip cover pages, identified by `isCoverPage` on the document's markup.
5. For each surviving document, derive a label (see below) and emit a `NavPoint`: `{ id: "", label, href: archivePath, type: "", children: [] }`.
6. Replace `list.items` wholesale with that flat array.
7. Call `renumberNavPoints(list.id, list.items)`, then `syncNavRender(e, pkg, nav, list)` — the existing helper that re-renders the navigation document's markup and, when the book has an NCX, regenerates its `navMap` from the same list via `toNCXPoints` and `renderNCXDocument`.
8. Return `true`.

Only the `"toc"` list is replaced. `landmarks`, `page-list`, and any custom `epub:type` nav list are left untouched.

The result is a flat toc in exact spine order. Manual nesting or hand-edited labels in the `"toc"` list do not survive a `convert_manuscript` call. This is intended: the manuscript is the source of truth for a conversion.

### Label derivation

New helper in the same module:

```ts
export function deriveTocLabel(markup: string, archivePath: string): string
```

In order:

1. The text content of the first `<h1>`–`<h6>` element in `<body>`, with tags stripped, entities decoded, and whitespace collapsed.
2. Otherwise the `<title>` element's text — except the literal string `"Chapter"`, which `chaptersToXHTML` hardcodes into every document it generates and which carries no information.
3. Otherwise `defaultChapterLabel(archivePath)`, the existing filename-derived fallback in `nav-sync.ts` (`"text/chapter-18.xhtml"` → `"Chapter 18"`).

A label derived at step 1 or 2 that is empty or whitespace-only falls through to the next step.

### Shared `isCoverPage`

`isCoverPage` currently lives in `src/tools/find-text.ts`. Move it to `src/epub/text.ts` and import it from both `find-text.ts` and `nav-rebuild.ts`, so the definition of "not prose" is single-sourced. Behavior is unchanged: a page whose markup contains an `epub:type` attribute with `"cover"` among its space-separated tokens. `find-text.ts` re-exports nothing; it just imports from the new home.

This keeps the rebuilt toc's Nth entry aligned with `find_text`'s chapter N, which is what makes `validate_epub`'s `toc-spine-order` check meaningful.

### `convert_manuscript` integration

In `handleConvertManuscript` (`src/tools/convert-manuscript.ts`):

- Call `rebuildToc(e, pkg)` once, after the create/replace loop and after leftover deletion, immediately before `epubCache.markDirty(abs)`.
- Add `tocRebuilt: boolean` to `ConvertManuscriptResult`, set from `rebuildToc`'s return value.
- Append to the summary: `" The table of contents was rebuilt from the spine."` when `true`, and `" This book has no navigation document, so no table of contents was rebuilt."` when `false`.

### `existingChaptersByNumber` matches on headings

`existingChaptersByNumber` currently scans the toc list for labels matching `/^chapter\s+(\d+)\b/i` and maps the number to the entry's href. That makes the toc both an input to and a rebuilt output of the same call, and it reads stale data whenever `edit_chapter edit` has changed a chapter's heading without updating its label.

Replace it with a spine walk that mirrors `rebuildToc`'s traversal: for each prose content document in spine order, parse a chapter number out of its derived label (same `deriveTocLabel` helper, same `/^chapter\s+(\d+)\b/i` pattern) and map that number to the document's archive path. Documents whose label carries no chapter number are not included in the map, exactly as toc entries without a numeric label are excluded today.

`leftoverChapterIds` consumes the resulting map unchanged.

This makes the spine plus each document's own markup the sole source of truth, and the toc purely derived.

## Part 2 — No auto-inserted blank chapter

In `src/tools/save-epub.ts`:

- Delete `ensureAtLeastOneChapter` and `defaultBlankChapterId`.
- Remove the `addedChapterId` local, the `addedBlankChapter` field from `SaveEpubResult`, the `addedNote` summary text, and the `epubCache.markDirty(abs)` branch that existed only to record the injected chapter when saving to a different path via `as`.
- Drop the now-unused `insertChapter`, `defaultChapterLabel`, `archiveIdInUse`, and `primaryPackage` imports.
- Correct the tool's registered description, which currently promises the blank-chapter behavior.

In `src/tools/new-epub.ts`, correct the registered description's reference to `save_epub` adding a blank chapter.

A new book now stays empty until `edit_chapter create` or `convert_manuscript` adds content.

### Accepted tradeoff

EPUB 3.3 requires `<spine>` to contain at least one `<itemref>`. Saving an untouched new book therefore writes a technically spec-invalid archive. This is accepted: the placeholder it replaces causes a concrete, user-visible corruption of every converted manuscript, and the empty state is transient by construction. `validate_epub`'s `empty-spine` check reports the condition explicitly rather than silently papering over it.

## Part 3 — `validate_epub`

### Contract

Read-only. Loads the EPUB through the same cache every other tool uses and mutates nothing — no cache writes, no `markDirty`, no disk access beyond the cache load.

Findings are actionable: each one names the tool and arguments that would fix it, so a caller can act on the report without inferring the repair.

### Arguments

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `path` | string | yes | filesystem path to the `.epub`, as previously passed to `read_epub` |
| `checks` | string[] | no | check names to run; omit to run all. An unknown name is an error naming the valid set. |

### Result

```ts
interface ValidateEpubFinding {
  check: string;      // check name, e.g. "toc-spine-order"
  severity: "error" | "warning";
  message: string;    // what is wrong, with the specific values involved
  ids: string[];      // affected archive ids / manifest ids, for the caller to act on
  remedy: string;     // a sentence naming the tool and arguments that fix it
}

interface ValidateEpubResult {
  path: string;
  ok: boolean;          // no findings of severity "error"
  errorCount: number;
  warningCount: number;
  checksRun: string[];
  findings: ValidateEpubFinding[];
}
```

Findings are ordered by check, in the order the checks are listed below; within a check, by spine order where applicable, otherwise by archive id. The text summary states the counts and lists each finding's check name and message.

An EPUB with no findings returns `ok: true` and an empty `findings` array — not an error.

### Structure

Pure check functions live in `src/epub/checks.ts`, each with the signature:

```ts
type Check = (e: Epub, pkg: Package) => ValidateEpubFinding[];
```

registered in a `CHECKS: Record<string, Check>` map. `src/tools/validate-epub.ts` holds only the MCP tool: argument handling, cache load, check selection, aggregation, and summary text. Checks never throw for defects — a defect is a finding. They throw only for a genuinely impossible input, and a book with no package document fails argument handling before any check runs.

### Checks

**Cross-structure alignment**

- `toc-spine-order` (error) — Compare the `"toc"` list's hrefs in order against the prose content documents in spine order (covers excluded, matching `rebuildToc`). Report toc entries whose target isn't a prose spine document, prose spine documents with no toc entry, and entries present in both but at different positions. Remedy: rerun `convert_manuscript`, or reorder with `edit_navigation`.
- `toc-label-heading-mismatch` (error) — For each toc entry whose label matches `/^chapter\s+(\d+)\b/i`, parse the same pattern from the target document's derived label. Report when both carry a number and the numbers differ. Remedy: `edit_navigation` to relabel, or `edit_chapter edit` to correct the heading.
- `chapter-number-sequence` (warning) — Parse chapter numbers from prose documents' headings in spine order. Report gaps, duplicates, and out-of-order runs. A warning, since deliberately unnumbered front matter and interludes are legitimate. Remedy: `edit_chapter` to correct the offending heading.
- `ncx-toc-divergence` (warning) — When the book has an NCX, compare its `navMap` against the `"toc"` list on labels, targets, and order. Remedy: any `convert_manuscript` or `edit_navigation` call regenerates the NCX from the toc.

**Referential integrity**

- `dangling-href` (error) — Every toc entry, NCX `navPoint` src, guide reference, and landmarks entry whose target (fragment stripped) resolves to no member of `contentDocuments`, `resources`, `navigation`, or `nCXs`. Remedy names the owning tool: `edit_navigation`, `edit_guide`.
- `spine-missing-manifest-item` (error) — Spine itemrefs whose `idRef` matches no manifest item. Remedy: `edit_spine` to remove, or `edit_manifest` to add the item.
- `manifest-missing-file` (error) — Manifest items whose resolved href is absent from every `Epub` file map. Remedy: `edit_manifest` to remove, or `edit_resource`/`edit_chapter` to supply the file.
- `orphan-content-document` (warning) — Content documents with no manifest item, or with one but no spine itemref. Unreachable in a linear read. Remedy: `edit_spine` to add, or `edit_chapter remove` to delete.
- `duplicate-id` (error) — Duplicate manifest item ids, duplicate spine `idRef`s, or two manifest items resolving to the same archive path. Remedy: `edit_manifest` / `edit_spine`.

**Structure and metadata**

- `malformed-xhtml` (error) — `validateXHTML` throws on a content document's or the navigation document's markup. The finding carries the parser's message. Remedy: `edit_chapter edit` with corrected markup.
- `missing-nav` (error) — No manifest item carries `properties="nav"`, or `spine/@toc` is set but names no manifest item. Remedy: `edit_manifest` to add the property; a missing navigation document needs `edit_navigation`.
- `missing-metadata` (error) — No `dc:identifier`, no `dc:title`, or no `dc:language`; or `package/@unique-identifier` names no entry in `metadata.identifiers`. Remedy: `edit_metadata`.
- `empty-spine` (error) — `pkg.spine.itemRefs` is empty. Remedy: `edit_chapter create` or `convert_manuscript`.
- `cover-image-missing` (warning) — A manifest item with `properties="cover-image"` whose file is absent, or a legacy `<meta name="cover">` whose `content` names no manifest item. Remedy: `edit_cover`.
- `back-cover-not-last` (warning) — The book has an `other.back-cover` guide reference, but the spine itemref for that document isn't the last entry. This is the server's own invariant, upheld by `spineInsertionIndexBeforeBackCover`. Remedy: `edit_spine` to move it.
- `empty-chapter` (warning) — A prose content document whose `plainText` output is empty or whitespace-only. Remedy: `edit_chapter edit` to add content, or `edit_chapter remove`.

### Registration

`validate-epub.ts` calls `registerTool` with the full prose description the other tools use, covering the argument contract, the read-only guarantee, the check list with severities, and the shape of the findings array. The tool is imported from `src/index.ts` alongside the others, and the README's tool count goes from 27 to 28.

## Testing

Per the existing per-file `*.test.ts` convention:

- `src/tools/nav-rebuild.test.ts` — label derivation precedence (`h1`–`h6` → `<title>` → filename, with the `"Chapter"` placeholder skipped and blank labels falling through); cover pages excluded; spine order preserved including the back-cover case that motivated the change; NCX regenerated in step; `landmarks` untouched; `false` returned for a book with no navigation document.
- `src/tools/convert-manuscript.test.ts` — extend: toc order matches spine after a conversion that both replaces and creates; a replaced chapter's changed title reaches its toc entry; `existingChaptersByNumber` matches on headings when toc labels are stale; `tocRebuilt` reported.
- `src/tools/save-epub.test.ts` — rewrite the blank-chapter cases: saving a chapter-less book writes it with an empty spine, adds no content document, and reports no `addedBlankChapter`; `new_epub` → `save_epub` → `convert_manuscript` yields chapter 1 at `chapter-1.xhtml` with no stray stub.
- `src/epub/checks.test.ts` — one test per check: a clean fixture producing no finding, and a mutated `Epub` tripping it with the expected `severity`, `ids`, and `remedy`.
- `src/tools/validate-epub.test.ts` — the clean `testdata/the-magic-hower.epub` fixture returns `ok: true`; `checks` selects a subset; an unknown check name is an error; counts and ordering are correct; the cache is not marked dirty.
- `src/epub/text.test.ts` — `isCoverPage` cases move here with the function.
