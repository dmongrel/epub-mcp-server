// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * The checks behind validate_epub: pure functions over an already-loaded
 * Epub that report what's wrong with it and never change it.
 *
 * Two rules hold for every check in this file. First, a defect is a finding,
 * not an exception — a check throws only for input no valid Epub could
 * produce, and a book with no package document is rejected by the tool
 * before any check runs. Second, every finding carries a remedy naming the
 * tool and arguments that would fix it, so the caller can act on the report
 * rather than infer the repair.
 *
 * Checks deliberately overlap as little as possible. Where one condition
 * would trip several, the narrower check stays quiet and lets the one that
 * owns the condition report it — tocLabelHeadingMismatch ignores an entry
 * whose target doesn't exist, for instance, because danglingHref reports it.
 */
import { primaryNavigation } from "./get-navigation.ts";
import { archiveIdInUse } from "./edit-resource.ts";
import { chapterNumberFromLabel, deriveTocLabel } from "../epub/labels.ts";
import { backCoverGuideRef, manifestItemByHref, manifestItemById, navItem, ncxItem, proseSpineDocuments, resolveHref } from "../epub/resolve.ts";
import { plainText } from "../epub/text.ts";
import { validateXHTML } from "../epub/validate.ts";
import type { Epub, ManifestItem, NCXNavPoint, NavList, NavPoint, Package } from "../epub/types.ts";

/** One problem validate_epub found, with the tool call that would fix it. */
export interface ValidateEpubFinding {
  /** The name of the check that produced this finding, e.g. "toc-spine-order". */
  check: string;
  /** "error" means the book is broken; "warning" means it's suspect but may be deliberate. */
  severity: "error" | "warning";
  /** What is wrong, naming the specific values involved. */
  message: string;
  /** Affected archive paths and structure ids, for the caller to act on. */
  ids: string[];
  /** A sentence naming the tool and arguments that fix it. */
  remedy: string;
}

export type Check = (e: Epub, pkg: Package) => ValidateEpubFinding[];

/** Drops an href's "#fragment", leaving the archive path it targets. */
function stripFragment(href: string): string {
  const i = href.indexOf("#");
  return i === -1 ? href : href.slice(0, i);
}

/** Returns the primary navigation document's "toc" list, or undefined if the book has neither. */
function tocList(e: Epub, pkg: Package): NavList | undefined {
  try {
    return primaryNavigation(e, pkg).lists.find((l) => l.type === "toc");
  } catch {
    return undefined; // missingNav reports a book with no navigation document
  }
}

/** Flattens a NavPoint tree into document order, parents before their children. */
function flattenPoints(points: NavPoint[]): NavPoint[] {
  const out: NavPoint[] = [];
  for (const p of points) {
    out.push(p);
    out.push(...flattenPoints(p.children));
  }
  return out;
}

/** Flattens an NCX navMap into document order, parents before their children. */
function flattenNCX(points: NCXNavPoint[]): NCXNavPoint[] {
  const out: NCXNavPoint[] = [];
  for (const p of points) {
    out.push(p);
    out.push(...flattenNCX(p.children));
  }
  return out;
}

/**
 * The archive paths a toc reaches, in document order, with fragments
 * stripped and consecutive repeats collapsed. Both normalizations matter for
 * comparing a toc against the spine: nesting is a presentation choice that
 * shouldn't count as disorder, and a chapter subdivided into several
 * fragment entries ("#part1", "#part2") is still one document in the spine.
 *
 * NavPoint hrefs are stored relative to pkg.baseDir, so they're resolved to
 * archive paths here — otherwise every comparison against a spine or manifest
 * path is a string mismatch on any book whose package document isn't at the
 * archive root.
 */
function tocDocumentOrder(pkg: Package, points: NavPoint[]): string[] {
  const flat = flattenPoints(points).map((p) => resolveHref(pkg, p.href));
  return flat.filter((href, i) => href !== "" && href !== flat[i - 1]);
}

/**
 * The table of contents must reach every prose document in the spine, reach
 * nothing else, and reach them in the same order — the property that makes
 * "chapter 5" mean one thing across the toc, find_text, and a reader's
 * progress bar.
 */
