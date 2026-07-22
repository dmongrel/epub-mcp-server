// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleReloadEpub } from "./reload-epub.ts";
import { epubCache } from "./epub-cache.ts";
import { canonicalPath } from "../epub/cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("reload_epub", () => {
  test("discards in-memory edits and re-parses from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-reload-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Reload Epub Test", "Author"), path);
    const { epub: loaded } = await epubCache.load(path);
    primaryPackage(loaded)!.metadata.titles[0]!.value = "Unsaved Edit";
    epubCache.markDirty(path);

    const result = await handleReloadEpub(fakeServer, { path });

    expect(result.structuredContent?.title).toBe("Reload Epub Test");
    const cached = epubCache.get(canonicalPath(path))!;
    expect(primaryPackage(cached)?.metadata.titles[0]?.value).toBe("Reload Epub Test");

    await rm(dir, { recursive: true, force: true });
  });

  test("behaves like a plain read_epub when path wasn't already cached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-reload-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Reload Fresh Test", "Author"), path);

    const result = await handleReloadEpub(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.title).toBe("Reload Fresh Test");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path is missing", async () => {
    await expect(handleReloadEpub(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });
});

