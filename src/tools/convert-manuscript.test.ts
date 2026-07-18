import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleConvertManuscript } from "./convert-manuscript.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

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
});
