/**
 * epub-mcp-server
 * A Model Context Protocol (MCP) server built for Bun, compatible with Deno.
 * Uses stdio transport (JSON-RPC 2.0 over stdin/stdout).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import "./tools/get-context.ts"; // self-registers get_context as an import side effect
import "./tools/get-resource.ts";
import "./tools/edit-resource.ts";
import "./tools/get-spine.ts";
import "./tools/edit-spine.ts";
import "./tools/get-guide.ts";
import "./tools/edit-guide.ts";
import "./tools/get-manifest.ts";
import "./tools/edit-manifest.ts";
import "./tools/get-metadata.ts";
import "./tools/edit-metadata.ts";
import "./tools/get-navigation.ts";
import "./tools/edit-navigation.ts";
import "./tools/edit-chapter.ts";
import "./tools/get-chapter.ts";
import "./tools/get-cover.ts";
import "./tools/edit-cover.ts";
import "./tools/convert-manuscript.ts";
import "./tools/read-epub.ts";
import "./tools/new-epub.ts";
import "./tools/save-epub.ts";
import "./tools/close-epub.ts";
import "./tools/reload-epub.ts";
import "./tools/get-epubs-list.ts";
import "./tools/get-cache-status.ts";
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
