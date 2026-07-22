// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * Chapter-lifecycle <-> navigation syncing: keeps the "toc" nav list
 * (and legacy NCX, if present) up to date as chapters are created or
 * removed via edit_chapter (Phase 6), without requiring a separate
 * edit_navigation call for the common case. Mirrors Go's
 * tools/nav_sync.go.
 *
 * syncTocOnChapterCreate/syncTocOnChapterRemove are deliberately
 * best-effort (boolean return, no throw): a book with no EPUB 3
 * navigation document has nothing to sync, and that's not an error
 * condition for the chapter create/remove that triggered the sync
 * attempt — it's simply skipped. This means catching primaryNavigation's
 * throw internally and converting it to a false return, rather than
 * propagating per this codebase's usual throw-only convention (which
 * governs MCP tool handlers' error-vs-user contract, not every internal
 * helper's own contract). syncTocOnChapterCreate's second catch, around
 * findOrCreateNavList(nav, "toc", "create"), is currently unreachable —
 * that function only throws for a non-"create" third argument — but is
 * kept as defensive symmetry in case that contract ever changes.
 */
import { removeAt } from "./idlist.ts";
import { primaryNavigation } from "./get-navigation.ts";
import { bookTitle, bookUID, findOrCreateNavList, renumberNavPoints, toNCXPoints } from "./edit-navigation.ts";
import { ncxItem, resolveHref } from "../epub/resolve.ts";
import { renderNavigationDocument, renderNCXDocument } from "../epub/render-nav.ts";
import type { Epub, NavList, NavPoint, Navigation, Package } from "../epub/types.ts";

/** Appends a top-level "toc" entry for archivePath, best-effort. Returns whether the sync happened. */
export function syncTocOnChapterCreate(e: Epub, pkg: Package, archivePath: string, label: string): boolean {
  let nav: Navigation;
  try {
    nav = primaryNavigation(e, pkg);
  } catch {
    return false;
  }
  let list: NavList;
  try {
    list = findOrCreateNavList(nav, "toc", "create");
  } catch {
    return false;
  }
  const resolvedLabel = label || defaultChapterLabel(archivePath);
  list.items.push({ id: "", label: resolvedLabel, href: archivePath, type: "", children: [] });
  renumberNavPoints(list.id, list.items);
  syncNavRender(e, pkg, nav, list);
  return true;
}

/** Deletes the top-level "toc" entry targeting archivePath, if any. Best-effort. Returns whether an entry was found and removed. */
export function syncTocOnChapterRemove(e: Epub, pkg: Package, archivePath: string): boolean {
  let nav: Navigation;
  try {
    nav = primaryNavigation(e, pkg);
  } catch {
    return false;
  }
  for (const list of nav.lists) {
    if (list.type !== "toc") continue;
    const [items, ok] = removeNavPointByHref(list.items, archivePath);
    if (!ok) return false;
    list.items = items;
    renumberNavPoints(list.id, list.items);
    syncNavRender(e, pkg, nav, list);
    return true;
  }
  return false;
}

/** Re-renders nav's markup and, if the book also has a legacy NCX, regenerates it from list's current items — the same pairing edit_navigation performs after every structural change to the toc list. */
export function syncNavRender(e: Epub, pkg: Package, nav: Navigation, list: NavList): void {
  const docTitle = bookTitle(pkg);
  renderNavigationDocument(nav, docTitle);
  const item = ncxItem(pkg);
  if (item) {
    const ncx = e.nCXs[resolveHref(pkg, item.href)];
    if (ncx) {
      ncx.navMap = toNCXPoints(list.items);
      renderNCXDocument(ncx, docTitle, bookUID(pkg));
    }
  }
}

/** Derives a human-readable toc label from an archive path's file name, e.g. "text/chapter-18.xhtml" -> "Chapter 18", for create calls that don't supply an explicit label. */
export function defaultChapterLabel(archivePath: string): string {
  let name = archivePath;
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot > 0) name = name.slice(0, dot);
  name = name.replace(/[-_]/g, " ");
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Untitled";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Deletes the first top-level NavPoint in points whose href matches href, reporting whether one was found. Doesn't recurse into children, since syncTocOnChapterCreate only ever inserts top-level entries. */
function removeNavPointByHref(points: NavPoint[], href: string): [NavPoint[], boolean] {
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.href === href) return [removeAt(points, i), true];
  }
  return [points, false];
}

