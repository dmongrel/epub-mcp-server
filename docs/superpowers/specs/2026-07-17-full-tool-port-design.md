# Full port of remaining EPUB tools — design

Date: 2026-07-17

## Context

`epub-mcp-server` (this repo) is a TypeScript/Bun port of `G:\_GoProjects\epub-novel-mcp-server`, a feature-complete Go MCP server for EPUB novels. So far only scaffolding exists: `get_context` and the update-check background task. Everything else — the entire `epub/` core package and all ~24 remaining tools — is unported.

This was triggered by a request to run `convert_manuscript` to build `The Magic Hower.epub` from `examples/The Magic Hower.md`. That tool doesn't exist yet in this repo (only in the Go reference). Rather than hand-build one epub file as a one-off, this spec covers the full port, phased so `convert_manuscript` and its dependencies land as one early, usable milestone.

The Go source is the spec of record for every behavior, schema, and edge case below — this document describes structure and sequencing, not line-by-line semantics. Each phase's implementation plan step should read the corresponding Go file(s) directly.

## Goals

- Port the entire `epub/` core package (data model, zip parser/writer, LRU cache, XHTML validation, plain-text extraction, nav/NCX rendering, href resolution) to TypeScript, one-way dependency from `tools/` as in the Go version.
- Port all ~24 remaining tools plus the shared infrastructure (registry, elicitation, eviction notices) they depend on.
- Preserve behavior parity with the Go reference: same tool names, same argument shapes (translated to TS/Zod-or-plain-JSON-schema equivalents), same elicitation conventions, same `get_`/`edit_` naming rules.
- Keep the existing stdio transport and Bun/Deno portability constraint (see `check-update.ts`'s runtime-detection pattern) — do not introduce Node-only or Bun-only native dependencies.
- End with `The Magic Hower.epub` buildable via `convert_manuscript` (plus `new_epub`/`save_epub`) from `examples/The Magic Hower.md`, and a passing test suite with coverage comparable to the Go `test/` directory.

## Non-goals

- No behavior changes or "improvements" over the Go reference — this is a straight port. Any divergence found necessary (e.g. because of a JS/TS constraint) gets called out explicitly in the relevant phase, not silently introduced.
- No HTTP transport — the TS server stays stdio-only, as already decided (see project memory on the Go/TS transport split).
- No UI, no MCP "apps"/widgets.

## Dependencies

Two new runtime dependencies, both pure-JS with no native bindings (required for Bun/Deno portability):

- **`fflate`** — zip container read/write, replacing Go's `archive/zip`.
- **`@xmldom/xmldom`** — `DOMParser`/`XMLSerializer`, replacing Go's `encoding/xml`. Used both to parse structured documents (OPF package, NCX, nav) into the TS data model and to validate arbitrary XHTML content-document markup by attempting a DOM parse (mirrors `epub/validate.go`'s well-formedness check).

## Architecture

### Directory layout

```
src/
  epub/
    types.ts        # data model (epub.go)
    parse.ts         # zip -> in-memory model (parse.go)
    write.ts         # in-memory model -> zip (write.go)
    cache.ts          # bounded LRU path->Epub cache (cache.go)
    validate.ts       # XHTML well-formedness check (validate.go)
    text.ts            # markup -> plain text (text.go)
    render-nav.ts       # NavList/NCXNavMap -> Markup (render_nav.go)
    resolve.ts            # href<->archive-path, PrimaryPackage, ManifestItemBy* (resolve.go)
    new-epub.ts             # minimal valid EPUB3 skeleton (new_epub.go)
  tools/
    registry.ts        # registerTool + toolRegistry + async lock (registry.go)
    elicit.ts            # resolveArg/withHint via server.elicitInput (elicit.go)
    eviction.ts           # evictionNote helper (eviction.go)
    get-context.ts         # existing — extended to list every registered tool
    check-update.ts         # existing, unchanged
    new-epub.ts, read-epub.ts, get-epubs-list.ts, save-epub.ts, close-epub.ts,
    reload-epub.ts, get-cache-status.ts,                                        # lifecycle
    get-chapter.ts, edit-chapter.ts, convert-manuscript.ts,
    chapter-markdown.ts, manuscript-parse.ts,                                    # chapters/manuscript
    get-metadata.ts, edit-metadata.ts,                                            # metadata
    get-cover.ts, edit-cover.ts, edit-back-cover.ts,
    get-resource.ts, edit-resource.ts,                                            # resources
    get-spine.ts, edit-spine.ts, get-manifest.ts, edit-manifest.ts,
    get-guide.ts, edit-guide.ts, get-navigation.ts, edit-navigation.ts,
    nav-sync.ts, idlist.ts                                                        # structure
  index.ts              # wires every tool the same way Go's tools.Register does
```

One `*.test.ts` per source file (bun:test), mirroring `test/*.go` by subject.