export const tocSpineOrder: Check = (e, pkg) => {
  const list = tocList(e, pkg);
  if (!list) return [];

  const spine = proseSpineDocuments(e, pkg).map((d) => d.archivePath);
  const toc = tocDocumentOrder(pkg, list.items);
  const spineSet = new Set(spine);
  const tocSet = new Set(toc);
  const findings: ValidateEpubFinding[] = [];

  const extra = toc.filter((href) => !spineSet.has(href));
  if (extra.length > 0) {
    findings.push({
      check: "toc-spine-order",
      severity: "error",
      message: `${extra.length} table-of-contents entr(ies) target something that is not a prose document in the spine: ${extra.join(", ")}.`,
      ids: extra,
      remedy: 'Rerun convert_manuscript to rebuild the table of contents from the spine, or call edit_navigation with action "remove" on each stale entry.',
    });
  }

  const missing = spine.filter((href) => !tocSet.has(href));
  if (missing.length > 0) {
    findings.push({
      check: "toc-spine-order",
      severity: "error",
      message: `${missing.length} prose document(s) in the spine have no table-of-contents entry: ${missing.join(", ")}.`,
      ids: missing,
      remedy: 'Rerun convert_manuscript to rebuild the table of contents from the spine, or call edit_navigation with action "create" for each missing document.',
    });
  }

  // Order is compared over the intersection only, so a missing or extra
  // entry doesn't also register as every following chapter being misplaced.
  const tocCommon = toc.filter((href) => spineSet.has(href));
  const spineCommon = spine.filter((href) => tocSet.has(href));
  if (tocCommon.some((href, i) => href !== spineCommon[i])) {
    findings.push({
      check: "toc-spine-order",
      severity: "error",
      message: `The table of contents lists chapters in a different order than the spine. Spine order: ${spineCommon.join(", ")}. Table-of-contents order: ${tocCommon.join(", ")}.`,
      ids: tocCommon,
      remedy: "Rerun convert_manuscript to rebuild the table of contents from the spine, or reorder the entries with edit_navigation.",
    });
  }

  return findings;
};

/**
 * A toc entry labelled "Chapter 5" must point at a document whose own
 * heading also says chapter 5. This is the misalignment that survives every
 * structural check: manifest, spine, and toc all internally consistent,
 * every href resolving, and the book still numbered wrong for a reader.
 */
export const tocLabelHeadingMismatch: Check = (e, pkg) => {
  const list = tocList(e, pkg);
  if (!list) return [];

  const findings: ValidateEpubFinding[] = [];
  for (const point of flattenPoints(list.items)) {
    const labelNumber = chapterNumberFromLabel(point.label);
    if (labelNumber === 0) continue;

    const archivePath = resolveHref(pkg, point.href);
    const doc = e.contentDocuments[archivePath];
    if (!doc) continue; // danglingHref reports this

    const headingNumber = chapterNumberFromLabel(deriveTocLabel(doc.markup, archivePath));
    if (headingNumber === 0 || headingNumber === labelNumber) continue;

    findings.push({
      check: "toc-label-heading-mismatch",
      severity: "error",
      message: `Table-of-contents entry ${JSON.stringify(point.label)} points at ${archivePath}, whose own heading reads "Chapter ${headingNumber}".`,
      ids: [point.id, archivePath],
      remedy: `Rerun convert_manuscript to rebuild the table of contents, or call edit_navigation with action "edit" on ${JSON.stringify(point.id)} to relabel the entry, or edit_chapter with action "edit" on ${JSON.stringify(archivePath)} to correct the heading.`,
    });
  }
  return findings;
};

/**
 * Chapter numbers read from prose documents' own headings should run 1, 2,
 * 3... in spine order. A warning rather than an error: unnumbered front
 * matter, interludes, and books that genuinely start at chapter 0 are all
 * legitimate, and only gaps, repeats, and backwards jumps are reported.
 */
