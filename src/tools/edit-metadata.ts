/**
 * edit_metadata — create, edit, or remove one entry of the Dublin
 * Core / EPUB metadata. Mirrors Go's tools/edit_metadata.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { contains, findIndex, removeAt, verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { ArchiveId, Package } from "../epub/types.ts";

const METADATA_FIELDS = [
  "identifier", "title", "language", "creator", "contributor",
  "publisher", "date", "subject", "description", "rights", "meta",
];

interface EditMetadataArgs {
  action?: string;
  path?: string;
  field: string;
  id?: string;
  value?: string;
  scheme?: string;
  type?: string;
  role?: string;
  fileAs?: string;
  lang?: string;
  event?: string;
  code?: string;
  property?: string;
  refines?: string;
  metaName?: string;
}

export const editMetadataTool: EpubTool = {
  name: "edit_metadata",
  description: "Create, edit, or remove one entry of an already-read EPUB's Dublin Core / EPUB metadata. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" a new entry, "edit" an existing one, or "remove" one' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      field: { type: "string", description: "which metadata list to affect: identifier, title, language, creator, contributor, publisher, date, subject, description, rights, or meta" },
      id: { type: "string", description: "id of the entry to edit/remove, from get_metadata (ignored by create; for the publisher field, use the exact current publisher text as the id instead)" },
      value: { type: "string", description: "the entry's primary text; ignored by remove" },
      scheme: { type: "string", description: 'identifier scheme (e.g. "UUID", "ISBN") or subject authority' },
      type: { type: "string", description: 'title type, e.g. "main", "subtitle", "collection" (title field only)' },
      role: { type: "string", description: 'creator/contributor MARC relator code, e.g. "aut", "trl", "ill"' },
      fileAs: { type: "string", description: "sort-friendly form of a creator/contributor name" },
      lang: { type: "string", description: "xml:lang for a title/creator/contributor entry" },
      event: { type: "string", description: 'date event, e.g. "publication", "modification"' },
      code: { type: "string", description: "subject authority-specific term code" },
      property: { type: "string", description: 'EPUB 3 meta property, e.g. "belongs-to-collection" (meta field only)' },
      refines: { type: "string", description: 'IDREF this meta refines, e.g. "#bookid" (meta field only)' },
      metaName: { type: "string", description: 'legacy EPUB 2 meta name attribute, e.g. "calibre:series" (meta field only)' },
    },
    required: ["field"],
  },
};

export async function handleEditMetadata(server: Server, args: EditMetadataArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const field = args.field;
  if (!field?.trim()) throw new Error(`field is required — must be one of ${METADATA_FIELDS.join(", ")}`);
  if (!contains(METADATA_FIELDS, field)) throw new Error(`field must be one of ${METADATA_FIELDS.join(", ")}, got ${JSON.stringify(field)}`);
  if (action !== "create" && action !== "edit" && action !== "remove") {
    throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  const isScalar = field === "description" || field === "rights";

  let id = "";
  if (!isScalar && action !== "create") {
    id = await resolveArg(server, args.id, "id", "Which entry? Provide its id from get_metadata (or, for publisher, its exact text).");
  }

  let value = "";
  if (action !== "remove") {
    value = await resolveArg(server, args.value, "value", "What should this entry's value be?");
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  const resultId = applyMetadataEdit(pkg, action, field, id, value, args);

  epubCache.markDirty(abs);
  const summary = `${verbPast(action)}d ${field} ${JSON.stringify(resultId)} in ${JSON.stringify(abs)}. Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: { action, field, id: resultId } };
}

function applyMetadataEdit(pkg: Package, action: string, field: string, id: string, value: string, args: EditMetadataArgs): string {
  const m = pkg.metadata;

  switch (field) {
    case "description":
      m.description = action === "remove" ? "" : value;
      return "description";
    case "rights":
      m.rights = action === "remove" ? "" : value;
      return "rights";
    case "publisher":
      switch (action) {
        case "create": {
          if (findIndex(m.publishers, value, (v) => v) >= 0) throw new Error(`publisher ${JSON.stringify(value)} already exists; use action "edit" instead`);
          m.publishers.push(value);
          return value;
        }
        case "edit": {
          const i = findIndex(m.publishers, id, (v) => v);
          if (i < 0) throw new Error(`no publisher ${JSON.stringify(id)}`);
          m.publishers[i] = value;
          return value;
        }
        case "remove": {
          const i = findIndex(m.publishers, id, (v) => v);
          if (i < 0) throw new Error(`no publisher ${JSON.stringify(id)}`);
          m.publishers = removeAt(m.publishers, i);
          return id;
        }
      }
      break;
    case "identifier":
      return editList(m.identifiers, action, id, m.id, "identifier", (v) => v.id, (elId) => ({ id: elId, scheme: args.scheme ?? "", value }), (list) => (m.identifiers = list));
    case "title":
      return editList(m.titles, action, id, m.id, "title", (v) => v.id, (elId) => ({ id: elId, value, type: args.type ?? "", lang: args.lang ?? "" }), (list) => (m.titles = list));
    case "language":
      return editList(m.languages, action, id, m.id, "language", (v) => v.id, (elId) => ({ id: elId, value }), (list) => (m.languages = list));
    case "creator":
      return editList(m.creators, action, id, m.id, "creator", (v) => v.id, (elId) => ({ id: elId, name: value, role: args.role ?? "", fileAs: args.fileAs ?? "", lang: args.lang ?? "" }), (list) => (m.creators = list));
    case "contributor":
      return editList(m.contributors, action, id, m.id, "contributor", (v) => v.id, (elId) => ({ id: elId, name: value, role: args.role ?? "", fileAs: args.fileAs ?? "", lang: args.lang ?? "" }), (list) => (m.contributors = list));
    case "date":
      return editList(m.dates, action, id, m.id, "date", (v) => v.id, (elId) => ({ id: elId, value, event: args.event ?? "" }), (list) => (m.dates = list));
    case "subject":
      return editList(m.subjects, action, id, m.id, "subject", (v) => v.id, (elId) => ({ id: elId, value, scheme: args.scheme ?? "", code: args.code ?? "" }), (list) => (m.subjects = list));
    case "meta":
      return editList(m.metas, action, id, m.id, "meta", (v) => v.id, (elId) => ({ id: elId, property: args.property ?? "", refines: args.refines ?? "", scheme: args.scheme ?? "", value, name: args.metaName ?? "" }), (list) => (m.metas = list));
  }

  throw new Error(`unknown field ${JSON.stringify(field)}`);
}

/**
 * Implements create/edit/remove for one id-addressed metadata array
 * field, generic over its element type T. setList writes the new array
 * back onto the owning Metadata field (TS has no equivalent of Go's
 * `*[]T` in-place slice mutation via a pointer, so the caller supplies a
 * setter instead).
 */
