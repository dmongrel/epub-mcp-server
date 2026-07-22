// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleReadEpub, summarizeEpub } from "./read-epub.ts";
import { canonicalPath } from "../epub/cache.ts";
import { insertChapter } from "./edit-chapter.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("read_epub", () => {
  test("returns title, creators, language, manifestItemCount, contentDocuments, and tableOfContents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-read-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Read Epub Test", "Jane Author"), path);

    const result = await handleReadEpub(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.title).toBe("Read Epub Test");
    expect(result.structuredContent?.creators).toEqual(["Jane Author"]);
    expect(result.structuredContent?.language).toBe("en");
    expect(result.structuredContent?.manifestItemCount).toBe(2); // nav.xhtml + styles/style.css
    expect(result.structuredContent?.contentDocuments).toEqual([]);
    expect(result.structuredContent?.path).toBe(canonicalPath(path));

    await rm(dir, { recursive: true, force: true });
  });

  // Case-folding an existing path and expecting it to still resolve only holds on case-insensitive
  // filesystems (Windows, macOS) — on Linux, path.toUpperCase() names a file that doesn't exist.
  test.skipIf(process.platform === "linux")("returns the canonical path as the result's path field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-read-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Canonical Path Test", "Author"), path);

    const result = await handleReadEpub(fakeServer, { path: path.toUpperCase() });

    expect(result.structuredContent?.path).toBe(canonicalPath(path));

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path is missing", async () => {
    await expect(handleReadEpub(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });

  test("includes a real chapter in contentDocuments, filtering out only the nav document", async () => {
    // Regression coverage for summarizeEpub's contentDocuments filter: the
    // other read_epub tests only exercise a book with zero chapters, where
    // the filter's affirmative case (a genuine chapter surviving the
    // `archivePath in e.contentDocuments` check) is never actually proven —
    // an inverted/broken filter would pass those tests too. This builds a
    // book with one real chapter via insertChapter (the same path
    // edit_chapter's create action uses) and confirms it appears in
    // contentDocuments while the nav document still does not.
    const dir = await mkdtemp(join(tmpdir(), "epub-read-epub-chapter-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Read Epub Chapter Test", "Author");
    await writeEpub(e, path);
    const { epub: loaded } = await epubCache.load(path);
    const pkg = primaryPackage(loaded)!;
    insertChapter(loaded, pkg, "text/ch1.xhtml", "<html><body><p>Hello.</p></body></html>", "Chapter 1");
    epubCache.markDirty(path);

    const result = await handleReadEpub(fakeServer, { path });

    const contentDocuments = result.structuredContent?.contentDocuments as string[];
    expect(contentDocuments).toContain("text/ch1.xhtml");
    expect(contentDocuments).not.toContain("nav.xhtml");
    expect(contentDocuments).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("summarizeEpub", () => {
  test("returns zero-valued fields for an epub with no package document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-summarize-test-"));
    // summarizeEpub is exercised indirectly through handleReadEpub above for
    // the normal case; this only needs to confirm the defensive branch for
    // an Epub with no primary package doesn't throw. Build the minimal
    // possible Epub value directly rather than parsing a real (invalid)
    // file from disk.
    const empty = {
      id: "",
      mimetype: "application/epub+zip",
      container: { id: "META-INF/container.xml", version: "1.0", rootfiles: [] },
      packages: {},
      navigation: {},
      nCXs: {},
      contentDocuments: {},
      resources: {},
    };
    const result = summarizeEpub("/tmp/nonexistent.epub", empty as never);
    expect(result.manifestItemCount).toBe(0);
    expect(result.contentDocuments).toEqual([]);
    expect(result.title).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});