export const chapterNumberSequence: Check = (e, pkg) => {
  const numbered: Array<{ archivePath: string; number: number }> = [];
  for (const doc of proseSpineDocuments(e, pkg)) {
    const number = chapterNumberFromLabel(deriveTocLabel(doc.markup, doc.archivePath));
    if (number > 0) numbered.push({ archivePath: doc.archivePath, number });
  }

  const findings: ValidateEpubFinding[] = [];

  const byNumber = new Map<number, string[]>();
  for (const c of numbered) {
    const paths = byNumber.get(c.number) ?? [];
    paths.push(c.archivePath);
    byNumber.set(c.number, paths);
  }
  for (const [number, paths] of [...byNumber].sort((a, b) => a[0] - b[0])) {
    if (paths.length < 2) continue;
    findings.push({
      check: "chapter-number-sequence",
      severity: "warning",
      message: `Chapter ${number} appears in ${paths.length} documents: ${paths.join(", ")}.`,
      ids: paths,
      remedy: 'Call edit_chapter with action "edit" to renumber the duplicate heading(s), then rerun convert_manuscript to rebuild the table of contents.',
    });
  }

  for (let i = 1; i < numbered.length; i++) {
    const prev = numbered[i - 1]!;
    const cur = numbered[i]!;
    if (cur.number === prev.number || cur.number === prev.number + 1) continue;
    if (cur.number < prev.number) {
      findings.push({
        check: "chapter-number-sequence",
        severity: "warning",
        message: `Chapter ${cur.number} (${cur.archivePath}) comes after chapter ${prev.number} (${prev.archivePath}) in the spine.`,
        ids: [prev.archivePath, cur.archivePath],
        remedy: 'Reorder the reading order with edit_spine, or renumber the heading with edit_chapter action "edit".',
      });
    } else {
      findings.push({
        check: "chapter-number-sequence",
        severity: "warning",
        message: `Chapter numbering jumps from ${prev.number} (${prev.archivePath}) to ${cur.number} (${cur.archivePath}) — ${cur.number - prev.number - 1} number(s) missing.`,
        ids: [prev.archivePath, cur.archivePath],
        remedy: 'Add the missing chapter(s) with edit_chapter action "create" or convert_manuscript, or renumber the heading with edit_chapter action "edit".',
      });
    }
  }

  return findings;
};

/**
 * A book carrying the legacy EPUB 2 NCX for older reading systems must keep
 * it saying the same thing as the EPUB 3 navigation document, or the same
 * book navigates differently depending on what opens it.
 */
export const ncxTocDivergence: Check = (e, pkg) => {
  const item = ncxItem(pkg);
  if (!item) return [];
  const ncx = e.nCXs[resolveHref(pkg, item.href)];
  if (!ncx) return []; // manifestMissingFile reports this
  const list = tocList(e, pkg);
  if (!list) return [];

  // Compared as label+target pairs in document order, so a divergence in any
  // of label, target, or order is caught by one comparison.
  const tocPairs = flattenPoints(list.items).map((p) => `${p.label} ${resolveHref(pkg, p.href)}`);
  const ncxPairs = flattenNCX(ncx.navMap).map((p) => `${p.label} ${resolveHref(pkg, p.src)}`);
  if (tocPairs.length === ncxPairs.length && tocPairs.every((v, i) => v === ncxPairs[i])) return [];

  return [
    {
      check: "ncx-toc-divergence",
      severity: "warning",
      message: `The legacy NCX (${ncx.id}) has ${ncxPairs.length} entr(ies), which differ from the navigation document's ${tocPairs.length} table-of-contents entr(ies) in label, target, or order.`,
      ids: [ncx.id, list.id],
      remedy: "Any convert_manuscript or edit_navigation call regenerates the NCX from the table of contents; rerun one of them to bring the two back into agreement.",
    },
  ];
};

/** Strips the "<manifest id>/" prefix from a ManifestItem's ArchiveId, leaving the bare opf:id a spine itemref's idRef would name. */
function manifestOpfId(pkg: Package, item: ManifestItem): string {
  const prefix = pkg.manifest.id + "/";
  return item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
}

/**
 * Every navigational target — table of contents, NCX, guide, landmarks —
 * must name a file the archive actually contains. A dangling target is a
 * dead link in the reader's table of contents, and it hides other problems:
 * checks that compare a toc entry against its document can't run at all.
 */
