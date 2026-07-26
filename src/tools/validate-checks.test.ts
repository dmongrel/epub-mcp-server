// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  chapterNumberSequence,
  danglingHref,
  duplicateId,
  manifestMissingFile,
  ncxTocDivergence,
  orphanContentDocument,
  spineMissingManifestItem,
  tocLabelHeadingMismatch,
  tocSpineOrder,
} from "./validate-checks.ts";
import { rebuildToc } from "./nav-rebuild.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { Epub } from "../epub/types.ts";

export function chapterMarkup(heading: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h2>${heading}</h2><p>Text.</p></body></html>`;
}

/** Adds a content document with a manifest item and a spine entry at the end. */
export function addDoc(e: Epub, archivePath: string, opfId: string, markup: string): void {
  const pkg = primaryPackage(e)!;
  pkg.manifest.items.push({ id: `${pkg.manifest.id}/${opfId}`, href: archivePath, mediaType: "application/xhtml+xml", properties: [], fallback: "", mediaOverlay: "" });
  pkg.spine.itemRefs.push({ id: "", idRef: opfId, linear: true, properties: [] });
  e.contentDocuments[archivePath] = { id: archivePath, mediaType: "application/xhtml+xml", markup };
}

/** A two-chapter book whose toc has been rebuilt, so every check should pass. */
export function cleanBook(title: string): Epub {
  const e = newEpub(title, "Author");
  addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1: Dawn"));
  addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2: Dusk"));
  rebuildToc(e, primaryPackage(e)!);
  return e;
}

export function tocOf(e: Epub) {
  return e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
}

describe("tocSpineOrder", () => {
  test("finds nothing wrong with a rebuilt toc", () => {
    const e = cleanBook("Order Clean");
    expect(tocSpineOrder(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a toc entry targeting nothing in the prose spine", () => {
    const e = cleanBook("Order Extra");
    tocOf(e).items.push({ id: "x", label: "Ghost", href: "text/ghost.xhtml", type: "", children: [] });

    const findings = tocSpineOrder(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "toc-spine-order", severity: "error", ids: ["text/ghost.xhtml"] });
    expect(findings[0]!.remedy).toContain("convert_manuscript");
  });

  test("reports a prose document with no toc entry", () => {
    const e = cleanBook("Order Missing");
    tocOf(e).items = tocOf(e).items.slice(0, 1);

    const findings = tocSpineOrder(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.ids).toEqual(["text/ch2.xhtml"]);
  });

  test("reports entries present in both but in a different order", () => {
    const e = cleanBook("Order Swapped");
    tocOf(e).items.reverse();

    const findings = tocSpineOrder(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("different order");
  });

  test("tolerates a nested toc and multiple fragment entries into one document", () => {
    const e = cleanBook("Order Nested");
    tocOf(e).items = [
      {
        id: "a", label: "Part One", href: "text/ch1.xhtml", type: "", children: [
          { id: "a1", label: "Chapter 1: Dawn", href: "text/ch1.xhtml#top", type: "", children: [] },
        ],
      },
      { id: "b", label: "Chapter 2: Dusk", href: "text/ch2.xhtml", type: "", children: [] },
    ];

    expect(tocSpineOrder(e, primaryPackage(e)!)).toEqual([]);
  });

  test("is a no-op for a book with no navigation document", () => {
    const e = cleanBook("Order No Nav");
    delete e.navigation["nav.xhtml"];
    const navItem = primaryPackage(e)!.manifest.items.find((i) => i.properties.includes("nav"));
    if (navItem) navItem.properties = [];

    expect(tocSpineOrder(e, primaryPackage(e)!)).toEqual([]);
  });
});

describe("tocLabelHeadingMismatch", () => {
  test("finds nothing wrong with a rebuilt toc", () => {
    const e = cleanBook("Label Clean");
    expect(tocLabelHeadingMismatch(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a toc entry whose chapter number disagrees with the document's heading", () => {
    const e = cleanBook("Label Mismatch");
    tocOf(e).items[0]!.label = "Chapter 5: Dawn";

    const findings = tocLabelHeadingMismatch(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "toc-label-heading-mismatch", severity: "error" });
    expect(findings[0]!.message).toContain("Chapter 1");
    expect(findings[0]!.ids).toContain("text/ch1.xhtml");
  });

  test("ignores entries whose label names no chapter number", () => {
    const e = cleanBook("Label Unnumbered");
    tocOf(e).items[0]!.label = "Prologue";

    expect(tocLabelHeadingMismatch(e, primaryPackage(e)!)).toEqual([]);
  });

  test("ignores an entry whose target does not exist, leaving that to dangling-href", () => {
    const e = cleanBook("Label Dangling");
    tocOf(e).items[0]!.href = "text/ghost.xhtml";

    expect(tocLabelHeadingMismatch(e, primaryPackage(e)!)).toEqual([]);
  });
});

describe("chapterNumberSequence", () => {
  test("finds nothing wrong with contiguous numbering", () => {
    const e = cleanBook("Seq Clean");
    expect(chapterNumberSequence(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a gap", () => {
    const e = newEpub("Seq Gap", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));
    addDoc(e, "text/ch4.xhtml", "ch4", chapterMarkup("Chapter 4"));

    const findings = chapterNumberSequence(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "chapter-number-sequence", severity: "warning" });
    expect(findings[0]!.message).toContain("2 number(s) missing");
  });

  test("reports a duplicate", () => {
    const e = newEpub("Seq Dupe", "Author");
    addDoc(e, "text/a.xhtml", "a", chapterMarkup("Chapter 1"));
    addDoc(e, "text/b.xhtml", "b", chapterMarkup("Chapter 1"));

    const findings = chapterNumberSequence(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.ids).toEqual(["text/a.xhtml", "text/b.xhtml"]);
  });

  test("reports chapters out of order in the spine", () => {
    const e = newEpub("Seq Backwards", "Author");
    addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2"));
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));

    const findings = chapterNumberSequence(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("comes after");
  });

  test("ignores unnumbered front matter between chapters", () => {
    const e = newEpub("Seq Front Matter", "Author");
    addDoc(e, "text/pro.xhtml", "pro", chapterMarkup("Prologue"));
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));
    addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2"));

    expect(chapterNumberSequence(e, primaryPackage(e)!)).toEqual([]);
  });
});

describe("ncxTocDivergence", () => {
  /** Gives e a legacy NCX wired into the spine and manifest, with the given navMap. */
  function addNCX(e: Epub, navMap: Array<{ label: string; src: string }>): void {
    const pkg = primaryPackage(e)!;
    pkg.spine.tocRef = "ncx";
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ncx`, href: "toc.ncx", mediaType: "application/x-dtbncx+xml", properties: [], fallback: "", mediaOverlay: "" });
    e.nCXs["toc.ncx"] = { id: "toc.ncx", markup: "", navMap: navMap.map((p, i) => ({ id: `np-${i}`, playOrder: i + 1, label: p.label, src: p.src, children: [] })) };
  }

  test("is a no-op for a book with no NCX", () => {
    const e = cleanBook("NCX Absent");
    expect(ncxTocDivergence(e, primaryPackage(e)!)).toEqual([]);
  });

  test("finds nothing wrong when the NCX matches the toc", () => {
    const e = cleanBook("NCX Match");
    addNCX(e, [{ label: "Chapter 1: Dawn", src: "text/ch1.xhtml" }, { label: "Chapter 2: Dusk", src: "text/ch2.xhtml" }]);

    expect(ncxTocDivergence(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a divergent label", () => {
    const e = cleanBook("NCX Diverged");
    addNCX(e, [{ label: "Chapter 1: Old", src: "text/ch1.xhtml" }, { label: "Chapter 2: Dusk", src: "text/ch2.xhtml" }]);

    const findings = ncxTocDivergence(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "ncx-toc-divergence", severity: "warning" });
  });

  test("reports a different entry count", () => {
    const e = cleanBook("NCX Short");
    addNCX(e, [{ label: "Chapter 1: Dawn", src: "text/ch1.xhtml" }]);

    expect(ncxTocDivergence(e, primaryPackage(e)!)).toHaveLength(1);
  });
});

