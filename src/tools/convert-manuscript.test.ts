import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleConvertManuscript } from "./convert-manuscript.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";
import type { Epub, Package } from "../epub/types.ts";

function makeFakeServer(elicitResponse?: { action: string; content?: Record<string, unknown> }): Server {
  return {
    elicitInput: async () => elicitResponse ?? { action: "accept", content: { leftoverAction: "keep" } },
  } as unknown as Server;
}

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-convert-manuscript-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Convert Manuscript Test", "Author"), path);
  return { dir, path };
}

/**
 * Builds a temp EPUB whose package document lives under "OEBPS/" rather than
 * at the archive root, so pkg.baseDir is non-empty ("OEBPS/") once parseEpub
 * reads it back in. Every fixture built by writeTempBook() (and thus every
 * other test in this file) has an empty baseDir, which is what let the
 * NavPoint.href-through-resolveHref bug slip through undetected — see
 * edit-resource.test.ts's writeTempBookUnderOEBPS for the established
 * pattern this mirrors (Phase 4 hit an analogous baseDir bug there).
 */
async function writeTempBookUnderOEBPS(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-convert-manuscript-basedir-test-"));
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
      titles: [{ id: "OEBPS/content.opf#metadata/title[0]", value: "Convert Manuscript BaseDir Test", type: "main", lang: "" }],
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
      tocRef: "",
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

describe("convert_manuscript", () => {
  test("splits a manuscript file into chapters and inserts them", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1: The Beginning", "", "First paragraph.", "", "Chapter 2", "", "Second paragraph."].join("\n"));

    const result = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.chaptersFound).toBe(2);
    const createdIds = result.structuredContent?.createdIds as string[];
    expect(createdIds).toHaveLength(2);

    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[createdIds[0]!]?.markup).toContain("First paragraph.");
    expect(cached.contentDocuments[createdIds[1]!]?.markup).toContain("Second paragraph.");

    await rm(dir, { recursive: true, force: true });
  });

  test("strips HTML tags for .html sources", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.html");
    await writeFile(sourcePath, "<html><body><h1>Chapter 1</h1><p>Body text.</p></body></html>");

    const result = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    expect(result.structuredContent?.chaptersFound).toBe(1);
    const createdIds = result.structuredContent?.createdIds as string[];
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[createdIds[0]!]?.markup).toContain("Body text.");

    await rm(dir, { recursive: true, force: true });
  });

  test("replaces an existing chapter in place when its number already exists", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1", "", "Original text."].join("\n"));
    const first = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });
    const originalId = (first.structuredContent?.createdIds as string[])[0]!;

    await writeFile(sourcePath, ["Chapter 1", "", "Replacement text."].join("\n"));
    const second = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    expect(second.structuredContent?.replacedIds).toEqual([originalId]);
    expect(second.structuredContent?.createdIds).toBeUndefined();
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[originalId]?.markup).toContain("Replacement text.");

    await rm(dir, { recursive: true, force: true });
  });

  test("reports leftover chapters and keeps them by default", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1", "", "First.", "", "Chapter 2", "", "Second."].join("\n"));
    await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    await writeFile(sourcePath, ["Chapter 1", "", "Only one chapter now."].join("\n"));
    const result = await handleConvertManuscript(makeFakeServer({ action: "accept", content: { leftoverAction: "" } }), { path, sourcePath });

    expect(result.structuredContent?.leftoverAction).toBe("keep");
    const leftoverIds = result.structuredContent?.leftoverIds as string[];
    expect(leftoverIds).toHaveLength(1);
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[leftoverIds[0]!]).toBeDefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("deletes leftover chapters when the user chooses delete", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1", "", "First.", "", "Chapter 2", "", "Second."].join("\n"));
    await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    await writeFile(sourcePath, ["Chapter 1", "", "Only one chapter now."].join("\n"));
    const result = await handleConvertManuscript(makeFakeServer({ action: "accept", content: { leftoverAction: "delete" } }), { path, sourcePath });

    const leftoverIds = result.structuredContent?.leftoverIds as string[];
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[leftoverIds[0]!]).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when the leftover-action prompt is declined", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1", "", "First.", "", "Chapter 2", "", "Second."].join("\n"));
    await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    await writeFile(sourcePath, ["Chapter 1", "", "Only one now."].join("\n"));
    await expect(
      handleConvertManuscript(makeFakeServer({ action: "decline" }), { path, sourcePath }),
    ).rejects.toThrow("leftover chapter action was not provided");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when the source file has no readable chapters and is empty", async () => {
    const { dir, path } = await writeTempBook();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "");

    // An empty file still produces one untitled fragment via
    // splitProseParagraphs/splitManuscriptChapters's no-marker fallback,
    // so this exercises the fallback path rather than a true error —
    // confirm it creates exactly one (empty-bodied) chapter rather than
    // throwing, matching splitManuscriptChapters's documented behavior.
    const result = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });
    expect(result.structuredContent?.chaptersFound).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("replaces an existing chapter in place when the package has a non-empty baseDir", async () => {
    // Regression test: existingChaptersByNumber used to resolve a NavPoint's
    // href through resolveHref(pkg, item.href) as though it were a
    // baseDir-relative ManifestItem.href. NavPoint.href is already a full
    // archive path (see syncTocOnChapterCreate in nav-sync.ts), so under a
    // non-empty baseDir this double-applied the prefix (e.g.
    // "OEBPS/OEBPS/chapter-1.xhtml"), which never matched a real content
    // document key — silently creating a duplicate chapter instead of
    // replacing the existing one. Every other test in this file uses
    // writeTempBook()/newEpub(), whose baseDir is always "", under which
    // that bug collapses to a harmless no-op. This test uses a genuinely
    // non-empty baseDir to catch a regression of that bug.
    const { dir, path } = await writeTempBookUnderOEBPS();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1", "", "Original text."].join("\n"));
    const first = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });
    const originalId = (first.structuredContent?.createdIds as string[])[0]!;

    await writeFile(sourcePath, ["Chapter 1", "", "Replacement text."].join("\n"));
    const second = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });

    expect(second.structuredContent?.replacedIds).toEqual([originalId]);
    expect(second.structuredContent?.createdIds).toBeUndefined();
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[originalId]?.markup).toContain("Replacement text.");
    // Exactly one content document should exist for chapter 1 — not two.
    const chapterDocIds = Object.keys(cached.contentDocuments).filter((id) => id !== "OEBPS/nav.xhtml");
    expect(chapterDocIds).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("deletes leftover chapters when the package has a non-empty baseDir", async () => {
    // Same root cause as above: leftoverChapterIds is built from
    // existingChaptersByNumber's map, so a mis-resolved href there also
    // broke deletion — deleteChapterDocument would silently no-op on a
    // nonexistent (double-prefixed) key while the tool's summary falsely
    // reported success. Checking contentDocuments[leftoverIds[0]] alone
    // would pass vacuously even under the bug, since a bogus reported id
    // was never a real key either way — so this asserts on the REAL
    // chapter 2 document id (captured from the first call's createdIds)
    // instead, to genuinely discriminate deleted from silently-not-deleted.
    const { dir, path } = await writeTempBookUnderOEBPS();
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, ["Chapter 1", "", "First.", "", "Chapter 2", "", "Second."].join("\n"));
    const first = await handleConvertManuscript(makeFakeServer(), { path, sourcePath });
    const chapter2Id = (first.structuredContent?.createdIds as string[])[1]!;
    expect(chapter2Id).toBeDefined();

    await writeFile(sourcePath, ["Chapter 1", "", "Only one chapter now."].join("\n"));
    const result = await handleConvertManuscript(makeFakeServer({ action: "accept", content: { leftoverAction: "delete" } }), { path, sourcePath });

    const leftoverIds = result.structuredContent?.leftoverIds as string[];
    expect(leftoverIds).toEqual([chapter2Id]);
    const cached = epubCache.get(resolve(path))!;
    expect(cached.contentDocuments[chapter2Id]).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});