export const danglingHref: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  const report = (source: string, id: string, target: string, remedy: string): void => {
    const path = stripFragment(target);
    if (path === "" || archiveIdInUse(e, path)) return;
    findings.push({
      check: "dangling-href",
      severity: "error",
      message: `${source} ${JSON.stringify(id)} targets ${JSON.stringify(target)}, which is not a file in this EPUB.`,
      ids: [id],
      remedy,
    });
  };

  try {
    for (const list of primaryNavigation(e, pkg).lists) {
      for (const point of flattenPoints(list.items)) {
        report(
          `Navigation ${JSON.stringify(list.type)} entry`,
          point.id,
          resolveHref(pkg, point.href),
          `Call edit_navigation with action "remove" on ${JSON.stringify(point.id)}, or add the missing file with edit_chapter or edit_resource.`,
        );
      }
    }
  } catch {
    // missingNav reports a book with no navigation document
  }

  const item = ncxItem(pkg);
  const ncx = item ? e.nCXs[resolveHref(pkg, item.href)] : undefined;
  if (ncx) {
    for (const point of flattenNCX(ncx.navMap)) {
      report(
        "NCX navPoint",
        point.id || ncx.id,
        resolveHref(pkg, point.src),
        "Any convert_manuscript or edit_navigation call regenerates the NCX from the table of contents, dropping targets the table of contents no longer has.",
      );
    }
  }

  for (const ref of pkg.guide?.references ?? []) {
    report(
      "Guide reference",
      ref.id,
      resolveHref(pkg, ref.href),
      `Call edit_guide with action "remove" on ${JSON.stringify(ref.id)}, or add the missing file with edit_chapter or edit_resource.`,
    );
  }

  return findings;
};

/** Every spine entry must name a manifest item; one that doesn't places a file that doesn't exist into the reading order. */
export const spineMissingManifestItem: Check = (_e, pkg) => {
  const findings: ValidateEpubFinding[] = [];
  for (const ref of pkg.spine.itemRefs) {
    if (manifestItemById(pkg, ref.idRef)) continue;
    findings.push({
      check: "spine-missing-manifest-item",
      severity: "error",
      message: `Spine entry ${JSON.stringify(ref.id)} references manifest item id ${JSON.stringify(ref.idRef)}, which does not exist.`,
      ids: [ref.id],
      remedy: `Call edit_spine with action "remove" on ${JSON.stringify(ref.id)}, or edit_manifest with action "create" to add an item with id ${JSON.stringify(ref.idRef)}.`,
    });
  }
  return findings;
};

/** Every manifest item must correspond to a file in the archive — the manifest is the exhaustive list of what the rendition contains, so an entry for a file that isn't there makes the package invalid. */
export const manifestMissingFile: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];
  for (const item of pkg.manifest.items) {
    const path = resolveHref(pkg, item.href);
    if (path !== "" && archiveIdInUse(e, path)) continue;
    findings.push({
      check: "manifest-missing-file",
      severity: "error",
      message: `Manifest item ${JSON.stringify(item.id)} points at ${JSON.stringify(item.href)}, which is not a file in this EPUB.`,
      ids: [item.id],
      remedy: `Call edit_manifest with action "remove" on ${JSON.stringify(item.id)}, or supply the missing file with edit_resource or edit_chapter.`,
    });
  }
  return findings;
};

/**
 * Every content document should be listed in the manifest and placed in the
 * spine. One that isn't still ships inside the archive but no linear read
 * ever reaches it — usually a chapter half-removed, or one added without its
 * wiring. A warning, since a document deliberately reached only by an
 * internal link (a footnotes page) is legitimate.
 */
