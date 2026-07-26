// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleSaveEpub } from "./save-epub.ts";
import { handleCloseEpub } from "./close-epub.ts";
import { handleConvertManuscript } from "./convert-manuscript.ts";
import { handleReadEpub } from "./read-epub.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { parseEpub } from "../epub/parse.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function newTestEpub(title: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-save-epub-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub(title, "Author"), path);
  await epubCache.load(path);
  return { dir, path };
}

describe("save_epub", () => {
  test("fails if path isn't currently cached", async () => {
    await expect(handleSaveEpub(fakeServer, { path: "/no/such/cached-book.epub" })).rejects.toThrow("is not currently cached");
  });

  test("errors when path is missing (not elicited)", async () => {
    await expect(handleSaveEpub(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });

  test("writes cached edits back to disk and clears the dirty flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-save-epub-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Save Epub Test", "Author");
    await writeEpub(e, path);
    const { epub: loaded } = await epubCache.load(path);
    const pkg = primaryPackage(loaded)!;
    pkg.metadata.titles[0]!.value = "Edited Title";
    epubCache.markDirty(path);

    const result = await handleSaveEpub(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.savedTo).toBe(path);
    const reparsed = await parseEpub(path);
    expect(primaryPackage(reparsed)?.metadata.titles[0]?.value).toBe("Edited Title");

    const status = epubCache.entries().find((entry) => entry.path === path);
    expect(status?.dirty).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  test("saves to a different 'as' path, leaving the original's dirty flag untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-save-epub-test-"));
    const path = join(dir, "book.epub");
    const asPath = join(dir, "book-copy.epub");
    await writeEpub(newEpub("Save As Test", "Author"), path);
    await epubCache.load(path);
    epubCache.markDirty(path);

    const result = await handleSaveEpub(fakeServer, { path, as: asPath });

    expect(result.structuredContent?.savedTo).toBe(asPath);
    const reparsed = await parseEpub(asPath);
    expect(primaryPackage(reparsed)).toBeDefined();

    const status = epubCache.entries().find((entry) => entry.path === path);
    expect(status?.dirty).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("saves a book with no chapters as-is, adding nothing", async () => {
    const { path } = await newTestEpub("No Auto Chapter");

    const res = await handleSaveEpub(fakeServer, { path });

    expect(res.structuredContent).not.toHaveProperty("addedBlankChapter");
    const e = epubCache.get(resolve(path))!;
    expect(Object.keys(e.contentDocuments)).toHaveLength(0);
    // newEpub's spine always carries one itemref for the nav document itself
    // (see src/epub/new-epub.ts); that's unrelated to chapters and isn't
    // something this fix touches, so the baseline here is 1, not 0.
    expect(primaryPackage(e)!.spine.itemRefs).toHaveLength(1);
    expect(res.content[0]!.text).not.toContain("blank");
  });

  test("a saved-then-reloaded empty book still has no chapters", async () => {
    const { path } = await newTestEpub("No Auto Chapter Roundtrip");
    await handleSaveEpub(fakeServer, { path });
    await handleCloseEpub(fakeServer, { path });

    await handleReadEpub(fakeServer, { path });

    expect(Object.keys(epubCache.get(resolve(path))!.contentDocuments)).toHaveLength(0);
  });

  test("converting a manuscript into a freshly saved new book puts chapter 1 at chapter-1.xhtml", async () => {
    const { path, dir } = await newTestEpub("No Stub Collision");
    // The bug this guards: save_epub used to inject text/chapter-1.xhtml
    // here, so the real chapter 1 landed at chapter-1-2.xhtml with a blank
    // stub left at the head of the book and its table of contents.
    await handleSaveEpub(fakeServer, { path });
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "Chapter 1: Dawn\n\nFirst.\n\nChapter 2: Dusk\n\nSecond.\n", "utf-8");

    await handleConvertManuscript(fakeServer, { path, sourcePath });

    const e = epubCache.get(resolve(path))!;
    // deriveManuscriptBaseId falls back to pkg.baseDir + "chapter" when there
    // are no existing content documents to infer a directory from, so with
    // the injection gone (no pre-existing "text/chapter-1.xhtml" stub) these
    // land at the archive root rather than under "text/".
    expect(Object.keys(e.contentDocuments).sort()).toEqual(["chapter-1.xhtml", "chapter-2.xhtml"]);
    const toc = e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items.map((i) => i.label)).toEqual(["Chapter 1: Dawn", "Chapter 2: Dusk"]);
  });
});

