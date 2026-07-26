// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleEditMetadata } from "./edit-metadata.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import type { Package } from "../epub/types.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(mutate?: (pkg: Package) => void): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-metadata-test-"));
  const path = join(dir, "book.epub");
  const e = newEpub("Edit Metadata Test", "Author");
  if (mutate) mutate(primaryPackage(e)!);
  await writeEpub(e, path);
  return { dir, path };
}

describe("edit_metadata", () => {
  test("create adds a new subject", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditMetadata(fakeServer, { action: "create", path, field: "subject", value: "Fantasy" });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.metadata.subjects).toHaveLength(1);
    expect(pkg.metadata.subjects[0]?.value).toBe("Fantasy");

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails on an exact-duplicate entry", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditMetadata(fakeServer, { action: "create", path, field: "subject", value: "Fantasy" });

    await expect(
      handleEditMetadata(fakeServer, { action: "create", path, field: "subject", value: "Fantasy" }),
    ).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces the description scalar field", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditMetadata(fakeServer, { action: "edit", path, field: "description", value: "A test book." });

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.metadata.description).toBe("A test book.");

    await rm(dir, { recursive: true, force: true });
  });

  test("publisher is addressed by its own text, not an id", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditMetadata(fakeServer, { action: "create", path, field: "publisher", value: "Acme Books" });
    const result = await handleEditMetadata(fakeServer, { action: "remove", path, field: "publisher", id: "Acme Books" });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.metadata.publishers).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("rejects an unknown field", async () => {
    const { dir, path } = await writeTempBook();

    await expect(
      handleEditMetadata(fakeServer, { action: "create", path, field: "bogus", value: "x" }),
    ).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });

  test("edit on a title updates value/type/lang wholesale", async () => {
    const { dir, path } = await writeTempBook();
    const cachedBefore = (await epubCache.load(resolve(path))).epub;
    const titleId = primaryPackage(cachedBefore)!.metadata.titles[0]!.id;

    const result = await handleEditMetadata(fakeServer, {
      action: "edit",
      path,
      field: "title",
      id: titleId,
      value: "New Title",
      type: "main",
      lang: "en",
    });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.metadata.titles[0]).toMatchObject({ value: "New Title", type: "main", lang: "en" });

    await rm(dir, { recursive: true, force: true });
  });

  test("edit on an identifier repoints a dangling unique-identifier at it", async () => {
    // The shape older new_epub versions produced: the package names "uid",
    // but the one dc:identifier carries id="bookid".
    const { dir, path } = await writeTempBook((pkg) => {
      pkg.uniqueIdentifierRef = "uid";
    });

    await handleEditMetadata(fakeServer, {
      action: "edit",
      path,
      field: "identifier",
      id: "content.opf#metadata/identifier[bookid]",
      value: "urn:uuid:11111111-1111-1111-1111-111111111111",
      scheme: "UUID",
    });

    const pkg = primaryPackage(epubCache.get(resolve(path))!)!;
    expect(pkg.uniqueIdentifierRef).toBe("bookid");
    expect(pkg.metadata.identifiers[0]?.value).toBe("urn:uuid:11111111-1111-1111-1111-111111111111");

    await rm(dir, { recursive: true, force: true });
  });

  test("create gives the first identifier a real id and names it as unique-identifier", async () => {
    const { dir, path } = await writeTempBook((pkg) => {
      pkg.metadata.identifiers = [];
      pkg.uniqueIdentifierRef = "";
    });

    const result = await handleEditMetadata(fakeServer, { action: "create", path, field: "identifier", value: "urn:isbn:9780000000002" });

    expect(result.structuredContent?.id).toBe("content.opf#metadata/identifier[bookid]");
    const pkg = primaryPackage(epubCache.get(resolve(path))!)!;
    expect(pkg.uniqueIdentifierRef).toBe("bookid");

    await rm(dir, { recursive: true, force: true });
  });

  test("create leaves an already-valid unique-identifier alone", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditMetadata(fakeServer, { action: "create", path, field: "identifier", value: "urn:isbn:9780000000002" });

    const pkg = primaryPackage(epubCache.get(resolve(path))!)!;
    expect(pkg.uniqueIdentifierRef).toBe("bookid");
    expect(pkg.metadata.identifiers).toHaveLength(2);

    await rm(dir, { recursive: true, force: true });
  });

  test("remove of the named identifier clears unique-identifier when none is left", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditMetadata(fakeServer, { action: "remove", path, field: "identifier", id: "content.opf#metadata/identifier[bookid]" });

    const pkg = primaryPackage(epubCache.get(resolve(path))!)!;
    expect(pkg.metadata.identifiers).toHaveLength(0);
    expect(pkg.uniqueIdentifierRef).toBe("");

    await rm(dir, { recursive: true, force: true });
  });
});

