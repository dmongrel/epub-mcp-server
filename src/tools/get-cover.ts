// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * get_cover — read the cover image of an already-read EPUB, if it has
 * one. Mirrors Go's tools/get_cover.go.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemById, primaryPackage, resolveHref } from "../epub/resolve.ts";
import type { ManifestItem, Package } from "../epub/types.ts";

interface GetCoverArgs {
  path: string;
  sourcePath?: string;
}

export const getCoverTool: EpubTool = {
  name: "get_cover",
  description: "Read the cover image of an already-read EPUB, if it has one. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      sourcePath: { type: "string", description: "optional filesystem path to write the cover image's raw bytes to directly; if given, the response omits inline data and instead reports where the file was written" },
    },
    required: ["path"],
  },
};

/**
 * Returns the manifest item marked as the cover image, either via the
 * EPUB 3 "cover-image" manifest property or, failing that, the legacy
 * EPUB 2 meta name="cover" pointer. Returns undefined if neither is
 * present.
 */
export function findCoverItem(pkg: Package): ManifestItem | undefined {
  const byProperty = pkg.manifest.items.find((item) => item.properties.includes("cover-image"));
  if (byProperty) return byProperty;

  for (const meta of pkg.metadata.metas) {
    if (meta.name === "cover" && meta.value !== "") {
      const item = manifestItemById(pkg, meta.value);
      if (item) return item;
    }
  }
  return undefined;
}

export async function handleGetCover(_server: Server, args: GetCoverArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const item = findCoverItem(pkg);
  if (!item) {
    const summary = `${JSON.stringify(abs)} has no cover image.${evictionNote(eviction)}`;
    return { content: [{ type: "text", text: summary }], structuredContent: { present: false } };
  }

  const archivePath = resolveHref(pkg, item.href);
  const res = e.resources[archivePath];
  if (!res) throw new Error(`cover manifest item ${JSON.stringify(item.id)} resolves to ${JSON.stringify(archivePath)}, which isn't in resources`);

  const structuredContent: Record<string, unknown> = {
    present: true,
    id: archivePath,
    mediaType: res.mediaType,
    sizeBytes: res.data.length,
  };

  if (args.sourcePath) {
    await writeFile(args.sourcePath, res.data);
    structuredContent.sourcePath = args.sourcePath;
  } else {
    structuredContent.data = Buffer.from(res.data).toString("base64");
  }

  const summary = `Read cover ${JSON.stringify(archivePath)} from ${JSON.stringify(abs)} (${res.data.length} bytes, ${res.mediaType}).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getCoverTool,
  "Takes path, the same .epub filesystem path passed to read_epub. Returns present (false if the book has " +
    "no manifest item marked as the cover image), and if true, the cover's id (archive path), mediaType, " +
    "sizeBytes, and its raw bytes as base64 in data. Pass sourcePath to instead write the raw bytes " +
    "directly to that filesystem path on the machine running this server — the response then omits data " +
    "and reports sourcePath instead, avoiding sending large images through MCP.",
  handleGetCover as never,
);

