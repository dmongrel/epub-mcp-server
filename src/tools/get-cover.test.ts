import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { findCoverItem, handleGetCover } from "./get-cover.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_cover", () => {
  test("reports present:false for a book with no cover", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-cover-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Get Cover Test", "Author"), path);

    const result = await handleGetCover(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.present).toBe(false);
    expect(result.structuredContent?.data).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("returns inline base64 data for a book with a cover-image property", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-cover-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Get Cover Data Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/cover`, href: "images/cover.jpg", mediaType: "image/jpeg", properties: ["cover-image"], fallback: "", mediaOverlay: "" });
    e.resources["images/cover.jpg"] = { id: "images/cover.jpg", mediaType: "image/jpeg", data: new TextEncoder().encode("fake-jpeg-bytes") };
    await writeEpub(e, path);

    const result = await handleGetCover(fakeServer, { path });

    expect(result.structuredContent?.present).toBe(true);
    expect(result.structuredContent?.id).toBe("images/cover.jpg");
    expect(result.structuredContent?.mediaType).toBe("image/jpeg");
    expect(result.structuredContent?.sizeBytes).toBe(15);
    expect(result.structuredContent?.data).toBe(Buffer.from("fake-jpeg-bytes").toString("base64"));
    expect(result.structuredContent?.sourcePath).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("falls back to the legacy meta name=cover pointer when no manifest item has cover-image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-cover-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Get Cover Legacy Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/cover`, href: "images/cover.png", mediaType: "image/png", properties: [], fallback: "", mediaOverlay: "" });
    e.resources["images/cover.png"] = { id: "images/cover.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) };
    pkg.metadata.metas.push({ id: `${pkg.metadata.id}/meta[0]`, property: "", refines: "", scheme: "", value: "cover", name: "cover" });

    await writeEpub(e, path);

    const result = await handleGetCover(fakeServer, { path });

    expect(result.structuredContent?.present).toBe(true);
    expect(result.structuredContent?.id).toBe("images/cover.png");

    await rm(dir, { recursive: true, force: true });
  });

  test("writes to sourcePath instead of returning inline data when given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-cover-test-"));
    const path = join(dir, "book.epub");
    const e = newEpub("Get Cover SourcePath Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/cover`, href: "cover.jpg", mediaType: "image/jpeg", properties: ["cover-image"], fallback: "", mediaOverlay: "" });
    e.resources["cover.jpg"] = { id: "cover.jpg", mediaType: "image/jpeg", data: new TextEncoder().encode("bytes") };
    await writeEpub(e, path);

    const outPath = join(dir, "out.jpg");
    const result = await handleGetCover(fakeServer, { path, sourcePath: outPath });

    expect(result.structuredContent?.sourcePath).toBe(outPath);
    expect(result.structuredContent?.data).toBeUndefined();
    const written = await Bun.file(outPath).text();
    expect(written).toBe("bytes");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when path is missing", async () => {
    await expect(handleGetCover(fakeServer, { path: "" })).rejects.toThrow("path is required");
  });
});

describe("findCoverItem", () => {
  test("prefers the cover-image manifest property over the legacy meta pointer", async () => {
    const e = newEpub("Find Cover Item Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/a`, href: "a.jpg", mediaType: "image/jpeg", properties: [], fallback: "", mediaOverlay: "" });
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/b`, href: "b.jpg", mediaType: "image/jpeg", properties: ["cover-image"], fallback: "", mediaOverlay: "" });
    pkg.metadata.metas.push({ id: `${pkg.metadata.id}/meta[0]`, property: "", refines: "", scheme: "", value: "a", name: "cover" });

    const item = findCoverItem(pkg);
    expect(item?.href).toBe("b.jpg");
  });

  test("returns undefined when neither mechanism identifies a cover", () => {
    const e = newEpub("Find Cover Item Missing Test", "Author");
    const pkg = primaryPackage(e)!;
    expect(findCoverItem(pkg)).toBeUndefined();
  });
});
