/**
 * get_resource — read one non-content manifest resource (stylesheet,
 * image, font, audio/video) by its archive-path id. Mirrors Go's
 * tools/get_resource.go.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";

interface GetResourceArgs {
  path: string;
  id: string;
  sourcePath?: string;
}

export const getResourceTool: EpubTool = {
  name: "get_resource",
  description:
    "Read one non-content manifest resource (stylesheet, image, font, audio/video) of an already-read EPUB by its id. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: 'resource id (archive path), e.g. "OEBPS/styles/style.css"' },
      sourcePath: {
        type: "string",
        description:
          "optional filesystem path to write the resource's raw bytes to directly; if given, the response omits inline text/data and instead reports where the file was written",
      },
    },
    required: ["path", "id"],
  },
};

/** Reports whether mediaType's bytes should be surfaced as a UTF-8 string rather than base64. */
export function isTextMediaType(mediaType: string): boolean {
  if (mediaType.startsWith("text/")) return true;
  return (
    mediaType === "image/svg+xml" ||
    mediaType === "application/xml" ||
    mediaType === "application/javascript" ||
    mediaType === "application/ecmascript" ||
    mediaType === "application/json"
  );
}

export async function handleGetResource(_server: Server, args: GetResourceArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  if (!args.id?.trim()) throw new Error("id is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const res = e.resources[args.id];
  if (!res) {
    throw new Error(
      `no resource with id ${JSON.stringify(args.id)} in ${JSON.stringify(abs)}; call read_epub or get_manifest to list valid ids`,
    );
  }

  const isText = isTextMediaType(res.mediaType);
  const structuredContent: Record<string, unknown> = {
    id: args.id,
    mediaType: res.mediaType,
    sizeBytes: res.data.length,
    isText,
  };

  if (args.sourcePath) {
    await writeFile(args.sourcePath, res.data);
    structuredContent.sourcePath = args.sourcePath;
  } else if (isText) {
    structuredContent.text = new TextDecoder().decode(res.data);
  } else {
    structuredContent.data = Buffer.from(res.data).toString("base64");
  }

  const summary = `Read resource ${JSON.stringify(args.id)} from ${JSON.stringify(abs)} (${res.data.length} bytes, ${res.mediaType}).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getResourceTool,
  "Takes path, the same .epub filesystem path passed to read_epub, and id, the resource's archive path. " +
    "Covers everything in the manifest that isn't a chapter (see get_chapter/edit_chapter), the navigation " +
    "document, or an NCX — stylesheets, images, fonts, audio, video, and anything else. Returns isText " +
    "(true for text media types like CSS, in which case text holds the content as a string) or, for binary " +
    "media types, data holding the raw bytes as base64. Pass sourcePath to instead write the raw bytes " +
    "directly to that filesystem path on the machine running this server — the response then omits " +
    "text/data and reports sourcePath instead, avoiding sending large binary resources through MCP. Fails " +
    "if id isn't a resource in this book; a chapter, cover, navigation, or NCX id will also fail here — use " +
    "get_chapter, get_cover, or get_navigation for those instead.",
  handleGetResource as never,
);
