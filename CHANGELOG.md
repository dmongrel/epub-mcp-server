# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-07-25

### Added

- `validate_epub`: a read-only tool that checks an EPUB's table of contents, spine, manifest, and chapter text against each other and against the spec. Reports misalignment (a toc entry labelled "Chapter 5" pointing at chapter 7), dangling references, duplicate ids, orphaned chapters, malformed XHTML, and missing required metadata. Every finding names the tool call that fixes it. Runs all 16 checks by default, or a named subset.

### Changed

- `convert_manuscript` now rebuilds the table of contents from scratch when it finishes, instead of patching it chapter by chapter: one flat entry per chapter, in spine reading order, labelled from each chapter's own heading. Cover pages are skipped and the legacy NCX is regenerated to match. This fixes tables of contents that drifted out of spine order in books with a back cover, and chapters whose title changed but whose toc entry didn't. Manual nesting or renaming applied with `edit_navigation` does not survive a conversion — use `edit_chapter` for incremental changes that preserve a curated table of contents.
- `convert_manuscript` matches manuscript chapters against existing ones by the chapter number in each chapter's own heading, rather than by its table-of-contents label, which could be stale.
- `edit_chapter` is unchanged: `create` and `remove` still sync the table of contents incrementally.

### Fixed

- `save_epub` no longer inserts a blank placeholder chapter into a book that has none. Saving a new EPUB before adding content used to create `text/chapter-1.xhtml`, which then collided with the real chapter 1 on the next `convert_manuscript` — pushing it to `chapter-1-2.xhtml` and leaving a blank chapter at the head of the book and its table of contents. A book now stays empty until you add a chapter. Note that a spine with no entries is not valid EPUB 3; `validate_epub` reports it as `empty-spine`.

## [0.0.5] - 2026-07-24

### Fixed

- **`find_text` counted cover pages as chapters.** Front/back cover wrapper pages sit in the spine like any other content document, so without exclusion a book with a front cover would report its actual chapter 1 as chapter 2. `find_text` now excludes both (detected via the `cover` token in their `epub:type` attribute, the same convention `edit_cover`/`edit_back_cover` use when creating them), so chapter numbers always align with the book's real chapters.

## [0.0.4] - 2026-07-24

### Added

- **`find_text` tool** — searches chapter prose for a plaintext substring or regex pattern, reporting the chapter, line number, and matching line for every hit. Accepts an optional list of 1-based chapter numbers (spine order) to limit the search area.

### Fixed

- **`plainText` leaked `<head><title>` text.** It walked the entire document instead of just `<body>`, so the title element's text appeared as a spurious leading paragraph — throwing off `find_text`'s line numbers and slightly polluting `get_chapter`'s text output too. Now only walks `<body>` (falling back to the document root for malformed markup with no `<body>`).

## [0.0.3] - 2026-07-23

### Fixed

- **Broken update check.** `check-update.ts` queried the GitHub Releases API (`/releases/latest`), but `publish.yml` only pushes a git tag and publishes to npm — it never creates a GitHub Release, so the endpoint 404'd and the check silently failed open (no update ever reported, regardless of version). Switched it to query the npm registry (`registry.npmjs.org/epub-mcp-server/latest`) instead, since that's the actual source of truth for what's installable.

## [0.0.2] - 2026-07-23

### Added

- Inline markdown emphasis support in the chapter converters: `**bold**`, `*italic*`, and `***bold italic***` spans are now converted to `<strong>`/`<em>` tags in generated chapter XHTML.

## [0.0.1] - 2026-07-22

Version reset to mark the switch to real npm registry publishing.

### Changed

- Added `.github/workflows/publish.yml` — publishes to the npm registry whenever a `v*` tag is pushed.
- The npm package is now published to [npmjs.com](https://npmjs.com) directly, so `npm install -g epub-mcp-server` and `npm update -g epub-mcp-server` install a pre-built tarball from the registry — no local git clone/build step, which is what caused the Windows npm/node-tar `ENOENT` race with the old `github:dmongrel/epub-mcp-server`-based install.
- Removed `"private": true` from `package.json` (it blocked `npm publish` outright).
- Deleted the pre-registry `v0.1.0`/`v1.0.1`/`v1.0.2` git tags and GitHub Releases and restarted version numbering at `0.0.1` for the first real npm publish.
- Fixed stale README `raw.githubusercontent.com` URLs that pointed at a nonexistent `main` branch instead of `master`.
