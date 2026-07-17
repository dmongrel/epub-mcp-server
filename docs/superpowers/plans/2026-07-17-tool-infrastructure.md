# Tool Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Go reference's `tools/registry.go`, `tools/elicit.go`, and `tools/eviction.go` — the shared machinery every real MCP tool (Phase 4 onward) will register through — and wire the existing `get_context`/`index.ts` scaffold to use it, replacing today's hand-rolled single-tool dispatch.

**Architecture:** Three new files under `src/tools/` — `registry.ts` (tool registration, name-based dispatch, the async serialization lock), `elicit.ts` (`resolveArg`/`withHint` for optional-argument prompting via MCP elicitation), `eviction.ts` (`evictionNote`, a cache-eviction warning formatter) — plus a refactor of the two existing files that currently hard-code a single tool: `src/tools/get-context.ts` (now self-registers via `registerTool` instead of being special-cased) and `src/index.ts` (now delegates to the registry instead of its own local `tools`/`toolHandlers` arrays). This is **Phase 3** of the full port described in `docs/superpowers/specs/2026-07-17-full-tool-port-design.md`, building on Phases 1 (read path) and 2 (write path), both complete. Every real tool from Phase 4 onward (`new_epub`, `edit_chapter`, `convert_manuscript`, ...) will call `registerTool` the same way `get-context.ts` does after this phase.

