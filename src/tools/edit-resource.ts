/**
 * edit_resource — create, edit, or remove one non-content manifest
 * resource. Mirrors Go's tools/edit_resource.go.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemById, primaryPackage, relativeHref } from "../epub/resolve.ts";
import type { Epub, Package } from "../epub/types.ts";

interface EditResourceArgs {
  action?: string;
  path?: string;
  id?: string;
  content?: string;
  sourcePath?: string;
  mediaType?: string;
}

interface EditResourceResult {
  action: string;
  id: string;
  mediaType?: string;
  sizeBytes?: number;
}

export const editResourceTool: EpubTool = {
  name: "edit_resource",
  description:
    "Create, edit, or remove one non-content manifest resource (stylesheet, image, font, audio/video) of an already-read EPUB. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a new resource, "edit" an existing one, or "remove" one' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: "resource id: the new resource's archive path for create, or an existing one's id for edit/remove" },
      content: { type: "string", description: "the resource's new text content; used by create and edit when sourcePath isn't given, ignored by remove" },
      sourcePath: { type: "string", description: "filesystem path to a file to use as the resource's content, read directly from disk (not sent through MCP); for binary resources, pass this instead of content" },
      mediaType: { type: "string", description: 'media type, e.g. "text/css" or "image/png"; guessed from id\'s extension if omitted on create' },
    },
  },
};

/** Reports whether archivePath already names a resource, content document, navigation document, or NCX in e. */
export function archiveIdInUse(e: Epub, archivePath: string): boolean {
  return (
    archivePath in e.resources ||
    archivePath in e.contentDocuments ||
    archivePath in e.navigation ||
    archivePath in e.nCXs
  );
}

/** Guesses a resource's media type from its archive path's extension. */
export function guessResourceMediaType(archivePath: string): string {
  switch (extname(archivePath).toLowerCase()) {
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
      return "application/javascript";
    case ".xhtml":
    case ".html":
    case ".htm":
      return "application/xhtml+xml";
    case ".xml":
      return "application/xml";
    case ".ttf":
    case ".otf":
      return "application/font-sfnt";
    case ".woff":
      return "application/font-woff";
    case ".woff2":
      return "font/woff2";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".m4a":
      return "audio/mp4";
    default:
      return guessImageMediaType(archivePath);
  }
}

