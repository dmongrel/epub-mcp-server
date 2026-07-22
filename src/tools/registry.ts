// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

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

export type ToolHandlerResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

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
  if (toolHandlers[tool.name]) {
    throw new Error(`Tool "${tool.name}" is already registered`);
  }
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