**Tech Stack:** TypeScript on Bun (bun:test), the `@modelcontextprotocol/sdk`'s `Server` class (already in use in `src/index.ts`) for elicitation (`server.elicitInput(...)`, confirmed present on the SDK's `Server` class at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts`).

**Source of record:** `G:\_GoProjects\epub-novel-mcp-server\tools\{registry,elicit,eviction,get_context}.go` — every task below is a direct translation. One deliberate architectural divergence from Go, explained in Task 1: Go's `Register(server)` threads the server instance through one explicit call per tool file (`registerGetContext(server)`, `registerNewEpub(server)`, ...), because Go's `registerTool` needs `server` immediately to call the SDK's `mcp.AddTool(server, t, locked)`. This TS server hand-rolls its own dispatch table (see `src/index.ts`'s existing `tools`/`toolHandlers` pattern) rather than using the SDK's registration sugar, so `registerTool` here doesn't need a `Server` instance at registration time at all — only at *call* time, when a handler might need to elicit input from the one connected client. That lets every TS tool file self-register with a top-level `registerTool(...)` call as an import side effect (mirroring how `check-update.ts`/`get-context.ts` already work as self-contained modules), and `index.ts` just needs to import each tool file for that side effect and read `getTools()`/`dispatchTool()` back from the registry — no `Register(server)` entry point needed.

## Global Constraints

- Every exported name mirrors its Go counterpart's meaning, translated to camelCase.
- All relative imports use explicit `.ts` extensions; SDK imports keep their existing `.js` extensions (matching `src/index.ts`'s current imports from `@modelcontextprotocol/sdk/...`).
- `verbatimModuleSyntax` is on: import types with `import type { ... }`.
- Tests use `bun:test` (`describe`/`test`/`expect`).
- `registry.ts`'s `tools`/`toolHandlers`/`toolRegistry` arrays and the serialization lock's `queue` are module-level singletons — the same characteristic Go's package-level `var toolRegistry []toolInfo` and `var toolMu sync.Mutex` have. Because `bun test` runs all test files in one process without resetting module state between files, tests that call `registerTool` must use unique, randomly-suffixed tool names and assert via `.find()`/membership checks rather than exact array lengths, so they don't collide with or get confused by tools other test files registered first.
- A registered tool's handler signature is `(server: Server, args: Record<string, unknown> | undefined) => ToolHandlerResult | Promise<ToolHandlerResult>` — every real tool from Phase 4 onward receives the live `Server` instance as its first argument so it can call `resolveArg`/`elicitInput` when it needs to prompt for a missing argument.

---

### Task 1: Tool registry

**Files:**
- Create: `src/tools/registry.ts`
- Test: `src/tools/registry.test.ts`

**Interfaces:**
- Consumes: `Server` (type-only) from `@modelcontextprotocol/sdk/server/index.js`.
- Produces: `EpubTool`, `ToolHandlerResult`, `ToolHandler` (types), `registerTool(tool, extendedDescription, handler): void`, `getTools(): EpubTool[]`, `getToolRegistry(): { name, description, extendedDescription }[]`, `dispatchTool(server, name, args): Promise<ToolHandlerResult>` — all exported. Consumed by every tool file (`registerTool`) and by `src/index.ts` (`getTools`, `dispatchTool`) in Task 4.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { dispatchTool, getToolRegistry, getTools, registerTool } from "./registry.ts";

const fakeServer = {} as Server;

function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

describe("registerTool", () => {
  test("adds the tool to getTools() and getToolRegistry()", () => {
    const name = uniqueName("basic-tool");
    const tool = { name, description: "A test tool.", inputSchema: { type: "object", properties: {} } };
    registerTool(tool, "Extended notes.", async () => ({ content: [{ type: "text", text: "ok" }] }));

    expect(getTools().find((t) => t.name === name)).toEqual(tool);
    expect(getToolRegistry().find((t) => t.name === name)).toEqual({
      name,
      description: "A test tool.",
      extendedDescription: "Extended notes.",
    });
  });
});

describe("dispatchTool", () => {
  test("calls the registered handler with the server and args, returning its result", async () => {
    const name = uniqueName("echo-tool");
    let receivedArgs: unknown;
    registerTool({ name, description: "", inputSchema: {} }, "", async (_server, args) => {
      receivedArgs = args;
      return { content: [{ type: "text", text: "echoed" }] };
    });

    const result = await dispatchTool(fakeServer, name, { foo: "bar" });

    expect(result).toEqual({ content: [{ type: "text", text: "echoed" }] });
    expect(receivedArgs).toEqual({ foo: "bar" });
  });

  test("returns an isError result naming every registered tool when the name is unknown", async () => {
    const name = uniqueName("known-tool");
    registerTool({ name, description: "", inputSchema: {} }, "", async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const result = await dispatchTool(fakeServer, "does-not-exist", undefined);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool: does-not-exist");
    expect(result.content[0]?.text).toContain(name);
  });

  test("converts a thrown error into an isError result instead of rejecting", async () => {
    const name = uniqueName("throwing-tool");
    registerTool({ name, description: "", inputSchema: {} }, "", async () => {
      throw new Error("boom");
    });

    const result = await dispatchTool(fakeServer, name, undefined);

    expect(result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  });

  test("serializes concurrent calls to different registered tools through the global lock", async () => {
    const nameA = uniqueName("lock-a");
    const nameB = uniqueName("lock-b");
    const order: string[] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    registerTool({ name: nameA, description: "", inputSchema: {} }, "", async () => {
      order.push("a-start");
      await gateA;
      order.push("a-end");
      return { content: [{ type: "text", text: "a" }] };
    });
    registerTool({ name: nameB, description: "", inputSchema: {} }, "", async () => {
      order.push("b-start");
      order.push("b-end");
      return { content: [{ type: "text", text: "b" }] };
    });

    const pA = dispatchTool(fakeServer, nameA, undefined);
    const pB = dispatchTool(fakeServer, nameB, undefined);

    // Let A's handler run up to its await point; B must still be queued
    // behind the lock, not interleaved with it.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a-start"]);

    releaseA();
    await Promise.all([pA, pB]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/registry.test.ts`