export const orphanContentDocument: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  const inSpine = new Set<string>();
  for (const ref of pkg.spine.itemRefs) {
    const item = manifestItemById(pkg, ref.idRef);
    if (item) inSpine.add(resolveHref(pkg, item.href));
  }

  for (const path of Object.keys(e.contentDocuments).sort()) {
    const item = manifestItemByHref(pkg, path);
    if (!item) {
      findings.push({
        check: "orphan-content-document",
        severity: "warning",
        message: `Content document ${path} is not listed in the manifest, so it is not part of this rendition.`,
        ids: [path],
        remedy: `Call edit_manifest with action "create" to list it, or edit_chapter with action "remove" on ${JSON.stringify(path)} to delete it.`,
      });
      continue;
    }
    if (inSpine.has(path)) continue;
    findings.push({
      check: "orphan-content-document",
      severity: "warning",
      message: `Content document ${path} is in the manifest but not the spine, so a linear read never reaches it.`,
      ids: [path],
      remedy: `Call edit_spine with action "create" to place it in the reading order, or edit_chapter with action "remove" on ${JSON.stringify(path)} to delete it.`,
    });
  }

  return findings;
};

/**
 * Reduces an ArchiveId to the bare opf:id it carries, so a reference
 * written as a plain opf:id ("bookid") can be matched against a modelled
 * id carrying its owner's path and element name ("content.opf#metadata/
 * identifier[bookid]", per fragId in parse.ts) without this file having to
 * know how each layer composes them.
 */
function idTail(id: string): string {
  const i = id.lastIndexOf("[");
  const j = id.lastIndexOf("]");
  if (i === -1 || j === -1 || j < i) return id;
  return id.slice(i + 1, j);
}

/** Manifest ids, spine entries, and manifest hrefs must each be unique — a duplicate makes every reference to it ambiguous, and which one wins is up to the reading system. */
export const duplicateId: Check = (_e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  const repeated = (values: string[]): string[] => {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts].filter(([, n]) => n > 1).map(([v]) => v).sort();
  };

  for (const id of repeated(pkg.manifest.items.map((i) => i.id))) {
    findings.push({
      check: "duplicate-id",
      severity: "error",
      message: `Manifest id ${JSON.stringify(id)} is used by more than one item.`,
      ids: [id],
      remedy: `Call edit_manifest with action "remove" on the redundant item, or action "edit" to give it a distinct id.`,
    });
  }

  for (const idRef of repeated(pkg.spine.itemRefs.map((r) => r.idRef))) {
    findings.push({
      check: "duplicate-id",
      severity: "error",
      message: `The spine places manifest item ${JSON.stringify(idRef)} into the reading order more than once.`,
      ids: [idRef],
      remedy: `Call edit_spine with action "remove" on the redundant entry.`,
    });
  }

  for (const href of repeated(pkg.manifest.items.map((i) => resolveHref(pkg, i.href)))) {
    findings.push({
      check: "duplicate-id",
      severity: "error",
      message: `More than one manifest item points at ${href}.`,
      ids: [href],
      remedy: `Call edit_manifest with action "remove" on the redundant item.`,
    });
  }

  return findings;
};

/** Content and navigation documents must be well-formed XHTML, or a reading system may refuse to render them at all. */
export const malformedXHTML: Check = (e, _pkg) => {
  const findings: ValidateEpubFinding[] = [];

  for (const path of Object.keys(e.contentDocuments).sort()) {
    try {
      validateXHTML(e.contentDocuments[path]!.markup);
    } catch (err) {
      findings.push({
        check: "malformed-xhtml",
        severity: "error",
        message: `Content document ${path} is not well-formed XHTML: ${(err as Error).message}`,
        ids: [path],
        remedy: `Call edit_chapter with action "edit" on ${JSON.stringify(path)} and corrected markup.`,
      });
    }
  }

  for (const path of Object.keys(e.navigation).sort()) {
    try {
      validateXHTML(e.navigation[path]!.markup);
    } catch (err) {
      findings.push({
        check: "malformed-xhtml",
        severity: "error",
        message: `Navigation document ${path} is not well-formed XHTML: ${(err as Error).message}`,
        ids: [path],
        remedy: "Any edit_navigation or convert_manuscript call re-renders the navigation document from its structured lists, replacing the broken markup.",
      });
    }
  }

  return findings;
};

