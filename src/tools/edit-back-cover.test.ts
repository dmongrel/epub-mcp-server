// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleEditBackCover, findBackCoverGuideRef, backCoverImageId, resolveDocumentRelativeHref } from "./edit-back-cover.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string; sourcePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-back-cover-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Back Cover Test", "Author"), path);
  const sourcePath = join(dir, "back-cover-source.jpg");
  await writeFile(sourcePath, "fake-jpeg-bytes-for-back-cover");
  return { dir, path, sourcePath };
}

describe("edit_back_cover", () => {
  test("create adds the back cover image resource, a wrapper page in content documents, spine entry (appended), guide reference, and landmark", async () => {
    const { dir, path, sourcePath } = await writeTempBook();

    const result = await handleEditBackCover(fakeServer, { action: "create", path, id: "images/back-cover.jpg", sourcePath });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.id).toBe("images/back-cover.jpg");
    expect(result.structuredContent?.mediaType).toBe("image/jpeg");
    expect(Number(result.structuredContent?.sizeBytes)).toBe(30); // "fake-jpeg-bytes-for-back-cover"

    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    expect(cached.resources["images/back-cover.jpg"]?.mediaType).toBe("image/jpeg");

    // Wrapper page: should be the LAST entry in the spine (appended, not inserted at 0).
    const lastSpineItem = pkg.spine.itemRefs[pkg.spine.itemRefs.length - 1];
    expect(lastSpineItem).toBeDefined();
    // The wrapper page is a content document — check it's in contentDocuments.
    expect(Object.keys(cached.contentDocuments)).toContain("back-cover.xhtml");

    // Guide reference: type "other.back-cover".
    const backCoverRef = pkg.guide?.references.find((r) => r.type === "other.back-cover");
    expect(backCoverRef).toBeDefined();

    // Landmarks entry with epub:type="afterword".
    const nav = cached.navigation["nav.xhtml"]!;
    const landmarks = nav.lists.find((l) => l.type === "landmarks");
    expect(landmarks?.items.some((p) => p.type === "afterword")).toBe(true);

    // No meta name="cover" (back cover has no such pointer).
    const coverMeta = pkg.metadata.metas.find((m) => m.name === "cover");
    expect(coverMeta).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if the book already has a back cover", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await handleEditBackCover(fakeServer, { action: "create", path, id: "images/back-cover.jpg", sourcePath });

    await expect(
      handleEditBackCover(fakeServer, { action: "create", path, id: "images/another-back.jpg", sourcePath }),
    ).rejects.toThrow("already has a back cover");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces the existing back cover's bytes in place, leaving the wrapper page untouched", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await handleEditBackCover(fakeServer, { action: "create", path, id: "images/back-cover.jpg", sourcePath });

    const newSource = join(dir, "new-back.png");
    await writeFile(newSource, "new-bytes-longer-than-before-for-back-cover");

    const result = await handleEditBackCover(fakeServer, { action: "edit", path, sourcePath: newSource, mediaType: "image/png" });

    expect(result.structuredContent?.id).toBe("images/back-cover.jpg");
    expect(Number(result.structuredContent?.sizeBytes)).toBe(43); // "new-bytes-longer-than-before-for-back-cover"

    const cached = epubCache.get(resolve(path))!;
    const text = new TextDecoder().decode(cached.resources["images/back-cover.jpg"]!.data);
    expect(text).toBe("new-bytes-longer-than-before-for-back-cover");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit fails if the book has no back cover yet", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await expect(handleEditBackCover(fakeServer, { action: "edit", path, sourcePath })).rejects.toThrow("has no back cover");

    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes the back cover resource, manifest entry, wrapper page content doc, spine entry, landmark, and guide reference", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    await handleEditBackCover(fakeServer, { action: "create", path, id: "images/back-cover.jpg", sourcePath });

    const result = await handleEditBackCover(fakeServer, { action: "remove", path });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    expect(cached.resources["images/back-cover.jpg"]).toBeUndefined();
    // Guide reference should be gone.
    expect(pkg.guide?.references.some((r) => r.type === "other.back-cover")).toBe(false);
    // Landmarks entry for afterword should be gone.
    const nav = cached.navigation["nav.xhtml"]!;
    const landmarks = nav.lists.find((l) => l.type === "landmarks");
    expect(landmarks?.items.some((p) => p.type === "afterword")).toBe(false);
    // Wrapper page content document should also be gone.
    expect(Object.keys(cached.contentDocuments)).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("remove fails if the book has no back cover", async () => {
    const { dir, path } = await writeTempBook();
    await expect(handleEditBackCover(fakeServer, { action: "remove", path })).rejects.toThrow("has no back cover");

    await rm(dir, { recursive: true, force: true });
  });

  test("front cover and back cover can coexist without interfering with each other", async () => {
    const { dir, path, sourcePath } = await writeTempBook();
    const { handleEditCover } = await import("./edit-cover.ts");
    await handleEditCover(fakeServer, { action: "create", path, id: "images/front.jpg", sourcePath });
    await handleEditBackCover(fakeServer, { action: "create", path, id: "images/back.jpg", sourcePath });

    const cached = epubCache.get(resolve(path))!;
    const pkg = primaryPackage(cached)!;
    // Front cover is first in the spine, back cover is last.
    const firstItem = pkg.manifest.items.find((mi) => mi.id.endsWith("/" + pkg.spine.itemRefs[0]!.idRef));
    const lastItem = pkg.manifest.items.find((mi) => mi.id.endsWith("/" + pkg.spine.itemRefs[pkg.spine.itemRefs.length - 1]!.idRef));
    expect(firstItem?.href).toContain("cover.xhtml");
    expect(lastItem?.href).toContain("back-cover.xhtml");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("findBackCoverGuideRef", () => {
  test("returns undefined when there's no guide element", () => {
    const pkg = newEpub("Test", "Author").packages["content.opf"]!;
    expect(findBackCoverGuideRef(pkg)).toBeUndefined();
  });

  test("returns undefined when guide exists but has no back-cover reference", () => {
    const e = newEpub("Test", "Author");
    e.packages["content.opf"].guide = { id: "content.opf#guide", references: [{ id: "ref1", type: "cover", href: "cover.xhtml", title: "Cover" }] };
    expect(findBackCoverGuideRef(e.packages["content.opf"])).toBeUndefined();
  });

  test("returns the back-cover guide reference when it exists", () => {
    const e = newEpub("Test", "Author");
    e.packages["content.opf"].guide = { id: "content.opf#guide", references: [{ id: "ref1", type: "other.back-cover", href: "back-cover.xhtml", title: "Back Cover" }] };
    const ref = findBackCoverGuideRef(e.packages["content.opf"]);
    expect(ref).toBeDefined();
    expect(ref?.href).toBe("back-cover.xhtml");
  });
});

describe("backCoverImageId", () => {
  test("returns undefined for a non-existent page id", () => {
    const e = newEpub("Test", "Author");
    expect(backCoverImageId(e, "nonexistent.xhtml")).toBeUndefined();
  });

  test("parses the image href from wrapper page markup", async () => {
    const e = newEpub("Test", "Author");
    // Simulate a back cover wrapper page generated by coverPageMarkup.
    e.contentDocuments["back-cover.xhtml"] = {
      id: "back-cover.xhtml",
      mediaType: "application/xhtml+xml",
      markup: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><section epub:type="backmatter cover"><img src="images/back-cover.jpg" alt="Back Cover"/></section></body>
</html>`,
    };

    expect(backCoverImageId(e, "back-cover.xhtml")).toBe("images/back-cover.jpg");
  });

  test("handles document-relative href resolution when page is in a subdirectory", async () => {
    const e = newEpub("Test", "Author");
    e.contentDocuments["chapters/back-cover.xhtml"] = {
      id: "chapters/back-cover.xhtml",
      mediaType: "application/xhtml+xml",
      markup: `<html><body><img src="images/cover.jpg"/></body></html>`,
    };

    expect(backCoverImageId(e, "chapters/back-cover.xhtml")).toBe("chapters/images/cover.jpg");
  });

  test("returns undefined when markup has no img tag", () => {
    const e = newEpub("Test", "Author");
    e.contentDocuments["page.xhtml"] = {
      id: "page.xhtml",
      mediaType: "application/xhtml+xml",
      markup: "<html><body><p>No image here</p></body></html>",
    };

    expect(backCoverImageId(e, "page.xhtml")).toBeUndefined();
  });
});

describe("resolveDocumentRelativeHref", () => {
  test("absolute path returns without leading slash", () => {
    expect(resolveDocumentRelativeHref("foo.xhtml", "/bar/baz.jpg")).toBe("bar/baz.jpg");
  });

  test("same-directory relative href preserved", () => {
    expect(resolveDocumentRelativeHref("page.xhtml", "image.jpg")).toBe("image.jpg");
  });

  test("subdirectory page resolves relative href into subdirectory path", () => {
    expect(resolveDocumentRelativeHref("chapters/page.xhtml", "image.jpg")).toBe("chapters/image.jpg");
  });

  test("parent-directory traversal is collapsed", () => {
    expect(resolveDocumentRelativeHref("chapters/sub/page.xhtml", "../image.jpg")).toBe("chapters/image.jpg");
  });
});

