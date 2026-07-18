import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleSaveEpub } from "./save-epub.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { parseEpub } from "../epub/parse.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

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

  test("marks the original dirty when saving to a different 'as' path auto-adds a blank chapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-save-epub-test-"));
    const path = join(dir, "book.epub");
    const asPath = join(dir, "book-copy.epub");
    await writeEpub(newEpub("Save As Blank Chapter Test", "Author"), path);
    await epubCache.load(path);

    const preStatus = epubCache.entries().find((entry) => entry.path === path);
    expect(preStatus?.dirty).toBeFalsy();

    const result = await handleSaveEpub(fakeServer, { path, as: asPath });

    expect(result.structuredContent?.addedBlankChapter).toBeTruthy();
    const status = epubCache.entries().find((entry) => entry.path === path);
    expect(status?.dirty).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("adds a blank chapter automatically when saving a book with none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-save-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Blank Chapter Test", "Author"), path);
    await epubCache.load(path);

    const result = await handleSaveEpub(fakeServer, { path });

    expect(result.structuredContent?.addedBlankChapter).toBeTruthy();
    const reparsed = await parseEpub(path);
    expect(Object.keys(reparsed.contentDocuments)).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("does not add a blank chapter when one already exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-save-epub-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Has Chapter Test", "Author");
    await writeEpub(e, path);
    const { epub: loaded } = await epubCache.load(path);
    const pkg = primaryPackage(loaded)!;
    const { insertChapter } = await import("./edit-chapter.ts");
    insertChapter(loaded, pkg, "text/ch1.xhtml", "<html><body><p>Hi</p></body></html>", "Chapter 1");

    const result = await handleSaveEpub(fakeServer, { path });

    expect(result.structuredContent?.addedBlankChapter).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});
