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
import type { Epub } from "../epub/types.ts";

/** newEpub()'s skeleton relocated so its package document lives at OEBPS/content.opf, giving a book with a non-empty baseDir. */
function nestedEpub(title: string): Epub {
  const e = newEpub(title, "Author");

  const pkg = e.packages["content.opf"]!;
  delete e.packages["content.opf"];
  pkg.id = "OEBPS/content.opf";
  pkg.baseDir = "OEBPS/";
  e.packages["OEBPS/content.opf"] = pkg;
  e.container.rootfiles[0]!.fullPath = "OEBPS/content.opf";

  const nav = e.navigation["nav.xhtml"]!;
  delete e.navigation["nav.xhtml"];
  nav.id = "OEBPS/nav.xhtml";
  e.navigation["OEBPS/nav.xhtml"] = nav;

  const css = e.resources["styles/style.css"]!;
  delete e.resources["styles/style.css"];
  css.id = "OEBPS/styles/style.css";
  e.resources["OEBPS/styles/style.css"] = css;

  return e;
}

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

  test("on a book whose package document isn't at the archive root, the landmark and guide hrefs are baseDir-relative, not full archive paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-edit-cover-nested-test-"));
    const path = join(dir, "book.epub");
    const sourcePath = join(dir, "cover-source.jpg");
    await writeFile(sourcePath, "fake-jpeg-bytes");
    const abs = resolve(path);
    epubCache.put(abs, nestedEpub("Nested Cover Test"));

    await handleEditCover(fakeServer, { action: "create", path, id: "OEBPS/images/cover.jpg", sourcePath });

    const cached = epubCache.get(abs)!;
    const pkg = primaryPackage(cached)!;

    const nav = cached.navigation["OEBPS/nav.xhtml"]!;
    const landmarks = nav.lists.find((l) => l.type === "landmarks");
    const landmark = landmarks?.items.find((p) => p.type === "cover");
    expect(landmark?.href).toBe("cover.xhtml");

    const guideRef = pkg.guide?.references.find((r) => r.type === "cover");
    expect(guideRef?.href).toBe("cover.xhtml");

    // Both must resolve to the wrapper page's real archive path.
    expect(Object.keys(cached.contentDocuments)).toEqual(["OEBPS/cover.xhtml"]);

    // remove must find and clean up the same wrapper page via those relative hrefs.
    await handleEditCover(fakeServer, { action: "remove", path });
    expect(Object.keys(epubCache.get(abs)!.contentDocuments)).toHaveLength(0);
    expect(landmarks?.items.some((p) => p.type === "cover")).toBe(false);

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

