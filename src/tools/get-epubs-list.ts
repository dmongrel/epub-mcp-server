// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * get_epubs_list — list .epub files in a directory. Mirrors Go's
 * tools/get_epubs_list.go.
 *
 * Uses node:fs/promises's readdir with { recursive, withFileTypes: true }
 * for both the recursive and non-recursive case, rather than hand-rolling
 * a directory walk. Empirically verified against Bun 1.3.14 on Windows
 * (see task-5-report.md): Dirent.parentPath is populated on every entry
 * in both recursive:true and recursive:false modes, so `entry.parentPath`
 * is always usable to reconstruct the entry's containing directory —
 * unlike a bare join(abs, entry.name), which would be wrong for
 * subdirectory entries in the recursive case.
 */
import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

interface GetEpubsListArgs {
  dir?: string;
  recursive?: boolean;
}

interface EpubFileInfo {
  path: string;
  sizeBytes: number;
}

export const getEpubsListTool: EpubTool = {
  name: "get_epubs_list",
  description: "List .epub files in a directory. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "directory to search for .epub files" },
      recursive: { type: "boolean", description: "search subdirectories too (default false)" },
    },
  },
};

export async function handleGetEpubsList(_server: Server, args: GetEpubsListArgs): Promise<ToolHandlerResult> {
  const dir = args.dir?.trim() ? args.dir : ".";
  const abs = resolve(dir);

  const entries = await readdir(abs, { recursive: args.recursive === true, withFileTypes: true });

  const files: EpubFileInfo[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (extname(entry.name).toLowerCase() !== ".epub") continue;
    const entryDir = "parentPath" in entry ? (entry as { parentPath: string }).parentPath : abs;
    const fullPath = join(entryDir, entry.name);
    const info = await stat(fullPath);
    files.push({ path: fullPath, sizeBytes: info.size });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  const structuredContent = { dir: abs, files };
  const summary = `Found ${files.length} .epub file(s) in ${JSON.stringify(abs)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getEpubsListTool,
  "Takes dir, the directory to search, and an optional recursive flag (default false) to also search " +
    'subdirectories. Matches files by a case-insensitive ".epub" extension only; it does not open or ' +
    "validate them. Returns each match's absolute path and size in bytes, sorted by path. Feed a returned " +
    "path straight into read_epub to parse that book.",
  handleGetEpubsList as never,
);