Expected: FAIL — `error: Cannot find module './registry.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Generic tool registration/dispatch machinery shared by every MCP tool
 * this server exposes. One place records every tool for get_context's
 * benefit and wraps every handler in a single global async lock — mirrors
 * the Go reference's tools/registry.go, translated for a module-based
 * (rather than explicit Register(server)-call-based) registration style:
 * a TS tool file self-registers via a top-level registerTool(...) call as
 * an import side effect, instead of Go's registerXxx(server) functions
 * threaded through one Register(server) entry point.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface EpubTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ToolHandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type ToolHandler = (
  server: Server,
  args: Record<string, unknown> | undefined,
) => ToolHandlerResult | Promise<ToolHandlerResult>;

interface ToolRegistryEntry {
  name: string;
  description: string;
  extendedDescription: string;
}

const tools: EpubTool[] = [];
const toolHandlers: Record<string, ToolHandler> = {};
const toolRegistry: ToolRegistryEntry[] = [];

/**
 * Serializes every dispatched tool call through one FIFO queue. The cache
 * entries tools/ operates on (see epub/cache.ts) aren't safe for
 * concurrent mutation — two edit_ calls racing on the same book could
 * interleave their in-memory edits mid-await. One global lock trades
 * away cross-book parallelism (not a concern for a local, single-user
 * server) for correctness, mirroring Go's package-level toolMu.
 */
let queue: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Registers tool into this server's tool list and records it for
 * get_context's benefit. handler is wrapped in the global lock and in a
 * try/catch that converts a thrown error into an MCP error result — the
 * single choke point every tool's internal invariant violations flow
 * through, so individual tool handlers don't each need their own
 * top-level catch.
 */
export function registerTool(tool: EpubTool, extendedDescription: string, handler: ToolHandler): void {
  tools.push(tool);
  toolRegistry.push({
    name: tool.name,
    description: tool.description,
    extendedDescription,
  });
  toolHandlers[tool.name] = (server, args) =>
    withLock(async () => {
      try {
        return await handler(server, args);
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    });
}

/** Every registered tool's MCP descriptor, in registration order — the live list ListToolsRequestSchema returns. */
export function getTools(): EpubTool[] {
  return tools;
}

/** A snapshot of every registered tool's name/description/extendedDescription, for get_context. */
export function getToolRegistry(): ToolRegistryEntry[] {
  return toolRegistry;
}

/** Routes a CallToolRequest to its registered handler, or an "unknown tool" error result if none matches. */
export async function dispatchTool(
  server: Server,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolHandlerResult> {
  const handler = toolHandlers[name];
  if (!handler) {
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${name}. Available tools: ${tools.map((t) => t.name).join(", ")}`,
        },
      ],
      isError: true,
    };
  }
  return handler(server, args);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/registry.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/registry.ts src/tools/registry.test.ts
