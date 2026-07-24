// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleFindText } from "./find-text.ts";
import { handleEditChapter } from "./edit-chapter.ts";
import { handleEditCover } from "./edit-cover.ts";
import { handleEditBackCover } from "./edit-back-cover.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-find-text-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Find Text Test", "Author"), path);
  return { dir, path };
}

describe("find_text", () => {
  test("finds a plaintext match with chapter and line number", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, {
      action: "create",
      path,
      id: "text/ch1.xhtml",
      content: "# Chapter 1\n\nThe gray wolf howled at the moon.\n\nIt was a quiet night otherwise.",
    });

    const result = await handleFindText(fakeServer, { path, query: "gray wolf" });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { matches: Array<{ chapter: number; line: number; text: string }> };
    expect(structured.matches).toHaveLength(1);
    expect(structured.matches[0]!.chapter).toBe(1);
    expect(structured.matches[0]!.line).toBe(2);
    expect(structured.matches[0]!.text).toContain("gray wolf");

    await rm(dir, { recursive: true, force: true });
  });

  test("supports regex queries", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, {
      action: "create",
      path,
      id: "text/ch1.xhtml",
      content: "# Chapter 1\n\nThe gray wolf met the grey fox.",
    });

    const result = await handleFindText(fakeServer, { path, query: "gr(a|e)y", regex: true });

    const structured = result.structuredContent as { matches: unknown[] };
    expect(structured.matches).toHaveLength(2);

    await rm(dir, { recursive: true, force: true });
  });

  test("plaintext mode treats regex special characters literally", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, {
      action: "create",
      path,
      id: "text/ch1.xhtml",
      content: "# Chapter 1\n\nWhat is this(really)?",
    });

    const result = await handleFindText(fakeServer, { path, query: "this(really)" });

    const structured = result.structuredContent as { matches: unknown[] };
    expect(structured.matches).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("limits the search to the given chapter numbers", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, {
      action: "create",
      path,
      id: "text/book.xhtml",
      content: "# Chapter 1\n\nThe fox ran.\n\n# Chapter 2\n\nThe fox ran again.",
    });

    const onlyChapterOne = await handleFindText(fakeServer, { path, query: "fox", chapters: [1] });
    const onlyChapterTwo = await handleFindText(fakeServer, { path, query: "fox", chapters: [2] });

    expect((onlyChapterOne.structuredContent as { matches: unknown[] }).matches).toHaveLength(1);
    expect((onlyChapterTwo.structuredContent as { matches: unknown[] }).matches).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("errors on an out-of-range chapter number", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: "# Chapter 1\n\nHello." });

    await expect(handleFindText(fakeServer, { path, query: "Hello", chapters: [99] })).rejects.toThrow("out of range");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors on an invalid regex pattern", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: "# Chapter 1\n\nHello." });

    await expect(handleFindText(fakeServer, { path, query: "(unclosed", regex: true })).rejects.toThrow("invalid regex pattern");

    await rm(dir, { recursive: true, force: true });
  });

  test("returns an empty matches array when nothing matches", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: "# Chapter 1\n\nHello." });

    const result = await handleFindText(fakeServer, { path, query: "nonexistent phrase" });

    expect((result.structuredContent as { matches: unknown[] }).matches).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path or query is missing", async () => {
    await expect(handleFindText(fakeServer, { path: "", query: "x" })).rejects.toThrow("path is required");
    await expect(handleFindText(fakeServer, { path: "x", query: "" })).rejects.toThrow("query is required");
  });

  test("excludes front/back cover pages and numbers chapters starting from the first real chapter", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "cover-source.jpg");
    await writeFile(sourcePath, "fake-jpeg-bytes");

    // Front cover is inserted at the start of the spine, so without
    // exclusion it would occupy chapter 1.
    await handleEditCover(fakeServer, { action: "create", path, id: "images/cover.jpg", sourcePath });
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: "# Chapter 1\n\nFox in chapter one." });
    // Back cover is inserted at the end of the spine.
    await handleEditBackCover(fakeServer, { action: "create", path, id: "images/back-cover.jpg", sourcePath });

    const result = await handleFindText(fakeServer, { path, query: "Fox" });
    const structured = result.structuredContent as { matches: Array<{ chapter: number }>; totalChapters: number };

    expect(structured.totalChapters).toBe(1);
    expect(structured.matches).toHaveLength(1);
    expect(structured.matches[0]!.chapter).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });
});