describe("danglingHref", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Dangling Clean");
    expect(danglingHref(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a toc entry targeting a file that does not exist", () => {
    const e = cleanBook("Dangling Toc");
    tocOf(e).items[0]!.href = "text/ghost.xhtml";

    const findings = danglingHref(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "dangling-href", severity: "error" });
    expect(findings[0]!.remedy).toContain("edit_navigation");
  });

  test("ignores the fragment when resolving a target", () => {
    const e = cleanBook("Dangling Fragment");
    tocOf(e).items[0]!.href = "text/ch1.xhtml#section-2";

    expect(danglingHref(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a guide reference targeting a file that does not exist", () => {
    const e = cleanBook("Dangling Guide");
    const pkg = primaryPackage(e)!;
    pkg.guide = { id: `${pkg.id}#guide`, references: [{ id: "g1", type: "cover", title: "Cover", href: "text/ghost.xhtml" }] };

    const findings = danglingHref(e, pkg);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.remedy).toContain("edit_guide");
  });
});

describe("spineMissingManifestItem", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Spine Clean");
    expect(spineMissingManifestItem(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a spine entry naming a manifest item that does not exist", () => {
    const e = cleanBook("Spine Ghost");
    primaryPackage(e)!.spine.itemRefs.push({ id: "sp-ghost", idRef: "ghost", linear: true, properties: [] });

    const findings = spineMissingManifestItem(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "spine-missing-manifest-item", severity: "error", ids: ["sp-ghost"] });
  });
});

