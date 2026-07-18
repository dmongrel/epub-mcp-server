/**
 * get_guide — read the legacy EPUB 2 guide landmarks. Mirrors Go's
 * tools/get_guide.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage } from "../epub/resolve.ts";

interface GetGuideArgs {
  path: string;
}

export const getGuideTool: EpubTool = {
  name: "get_guide",
  description: "Read the legacy EPUB 2 guide landmarks of an already-read EPUB, if it has any. Read-only.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" } },
    required: ["path"],
  },
};

export async function handleGetGuide(_server: Server, args: GetGuideArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const references = pkg.guide?.references.map((r) => ({ type: r.type, title: r.title || undefined, href: r.href })) ?? [];
  const structuredContent: Record<string, unknown> = { present: pkg.guide !== undefined };
  if (pkg.guide) structuredContent.references = references;

  const summary = `Read guide of ${JSON.stringify(abs)} (${references.length} references).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getGuideTool,
  'Takes path, the same .epub filesystem path passed to read_epub. Returns present (false if the package ' +
    'document has no <guide> element at all) and references, each a type (e.g. "cover", "toc", "text", ' +
    '"bibliography"), optional title, and href (an archive path, possibly with a "#fragment"). This is a ' +
    "legacy structure superseded by EPUB 3 navigation landmarks (part of get_navigation), kept only for " +
    "older reading systems; most modern novels don't need it.",
  handleGetGuide as never,
);