/** EPUB 3 requires a navigation document, and it must be findable: declared with properties="nav" in the manifest and present in the archive. */
export const missingNav: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  const item = navItem(pkg);
  if (!item) {
    findings.push({
      check: "missing-nav",
      severity: "error",
      message: 'No manifest item is marked properties="nav", so this book has no EPUB 3 navigation document and no table of contents.',
      ids: [pkg.manifest.id],
      remedy: 'Call edit_manifest with action "edit" to add the "nav" property to the navigation document\'s item, or edit_navigation to build one.',
    });
  } else if (!e.navigation[resolveHref(pkg, item.href)]) {
    findings.push({
      check: "missing-nav",
      severity: "error",
      message: `The manifest item marked as the navigation document (${item.id}) points at ${resolveHref(pkg, item.href)}, which is not a navigation document in this EPUB.`,
      ids: [item.id],
      remedy: `Call edit_manifest with action "edit" on ${JSON.stringify(item.id)} to point it at the real navigation document.`,
    });
  }

  if (pkg.spine.tocRef !== "" && !manifestItemById(pkg, pkg.spine.tocRef)) {
    findings.push({
      check: "missing-nav",
      severity: "error",
      message: `The spine's toc attribute names manifest item ${JSON.stringify(pkg.spine.tocRef)}, which does not exist.`,
      ids: [pkg.spine.id],
      remedy: `Call edit_manifest with action "create" to add the legacy NCX item ${JSON.stringify(pkg.spine.tocRef)}, or edit_spine with action "edit" to clear the toc attribute.`,
    });
  }

  return findings;
};

/** dc:identifier, dc:title, and dc:language are required by the spec, and the package's unique-identifier must name one of the identifiers actually present. */
export const missingMetadata: Check = (_e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  const requireField = (present: boolean, element: string, field: string): void => {
    if (present) return;
    findings.push({
      check: "missing-metadata",
      severity: "error",
      message: `This book has no ${element}, which EPUB requires.`,
      ids: [pkg.metadata.id],
      remedy: `Call edit_metadata with action "create" and field ${JSON.stringify(field)}.`,
    });
  };

  requireField(pkg.metadata.identifiers.length > 0, "dc:identifier", "identifier");
  requireField(pkg.metadata.titles.length > 0, "dc:title", "title");
  requireField(pkg.metadata.languages.length > 0, "dc:language", "language");

  if (pkg.uniqueIdentifierRef === "") {
    findings.push({
      check: "missing-metadata",
      severity: "error",
      message: "The package's unique-identifier attribute is not set, so no identifier is marked as this book's canonical one.",
      ids: [pkg.id],
      remedy: 'Call edit_metadata with action "create" and field "identifier" to add an identifier, which sets the package\'s unique-identifier to match.',
    });
  } else if (!pkg.metadata.identifiers.some((ident) => idTail(ident.id) === pkg.uniqueIdentifierRef)) {
    findings.push({
      check: "missing-metadata",
      severity: "error",
      message: `The package's unique-identifier names ${JSON.stringify(pkg.uniqueIdentifierRef)}, which is not one of this book's ${pkg.metadata.identifiers.length} identifier(s).`,
      ids: [pkg.id],
      remedy: 'Call edit_metadata with action "edit" and field "identifier" on an existing identifier from get_metadata, passing its current value back, which repoints the package\'s unique-identifier at it.',
    });
  }

  return findings;
};

/** A spine with no entries has no reading order at all — EPUB 3 requires at least one itemref, and a reading system has nothing to open. */
export const emptySpine: Check = (_e, pkg) => {
  if (pkg.spine.itemRefs.length > 0) return [];
  return [
    {
      check: "empty-spine",
      severity: "error",
      message: "This book's spine has no entries, so it has no reading order. EPUB 3 requires at least one.",
      ids: [pkg.spine.id],
      remedy: 'Call edit_chapter with action "create", or convert_manuscript, to add a chapter.',
    },
  ];
};

