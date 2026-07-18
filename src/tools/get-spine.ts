/**
 * get_spine — read the reading order (spine) of an already-read EPUB.
 * Mirrors Go's tools/get_spine.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemById, primaryPackage, resolveHref } from "../epub/resolve.ts";

interface GetSpineArgs {
  path: string;
}

export const getSpineTool: EpubTool = {
  name: "get_spine",
  description: "Read the reading order (spine) of an already-read EPUB. Read-only.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" } },
    required: ["path"],
  },
};

export async function handleGetSpine(_server: Server, args: GetSpineArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const items = pkg.spine.itemRefs.map((ref) => {
    const item = manifestItemById(pkg, ref.idRef);
    const id = item ? resolveHref(pkg, item.href) : ref.idRef;
    return { id, linear: ref.linear, properties: ref.properties };
  });

  const structuredContent = { pageProgressionDirection: pkg.spine.pageProgressionDirection, items };
  const summary = `Read spine of ${JSON.stringify(abs)} (${items.length} entries).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getSpineTool,
  'Takes path, the same .epub filesystem path passed to read_epub. Returns pageProgressionDirection ("ltr", ' +
    '"rtl", or empty for unspecified) and items, the ordered list of manifest entries in the default reading ' +
    "order, each with its id (archive path), linear (false for auxiliary content skipped by default linear " +
    'reading, e.g. a pop-up footnote), and properties (e.g. "page-spread-left"/"page-spread-right"). This is ' +
    "the same order read_epub's contentDocuments list reflects for linear content documents, but also " +
    "includes non-linear and non-chapter entries.",
  handleGetSpine as never,
);
