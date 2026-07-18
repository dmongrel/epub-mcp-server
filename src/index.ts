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
