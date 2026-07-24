# Changelog

All notable changes to this project are documented in this file.

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

## [1.0.2] - 2026-07-22

### Added

- `CHANGELOG.md`.

## [1.0.1] - 2026-07-21

### Fixed

- **Broken `npm install -g` (Option B in the README).** `package.json` had no `"bin"` entry, so a global install never created the `epub-mcp-server` command. `"main"`/`"exports"` also pointed at `dist/index.js`, which was gitignored and never committed, so there was no working entrypoint even for programmatic use.
- **Node runtime support.** The server previously threw at startup unless `Bun` or `Deno` was present in the global scope, so a plain-Node install couldn't have worked regardless of the packaging fix above. Added a `node:fs/promises` fallback to the shared runtime helpers (`src/epub/runtime.ts`, `src/tools/check-update.ts`), so the server now also runs under plain Node.
- **Version lookup fragility.** `check-update.ts` resolved `package.json` via a hardcoded `"../../"` relative path from the source file, which breaks once the code is bundled into a single `dist/index.js` at a different depth. It now walks up from the module's location instead of assuming a fixed depth.

### Changed

- `dist/index.js` is now built targeting Node (with a `#!/usr/bin/env node` banner) and is committed to the repository, so a git-based `npm install -g` needs no build step.
- `package.json`'s `"files"` field now scopes the published npm package to `dist/`, `LICENSE.md`, and `README.md` — cutting the tarball from 106 files to 4. This incidentally addresses the Windows `npm`/`tar` `ENOENT` race that surfaced the underlying packaging bug.

## [1.0.0] - 2026-07-21

Initial versioned release.

### Added

- MIT license (`LICENSE.md`, SPDX headers on all TypeScript sources, `"license"` field in `package.json`).
- README rewritten to describe this repository's actual TypeScript/Bun/Deno stdio server (the previous README described an unrelated Go/HTTP implementation).

> **Note:** this version was superseded the same day by 1.0.1 — the npm global-install path documented in the README did not actually work in 1.0.0 (see Fixed above).