describe("manifestMissingFile", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Manifest Clean");
    expect(manifestMissingFile(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a manifest item whose file is absent", () => {
    const e = cleanBook("Manifest Ghost");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ghost`, href: "images/ghost.jpg", mediaType: "image/jpeg", properties: [], fallback: "", mediaOverlay: "" });

    const findings = manifestMissingFile(e, pkg);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "manifest-missing-file", severity: "error" });
    expect(findings[0]!.message).toContain("images/ghost.jpg");
  });
});

describe("orphanContentDocument", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Orphan Clean");
    expect(orphanContentDocument(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a content document missing from the manifest", () => {
    const e = cleanBook("Orphan Unmanifested");
    e.contentDocuments["text/loose.xhtml"] = { id: "text/loose.xhtml", mediaType: "application/xhtml+xml", markup: chapterMarkup("Chapter 9") };

    const findings = orphanContentDocument(e, primaryPackage(e)!);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "orphan-content-document", severity: "warning", ids: ["text/loose.xhtml"] });
    expect(findings[0]!.message).toContain("manifest");
  });

  test("reports a manifested content document that the spine never reaches", () => {
    const e = cleanBook("Orphan Unspined");
    const pkg = primaryPackage(e)!;
    pkg.spine.itemRefs = pkg.spine.itemRefs.filter((r) => r.idRef !== "ch2");

    const findings = orphanContentDocument(e, pkg);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.ids).toEqual(["text/ch2.xhtml"]);
    expect(findings[0]!.message).toContain("spine");
  });
});

describe("duplicateId", () => {
  test("finds nothing wrong with a clean book", () => {
    const e = cleanBook("Dupe Clean");
    expect(duplicateId(e, primaryPackage(e)!)).toEqual([]);
  });

  test("reports a manifest id used twice", () => {
    const e = cleanBook("Dupe Manifest Id");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ch1`, href: "text/other.xhtml", mediaType: "application/xhtml+xml", properties: [], fallback: "", mediaOverlay: "" });
    e.contentDocuments["text/other.xhtml"] = { id: "text/other.xhtml", mediaType: "application/xhtml+xml", markup: chapterMarkup("Chapter 3") };

    const findings = duplicateId(e, pkg);

    expect(findings.some((f) => f.message.includes("Manifest id"))).toBe(true);
    expect(findings.every((f) => f.check === "duplicate-id" && f.severity === "error")).toBe(true);
  });

  test("reports a spine entry repeated", () => {
    const e = cleanBook("Dupe Spine");
    primaryPackage(e)!.spine.itemRefs.push({ id: "sp-again", idRef: "ch1", linear: true, properties: [] });

    const findings = duplicateId(e, primaryPackage(e)!);

    expect(findings.some((f) => f.message.includes("more than once"))).toBe(true);
  });

  test("reports two manifest items pointing at the same file", () => {
    const e = cleanBook("Dupe Href");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ch1-again`, href: "text/ch1.xhtml", mediaType: "application/xhtml+xml", properties: [], fallback: "", mediaOverlay: "" });

    const findings = duplicateId(e, pkg);

    expect(findings.some((f) => f.message.includes("text/ch1.xhtml"))).toBe(true);
  });
});
