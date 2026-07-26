// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleValidateEpub } from "./validate-epub.ts";
import { handleConvertManuscript } from "./convert-manuscript.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function newTestEpub(title: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-validate-epub-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub(title, "Author"), path);
  return { dir, path };
}

interface ValidateResult {
  path: string;
  ok: boolean;
  errorCount: number;
  warningCount: number;
  checksRun: string[];
  findings: Array<{ check: string; severity: string; message: string; ids: string[]; remedy: string }>;
}

describe("validate_epub", () => {
  test("errors when path is missing", async () => {
    await expect(handleValidateEpub(fakeServer, {} as never)).rejects.toThrow("path is required");
  });

  test("reports a converted book as clean", async () => {
    const { path, dir } = await newTestEpub("Validate Clean");
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "Chapter 1: Dawn\n\nFirst.\n\nChapter 2: Dusk\n\nSecond.\n", "utf-8");
    await handleConvertManuscript(fakeServer, { path, sourcePath });

    const res = await handleValidateEpub(fakeServer, { path });
    const result = res.structuredContent as unknown as ValidateResult;

    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.findings).toEqual([]);
    expect(res.content[0]!.text).toContain("no problems found");

    await rm(dir, { recursive: true, force: true });
  });

  test("reports a misaligned toc as an error, with a remedy", async () => {
    const { path, dir } = await newTestEpub("Validate Misaligned");
    const sourcePath = join(dir, "manuscript.txt");
    await writeFile(sourcePath, "Chapter 1: Dawn\n\nFirst.\n\nChapter 2: Dusk\n\nSecond.\n", "utf-8");
    await handleConvertManuscript(fakeServer, { path, sourcePath });
    const e = epubCache.get(resolve(path))!;
    e.navigation["nav.xhtml"]!.lists.find((l) => l.type === "toc")!.items[0]!.label = "Chapter 5: Dawn";

    const result = (await handleValidateEpub(fakeServer, { path })).structuredContent as unknown as ValidateResult;

    expect(result.ok).toBe(false);
    expect(result.errorCount).toBe(1);
    const finding = result.findings[0]!;
    expect(finding.check).toBe("toc-label-heading-mismatch");
    expect(finding.remedy).toContain("edit_navigation");

    await rm(dir, { recursive: true, force: true });
  });

  test("runs only the requested checks", async () => {
    // newEpub()'s spine always carries one itemref for the nav document
    // itself (see src/epub/new-epub.ts, and the same note in
    // save-epub.test.ts), so a book with a genuinely empty spine to trip
    // this check needs that itemref cleared before it's written.
    const dir = await mkdtemp(join(tmpdir(), "epub-validate-epub-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Validate Subset", "Author");
    primaryPackage(e)!.spine.itemRefs = [];
    await writeEpub(e, path);

    const result = (await handleValidateEpub(fakeServer, { path, checks: ["empty-spine"] })).structuredContent as unknown as ValidateResult;

    expect(result.checksRun).toEqual(["empty-spine"]);
    expect(result.findings.map((f) => f.check)).toEqual(["empty-spine"]);

    await rm(dir, { recursive: true, force: true });
  });

  test("rejects an unknown check name, naming the valid ones", async () => {
    const { path, dir } = await newTestEpub("Validate Unknown Check");

    await expect(handleValidateEpub(fakeServer, { path, checks: ["no-such-check"] })).rejects.toThrow("toc-spine-order");

    await rm(dir, { recursive: true, force: true });
  });

  test("counts errors and warnings separately", async () => {
    const { path, dir } = await newTestEpub("Validate Counts");
    await epubCache.load(resolve(path));
    const e = epubCache.get(resolve(path))!;
    // newEpub()'s spine always carries one itemref for the nav document
    // itself (see src/epub/new-epub.ts), so an actually-empty spine has to
    // be cleared explicitly to get the error this test wants alongside the
    // orphan-content-document warning below.
    primaryPackage(e)!.spine.itemRefs = [];
    e.contentDocuments["text/loose.xhtml"] = { id: "text/loose.xhtml", mediaType: "application/xhtml+xml", markup: "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>x</p></body></html>" };

    const result = (await handleValidateEpub(fakeServer, { path })).structuredContent as unknown as ValidateResult;

    // An empty spine (error) plus an unmanifested content document (warning).
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.warningCount).toBeGreaterThan(0);
    expect(result.errorCount + result.warningCount).toBe(result.findings.length);

    await rm(dir, { recursive: true, force: true });
  });

  test("changes nothing — the cache stays clean", async () => {
    const { path, dir } = await newTestEpub("Validate Read Only");
    await epubCache.load(resolve(path));
    const before = JSON.stringify(primaryPackage(epubCache.get(resolve(path))!)!.spine);

    await handleValidateEpub(fakeServer, { path });

    const status = epubCache.entries().find((entry) => entry.path === resolve(path));
    expect(status?.dirty).toBe(false);
    expect(JSON.stringify(primaryPackage(epubCache.get(resolve(path))!)!.spine)).toBe(before);

    await rm(dir, { recursive: true, force: true });
  });
});
