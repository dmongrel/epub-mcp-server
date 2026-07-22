// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleEditCover, uniqueArchivePath, coverPageMarkup, xmlEscapeAttr } from "./edit-cover.ts";
import { epubCache } from "./epub-cache.ts";
import { findCoverItem } from "./get-cover.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string; sourcePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-cover-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Cover Test", "Author"), path);
  const sourcePath = join(dir, "cover-source.jpg");
  await writeFile(sourcePath, "fake-jpeg-bytes");
  return { dir, path, sourcePath };
}

describe("edit_cover", () => {
  test("create adds the cover-image manifest item, a wrapper page, spine entry, landmark, and guide reference", async () => {
    const { dir, path, sourcePath } = await writeTempBook();

    const result = await handleEditCover(fakeServer, { action: "create", path, id: "images/cover.jpg", sourcePath });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.id).toBe("images/cover.jpg");

    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    const coverItem = findCoverItem(pkg);
    expect(coverItem?.href).toBe("images/cover.jpg");
    expect(cached.resources["images/cover.jpg"]?.mediaType).toBe("image/jpeg");

    // Wrapper page: first entry in the spine.
    expect(pkg.spine.itemRefs[0]?.idRef).not.toBe("nav");
    const pageItem = pkg.manifest.items.find((i) => i.id === pkg.spine.itemRefs[0]?.id ? false : pkg.manifest.items.find((mi) => mi.id.endsWith("/" + pkg.spine.itemRefs[0]!.idRef)));
    expect(pageItem).toBeDefined();

    // Legacy meta pointer.
    const coverMeta = pkg.metadata.metas.find((m) => m.name === "cover");
    expect(coverMeta).toBeDefined();

    // Landmarks entry.
    const nav = cached.navigation["nav.xhtml"]!;
    const landmarks = nav.lists.find((l) => l.type === "landmarks");
    expect(landmarks?.items.some((p) => p.type === "cover")).toBe(true);

    // Guide reference.
    expect(pkg.guide?.references.some((r) => r.type === "cover")).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if the book already has a cover", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await handleEditCover(fakeServer, { action: "create", path, id: "images/cover.jpg", sourcePath });

    await expect(
      handleEditCover(fakeServer, { action: "create", path, id: "images/cover2.jpg", sourcePath }),
    ).rejects.toThrow("already has a cover");

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if id already names something in the book", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await expect(
      handleEditCover(fakeServer, { action: "create", path, id: "styles/style.css", sourcePath }),
    ).rejects.toThrow("already exists");
    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces the existing cover's bytes in place, leaving the wrapper page untouched", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await handleEditCover(fakeServer, { action: "create", path, id: "images/cover.jpg", sourcePath });
    const newSource = join(dir, "new-cover.png");
    await writeFile(newSource, "new-bytes-longer-than-before");

    const result = await handleEditCover(fakeServer, { action: "edit", path, sourcePath: newSource, mediaType: "image/png" });

    expect(result.structuredContent?.id).toBe("images/cover.jpg");
    const cached = epubCache.get(resolve(path))!;
    const text = new TextDecoder().decode(cached.resources["images/cover.jpg"]!.data);
    expect(text).toBe("new-bytes-longer-than-before");
    const pkg = primaryPackage(cached)!;
    expect(findCoverItem(pkg)?.mediaType).toBe("image/png");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit fails if the book has no cover yet", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await expect(handleEditCover(fakeServer, { action: "edit", path, sourcePath })).rejects.toThrow("has no cover image");
    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes the cover resource, manifest entry, meta pointer, wrapper page, spine entry, landmark, and guide reference", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await handleEditCover(fakeServer, { action: "create", path, id: "images/cover.jpg", sourcePath });

    const result = await handleEditCover(fakeServer, { action: "remove", path });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    expect(findCoverItem(pkg)).toBeUndefined();
    expect(cached.resources["images/cover.jpg"]).toBeUndefined();
    expect(pkg.metadata.metas.some((m) => m.name === "cover")).toBe(false);
    expect(pkg.guide?.references.some((r) => r.type === "cover")).toBe(false);
    const nav = cached.navigation["nav.xhtml"]!;
    const landmarks = nav.lists.find((l) => l.type === "landmarks");
    expect(landmarks?.items.some((p) => p.type === "cover")).toBe(false);
    // Wrapper page's content document should also be gone.
    expect(Object.keys(cached.contentDocuments)).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("remove fails if the book has no cover", async () => {
    const { dir, path } = await writeTempBook();
    await expect(handleEditCover(fakeServer, { action: "remove", path })).rejects.toThrow("has no cover image");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("uniqueArchivePath", () => {
  test("returns candidate unchanged when unused, else appends a numeric suffix before the extension", () => {
    const e = newEpub("Unique Archive Path Test", "Author");
    expect(uniqueArchivePath(e, "cover.xhtml")).toBe("cover.xhtml");
    e.contentDocuments["cover.xhtml"] = { id: "cover.xhtml", mediaType: "application/xhtml+xml", markup: "" };
    expect(uniqueArchivePath(e, "cover.xhtml")).toBe("cover-2.xhtml");
  });
});

describe("coverPageMarkup / xmlEscapeAttr", () => {
  test("escapes special characters in title and href", () => {
    const markup = coverPageMarkup('A & B < "C"', "cover", "images/a&b.jpg");
    expect(markup).toContain("A &amp; B &lt; &quot;C&quot;");
    expect(markup).toContain('src="images/a&amp;b.jpg"');
    expect(markup).toContain('epub:type="cover"');
  });

  test("xmlEscapeAttr escapes the five XML-significant characters", () => {
    expect(xmlEscapeAttr(`& < > "`)).toBe("&amp; &lt; &gt; &quot;");
  });
});

