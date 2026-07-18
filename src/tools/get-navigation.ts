/**
 * get_navigation — read the EPUB 3 navigation document (table of
 * contents, landmarks, page-list). Mirrors Go's tools/get_navigation.go.
 *
 * Also hosts primaryNavigation and the nav-tree-to-TOC builders
 * (navPointsToTOC/ncxPointsToTOC/tableOfContents) — shared logic
 * consumed by nav-sync.ts, edit-navigation.ts, edit-cover.ts/
 * edit-back-cover.ts (Phase 8), and read-epub.ts (Phase 7). Go defines
 * tableOfContents/navPointsToTOC/ncxPointsToTOC in read_epub.go instead;
 * relocated here since they're fundamentally about navigation trees, and
 * get_navigation needs navPointsToTOC/ncxPointsToTOC regardless — keeping
 * all three together avoids a circular file-ordering dependency between
 * this file and a not-yet-built read-epub.ts.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { ncxItem, navItem, primaryPackage, resolveHref } from "../epub/resolve.ts";
import type { Epub, NavPoint, NCXNavPoint, Navigation, Package } from "../epub/types.ts";

interface GetNavigationArgs {
  path: string;
  listType?: string;
}

export interface TocEntry {
  id: string;
  label: string;
  href?: string;
  children?: TocEntry[];
}

export const getNavigationTool: EpubTool = {
  name: "get_navigation",
  description: "Read the navigation document (table of contents, landmarks, page-list) of an already-read EPUB. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      listType: { type: "string", description: 'restrict the result to one nav list by type ("toc", "landmarks", "page-list", ...); omit for all lists' },
    },
    required: ["path"],
  },
};

/** Returns e's EPUB 3 navigation document, throwing if the book has none. */
export function primaryNavigation(e: Epub, pkg: Package): Navigation {
  const item = navItem(pkg);
  if (!item) throw new Error(`${JSON.stringify(pkg.id)} has no EPUB 3 navigation document`);
  const nav = e.navigation[resolveHref(pkg, item.href)];
  if (!nav) throw new Error(`navigation item ${JSON.stringify(item.id)} resolves to a path not in navigation`);
  return nav;
}

export function navPointsToTOC(points: NavPoint[]): TocEntry[] {
  return points.map((p) => {
    const entry: TocEntry = { id: p.id, label: p.label };
    if (p.href) entry.href = p.href;
    if (p.children.length > 0) entry.children = navPointsToTOC(p.children);
    return entry;
  });
}

export function ncxPointsToTOC(points: NCXNavPoint[]): TocEntry[] {
  return points.map((p) => {
    const entry: TocEntry = { id: p.id, label: p.label };
    if (p.src) entry.href = p.src;
    if (p.children.length > 0) entry.children = ncxPointsToTOC(p.children);
    return entry;
  });
}

/** Prefers the EPUB 3 nav document's "toc" list, falling back to the legacy NCX for EPUB 2 books. */
export function tableOfContents(e: Epub, pkg: Package): TocEntry[] | undefined {
  const item = navItem(pkg);
  if (item) {
    const nav = e.navigation[resolveHref(pkg, item.href)];
    if (nav) {
      const list = nav.lists.find((l) => l.type === "toc");
      if (list) return navPointsToTOC(list.items);
    }
  }
  const ncx = ncxItem(pkg);
  if (ncx) {
    const doc = e.nCXs[resolveHref(pkg, ncx.href)];
    if (doc) return ncxPointsToTOC(doc.navMap);
  }
  return undefined;
}

export async function handleGetNavigation(_server: Server, args: GetNavigationArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document`);
  const nav = primaryNavigation(e, pkg);

  const lists = nav.lists
    .filter((list) => !args.listType || list.type === args.listType)
    .map((list) => ({
      id: list.id,
      type: list.type || undefined,
      heading: list.heading || undefined,
      items: navPointsToTOC(list.items),
    }));

  const structuredContent = { lists, hasNcx: ncxItem(pkg) !== undefined };
  const summary = `Read navigation of ${JSON.stringify(abs)} (${lists.length} lists).${evictionNote(eviction)}`;
  return { content: [{ type: "text", text: summary }], structuredContent };
}

registerTool(
  getNavigationTool,
  "Takes path, the same .epub filesystem path passed to read_epub, and an optional listType to restrict " +
    'the result to one nav list ("toc", "landmarks", "page-list", or a custom epub:type); omit it to get ' +
    "every list the navigation document has. Each list's items form a tree of id/label/href/children " +
    'entries — the same shape as read_epub\'s tableOfContents, which is always this tool\'s "toc" list. ' +
    "hasNcx reports whether the book also has a legacy EPUB 2 NCX; if so, edit_navigation keeps it " +
    "mirroring the \"toc\" list automatically, so this tool doesn't expose it separately. Use a returned " +
    "item's id with edit_navigation to edit/remove it, or as the parent id to nest a new one under it.",
  handleGetNavigation as never,
);
