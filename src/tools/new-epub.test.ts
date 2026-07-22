// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleNewEpub } from "./new-epub.ts";
import { canonicalPath } from "../epub/cache.ts";
import { epubCache } from "./epub-cache.ts";

const fakeServer = {} as Server;

describe("new_epub", () => {
  test("creates a blank EPUB on disk, caches it, and returns its summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-new-epub-test-"));
    const path = join(dir, "book.epub");

    const result = await handleNewEpub(fakeServer, { path, title: "My New Book", author: "Jane Author" });

    expect(result.isError).toBeUndefined();
    expect(existsSync(path)).toBe(true);
    expect(result.structuredContent?.title).toBe("My New Book");
    expect(result.structuredContent?.creators).toEqual(["Jane Author"]);
    expect(result.structuredContent?.contentDocuments).toEqual([]);
    expect(result.structuredContent?.path).toBe(canonicalPath(path));

    const cached = epubCache.get(canonicalPath(path));
    expect(cached).toBeDefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("defaults title to Untitled and author to Anonymous when omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-new-epub-test-"));
    const path = join(dir, "book.epub");

    const result = await handleNewEpub(fakeServer, { path, title: "", author: "" });

    expect(result.structuredContent?.title).toBe("Untitled");
    expect(result.structuredContent?.creators).toEqual(["Anonymous"]);

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path is missing and elicitation is not available", async () => {
    await expect(handleNewEpub(fakeServer, { path: undefined, title: "T", author: "A" })).rejects.toThrow();
  });
});