function editList<T extends { id: ArchiveId }>(
  list: T[],
  action: string,
  id: string,
  metaId: ArchiveId,
  name: string,
  getId: (item: T) => string,
  build: (elId: ArchiveId) => T,
  setList: (list: T[]) => void,
): string {
  switch (action) {
    case "create": {
      for (const existing of list) {
        const candidate = build(existing.id);
        if (deepEqual(candidate, existing)) {
          throw new Error(`${name} ${JSON.stringify(existing.id)} already has this exact content; use action "edit" instead`);
        }
      }
      const elId = `${metaId}/${name}[${list.length}]`;
      setList([...list, build(elId)]);
      return elId;
    }
    case "edit": {
      const i = findIndex(list, id, getId);
      if (i < 0) throw new Error(`no ${name} with id ${JSON.stringify(id)}`);
      const next = [...list];
      next[i] = build(id);
      setList(next);
      return id;
    }
    case "remove": {
      const i = findIndex(list, id, getId);
      if (i < 0) throw new Error(`no ${name} with id ${JSON.stringify(id)}`);
      setList(removeAt(list, i));
      return id;
    }
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
}

/** Relies on every call site constructing object literals with the same key order as their type's declared field order in ../epub/types.ts — JSON.stringify is key-order-sensitive. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

registerTool(
  editMetadataTool,
  'Takes action ("create", "edit", or "remove") and path, both of which are optional — omitting one ' +
    "triggers an elicitation prompt. field is required and must always be provided; it is not prompted for " +
    "and instead returns a clear error if omitted.\n\nfield selects which metadata list is affected: " +
    "identifier, title, language, creator, contributor, publisher, date, subject, meta (all list-valued, " +
    "addressed by id from get_metadata), or description/rights (scalar, id ignored). The publisher list " +
    "has no ids of its own — use the exact current publisher text as id for edit/remove. edit replaces the " +
    "whole entry (value and every attribute given), so pass the current value back if only an attribute is " +
    "changing. Secondary attributes (scheme, role, fileAs, lang, event, code, property, refines, metaName) " +
    "are optional and apply only to the fields they're documented against above; omitting one clears " +
    "it.\n\ncreate never touches an existing entry — it only appends a brand-new one, so it cannot be used " +
    "to update content that's already there. Call get_metadata first to check whether the entry you want " +
    'already exists; if it does, use action "edit" (addressed by its id) instead of "create", which would ' +
    "otherwise leave a duplicate alongside it. create fails outright if value and every given attribute " +
    "exactly match an existing entry in the same field. Only touches the in-memory cache; call save_epub " +
    "afterwards to persist.",
  handleEditMetadata as never,
);
