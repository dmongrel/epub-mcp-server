// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { defaultChapterLabel, syncNavRender, syncTocOnChapterCreate, syncTocOnChapterRemove } from "./nav-sync.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";

describe("syncTocOnChapterCreate", () => {
  test("appends a top-level toc entry with a derived label when none is given", () => {
    const e = newEpub("Sync Create Test", "Author");
    const pkg = primaryPackage(e)!;

    const synced = syncTocOnChapterCreate(e, pkg, "text/chapter-1.xhtml", "");

    expect(synced).toBe(true);
    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(1);
    expect(toc.items[0]).toMatchObject({ label: "Chapter 1", href: "text/chapter-1.xhtml" });
  });

  test("uses the given label when one is provided", () => {
    const e = newEpub("Sync Create Label Test", "Author");
    const pkg = primaryPackage(e)!;

    syncTocOnChapterCreate(e, pkg, "ch1.xhtml", "My Custom Title");

    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items[0]?.label).toBe("My Custom Title");
  });

  test("is a no-op returning false when the book has no EPUB 3 navigation document", () => {
    const e = newEpub("Sync No Nav Test", "Author");
    const pkg = primaryPackage(e)!;
    delete e.navigation["nav.xhtml"];
    // Also remove the nav manifest item's "nav" property so navItem(pkg)
    // finds nothing, matching a book genuinely without a nav document.
    const navManifestItem = pkg.manifest.items.find((i) => i.properties.includes("nav"));
    if (navManifestItem) navManifestItem.properties = [];

    expect(syncTocOnChapterCreate(e, pkg, "ch1.xhtml", "Chapter 1")).toBe(false);
  });

  test("also mirrors the new entry into the legacy NCX when the book has one", () => {
    const e = newEpub("Sync Create NCX Test", "Author");
    const pkg = primaryPackage(e)!;
    // newEpub()'s skeleton has no NCX; add one directly to exercise the
    // sync path, mirroring how a real EPUB 2-compat book would already
    // have one on disk.
    pkg.spine.tocRef = "ncx";
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ncx`, href: "toc.ncx", mediaType: "application/x-dtbncx+xml", properties: [], fallback: "", mediaOverlay: "" });
    e.nCXs["toc.ncx"] = { id: "toc.ncx", markup: "", navMap: [] };

    const synced = syncTocOnChapterCreate(e, pkg, "ch1.xhtml", "Chapter 1");

    expect(synced).toBe(true);
    expect(e.nCXs["toc.ncx"]!.navMap).toHaveLength(1);
    expect(e.nCXs["toc.ncx"]!.markup).toContain("Chapter 1");
  });
});

describe("syncTocOnChapterRemove", () => {
  test("removes the matching top-level entry and returns true", () => {
    const e = newEpub("Sync Remove Test", "Author");
    const pkg = primaryPackage(e)!;
    syncTocOnChapterCreate(e, pkg, "ch1.xhtml", "Chapter 1");

    const removed = syncTocOnChapterRemove(e, pkg, "ch1.xhtml");

    expect(removed).toBe(true);
    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(0);
  });

  test("returns false when no entry targets the given href", () => {
    const e = newEpub("Sync Remove Miss Test", "Author");
    const pkg = primaryPackage(e)!;
    expect(syncTocOnChapterRemove(e, pkg, "does-not-exist.xhtml")).toBe(false);
  });

  test("also mirrors the removal into the legacy NCX when the book has one", () => {
    const e = newEpub("Sync Remove NCX Test", "Author");
    const pkg = primaryPackage(e)!;
    // newEpub()'s skeleton has no NCX; add one directly to exercise the
    // sync path, mirroring how a real EPUB 2-compat book would already
    // have one on disk.
    pkg.spine.tocRef = "ncx";
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ncx`, href: "toc.ncx", mediaType: "application/x-dtbncx+xml", properties: [], fallback: "", mediaOverlay: "" });
    e.nCXs["toc.ncx"] = { id: "toc.ncx", markup: "", navMap: [] };
    syncTocOnChapterCreate(e, pkg, "ch1.xhtml", "Chapter 1");
    expect(e.nCXs["toc.ncx"]!.navMap).toHaveLength(1);

    const removed = syncTocOnChapterRemove(e, pkg, "ch1.xhtml");

    expect(removed).toBe(true);
    expect(e.nCXs["toc.ncx"]!.navMap).toHaveLength(0);
  });
});

describe("syncNavRender", () => {
  test("re-renders the navigation document's markup", () => {
    const e = newEpub("Sync Render Test", "Author");
    const pkg = primaryPackage(e)!;
    const nav = e.navigation["nav.xhtml"]!;
    const toc = nav.lists.find((l) => l.type === "toc")!;
    toc.items.push({ id: "x", label: "Chapter 1", href: "ch1.xhtml", type: "", children: [] });

    syncNavRender(e, pkg, nav, toc);

    expect(nav.markup).toContain("Chapter 1");
  });
});

describe("defaultChapterLabel", () => {
  test("derives a title-cased label from a hyphenated file name", () => {
    expect(defaultChapterLabel("text/chapter-18.xhtml")).toBe("Chapter 18");
  });

  test("handles underscores and no directory", () => {
    expect(defaultChapterLabel("chapter_two.xhtml")).toBe("Chapter Two");
  });

  test('falls back to "Untitled" for a name with no word characters', () => {
    expect(defaultChapterLabel("---.xhtml")).toBe("Untitled");
  });
});

