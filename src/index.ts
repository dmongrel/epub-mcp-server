/**
 * epub-mcp-server
 * A Model Context Protocol (MCP) server built for Bun, compatible with Deno.
 * Uses stdio transport (JSON-RPC 2.0 over stdin/stdout).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { getContextTool, handleGetContext } from "./tools/get-context.ts";
import { checkForUpdate } from "./tools/check-update.ts";
import { setUpdateNotice } from "./tools/get-context.ts";

/* ------------------------------------------------------------------ */
/*  MCP Server instance                                               */
/* ------------------------------------------------------------------ */

const server = new Server(
  { name: "epub-mcp-server", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
    },
  },
);

/* ------------------------------------------------------------------ */
/*  Tool definitions                                                  */
/* ------------------------------------------------------------------ */

interface EpubTool {
  name: string;
  description: string;
  inputSchema: object;
}

const tools: EpubTool[] = [getContextTool];

/* ------------------------------------------------------------------ */
/*  Request handlers                                                  */
/* ------------------------------------------------------------------ */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

type HandlerResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const toolHandlers: Record<
  string,
  (args: Record<string, unknown> | undefined) => HandlerResult | Promise<HandlerResult>
> = {
  get_context: () => handleGetContext(),
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const handler = toolHandlers[name];
  if (handler) {
    return await handler(args as Record<string, unknown> | undefined);
  }

  // Unknown tool
  return {
    content: [
      {
        type: "text",
        text: `Unknown tool: ${name}. Available tools: ${tools.map((t) => t.name).join(", ")}`,
      },
    ],
    isError: true,
  };
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
