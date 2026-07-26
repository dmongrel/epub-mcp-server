// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { rebuildToc } from "./nav-rebuild.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { Epub } from "../epub/types.ts";

/** Adds a content document to e with a manifest item and a spine entry at the given index (default: the end). */
function addDoc(e: Epub, archivePath: string, opfId: string, markup: string, at?: number): void {
  const pkg = primaryPackage(e)!;
  pkg.manifest.items.push({ id: `${pkg.manifest.id}/${opfId}`, href: archivePath, mediaType: "application/xhtml+xml", properties: [], fallback: "", mediaOverlay: "" });
  const ref = { id: "", idRef: opfId, linear: true, properties: [] };
  if (at === undefined) pkg.spine.itemRefs.push(ref);
  else pkg.spine.itemRefs.splice(at, 0, ref);
  e.contentDocuments[archivePath] = { id: archivePath, mediaType: "application/xhtml+xml", markup };
}

function tocOf(e: Epub) {
  return e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
}

function chapterMarkup(heading: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h2>${heading}</h2><p>Text.</p></body></html>`;
}

describe("rebuildToc", () => {
  test("replaces the toc with one flat entry per prose document, in spine order", () => {
    const e = newEpub("Rebuild Order", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1: Dawn"));
    addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2: Dusk"));

    expect(rebuildToc(e, primaryPackage(e)!)).toBe(true);

    const toc = tocOf(e);
    expect(toc.items.map((i) => [i.label, i.href])).toEqual([
      ["Chapter 1: Dawn", "text/ch1.xhtml"],
      ["Chapter 2: Dusk", "text/ch2.xhtml"],
    ]);
    expect(toc.items.every((i) => i.children.length === 0)).toBe(true);
  });

  test("discards stale entries left by incremental syncing, including a chapter appended after a back cover", () => {
    const e = newEpub("Rebuild Stale", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));
    addDoc(e, "text/back.xhtml", "back", `<body><section epub:type="backmatter cover"><img src="b.jpg"/></section></body>`);
    // Inserted before the back cover in the spine, but appended last in the
    // toc — exactly the drift syncTocOnChapterCreate produces. newEpub seeds
    // the spine with a "nav" itemref at index 0, so index 2 (not 1) is the
    // slot immediately before "back".
    addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2"), 2);
    const toc = tocOf(e);
    toc.items = [
      { id: "", label: "Chapter 1", href: "text/ch1.xhtml", type: "", children: [] },
      { id: "", label: "Back Cover", href: "text/back.xhtml", type: "", children: [] },
      { id: "", label: "Chapter 2", href: "text/ch2.xhtml", type: "", children: [] },
    ];

    rebuildToc(e, primaryPackage(e)!);

    expect(tocOf(e).items.map((i) => i.href)).toEqual(["text/ch1.xhtml", "text/ch2.xhtml"]);
  });

  test("picks up a chapter's retitled heading", () => {
    const e = newEpub("Rebuild Retitle", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1: The New Title"));
    tocOf(e).items = [{ id: "", label: "Chapter 1: The Old Title", href: "text/ch1.xhtml", type: "", children: [] }];

    rebuildToc(e, primaryPackage(e)!);

    expect(tocOf(e).items[0]?.label).toBe("Chapter 1: The New Title");
  });

  test("re-renders the navigation document's markup to match", () => {
    const e = newEpub("Rebuild Markup", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1: Dawn"));

    rebuildToc(e, primaryPackage(e)!);

    expect(e.navigation["nav.xhtml"]!.markup).toContain("Chapter 1: Dawn");
    expect(e.navigation["nav.xhtml"]!.markup).toContain('href="text/ch1.xhtml"');
  });

  test("regenerates the legacy NCX from the rebuilt toc when the book has one", () => {
    const e = newEpub("Rebuild NCX", "Author");
    const pkg = primaryPackage(e)!;
    pkg.spine.tocRef = "ncx";
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ncx`, href: "toc.ncx", mediaType: "application/x-dtbncx+xml", properties: [], fallback: "", mediaOverlay: "" });
    e.nCXs["toc.ncx"] = { id: "toc.ncx", markup: "", navMap: [] };
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1: Dawn"));

    rebuildToc(e, pkg);

    expect(e.nCXs["toc.ncx"]!.navMap.map((p) => p.label)).toEqual(["Chapter 1: Dawn"]);
    expect(e.nCXs["toc.ncx"]!.markup).toContain("Chapter 1: Dawn");
  });

  test("leaves other nav lists such as landmarks untouched", () => {
    const e = newEpub("Rebuild Landmarks", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));
    const nav = e.navigation["nav.xhtml"]!;
    nav.lists.push({ id: `${nav.id}#landmarks`, type: "landmarks", heading: "Landmarks", items: [{ id: "", label: "Start", href: "text/ch1.xhtml", type: "bodymatter", children: [] }] });

    rebuildToc(e, primaryPackage(e)!);

    const landmarks = nav.lists.find((l) => l.type === "landmarks")!;
    expect(landmarks.items.map((i) => i.label)).toEqual(["Start"]);
  });

  test("assigns collision-free positional ids to the rebuilt entries", () => {
    const e = newEpub("Rebuild Ids", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));
    addDoc(e, "text/ch2.xhtml", "ch2", chapterMarkup("Chapter 2"));

    rebuildToc(e, primaryPackage(e)!);

    const toc = tocOf(e);
    expect(toc.items.map((i) => i.id)).toEqual([`${toc.id}/item[0]`, `${toc.id}/item[1]`]);
  });

  test("returns false, changing nothing, when the book has no EPUB 3 navigation document", () => {
    const e = newEpub("Rebuild No Nav", "Author");
    const pkg = primaryPackage(e)!;
    delete e.navigation["nav.xhtml"];
    const navManifestItem = pkg.manifest.items.find((i) => i.properties.includes("nav"));
    if (navManifestItem) navManifestItem.properties = [];
    addDoc(e, "text/ch1.xhtml", "ch1", chapterMarkup("Chapter 1"));

    expect(rebuildToc(e, pkg)).toBe(false);
  });

  test("produces an empty toc for a book with no prose documents", () => {
    const e = newEpub("Rebuild Empty", "Author");

    expect(rebuildToc(e, primaryPackage(e)!)).toBe(true);
    expect(tocOf(e).items).toEqual([]);
  });
});