/** A declared cover must resolve to a file that exists, or the book shows up in a library with a broken thumbnail. */
export const coverImageMissing: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];

  for (const item of pkg.manifest.items) {
    if (!item.properties.includes("cover-image")) continue;
    const path = resolveHref(pkg, item.href);
    if (archiveIdInUse(e, path)) continue;
    findings.push({
      check: "cover-image-missing",
      severity: "warning",
      message: `Manifest item ${JSON.stringify(item.id)} is marked as the cover image but points at ${path}, which is not a file in this EPUB.`,
      ids: [item.id],
      remedy: 'Call edit_cover with action "create" and a sourcePath to supply the image, or edit_manifest to remove the item.',
    });
  }

  for (const meta of pkg.metadata.metas) {
    if (meta.name !== "cover" || meta.value === "") continue;
    if (manifestItemById(pkg, meta.value)) continue;
    findings.push({
      check: "cover-image-missing",
      severity: "warning",
      message: `The legacy cover meta names manifest item ${JSON.stringify(meta.value)}, which does not exist.`,
      ids: [meta.id],
      remedy: "Call edit_cover to set a cover, which rewrites the legacy meta to match, or edit_metadata to remove the stale meta.",
    });
  }

  return findings;
};

/**
 * This server's own invariant: insertChapter places new chapters before the
 * back cover (see spineInsertionIndexBeforeBackCover) so a back cover stays
 * the last thing a linear read reaches. A back cover that isn't last means
 * something bypassed that, and readers hit the back cover mid-book.
 */
export const backCoverNotLast: Check = (_e, pkg) => {
  const ref = backCoverGuideRef(pkg);
  if (!ref) return [];

  const path = resolveHref(pkg, ref.href);
  const item = manifestItemByHref(pkg, path);
  if (!item) return []; // danglingHref reports this

  const opfId = manifestOpfId(pkg, item);
  const index = pkg.spine.itemRefs.findIndex((r) => r.idRef === opfId);
  if (index === -1) {
    return [
      {
        check: "back-cover-not-last",
        severity: "warning",
        message: `The back cover (${path}) is not in the spine, so a linear read never reaches it.`,
        ids: [path],
        remedy: 'Call edit_spine with action "create" to place it at the end of the reading order.',
      },
    ];
  }
  if (index === pkg.spine.itemRefs.length - 1) return [];

  return [
    {
      check: "back-cover-not-last",
      severity: "warning",
      message: `The back cover (${path}) is spine entry ${index + 1} of ${pkg.spine.itemRefs.length}, not the last one, so readers reach it before the end of the book.`,
      ids: [path],
      remedy: 'Call edit_spine with action "remove" on the back cover\'s entry, then action "create" to re-add it at the end of the reading order.',
    },
  ];
};

/** A prose document with no readable text is almost always a leftover stub or a chapter whose content failed to land. */
export const emptyChapter: Check = (e, pkg) => {
  const findings: ValidateEpubFinding[] = [];
  for (const doc of proseSpineDocuments(e, pkg)) {
    if (plainText(doc.markup).trim() !== "") continue;
    findings.push({
      check: "empty-chapter",
      severity: "warning",
      message: `Chapter ${doc.archivePath} has no readable text.`,
      ids: [doc.archivePath],
      remedy: `Call edit_chapter with action "edit" on ${JSON.stringify(doc.archivePath)} to give it content, or action "remove" to delete it.`,
    });
  }
  return findings;
};

/**
 * Every check validate_epub can run, keyed by the name it reports findings
 * under. Insertion order is the order findings are reported in, so the
 * alignment checks a caller most likely acted on come first.
 */
export const CHECKS: Record<string, Check> = {
  "toc-spine-order": tocSpineOrder,
  "toc-label-heading-mismatch": tocLabelHeadingMismatch,
  "chapter-number-sequence": chapterNumberSequence,
  "ncx-toc-divergence": ncxTocDivergence,
  "dangling-href": danglingHref,
  "spine-missing-manifest-item": spineMissingManifestItem,
  "manifest-missing-file": manifestMissingFile,
  "orphan-content-document": orphanContentDocument,
  "duplicate-id": duplicateId,
  "malformed-xhtml": malformedXHTML,
  "missing-nav": missingNav,
  "missing-metadata": missingMetadata,
  "empty-spine": emptySpine,
  "cover-image-missing": coverImageMissing,
  "back-cover-not-last": backCoverNotLast,
  "empty-chapter": emptyChapter,
};
