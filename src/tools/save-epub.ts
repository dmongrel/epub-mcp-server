// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * save_epub — write a cached EPUB, including any edit_chapter/edit_*
 * edits, back to disk. Mirrors Go's tools/save_epub.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { writeEpub } from "../epub/write.ts";

interface SaveEpubArgs {
  path: string;
  as?: string;
}

interface SaveEpubResult {
  savedTo: string;
}

export const saveEpubTool: EpubTool = {
  name: "save_epub",
  description: "Write a cached EPUB, including any edit_chapter edits, back to disk as a .epub file. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path of the cached epub to save, as previously passed to read_epub" },
      as: { type: "string", description: "optional different filesystem path to save to instead of overwriting path" },
    },
    required: ["path"],
  },
};

export async function handleSaveEpub(_server: Server, args: SaveEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const e = epubCache.get(abs);
  if (!e) throw new Error(`${JSON.stringify(args.path)} is not currently cached; call read_epub first`);

  const dest = args.as?.trim() ? resolve(args.as) : abs;

  await writeEpub(e, dest);
  if (dest === abs) epubCache.clearDirty(abs);

  const result: SaveEpubResult = { savedTo: dest };
  const summary = `Saved ${JSON.stringify(dest)}.`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  saveEpubTool,
  "Takes path, identifying which already-cached EPUB to save (the same path used with read_epub / " +
    "edit_chapter), and an optional as path to save to a different location instead of overwriting the " +
    "original. Fails if path isn't currently cached — call read_epub first. Regenerates container.xml and " +
    "every package document (metadata, manifest, spine) from the in-memory structures, and writes every " +
    "content document, navigation document, NCX, and other resource back using its stored content " +
    "verbatim, including any edits. Writes to a temporary file in the destination directory first and " +
    "renames it into place, so a failed save never corrupts an existing file at the destination. When " +
    "saving back to path (no as given), also clears that cache entry's " +
    "unsaved-edits flag, as reported by get_cache_status; saving to a different as path leaves it set, " +
    "since path on disk still doesn't match what's in memory.\n\n" +
    "A book with no chapters is saved exactly as it is — nothing is invented to fill it. Note that EPUB 3 " +
    "requires a spine with at least one entry, so such a file is not yet valid for a reading system; add " +
    "a chapter with edit_chapter or convert_manuscript before distributing it. validate_epub reports the " +
    "condition as empty-spine.",
  handleSaveEpub as never,
);

