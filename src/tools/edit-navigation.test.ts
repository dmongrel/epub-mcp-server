// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { addLandmarkEntry, bookTitle, bookUID, findOrCreateNavList, handleEditNavigation, renumberNavPoints, toNCXPoints } from "./edit-navigation.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-navigation-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Navigation Test", "Author"), path);
  return { dir, path };
}

describe("edit_navigation", () => {
  test("create adds a top-level toc entry", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 1", href: "ch1.xhtml" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.listType).toBe("toc");

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    const nav = cached!.navigation["nav.xhtml"]!;
    const toc = nav.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(1);
    expect(toc.items[0]).toMatchObject({ label: "Chapter 1", href: "ch1.xhtml" });
    void pkg;

    await rm(dir, { recursive: true, force: true });
  });

  test("create nests a child under a given parent id", async () => {
    const { dir, path } = await writeTempBook();
    const first = await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Part One", href: "" });
    const parentId = first.structuredContent?.id as string;

    await handleEditNavigation(fakeServer, { action: "create", path, id: parentId, label: "Chapter 1", href: "ch1.xhtml" });

    const cached = epubCache.get(resolve(path));
    const nav = cached!.navigation["nav.xhtml"]!;
    const toc = nav.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(1);
    expect(toc.items[0]?.children).toHaveLength(1);
    expect(toc.items[0]?.children[0]).toMatchObject({ label: "Chapter 1", href: "ch1.xhtml" });

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails on a duplicate href among siblings", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 1", href: "ch1.xhtml" });

    await expect(
      handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 1 Again", href: "ch1.xhtml" }),
    ).rejects.toThrow("already has an entry");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces label/href/type and can reposition", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 1", href: "ch1.xhtml" });
    await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 2", href: "ch2.xhtml" });

    const cachedBefore = epubCache.get(resolve(path))!;
    const tocBefore = cachedBefore.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    const secondId = tocBefore.items[1]!.id;

    await handleEditNavigation(fakeServer, { action: "edit", path, id: secondId, label: "Chapter Two", href: "ch2.xhtml", position: "0" });

    const cached = epubCache.get(resolve(path))!;
    const toc = cached.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items[0]?.label).toBe("Chapter Two");

    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes an entry and its children", async () => {
    const { dir, path } = await writeTempBook();
    const created = await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Part One", href: "" });
    const parentId = created.structuredContent?.id as string;
    await handleEditNavigation(fakeServer, { action: "create", path, id: parentId, label: "Chapter 1", href: "ch1.xhtml" });

    await handleEditNavigation(fakeServer, { action: "remove", path, id: parentId });

    const cached = epubCache.get(resolve(path))!;
    const toc = cached.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("syncs the legacy NCX when listType is toc and the book has one", async () => {
    const { dir, path } = await writeTempBook();
    const cached = (await epubCache.load(resolve(path))).epub;
    const pkg = primaryPackage(cached)!;
    // newEpub()'s skeleton has no NCX; add one directly to exercise the
    // sync path, mirroring how a real EPUB 2-compat book would already
    // have one on disk.
    pkg.spine.tocRef = "ncx";
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/ncx`, href: "toc.ncx", mediaType: "application/x-dtbncx+xml", properties: [], fallback: "", mediaOverlay: "" });
    cached.nCXs["toc.ncx"] = { id: "toc.ncx", markup: "", navMap: [] };

    const result = await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Chapter 1", href: "ch1.xhtml" });

    expect(result.structuredContent?.ncxSynced).toBe(true);
    expect(cached.nCXs["toc.ncx"]!.navMap).toHaveLength(1);
    expect(cached.nCXs["toc.ncx"]!.markup).toContain("Chapter 1");

    await rm(dir, { recursive: true, force: true });
  });

  test("creating a landmarks entry doesn't sync the NCX", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditNavigation(fakeServer, { action: "create", path, id: "", label: "Cover", href: "cover.xhtml", listType: "landmarks", type: "cover" });
    expect(result.structuredContent?.ncxSynced).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("findOrCreateNavList", () => {
  test("creates a new list on demand and finds it again", () => {
    const e = newEpub("Find Or Create Test", "Author");
    const nav = e.navigation["nav.xhtml"]!;
    const created = findOrCreateNavList(nav, "landmarks", "create");
    expect(created.type).toBe("landmarks");
    expect(created.heading).toBe("Landmarks");
    expect(findOrCreateNavList(nav, "landmarks", "edit")).toBe(created);
  });

  test("throws for a missing list when action isn't create", () => {
    const e = newEpub("Find Or Create Throw Test", "Author");
    const nav = e.navigation["nav.xhtml"]!;
    expect(() => findOrCreateNavList(nav, "page-list", "edit")).toThrow();
  });
});

describe("bookTitle / bookUID", () => {
  test("bookTitle falls back to \"Navigation\" when there's no title", () => {
    const e = newEpub("", "Author");
    const pkg = primaryPackage(e)!;
    pkg.metadata.titles = [];
    expect(bookTitle(pkg)).toBe("Navigation");
  });

  test("bookUID falls back to empty string when there's no identifier", () => {
    const e = newEpub("UID Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.metadata.identifiers = [];
    expect(bookUID(pkg)).toBe("");
  });
});

describe("toNCXPoints", () => {
  test("maps label/href(as src) and recurses, leaving id/playOrder blank for the renderer to fill in", () => {
    const result = toNCXPoints([{ id: "x", label: "Chapter 1", href: "ch1.xhtml", type: "", children: [] }]);
    expect(result).toEqual([{ id: "", playOrder: 0, label: "Chapter 1", src: "ch1.xhtml", children: [] }]);
  });
});

describe("renumberNavPoints", () => {
  test("assigns positional ids recursively", () => {
    const points = [
      { id: "old", label: "A", href: "", type: "", children: [{ id: "old-child", label: "A1", href: "", type: "", children: [] }] },
    ];
    renumberNavPoints("base", points);
    expect(points[0]?.id).toBe("base/item[0]");
    expect(points[0]?.children[0]?.id).toBe("base/item[0]/item[0]");
  });
});

describe("addLandmarkEntry", () => {
  test("appends to the landmarks list, creating it if absent, and renders markup", () => {
    const e = newEpub("Landmark Test", "Author");
    const pkg = primaryPackage(e)!;
    const nav = e.navigation["nav.xhtml"]!;
    const added = addLandmarkEntry(pkg, nav, "Cover", "cover.xhtml", "cover");
    expect(added).toBe(true);
    const list = nav.lists.find((l) => l.type === "landmarks")!;
    expect(list.items).toHaveLength(1);
    expect(nav.markup).toContain("Cover");
  });

  test("returns false without duplicating an entry that already targets href", () => {
    const e = newEpub("Landmark Dup Test", "Author");
    const pkg = primaryPackage(e)!;
    const nav = e.navigation["nav.xhtml"]!;
    addLandmarkEntry(pkg, nav, "Cover", "cover.xhtml", "cover");
    const addedAgain = addLandmarkEntry(pkg, nav, "Cover Again", "cover.xhtml", "cover");
    expect(addedAgain).toBe(false);
    expect(nav.lists.find((l) => l.type === "landmarks")!.items).toHaveLength(1);
  });
});