/** Guesses an image's media type from its archive path's extension. */
export function guessImageMediaType(archivePath: string): string {
  switch (extname(archivePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** Derives a candidate NCName manifest item id from archivePath's last segment, stripped of its extension. */
export function manifestIdCandidate(archivePath: string): string {
  const slash = archivePath.lastIndexOf("/");
  let name = slash >= 0 ? archivePath.slice(slash + 1) : archivePath;
  const dot = name.lastIndexOf(".");
  if (dot > 0) name = name.slice(0, dot);

  let out = "";
  let first = true;
  for (const ch of name) {
    if (/[a-zA-Z_]/.test(ch)) {
      out += ch;
    } else if (/[0-9]/.test(ch)) {
      if (first) out += "x";
      out += ch;
    } else {
      out += "-";
    }
    first = false;
  }
  return out || "chapter";
}

/** Returns candidate, or candidate with a numeric suffix, whichever isn't already used by a manifest item id in pkg. */
export function uniqueManifestId(pkg: Package, candidate: string): string {
  let id = candidate;
  for (let n = 2; manifestItemById(pkg, id) !== undefined; n++) {
    id = `${candidate}-${n}`;
  }
  return id;
}

export async function handleEditResource(server: Server, args: EditResourceArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const idPromptMsg =
    action === "create"
      ? 'What archive path should the new resource be saved at (e.g. "OEBPS/styles/notes.css")?'
      : "Which resource should be affected? Provide its archive path.";
  const id = await resolveArg(server, args.id, "id", idPromptMsg);

  let data = new Uint8Array(0);
  if (action !== "remove") {
    if (args.sourcePath !== undefined) {
      const sourcePath = await resolveArg(server, args.sourcePath, "sourcePath", "What is the filesystem path to the file to use as this resource's content?");
      data = await readFile(sourcePath);
    } else {
      const content = await resolveArg(server, args.content, "content", "What should this resource's content be?");
      data = new TextEncoder().encode(content);
    }
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  let result: EditResourceResult;
  switch (action) {
    case "create":
      result = createResource(e, pkg, id, data, args.mediaType ?? "");
      break;
    case "edit":
      result = editExistingResource(e, pkg, id, data, args.mediaType ?? "");
      break;
    case "remove":
      result = removeResource(e, pkg, id);
      break;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  epubCache.markDirty(abs);
  const summary = `${verbPast(action)}d resource ${JSON.stringify(result.id)} in ${JSON.stringify(abs)} (${result.sizeBytes} bytes). Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

function createResource(e: Epub, pkg: Package, id: string, data: Uint8Array, mediaType: string): EditResourceResult {
  if (archiveIdInUse(e, id)) throw new Error(`${JSON.stringify(id)} already exists in this book; use action "edit" instead`);
  const resolvedMediaType = mediaType || guessResourceMediaType(id);

  const opfId = uniqueManifestId(pkg, manifestIdCandidate(id));
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/${opfId}`,
    href: relativeHref(pkg, id),
    mediaType: resolvedMediaType,
    properties: [],
    fallback: "",
    mediaOverlay: "",
  });
  e.resources[id] = { id, mediaType: resolvedMediaType, data };

  return { action: "create", id, mediaType: resolvedMediaType, sizeBytes: data.length };
}

function editExistingResource(e: Epub, pkg: Package, id: string, data: Uint8Array, mediaType: string): EditResourceResult {
  const res = e.resources[id];
  if (!res) throw new Error(`no resource with id ${JSON.stringify(id)} in ${JSON.stringify(pkg.id)}; call get_manifest to list valid ids`);
  res.data = data;
  if (mediaType) {
    res.mediaType = mediaType;
    const item = pkg.manifest.items.find((i) => i.href === id);
    if (item) item.mediaType = mediaType;
  }
  return { action: "edit", id, mediaType: res.mediaType, sizeBytes: data.length };
}

function removeResource(e: Epub, pkg: Package, id: string): EditResourceResult {
  const res = e.resources[id];
  if (!res) throw new Error(`no resource with id ${JSON.stringify(id)} in ${JSON.stringify(pkg.id)}; call get_manifest to list valid ids`);
  const item = pkg.manifest.items.find((i) => i.href === id);
  if (item) {
    if (item.properties.includes("cover-image")) {
      throw new Error(`${JSON.stringify(id)} is the cover image; use edit_cover instead`);
    }
    pkg.manifest.items = pkg.manifest.items.filter((i) => i.id !== item.id);
  }
  const sizeBytes = res.data.length;
  delete e.resources[id];

  return { action: "remove", id, sizeBytes };
}

registerTool(
  editResourceTool,
  'Takes action ("create", "edit", or "remove"), path, id, and content; any of these may be omitted to ' +
    "be prompted for (see edit_chapter's description for the general elicitation rules every edit_ tool " +
    "follows). content is text, used as-is. For binary resources such as images or fonts, pass sourcePath " +
    "instead — a filesystem path read directly from disk on the machine running this server, never sent " +
    "through MCP as bytes; when sourcePath is given, content is ignored and not prompted for.\n\n" +
    'action "create": id is the archive path to save the new resource at. mediaType is guessed from id\'s ' +
    "file extension if omitted. Added to the manifest but not the spine (resources aren't reading " +
    "content). create only ever adds a brand-new resource — it never updates one that already exists, so " +
    'it fails outright if id already names anything; use "edit" instead to replace that resource\'s ' +
    'bytes.\n\naction "edit": id must be an existing resource id; content replaces its bytes entirely, and ' +
    'mediaType replaces its media type if given.\n\naction "remove": id must be an existing resource id; ' +
    "content is ignored. Fails if id is the book's cover image (use edit_cover instead).\n\nAll three " +
    "actions only touch the in-memory cache; call save_epub afterwards to persist.",
  handleEditResource as never,
);
