// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * edit_spine — add, change, or remove one entry of an already-read EPUB's
 * reading order. Mirrors Go's tools/edit_spine.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolveArg } from "./elicit.ts";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import { findIndex, removeAt, verbPast } from "./idlist.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { manifestItemByHref, primaryPackage, spineInsertionIndexBeforeBackCover } from "../epub/resolve.ts";
import type { Package, SpineItemRef } from "../epub/types.ts";

interface EditSpineArgs {
  action?: string;
  path?: string;
  id?: string;
  linear?: string;
  properties?: string;
  position?: string;
  pageProgressionDirection?: string;
}

interface EditSpineResult {
  action: string;
  id: string;
  index: number;
}

export const editSpineTool: EpubTool = {
  name: "edit_spine",
  description: "Add, change, or remove one entry of an already-read EPUB's reading order (spine). Changing.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: 'what to do: "create" adds an existing manifest item to the reading order, "edit" changes an entry already in it, or "remove" takes one out' },
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      id: { type: "string", description: "archive path of the manifest item (chapter or resource) this entry targets" },
      linear: { type: "string", description: '"true" or "false"; omit to leave unchanged (edit) or default to true (create)' },
      properties: { type: "string", description: 'space-separated itemref properties, e.g. "page-spread-left"; omit to leave unchanged (edit) or unset (create); pass "none" to clear on edit' },
      position: { type: "string", description: "0-based index to insert/move this entry to; omit to append at the end (create) — or just before the back cover, if the book has one — or to leave its position unchanged (edit)" },
      pageProgressionDirection: { type: "string", description: 'if given, sets the spine\'s page-progression-direction ("ltr" or "rtl") regardless of action' },
    },
  },
};

/** Returns items with v inserted at index at, without mutating items. */
export function insertAt<T>(items: T[], at: number, v: T): T[] {
  return [...items.slice(0, at), v, ...items.slice(at)];
}

/** Clamps p into [0, length]. */
export function clampPosition(p: number, length: number): number {
  if (p < 0) return 0;
  if (p > length) return length;
  return p;
}

/** Refreshes every SpineItemRef's id to reflect its current position. */
export function renumberSpine(pkg: Package): void {
  pkg.spine.itemRefs.forEach((ref, i) => {
    ref.id = `${pkg.spine.id}/itemref[${i}]`;
  });
}

function spineIndexFor(pkg: Package, id: string): { index: number; opfId: string; item: ReturnType<typeof manifestItemByHref> } {
  const item = manifestItemByHref(pkg, id);
  if (!item) return { index: -1, opfId: "", item: undefined };
  const prefix = pkg.manifest.id + "/";
  const opfId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
  const index = findIndex(pkg.spine.itemRefs, opfId, (r) => r.idRef);
  return { index, opfId, item };
}

