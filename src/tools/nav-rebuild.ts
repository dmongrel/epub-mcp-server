// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * Rebuilding the table of contents from scratch, as opposed to nav-sync.ts's
 * incremental append/remove.
 *
 * The incremental path is right for a single edit_chapter call, where the
 * user may have curated the toc with edit_navigation and one new chapter
 * shouldn't discard that work. It is wrong for convert_manuscript, which
 * loads a whole new book's worth of text: there the manuscript is the source
 * of truth, and any toc predating it is stale by definition. Incremental
 * syncing also drifts — syncTocOnChapterCreate appends to the end of the toc
 * while insertChapter inserts into the spine before the back cover, so the
 * two orders diverge the moment a book has a back cover.
 *
 * rebuildToc discards the "toc" list wholesale and derives a new flat one
 * from the spine. Manual nesting and hand-edited labels in that list do not
 * survive; landmarks, page-list, and custom nav lists are untouched.
 *
 * Like nav-sync.ts's helpers, this is deliberately best-effort — a book with
 * no EPUB 3 navigation document has nothing to rebuild, which is not an
 * error for the conversion that triggered it. primaryNavigation's throw is
 * caught and converted to a false return rather than propagated.
 */
import { primaryNavigation } from "./get-navigation.ts";
import { findOrCreateNavList, renumberNavPoints } from "./edit-navigation.ts";
import { syncNavRender } from "./nav-sync.ts";
import { deriveTocLabel } from "../epub/labels.ts";
import { proseSpineDocuments } from "../epub/resolve.ts";
import type { Epub, NavList, Navigation, Package } from "../epub/types.ts";

/**
 * Replaces the primary navigation document's "toc" list with one flat entry
 * per prose content document, in spine reading order, each labelled from the
 * document's own markup. Re-renders the navigation document and regenerates
 * the legacy NCX to match. Returns whether the rebuild happened.
 */
export function rebuildToc(e: Epub, pkg: Package): boolean {
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
    // Unreachable while findOrCreateNavList only throws for a non-"create"
    // third argument; kept as defensive symmetry with nav-sync.ts.
    return false;
  }

  list.items = proseSpineDocuments(e, pkg).map((doc) => ({
    id: "",
    label: deriveTocLabel(doc.markup, doc.archivePath),
    href: doc.archivePath,
    type: "",
    children: [],
  }));

  renumberNavPoints(list.id, list.items);
  syncNavRender(e, pkg, nav, list);
  return true;
}
