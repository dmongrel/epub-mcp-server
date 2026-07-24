# Changelog

All notable changes to this project are documented in this file.

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
