import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleCloseEpub } from "./close-epub.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("close_epub", () => {
  test("removes a cached epub and reports closed:true, hadUnsavedEdits:false when clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-close-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Close Epub Test", "Author"), path);
    await epubCache.load(path);

    const result = await handleCloseEpub(fakeServer, { path });

    expect(result.structuredContent?.closed).toBe(true);
    expect(result.structuredContent?.hadUnsavedEdits).toBeUndefined();
    expect(epubCache.get(path)).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("reports hadUnsavedEdits:true when the closed entry was dirty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-close-epub-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Close Dirty Test", "Author"), path);
    await epubCache.load(path);
    epubCache.markDirty(path);

    const result = await handleCloseEpub(fakeServer, { path });

    expect(result.structuredContent?.hadUnsavedEdits).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("closing an uncached path is not an error; closed is false", async () => {
    const result = await handleCloseEpub(fakeServer, { path: "/no/such/cached-book.epub" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.closed).toBe(false);
  });

  test("errors when path is missing", async () => {
    await expect(handleCloseEpub(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });
});
