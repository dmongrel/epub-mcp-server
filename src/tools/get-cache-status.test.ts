import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetCacheStatus } from "./get-cache-status.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_cache_status", () => {
  test("reports capacity and every cached entry's dirty flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-cache-status-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Cache Status Test", "Author"), path);
    await epubCache.load(path);
    epubCache.markDirty(path);

    const result = await handleGetCacheStatus(fakeServer, {});

    expect(result.structuredContent?.capacity).toBe(epubCache.capacity);
    const entries = result.structuredContent?.entries as Array<{ path: string; dirty: boolean }>;
    const entry = entries.find((e) => e.path === path);
    expect(entry?.dirty).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("takes no required arguments", async () => {
    const result = await handleGetCacheStatus(fakeServer, undefined);
    expect(result.isError).toBeUndefined();
  });
});
