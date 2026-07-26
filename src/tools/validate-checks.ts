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
import { manifestItemByHref, manifestItemById, ncxItem, proseSpineDocuments, resolveHref } from "../epub/resolve.ts";
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
 */
function tocDocumentOrder(points: NavPoint[]): string[] {
  const flat = flattenPoints(points).map((p) => stripFragment(p.href));
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
  const toc = tocDocumentOrder(list.items);
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

    const archivePath = stripFragment(point.href);
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
  const tocPairs = flattenPoints(list.items).map((p) => `${p.label} ${stripFragment(p.href)}`);
  const ncxPairs = flattenNCX(ncx.navMap).map((p) => `${p.label} ${stripFragment(p.src)}`);
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
          point.href,
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
        point.src,
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
