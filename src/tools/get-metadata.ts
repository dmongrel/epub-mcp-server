/**
 * get_metadata — read the full Dublin Core / EPUB metadata. Mirrors Go's
 * tools/get_metadata.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { Metadata } from "../epub/types.ts";

interface GetMetadataArgs {
  path: string;
}

export const getMetadataTool: EpubTool = {
  name: "get_metadata",
  description: "Read the full Dublin Core / EPUB metadata of an already-read EPUB. Read-only.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" } },
    required: ["path"],
  },
};

export function summarizeMetadata(m: Metadata): Record<string, unknown> {
  return {
    identifiers: m.identifiers.map((v) => ({ id: v.id, scheme: v.scheme || undefined, value: v.value })),
    titles: m.titles.map((v) => ({ id: v.id, value: v.value, type: v.type || undefined, lang: v.lang || undefined })),
    languages: m.languages.map((v) => ({ id: v.id, value: v.value })),
    creators: m.creators.map((v) => ({ id: v.id, name: v.name, role: v.role || undefined, fileAs: v.fileAs || undefined, lang: v.lang || undefined })),
    contributors: m.contributors.map((v) => ({ id: v.id, name: v.name, role: v.role || undefined, fileAs: v.fileAs || undefined, lang: v.lang || undefined })),
    publishers: m.publishers,
    dates: m.dates.map((v) => ({ id: v.id, value: v.value, event: v.event || undefined })),
    subjects: m.subjects.map((v) => ({ id: v.id, value: v.value, scheme: v.scheme || undefined, code: v.code || undefined })),
    description: m.description || undefined,
    rights: m.rights || undefined,
    metas: m.metas.map((v) => ({ id: v.id, property: v.property || undefined, refines: v.refines || undefined, scheme: v.scheme || undefined, value: v.value, name: v.name || undefined })),
  };
}

export async function handleGetMetadata(_server: Server, args: GetMetadataArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const structuredContent = summarizeMetadata(pkg.metadata);
  const titles = structuredContent.titles as unknown[];
  const creators = structuredContent.creators as unknown[];
  const identifiers = structuredContent.identifiers as unknown[];
  const summary = `Read metadata from ${JSON.stringify(abs)} (${titles.length} titles, ${creators.length} creators, ${identifiers.length} identifiers).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getMetadataTool,
  "Takes path, the same .epub filesystem path passed to read_epub. Returns every metadata element: " +
    "identifiers, titles, languages, creators, contributors, publishers, dates, subjects, description, " +
    "rights, and the catch-all metas list (cover reference, series/collection info, dcterms:modified, and " +
    "anything else not modeled by name above). Every list entry carries an id usable with edit_metadata's " +
    "id argument to edit or remove that specific entry. read_epub's title/creators/language fields are a " +
    "convenience summary of a subset of this data.",
  handleGetMetadata as never,
);
