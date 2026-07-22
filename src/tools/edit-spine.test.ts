// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { clampPosition, handleEditSpine, insertAt, renumberSpine } from "./edit-spine.ts";
import { handleEditBackCover } from "./edit-back-cover.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";
import { epubCache } from "./epub-cache.ts";
import { resolve } from "node:path";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-spine-test-"));
  const path = join(dir, "book.epub");
  const e = newEpub("Edit Spine Test", "Author");
  // Add a second manifest item (a resource, not in the spine yet) to
  // exercise create/edit/remove without needing a full chapter tool.
  const pkg = primaryPackage(e)!;
  pkg.manifest.items.push({
    id: `${pkg.manifest.id}/extra`,
    href: "extra.xhtml",
    mediaType: "application/xhtml+xml",
    properties: [],
    fallback: "",
    mediaOverlay: "",
  });
  e.contentDocuments["extra.xhtml"] = { id: "extra.xhtml", mediaType: "application/xhtml+xml", markup: "<html/>" };
  await writeEpub(e, path);
  return { dir, path };
}

describe("insertAt", () => {
  test("inserts at the given index without mutating the original array", () => {
    const original = [1, 2, 4];
    const result = insertAt(original, 2, 3);
    expect(result).toEqual([1, 2, 3, 4]);
    expect(original).toEqual([1, 2, 4]);
  });
});

describe("clampPosition", () => {
  test("clamps below zero to zero", () => {
    expect(clampPosition(-5, 10)).toBe(0);
  });
  test("clamps above length to length", () => {
    expect(clampPosition(50, 10)).toBe(10);
  });
  test("passes through an in-range value", () => {
    expect(clampPosition(3, 10)).toBe(3);
  });
});

describe("edit_spine", () => {
  test("create adds an existing manifest item to the reading order", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditSpine(fakeServer, { action: "create", path, id: "extra.xhtml" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.index).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("create with no position inserts before an existing back cover instead of appending after it", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "back-cover-source.jpg");
    await writeFile(sourcePath, "fake-jpeg-bytes");
    await handleEditBackCover(fakeServer, { action: "create", path, id: "images/back-cover.jpg", sourcePath });

    const result = await handleEditSpine(fakeServer, { action: "create", path, id: "extra.xhtml" });
    expect(result.isError).toBeUndefined();

    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    const hrefs = pkg.spine.itemRefs.map((ref) => {
      const item = pkg.manifest.items.find((it) => it.id === `${pkg.manifest.id}/${ref.idRef}`);
      return item?.href;
    });
    expect(hrefs[hrefs.length - 1]).toBe("back-cover.xhtml");
    expect(hrefs.indexOf("extra.xhtml")).toBeLessThan(hrefs.indexOf("back-cover.xhtml"));

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if the item is already in the spine", async () => {
    const { dir, path } = await writeTempBook();
    // handleEditSpine throws rather than returning an isError result: per
    // registry.ts's design, converting a thrown error into an isError
    // result is registerTool's job, not each handler's own — see the same
    // note in edit-resource.test.ts.
    await expect(handleEditSpine(fakeServer, { action: "create", path, id: "nav.xhtml" })).rejects.toThrow(
      "nav.xhtml",
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("edit changes linear and position", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditSpine(fakeServer, { action: "create", path, id: "extra.xhtml" });
    const result = await handleEditSpine(fakeServer, { action: "edit", path, id: "extra.xhtml", linear: "false", position: "0" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.index).toBe(0);

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.spine.itemRefs[0]).toMatchObject({ linear: false });

    await rm(dir, { recursive: true, force: true });
  });

  test("remove takes an entry out of the spine", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditSpine(fakeServer, { action: "create", path, id: "extra.xhtml" });
    const result = await handleEditSpine(fakeServer, { action: "remove", path, id: "extra.xhtml" });

    expect(result.isError).toBeUndefined();

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.spine.itemRefs.some((r) => r.idRef === "extra")).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  test("renumberSpine refreshes ids to match position", () => {
    const pkg = primaryPackage(newEpub("Renumber Test", "Author"))!;
    pkg.spine.itemRefs.push({ id: "stale", idRef: "extra", linear: true, properties: [] });
    renumberSpine(pkg);
    expect(pkg.spine.itemRefs[1]?.id).toBe(`${pkg.spine.id}/itemref[1]`);
  });
});

