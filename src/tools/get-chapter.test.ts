// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetChapter } from "./get-chapter.ts";
import { handleEditChapter } from "./edit-chapter.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

const VALID_XHTML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>C</title></head><body><h1>Chapter 1</h1><p>Hello world.</p></body></html>';

describe("get_chapter", () => {
  test("returns both text and markup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-chapter-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Get Chapter Test", "Author"), path);
    await handleEditChapter(fakeServer, { action: "create", path, id: "text/ch1.xhtml", content: VALID_XHTML });

    const result = await handleGetChapter(fakeServer, { path, id: "text/ch1.xhtml" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.markup).toBe(VALID_XHTML);
    expect(result.structuredContent?.text).toContain("Hello world.");
    expect(result.structuredContent?.mediaType).toBe("application/xhtml+xml");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when id doesn't name a content document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-chapter-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Get Chapter Missing Test", "Author"), path);

    await expect(handleGetChapter(fakeServer, { path, id: "no/such.xhtml" })).rejects.toThrow("no/such.xhtml");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path or id is missing", async () => {
    await expect(handleGetChapter(fakeServer, { path: "", id: "x" })).rejects.toThrow("path is required");
    await expect(handleGetChapter(fakeServer, { path: "x", id: "" })).rejects.toThrow("id is required");
  });
});

