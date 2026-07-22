// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { archiveIdInUse, handleEditResource } from "./edit-resource.ts";
import { epubCache } from "./epub-cache.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { parseEpub } from "../epub/parse.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";
import type { Epub, Package } from "../epub/types.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-resource-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Resource Test", "Author"), path);
  return { dir, path };
}

/**
 * Builds a temp book whose package document lives under "OEBPS/" rather
 * than at the archive root, so pkg.baseDir is non-empty ("OEBPS/") once
 * parseEpub reads it back in. Every fixture built by writeTempBook() (and
 * thus every pre-existing test in this file) has an empty baseDir, which
 * is what let the manifest-lookup-by-raw-href bug slip through: `id` here
 * is always a full archive path ("OEBPS/images/cover.jpg"), while
 * ManifestItem.href is stored relative to baseDir ("images/cover.jpg") —
 * see manifestItemByHref in ../epub/resolve.ts.
 */
async function writeTempBookUnderOEBPS(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-resource-basedir-test-"));
  const path = join(dir, "book.epub");
  const now = new Date().toISOString();

  const pkg: Package = {
    id: "OEBPS/content.opf",
    baseDir: "OEBPS/",
    version: "3.0",
    uniqueIdentifierRef: "uid",
    lang: "en",
    metadata: {
      id: "OEBPS/content.opf#metadata",
      identifiers: [{ id: "OEBPS/content.opf#metadata/identifier[bookid]", scheme: "UUID", value: crypto.randomUUID() }],
      titles: [{ id: "OEBPS/content.opf#metadata/title[0]", value: "BaseDir Test", type: "main", lang: "" }],
      languages: [{ id: "OEBPS/content.opf#metadata/language[0]", value: "en" }],
      creators: [],
      contributors: [],
      publishers: [],
      dates: [],
      subjects: [],
      description: "",
      rights: "",
      metas: [{ id: "OEBPS/content.opf#metadata/meta[modified]", property: "dcterms:modified", refines: "", scheme: "", value: now, name: "" }],
    },
    manifest: {
      id: "OEBPS/content.opf#manifest",
      items: [
        { id: "OEBPS/content.opf#manifest/nav", href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: ["nav"], fallback: "", mediaOverlay: "" },
        { id: "OEBPS/content.opf#manifest/style", href: "styles/style.css", mediaType: "text/css", properties: [], fallback: "", mediaOverlay: "" },
      ],
    },
    spine: {
      id: "OEBPS/content.opf#spine",
      tocRef: "nav",
      pageProgressionDirection: "ltr",
      itemRefs: [{ id: "OEBPS/content.opf#spine/itemref[0]", idRef: "nav", linear: true, properties: [] }],
    },
  };

  const e: Epub = {
    id: "",
    mimetype: "application/epub+zip",
    container: {
      id: "META-INF/container.xml",
      version: "1.0",
      rootfiles: [{ id: "META-INF/container.xml#rootfiles[0]", fullPath: "OEBPS/content.opf", mediaType: "application/oebps-package+xml" }],
    },
    packages: { "OEBPS/content.opf": pkg },
    navigation: {
      "OEBPS/nav.xhtml": {
        id: "OEBPS/nav.xhtml",
        mediaType: "application/xhtml+xml",
        markup: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2009/ops" lang="en">
<body><nav epub:type="toc"><h1>Contents</h1><ol></ol></nav></body>
</html>`,
        lists: [{ id: "OEBPS/nav.xhtml#toc", type: "toc", heading: "Contents", items: [] }],
      },
    },
    nCXs: {},
    contentDocuments: {},
    resources: {
      "OEBPS/styles/style.css": {
        id: "OEBPS/styles/style.css",
        mediaType: "text/css",
        data: new TextEncoder().encode("body { margin: 0; }"),
      },
    },
  };

  await writeEpub(e, path);
  return { dir, path };
}

describe("edit_resource", () => {
  test("create adds a new resource to the manifest", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditResource(fakeServer, {
      action: "create",
      path,
      id: "styles/notes.css",
      content: "body { color: red; }",
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.action).toBe("create");
    expect(result.structuredContent?.mediaType).toBe("text/css");

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if id already exists", async () => {
    const { dir, path } = await writeTempBook();
    // handleEditResource throws rather than returning an isError result:
    // per registry.ts's design, converting a thrown error into an isError
    // result is registerTool's job, not each handler's own — see the same
    // note in get-resource.test.ts.
    await expect(
      handleEditResource(fakeServer, {
        action: "create",
        path,
        id: "styles/style.css", // already exists in newEpub()'s skeleton
        content: "body {}",
      }),
    ).rejects.toThrow("styles/style.css");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces an existing resource's content", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditResource(fakeServer, {
      action: "edit",
      path,
      id: "styles/style.css",
      content: "body { color: blue; }",
    });

    const cached = epubCache.get(resolve(path));
    expect(cached?.resources["styles/style.css"]?.data).toBeDefined();
    const text = new TextDecoder().decode(cached!.resources["styles/style.css"]!.data);
    expect(text).toBe("body { color: blue; }");

    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes a resource from the manifest", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditResource(fakeServer, { action: "create", path, id: "styles/notes.css", content: "x" });
    const result = await handleEditResource(fakeServer, { action: "remove", path, id: "styles/notes.css" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.action).toBe("remove");

    await rm(dir, { recursive: true, force: true });
  });

  test("remove fails on the cover image", async () => {
    const { dir, path } = await writeTempBook();
    // newEpub()'s skeleton has no cover; create one as a manifest item
    // with the cover-image property directly via a resource create, then
    // hand-verify edit_resource refuses to remove it — this test exists
    // to lock in the guard even though full cover creation is Phase 8's
    // edit_cover, not this tool.
    await handleEditResource(fakeServer, { action: "create", path, id: "images/cover.jpg", content: "x" });
    // Directly mutate the cached epub to add the cover-image property,
    // simulating what edit_cover will do in Phase 8.
    const cached = epubCache.get(resolve(path));
    const pkg = cached ? primaryPackage(cached) : undefined;
    const item = pkg?.manifest.items.find((i) => i.href === "images/cover.jpg");
    if (item) item.properties = ["cover-image"];

    // handleEditResource throws rather than returning an isError result —
    // see the note in the "create fails if id already exists" test above.
    await expect(handleEditResource(fakeServer, { action: "remove", path, id: "images/cover.jpg" })).rejects.toThrow(
      "edit_cover",
    );

    await rm(dir, { recursive: true, force: true });
  });

  test("remove fails on the cover image when the package has a non-empty baseDir", async () => {
    // Regression test for the bug fixed alongside this test: editExistingResource
    // and removeResource used to look up the manifest item via a raw
    // `i.href === id` comparison, but id is a full archive path
    // ("OEBPS/images/cover.jpg") while ManifestItem.href is stored relative to
    // pkg.baseDir ("images/cover.jpg"). That raw comparison only ever matched
    // when baseDir was empty, so on any real EPUB (content.opf nested under a
    // subdirectory, the common case) the cover-image guard silently never
    // fired, and the guarded item was deleted without error. This must now
    // use manifestItemByHref, which resolves baseDir correctly.
    const { dir, path } = await writeTempBookUnderOEBPS();
    await handleEditResource(fakeServer, { action: "create", path, id: "OEBPS/images/cover.jpg", content: "x" });

    const cached = epubCache.get(resolve(path));
    const pkg = cached ? primaryPackage(cached) : undefined;
    expect(pkg?.baseDir).toBe("OEBPS/");
    const item = pkg ? pkg.manifest.items.find((i) => i.href === "images/cover.jpg") : undefined;
    if (item) item.properties = ["cover-image"];

    await expect(
      handleEditResource(fakeServer, { action: "remove", path, id: "OEBPS/images/cover.jpg" }),
    ).rejects.toThrow("edit_cover");

    // The manifest item must still be present: the fixed remove path throws
    // before touching either the manifest or e.resources.
    const stillCached = epubCache.get(resolve(path));
    const stillPkg = stillCached ? primaryPackage(stillCached) : undefined;
    expect(stillPkg?.manifest.items.some((i) => i.href === "images/cover.jpg")).toBe(true);
    expect(stillCached?.resources["OEBPS/images/cover.jpg"]).toBeDefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("edit syncs mediaType on the manifest item when the package has a non-empty baseDir", async () => {
    // Same baseDir-aware lookup bug as above, but exercised through
    // editExistingResource's mediaType sync instead of removeResource's
    // cover-image guard.
    const { dir, path } = await writeTempBookUnderOEBPS();
    const result = await handleEditResource(fakeServer, {
      action: "edit",
      path,
      id: "OEBPS/styles/style.css",
      content: "body { color: blue; }",
      mediaType: "text/x-custom-css",
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.mediaType).toBe("text/x-custom-css");

    const cached = epubCache.get(resolve(path));
    const pkg = cached ? primaryPackage(cached) : undefined;
    const item = pkg?.manifest.items.find((i) => i.href === "styles/style.css");
    expect(item?.mediaType).toBe("text/x-custom-css");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("archiveIdInUse", () => {
  test("returns true for an existing resource, false for an unused path", async () => {
    const { dir, path } = await writeTempBook();
    const e = await parseEpub(path);
    expect(archiveIdInUse(e, "styles/style.css")).toBe(true);
    expect(archiveIdInUse(e, "does/not/exist.css")).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