### Data model

TS interfaces mirror the Go structs in `epub/epub.go` 1:1: same names (camelCase), `type ArchiveId = string` in place of Go's `ID` locator type, arrays for slices, optional (`?`) fields for Go pointers (e.g. `Package.guide?: Guide`), `Uint8Array` for `Resource.Data`. `Epub.packages`/`navigation`/`nCXs`/`contentDocuments`/`resources` stay as `Record<string, T>` (Go's `map[string]*T`).

### Concurrency

Every registered tool handler is wrapped in a simple async mutex (a promise chain) inside `registry.ts`, mirroring Go's global `toolMu`. JS is single-threaded, but interleaved `await`s during zip I/O could otherwise let two tool calls corrupt the same in-memory `Epub` (analogous to, if less catastrophic than, Go's fatal concurrent-map-write). One global lock, same tradeoff Go makes: no cross-book parallelism, not a concern for a local single-user server.

### Tool infrastructure

- `registry.ts`: `registerTool(server, tool, extendedDescription, handler)` records the tool into a registry (for `get_context`) and wraps `handler` in the async lock before calling the SDK's `server.tool(...)`/equivalent registration.
- `elicit.ts`: `resolveArg(server, request, current, field, message)` mirrors Go's `resolveArg` using the TS SDK's `server.elicitInput(...)` (confirmed present in `@modelcontextprotocol/sdk@1.29.0`). Same blank-vs-omitted-vs-declined semantics. `withHint(message, hint)` unchanged in spirit.
- `eviction.ts`: `evictionNote(evicted)` unchanged in spirit — appends a note to a tool's result text when loading one book evicted another dirty one from cache.

## Phases

Each phase is its own implementation-plan step; phases 4 onward can mostly proceed in parallel once phases 1–3 land, since most tool files only depend on the core package + infra, not on each other.

1. **Epub core, read path** — `types.ts`, `parse.ts`, `resolve.ts`, `cache.ts`, `new-epub.ts`. Nothing else works without this.
2. **Epub core, write path** — `write.ts`, `validate.ts`, `text.ts`, `render-nav.ts`.
3. **Tool infrastructure** — `registry.ts` (incl. the async lock), `elicit.ts`, `eviction.ts`; wire `index.ts` to use `registerTool` for the existing `get_context`.
4. **Lifecycle tools** — `new_epub`, `read_epub`, `get_epubs_list`, `save_epub`, `close_epub`, `reload_epub`, `get_cache_status`. First end-to-end slice: proves cache + parse + write actually round-trip.
5. **Chapter/manuscript tools** — `get_chapter`, `edit_chapter` (+ `chapter-markdown.ts` helper), `convert_manuscript` (+ `manuscript-parse.ts` helper). This unblocks the original ask: building `The Magic Hower.epub` from the `.md` source.
6. **Metadata tools** — `get_metadata`, `edit_metadata`.
7. **Resource/cover tools** — `get_resource`, `edit_resource`, `get_cover`, `edit_cover`, `edit_back_cover`.
8. **Structure tools** — `get_spine`, `edit_spine`, `get_manifest`, `edit_manifest`, `get_guide`, `edit_guide`, `get_navigation`, `edit_navigation` (+ `nav-sync.ts`, `idlist.ts` helpers).
9. **Finalize** — `get_context` lists every real registered tool (replacing the current placeholder body), README updated, full test-parity pass including an end-to-end test that builds `The Magic Hower.epub` from `examples/The Magic Hower.md` via `new_epub` → `convert_manuscript` → `save_epub`, matching the Go suite's `example_workflow_test.go`.

## Testing

`bun:test` throughout. Per phase: unit tests for the files landing in that phase (cache LRU/dirty-tracking behavior, parse/write round-trip against a real sample `.epub`, each tool's create/edit/remove actions, elicitation-on-missing-argument behavior). Phase 9 adds the end-to-end example-workflow test. Target coverage comparable in scope to the Go `test/` directory (`cache_test.go`, `roundtrip_test.go`, `chapter_management_test.go`, `edit_tools_test.go`, `navigation_test.go`, `convert_manuscript_test.go`, `path_cache_test.go`, `example_workflow_test.go`) — `concurrency_test.go` and `http_integration_test.go` have no TS analog since this server is stdio/single-connection, not HTTP.

## Error handling

Follow the Go reference's conventions throughout: tool handlers return an MCP error result (not a thrown exception escaping the handler) for user-facing failures (file not found, malformed manuscript, no chapters found, etc.); `resolveArg`'s elicitation-decline case is the one place an error is expected and correct. Internal invariant violations (e.g. a `Package` with no `BaseDir` where one is required) can throw, since the async-lock wrapper in `registry.ts` should catch and convert to an MCP error result at that single choke point rather than every tool handling it individually.