git commit -m "Add tool registration/dispatch registry (registry.ts)"
```

---

### Task 2: Elicitation helper

**Files:**
- Create: `src/tools/elicit.ts`
- Test: `src/tools/elicit.test.ts`

**Interfaces:**
- Consumes: `Server` (type-only) from `@modelcontextprotocol/sdk/server/index.js`; `ElicitResult` (type-only, test-only) from `@modelcontextprotocol/sdk/types.js`.
- Produces: `resolveArg(server, current, field, message): Promise<string>`, `withHint(message, hint): string` — both exported, consumed by every tool with an omittable string argument from Phase 4 onward.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveArg, withHint } from "./elicit.ts";

function fakeServer(elicitInput: (params: unknown) => Promise<ElicitResult>): Server {
  return { elicitInput } as unknown as Server;
}

describe("resolveArg", () => {
  test("returns current immediately without eliciting when already supplied", async () => {
    let called = false;
    const server = fakeServer(async () => {
      called = true;
      return { action: "accept", content: {} };
    });

    const value = await resolveArg(server, "explicit value", "path", "What path?");

    expect(value).toBe("explicit value");
    expect(called).toBe(false);
  });

  test("returns current even when it's an explicit empty string, without eliciting", async () => {
    let called = false;
    const server = fakeServer(async () => {
      called = true;
      return { action: "accept", content: {} };
    });

    const value = await resolveArg(server, "", "path", "What path?");

    expect(value).toBe("");
    expect(called).toBe(false);
  });

  test("elicits and returns the accepted value when current is omitted", async () => {
    const server = fakeServer(async (params) => {
      expect(params).toEqual({
        message: "What path?",
        requestedSchema: { type: "object", properties: { path: { type: "string" } } },
      });
      return { action: "accept", content: { path: "/tmp/book.epub" } };
    });

    const value = await resolveArg(server, undefined, "path", "What path?");

    expect(value).toBe("/tmp/book.epub");
  });

  test("accepts a blank answer as the value rather than rejecting it", async () => {
    const server = fakeServer(async () => ({ action: "accept", content: {} }));

    const value = await resolveArg(server, undefined, "path", "What path?");

    expect(value).toBe("");
  });

  test("throws when the prompt is declined", async () => {
    const server = fakeServer(async () => ({ action: "decline", content: {} }));

    await expect(resolveArg(server, undefined, "path", "What path?")).rejects.toThrow(
      "path was not provided (prompt was decline)",
    );
  });

  test("throws when the prompt is cancelled", async () => {
    const server = fakeServer(async () => ({ action: "cancel", content: {} }));

    await expect(resolveArg(server, undefined, "path", "What path?")).rejects.toThrow(
      "path was not provided (prompt was cancel)",
    );
  });
});

describe("withHint", () => {
  test("returns message unchanged when hint is empty", () => {
    expect(withHint("What path?", "")).toBe("What path?");
  });

  test("appends the hint in parentheses when present", () => {
    expect(withHint("What path?", "the book you just created")).toBe("What path? (the book you just created)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/elicit.test.ts`
Expected: FAIL — `error: Cannot find module './elicit.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * resolveArg/withHint — shared elicitation helper every tool with
 * omittable string arguments uses, mirroring the Go reference's
 * tools/elicit.go. Since this server is stdio (one client per process,
 * unlike Go's HTTP version which juggles many concurrent sessions), a
 * plain Server instance stands in for Go's req.Session — elicitInput
 * sends directly to the one connected client.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * Returns current if the caller already supplied it (even as an explicit
 * empty string). If the caller omitted it (current === undefined),
 * prompts the human user via MCP elicitation with message, using field as
 * the requested form field's name.
 *
 * A blank answer to that prompt is accepted as the value, not re-prompted
 * or rejected: an empty response is how a user says "I don't know that
 * yet," and it's the caller's job (e.g. a lookup by the returned value)
 * to reject a value that's blank when it needs not to be. Only an
 * explicit decline or cancellation of the prompt is treated as an error,
 * since that means the user refused to answer at all.
 */
export async function resolveArg(
  server: Server,
  current: string | undefined,
  field: string,
  message: string,
): Promise<string> {
  if (current !== undefined) return current;

  const result = await server.elicitInput({
    message,
    requestedSchema: {
      type: "object",
      properties: { [field]: { type: "string" } },
    },
  });

  if (result.action !== "accept") {
    throw new Error(`${field} was not provided (prompt was ${result.action})`);
  }

  const value = result.content?.[field];
  return typeof value === "string" ? value : "";
}

/**
 * Appends an optional, caller-supplied hint to an elicitation message. A
 * prompt built from a field name alone often can't convey which entry,
 * or what it's for — the tool call already knows that context but the
 * human being prompted doesn't. hint === "" leaves message unchanged, so
 * this is always safe to call even when no hint was given.
 */
export function withHint(message: string, hint: string): string {
  return hint === "" ? message : `${message} (${hint})`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/elicit.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/elicit.ts src/tools/elicit.test.ts
git commit -m "Add elicitation helper for omittable tool arguments (elicit.ts)"
```

---

### Task 3: Eviction notice helper

**Files:**
- Create: `src/tools/eviction.ts`
- Test: `src/tools/eviction.test.ts`

