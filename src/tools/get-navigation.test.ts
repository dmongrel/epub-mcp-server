import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetNavigation, navPointsToTOC, ncxPointsToTOC, primaryNavigation, tableOfContents } from "./get-navigation.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_navigation", () => {
  test("returns the toc list for a fresh book with hasNcx false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-navigation-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Nav Test", "Author"), path);

    const result = await handleGetNavigation(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    // A freshly created EPUB-3-only book has no legacy NCX.
    expect(result.structuredContent?.hasNcx).toBe(false);
    const lists = result.structuredContent?.lists as Array<{ type?: string; items: unknown[] }>;
    const toc = lists.find((l) => l.type === "toc");
    expect(toc).toBeDefined();
    expect(toc?.items).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  test("listType filters to one list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-navigation-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Nav Filter Test", "Author"), path);

    const result = await handleGetNavigation(fakeServer, { path, listType: "landmarks" });

    const lists = result.structuredContent?.lists as unknown[];
    expect(lists).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path is missing", async () => {
    await expect(handleGetNavigation(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });
});

describe("navPointsToTOC", () => {
  test("maps id/label/href and recurses into children", () => {
    const result = navPointsToTOC([
      { id: "a", label: "Chapter 1", href: "ch1.xhtml", type: "", children: [] },
      { id: "b", label: "Part", href: "", type: "", children: [{ id: "b1", label: "Chapter 2", href: "ch2.xhtml", type: "", children: [] }] },
    ]);

    expect(result).toEqual([
      { id: "a", label: "Chapter 1", href: "ch1.xhtml" },
      { id: "b", label: "Part", children: [{ id: "b1", label: "Chapter 2", href: "ch2.xhtml" }] },
    ]);
  });
});

describe("ncxPointsToTOC", () => {
  test("maps id/label/src(as href) and recurses", () => {
    const result = ncxPointsToTOC([{ id: "n1", playOrder: 1, label: "Chapter 1", src: "ch1.xhtml", children: [] }]);
    expect(result).toEqual([{ id: "n1", label: "Chapter 1", href: "ch1.xhtml" }]);
  });
});

describe("tableOfContents", () => {
  test("prefers the EPUB 3 nav document's toc list", async () => {
    const e = newEpub("TOC Test", "Author");
    const pkg = primaryPackage(e)!;
    const nav = e.navigation["nav.xhtml"]!;
    nav.lists.find((l) => l.type === "toc")!.items.push({ id: "x", label: "Chapter 1", href: "ch1.xhtml", type: "", children: [] });

    const toc = tableOfContents(e, pkg);
    expect(toc).toEqual([{ id: "x", label: "Chapter 1", href: "ch1.xhtml" }]);
  });

  test("returns undefined when the book has neither a nav document nor an NCX", () => {
    const e = newEpub("No Nav Test", "Author");
    const pkg = primaryPackage(e)!;
    // newEpub()'s skeleton always includes a nav document and marks the
    // manifest item with properties="nav". Strip that property so navItem()
    // finds nothing, and delete the navigation entry itself, to construct
    // the genuinely nav-less, NCX-less case tableOfContents() falls through
    // to `undefined` for.
    const navManifestItem = pkg.manifest.items.find((i) => i.properties.includes("nav"))!;
    navManifestItem.properties = navManifestItem.properties.filter((p) => p !== "nav");
    delete e.navigation["nav.xhtml"];

    expect(tableOfContents(e, pkg)).toBeUndefined();
  });

  test("an empty toc list yields [], not undefined", () => {
    const e = newEpub("Empty TOC Test", "Author");
    const pkg = primaryPackage(e)!;
    expect(tableOfContents(e, pkg)).toEqual([]);
  });
});

describe("primaryNavigation", () => {
  test("returns the book's Navigation object", () => {
    const e = newEpub("Primary Nav Test", "Author");
    const pkg = primaryPackage(e)!;
    expect(primaryNavigation(e, pkg)).toBe(e.navigation["nav.xhtml"]);
  });
});