export async function handleEditSpine(server: Server, args: EditSpineArgs): Promise<ToolHandlerResult> {
  const action = await resolveArg(server, args.action, "action", 'What should be done: "create", "edit", or "remove"?');
  const path = await resolveArg(server, args.path, "path", "Which .epub file should be edited? Provide its filesystem path.");
  const id = await resolveArg(server, args.id, "id", "Which manifest item (archive path) should this spine entry target?");

  let position: number | undefined;
  if (args.position) {
    const p = Number.parseInt(args.position, 10);
    if (Number.isNaN(p)) throw new Error(`position must be an integer, got ${JSON.stringify(args.position)}`);
    position = p;
  }

  const abs = resolve(path);
  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);

  if (args.pageProgressionDirection) pkg.spine.pageProgressionDirection = args.pageProgressionDirection;

  let result: EditSpineResult;
  switch (action) {
    case "create":
      result = createSpineEntry(pkg, id, args.linear ?? "", args.properties ?? "", position);
      break;
    case "edit":
      result = editSpineEntry(pkg, id, args.linear ?? "", args.properties ?? "", position);
      break;
    case "remove":
      result = removeSpineEntry(pkg, id);
      break;
    default:
      throw new Error(`action must be "create", "edit", or "remove", got ${JSON.stringify(action)}`);
  }

  epubCache.markDirty(abs);
  const summary = `${verbPast(action)}d spine entry ${JSON.stringify(result.id)} in ${JSON.stringify(abs)} (index ${result.index}). Call save_epub to persist this to disk.${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

function createSpineEntry(pkg: Package, id: string, linear: string, properties: string, position: number | undefined): EditSpineResult {
  const { index, opfId, item } = spineIndexFor(pkg, id);
  if (!item) throw new Error(`no manifest item with archive path ${JSON.stringify(id)}; call get_manifest to list valid ids`);
  if (index >= 0) throw new Error(`${JSON.stringify(id)} is already in the spine at index ${index}; use action "edit" instead`);

  const ref: SpineItemRef = { id: "", idRef: opfId, linear: linear !== "false", properties: [] };
  if (properties && properties !== "none") ref.properties = properties.split(/\s+/).filter(Boolean);

  const at = position !== undefined ? clampPosition(position, pkg.spine.itemRefs.length) : spineInsertionIndexBeforeBackCover(pkg);
  pkg.spine.itemRefs = insertAt(pkg.spine.itemRefs, at, ref);
  renumberSpine(pkg);

  return { action: "create", id, index: at };
}

function editSpineEntry(pkg: Package, id: string, linear: string, properties: string, position: number | undefined): EditSpineResult {
  const { index, item } = spineIndexFor(pkg, id);
  if (!item) throw new Error(`no manifest item with archive path ${JSON.stringify(id)}; call get_manifest to list valid ids`);
  if (index < 0) throw new Error(`${JSON.stringify(id)} is not in the spine; use action "create" instead`);

  const ref = { ...pkg.spine.itemRefs[index]! };
  if (linear) ref.linear = linear !== "false";
  if (properties === "none") ref.properties = [];
  else if (properties) ref.properties = properties.split(/\s+/).filter(Boolean);

  pkg.spine.itemRefs = removeAt(pkg.spine.itemRefs, index);
  const at = position !== undefined ? clampPosition(position, pkg.spine.itemRefs.length) : index;
  pkg.spine.itemRefs = insertAt(pkg.spine.itemRefs, at, ref);
  renumberSpine(pkg);

  return { action: "edit", id, index: at };
}

function removeSpineEntry(pkg: Package, id: string): EditSpineResult {
  const { index, item } = spineIndexFor(pkg, id);
  if (!item) throw new Error(`no manifest item with archive path ${JSON.stringify(id)}; call get_manifest to list valid ids`);
  if (index < 0) throw new Error(`${JSON.stringify(id)} is not in the spine`);
  pkg.spine.itemRefs = removeAt(pkg.spine.itemRefs, index);
  renumberSpine(pkg);
  return { action: "remove", id, index };
}

registerTool(
  editSpineTool,
  'Takes action ("create", "edit", or "remove"), path, and id; any of these may be omitted to be prompted ' +
    "for (see edit_chapter's description for the general elicitation rules every edit_ tool follows). id " +
    "names a manifest item by its archive path (see get_manifest) — this tool only reorders/retargets the " +
    "reading order, it doesn't create or delete the underlying chapter or resource (use edit_chapter/" +
    'edit_resource/edit_cover for that).\n\naction "create": adds id to the spine at position if given, ' +
    "otherwise appended at the end — or, if the book has a back cover (see edit_back_cover), just before " +
    "it, so the back cover stays the last thing a linear read reaches. create only ever adds a brand-new entry — it never updates one that's " +
    'already in the reading order, so it fails outright if id is already there; use "edit" instead to ' +
    'change its linear/properties/position.\n\naction "edit": id must already be in the spine; updates ' +
    'linear/properties/position as given, leaving anything omitted unchanged.\n\naction "remove": takes id ' +
    "out of the spine's reading order; the manifest item itself is untouched, so it still exists as a " +
    "resource, just no longer read in default order.\n\npageProgressionDirection, if given, always updates " +
    "the spine's direction regardless of action. Only touches the in-memory cache; call save_epub " +
    "afterwards to persist.",
  handleEditSpine as never,
);