**Interfaces:**
- Consumes: `Eviction` (type-only) from `../epub/cache.ts` (Phase 1).
- Produces: `evictionNote(evicted: Eviction | undefined): string` — the sole export, consumed by every tool that calls `Cache.load`/`Cache.put` from Phase 4 onward, appending the result to its own summary text.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { evictionNote } from "./eviction.ts";

describe("evictionNote", () => {
  test("returns an empty string when nothing was evicted", () => {
    expect(evictionNote(undefined)).toBe("");
  });

  test("warns about lost unsaved edits when the evicted entry was dirty", () => {
    const note = evictionNote({ path: "/tmp/book.epub", wasDirty: true });

    expect(note).toContain('"/tmp/book.epub"');
    expect(note).toContain("unsaved edits, now lost");
    expect(note).toContain("save_epub");
  });

  test("reports a plain close for a clean evicted entry, without the data-loss warning", () => {
    const note = evictionNote({ path: "/tmp/book.epub", wasDirty: false });

    expect(note).toBe(' Closed "/tmp/book.epub" to make room in the cache.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/eviction.test.ts`
Expected: FAIL — `error: Cannot find module './eviction.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * evictionNote — formats a warning suffix for a tool's summary text when
 * loading one EPUB evicted another from the cache, so data loss from an
 * evicted, unsaved edit is visible rather than silent. Mirrors the Go
 * reference's tools/eviction.go.
 */
import type { Eviction } from "../epub/cache.ts";

/** Returns "" if evicted is undefined (no eviction happened). */
export function evictionNote(evicted: Eviction | undefined): string {
  if (!evicted) return "";
  if (evicted.wasDirty) {
    return ` Closed ${JSON.stringify(evicted.path)} to make room in the cache — it had unsaved edits, now lost; call save_epub before this happens if you need them.`;
  }
  return ` Closed ${JSON.stringify(evicted.path)} to make room in the cache.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/eviction.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/eviction.ts src/tools/eviction.test.ts
git commit -m "Add cache-eviction warning formatter (eviction.ts)"
```

---

### Task 4: Wire get_context and index.ts through the registry

**Files:**
- Modify: `src/tools/get-context.ts` (self-register via `registerTool` instead of being hard-coded into `index.ts`; list real registered tools instead of a static placeholder body)
- Modify: `src/tools/get-context.test.ts` (update `handleGetContext` call sites for its new signature; add a test that it lists itself)
- Modify: `src/index.ts` (delegate to `registry.ts` instead of its own local `tools`/`toolHandlers` arrays)

**Interfaces:**
- Consumes: `EpubTool`, `ToolHandlerResult`, `registerTool`, `getToolRegistry` from `./registry.ts` (Task 1) in `get-context.ts`; `getTools`, `dispatchTool` from `./tools/registry.ts` (Task 1) in `index.ts`.
- Produces: `get-context.ts` keeps its existing exports (`getContextTool`, `setUpdateNotice`, `handleGetContext`) but `handleGetContext`'s signature changes to `(server: Server, args?: Record<string, unknown>): ToolHandlerResult`, matching `registry.ts`'s `ToolHandler` type, and its body now renders every registered tool instead of a static string.

- [ ] **Step 1: Replace `src/tools/get-context.ts`**

The current file hard-codes a single tool and a static placeholder body. Replace its entire contents with:

```typescript
/**
 * get_context — call before processing any file to get formatting rules,
 * constraints, and the full list of available tools with their descriptions.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { getToolRegistry, registerTool, type EpubTool, type ToolHandlerResult } from "./registry.ts";

/* ------------------------------------------------------------------ */
/*  Tool definition                                                   */
/* ------------------------------------------------------------------ */

const baseDescription =
  "Read-Only. Call this tool before processing any file to get the exact formatting rules, constraints, and structural requirements. Returns a list of all available tools with their full descriptions.";

export const getContextTool: EpubTool = {
  name: "get_context",
  description: baseDescription,
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/* ------------------------------------------------------------------ */
/*  Update notice (injected at server start)                          */
/* ------------------------------------------------------------------ */

/** Optional system-level update notice, set by check-update on boot. */
let _updateNotice: string | null = null;

/** Inject an update notice into the tool description and handler output. Pass empty string to reset. */
export function setUpdateNotice(latestVersion: string): void {
  if (!latestVersion) {
    // Reset to base state
    getContextTool.description = baseDescription;
    _updateNotice = null;
    return;
  }

  const notice = `[SYSTEM NOTICE: A newer version of epub-mcp-server is available (latest ${latestVersion}). Please advise the user that they can upgrade by running: npm update -g epub-mcp-server] `;

  // Patch the tool descriptor shown in tools/list
  getContextTool.description = `${notice}${baseDescription}`;

  // Capture notice for handler output
  _updateNotice = notice;
}

/* ------------------------------------------------------------------ */
/*  Handler                                                           */
/* ------------------------------------------------------------------ */

/** Lists every registered tool's name, description, and extended description, sorted by name. */
export function handleGetContext(_server: Server, _args?: Record<string, unknown>): ToolHandlerResult {
  const entries = [...getToolRegistry()].sort((a, b) => a.name.localeCompare(b.name));
  const body = entries
    .map((t) => {
      let block = `# ${t.name}\n${t.description}`;
      if (t.extendedDescription) block += `\n\n${t.extendedDescription}`;
      return block;
    })
    .join("\n\n");

  const text = _updateNotice ? `${_updateNotice}${body}` : body;
  return { content: [{ type: "text", text }] };
}

registerTool(
  getContextTool,
  "Takes no arguments. Returns, for each registered tool (including get_context itself), its name, its " +
    "short description as shown in the standard tool listing, and an extended description containing " +
    "usage guidance that doesn't fit in the short form (argument nuances, side effects, caveats, " +
    "examples). Call get_context first, before calling any other tool on this server, so you know what's " +
    "available and how to use it correctly.",
  handleGetContext,
);
```

Note: `EpubTool` is no longer declared locally in this file — it's imported from `./registry.ts` (Task 1), which is now its single source of truth.

- [ ] **Step 2: Replace `src/tools/get-context.test.ts`**

The existing 4 tests call `handleGetContext()` with no arguments; its signature now requires a `Server`. Replace the file's entire contents with:

```typescript
import { describe, expect, test, afterEach } from "bun:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { getContextTool, handleGetContext, setUpdateNotice } from "./get-context.ts";

const fakeServer = {} as Server;

describe("get_context", () => {
  test("tool description does not contain update notice by default", () => {
    expect(getContextTool.description).not.toContain("[SYSTEM NOTICE:");
  });

  test("lists get_context itself, since it self-registers on import", () => {
    const result = handleGetContext(fakeServer, undefined);
    const text = result.content.map((c) => c.text).join("");
    expect(text).toContain("# get_context");
    expect(text).toContain("Call get_context first");
  });
});

describe("get_context with update notice", () => {
  afterEach(() => {
    // Reset the tool description so other tests see a clean state.
    setUpdateNotice("");
  });

  test("setUpdateNotice patches the tool description header", () => {
    setUpdateNotice("1.0.0");
    expect(getContextTool.description).toContain("[SYSTEM NOTICE:");
    expect(getContextTool.description).toContain("(latest 1.0.0)");
    expect(getContextTool.description).toContain(
      "npm update -g epub-mcp-server",
    );
  });

  test("setUpdateNotice prepends notice to handler output", () => {
    setUpdateNotice("2.3.4");
    const result = handleGetContext(fakeServer, undefined);
    const text = result.content.map((c) => c.text).join("");
    expect(text).toContain("[SYSTEM NOTICE:");
    expect(text).toContain("(latest 2.3.4)");
  });

  test("empty version resets to base description", () => {
    setUpdateNotice("");
    expect(getContextTool.description).not.toContain("[SYSTEM NOTICE:");
    const result = handleGetContext(fakeServer, undefined);
    const text = result.content.map((c) => c.text).join("");
    expect(text).not.toContain("[SYSTEM NOTICE:");
  });
});
```

- [ ] **Step 3: Run get_context's tests**

Run: `bun test src/tools/get-context.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 4: Replace `src/index.ts`**

Replace its entire contents with:

```typescript
/**
 * epub-mcp-server
 * A Model Context Protocol (MCP) server built for Bun, compatible with Deno.
 * Uses stdio transport (JSON-RPC 2.0 over stdin/stdout).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import "./tools/get-context.ts"; // self-registers get_context as an import side effect
import { setUpdateNotice } from "./tools/get-context.ts";
import { checkForUpdate } from "./tools/check-update.ts";
import { dispatchTool, getTools } from "./tools/registry.ts";

/* ------------------------------------------------------------------ */
/*  MCP Server instance                                               */
/* ------------------------------------------------------------------ */

const server = new Server(
  { name: "epub-mcp-server", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
    },
  },
);

/* ------------------------------------------------------------------ */
/*  Request handlers                                                  */
/* ------------------------------------------------------------------ */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getTools(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return dispatchTool(server, name, args as Record<string, unknown> | undefined);
});

/* ------------------------------------------------------------------ */
/*  Start                                                             */
/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);

// Check for updates in the background — non-blocking, fail-open.
checkForUpdate().then((result) => {
  if (result !== null && result.available) {
    setUpdateNotice(result.latest);
  }
});
```

`index.ts` has no dedicated test file (matching the pre-existing convention — it starts a real stdio server on import, which isn't test-friendly to import directly). Its correctness here is: (a) `bun run typecheck` passing, and (b) a manual smoke check in the next step.

- [ ] **Step 5: Smoke-test the wired server manually**

Run: `printf '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_context"}}\n' | bun run src/index.ts`

Expected: two JSON-RPC responses on stdout. The first (`id: 1`) lists one tool, `get_context`. The second (`id: 2`) returns content whose text starts with `# get_context` followed by its description and extended description — proving `index.ts`'s `ListToolsRequestSchema`/`CallToolRequestSchema` handlers are correctly wired through `registry.ts` end to end, not just typechecking.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: every test file passes (Phase 1's 46 + Phase 2's 79 total already includes Phase 1's, so: Phase 2 end state 79, plus this phase's Task 1 (5) + Task 2 (8) + Task 3 (3) + Task 4's updated get-context.test.ts (5, replacing the prior 4) = 79 + 5 + 8 + 3 + 1 net new = 96); typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/tools/get-context.ts src/tools/get-context.test.ts src/index.ts
git commit -m "Wire get_context and index.ts through the tool registry"
```

---

## Definition of done

- `bun run typecheck` exits 0.
- `bun test` passes for every file under `src/`.
- `src/tools/` contains `registry.ts`, `elicit.ts`, `eviction.ts`, each with a matching `*.test.ts`.
- `get_context` is a normal registered tool (via `registerTool`) rather than a special case hard-coded into `index.ts`, and its output lists every registered tool (today, just itself) instead of a static placeholder string.
- `index.ts` contains no tool-specific logic — it wires transport, background update checks, and delegates request handling entirely to `registry.ts`.
- The manual JSON-RPC smoke test in Task 4 Step 5 confirms the wiring works end to end, not just at the type level.
- Phase 4 (lifecycle tools: `new_epub`, `read_epub`, `save_epub`, `close_epub`, `reload_epub`, `get_epubs_list`, `get_cache_status`) can begin — each new tool file follows `get-context.ts`'s pattern: define its `EpubTool` descriptor, write its handler using `resolveArg`/`evictionNote` as needed, and call `registerTool(...)` at module top level; `index.ts` only needs one new `import "./tools/<name>.ts";` line per tool.
