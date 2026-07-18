import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { deleteChapterDocument, handleEditChapter, insertChapter } from "./edit-chapter.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-chapter-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Chapter Test", "Author"), path);
  return { dir, path };
}

const VALID_XHTML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>C</title></head><body><p>Hello.</p></body></html>';

describe("edit_chapter", () => {
  test("create with XHTML content adds a chapter and a matching toc entry", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.tocSynced).toBe(true);

    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments["text/ch1.xhtml"]?.markup).toBe(VALID_XHTML);
    const toc = cached.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(1);
    expect(toc.items[0]?.href).toBe("text/ch1.xhtml");

    await rm(dir, { recursive: true, force: true });
  });

  test("create rejects malformed XHTML with no chapter markers", async () => {
    const { dir, path } = await writeTempBook();
    await expect(
      handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: "<p>unclosed" }),
    ).rejects.toThrow("not well-formed XHTML");
    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if id already exists", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML });
    await expect(
      handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML }),
    ).rejects.toThrow("already exists");
    await rm(dir, { recursive: true, force: true });
  });

  test("create with markdown content auto-detects and splits into multiple chapters", async () => {
    const { dir, path } = await writeTempBook();
    const markdown = ["# Chapter 1", "First body.", "", "# Chapter 2", "Second body."].join("\n");

    const result = await handleEditChapter(fakeServer, { action: "create", path, id: "text/chapter-1.xhtml", content: markdown });

    const createdIds = result.structuredContent?.createdIds as string[];
    expect(createdIds).toHaveLength(2);

    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[createdIds[0]!]?.markup).toContain("First body.");
    expect(cached.contentDocuments[createdIds[1]!]?.markup).toContain("Second body.");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces an existing chapter's markup", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML });
    const updated = VALID_XHTML.replace("Hello.", "Updated.");

    const result = await handleEditChapter(fakeServer, { action: "edit", path, id: "text/ch1.xhtml", content: updated });

    expect(result.structuredContent?.previousLength).toBe(VALID_XHTML.length);
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments["text/ch1.xhtml"]?.markup).toBe(updated);

    await rm(dir, { recursive: true, force: true });
  });

  test("edit fails for an unknown id", async () => {
    const { dir, path } = await writeTempBook();
    await expect(
      handleEditChapter(fakeServer, { action: "edit", path, id: "no/such.xhtml", content: VALID_XHTML }),
    ).rejects.toThrow("no/such.xhtml");
    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes the chapter, its manifest/spine entries, and its toc entry", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML });

    const result = await handleEditChapter(fakeServer, { action: "remove", path, id: "text/ch1.xhtml" });

    expect(result.structuredContent?.tocSynced).toBe(true);
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments["text/ch1.xhtml"]).toBeUndefined();
    const pkg = primaryPackage(cached)!;
    expect(pkg.manifest.items.some((i) => i.href === "text/ch1.xhtml")).toBe(false);
    const toc = cached.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!;
    expect(toc.items).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("insertChapter", () => {
  test("adds a manifest item, spine entry, content document, and toc entry", () => {
    const e = newEpub("Insert Chapter Test", "Author");
    const pkg = primaryPackage(e)!;

    const tocSynced = insertChapter(e, pkg, "text/ch1.xhtml", VALID_XHTML, "My Chapter");

    expect(tocSynced).toBe(true);
    expect(pkg.manifest.items.some((i) => i.href === "text/ch1.xhtml")).toBe(true);
    expect(pkg.spine.itemRefs).toHaveLength(2); // nav + new chapter
    expect(e.contentDocuments["text/ch1.xhtml"]?.markup).toBe(VALID_XHTML);
  });
});

describe("deleteChapterDocument", () => {
  test("returns ok:false for an id that doesn't exist", () => {
    const e = newEpub("Delete Chapter Test", "Author");
    const pkg = primaryPackage(e)!;
    expect(deleteChapterDocument(e, pkg, "no/such.xhtml")).toEqual({ previousLength: 0, tocSynced: false, ok: false });
  });

  test("removes the document, manifest item, and spine entry", () => {
    const e = newEpub("Delete Chapter Test 2", "Author");
    const pkg = primaryPackage(e)!;
    insertChapter(e, pkg, "text/ch1.xhtml", VALID_XHTML, "My Chapter");

    const del = deleteChapterDocument(e, pkg, "text/ch1.xhtml");

    expect(del.ok).toBe(true);
    expect(del.previousLength).toBe(VALID_XHTML.length);
    expect(e.contentDocuments["text/ch1.xhtml"]).toBeUndefined();
    expect(pkg.manifest.items.some((i) => i.href === "text/ch1.xhtml")).toBe(false);
  });
});
