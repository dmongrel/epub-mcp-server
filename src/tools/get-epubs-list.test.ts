// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetEpubsList } from "./get-epubs-list.ts";

const fakeServer = {} as Server;

describe("get_epubs_list", () => {
  test("lists .epub files by case-insensitive extension, sorted by path, non-recursive by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-list-test-"));
    await writeFile(join(dir, "b.epub"), "b");
    await writeFile(join(dir, "a.EPUB"), "a");
    await writeFile(join(dir, "not-an-epub.txt"), "x");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "nested.epub"), "n");

    const result = await handleGetEpubsList(fakeServer, { dir });

    const files = result.structuredContent?.files as Array<{ path: string; sizeBytes: number }>;
    expect(files.map((f) => f.path.split(/[\\/]/).pop())).toEqual(["a.EPUB", "b.epub"]);
    expect(files.every((f) => f.sizeBytes > 0)).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("recursive:true also finds files in subdirectories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-list-recursive-test-"));
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "root.epub"), "r");
    await writeFile(join(dir, "sub", "nested.epub"), "n");

    const result = await handleGetEpubsList(fakeServer, { dir, recursive: true });

    const files = result.structuredContent?.files as Array<{ path: string }>;
    expect(files).toHaveLength(2);

    await rm(dir, { recursive: true, force: true });
  });

  test("defaults dir to the current working directory when omitted", async () => {
    const result = await handleGetEpubsList(fakeServer, { dir: "" });
    expect(result.isError).toBeUndefined();
    expect(typeof result.structuredContent?.dir).toBe("string");
  });

  test("a directory misleadingly named *.epub is not treated as a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-list-dirname-test-"));
    await mkdir(join(dir, "tricky.epub"));
    await writeFile(join(dir, "tricky.epub", "inner.epub"), "i");

    const result = await handleGetEpubsList(fakeServer, { dir });

    const files = result.structuredContent?.files as Array<{ path: string }>;
    expect(files).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });
});

