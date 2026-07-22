// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleEditManifest } from "./edit-manifest.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-manifest-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Manifest Test", "Author"), path);
  return { dir, path };
}

describe("edit_manifest", () => {
  test("rejects any action other than edit", async () => {
    const { dir, path } = await writeTempBook();
    // handleEditManifest throws rather than returning an isError result:
    // per registry.ts's design, converting a thrown error into an isError
    // result is registerTool's job, not each handler's own — see the same
    // note in edit-resource.test.ts.
    await expect(
      handleEditManifest(fakeServer, { action: "create", path, id: "styles/style.css" }),
    ).rejects.toThrow('only supports action "edit"');
    await rm(dir, { recursive: true, force: true });
  });

  test("edit updates mediaType and properties", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditManifest(fakeServer, {
      action: "edit",
      path,
      id: "styles/style.css",
      mediaType: "text/x-custom-css",
      properties: "scripted",
    });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    const item = pkg.manifest.items.find((i) => i.href === "styles/style.css");
    expect(item?.mediaType).toBe("text/x-custom-css");
    expect(item?.properties).toEqual(["scripted"]);

    await rm(dir, { recursive: true, force: true });
  });

  test('properties "none" clears them', async () => {
    const { dir, path } = await writeTempBook();
    await handleEditManifest(fakeServer, { action: "edit", path, id: "nav.xhtml", properties: "none" });

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    const item = pkg.manifest.items.find((i) => i.href === "nav.xhtml");
    expect(item?.properties).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  test("fallback and mediaOverlay accept an archive path and resolve it to an opf:id", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditManifest(fakeServer, {
      action: "edit",
      path,
      id: "styles/style.css",
      fallback: "nav.xhtml",
      mediaOverlay: "nav.xhtml",
    });

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    const item = pkg.manifest.items.find((i) => i.href === "styles/style.css");
    // newEpub()'s nav item has opf:id "nav" (id === "content.opf#manifest/nav").
    expect(item?.fallback).toBe("nav");
    expect(item?.mediaOverlay).toBe("nav");

    await rm(dir, { recursive: true, force: true });
  });

  test('fallback "none" clears it', async () => {
    const { dir, path } = await writeTempBook();
    await handleEditManifest(fakeServer, { action: "edit", path, id: "styles/style.css", fallback: "nav.xhtml" });
    await handleEditManifest(fakeServer, { action: "edit", path, id: "styles/style.css", fallback: "none" });

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    const item = pkg.manifest.items.find((i) => i.href === "styles/style.css");
    expect(item?.fallback).toBe("");

    await rm(dir, { recursive: true, force: true });
  });

  test("errors for an unknown id", async () => {
    const { dir, path } = await writeTempBook();
    await expect(
      handleEditManifest(fakeServer, { action: "edit", path, id: "no/such.css" }),
    ).rejects.toThrow("no/such.css");
    await rm(dir, { recursive: true, force: true });
  });

  test("errors for an unknown fallback archive path", async () => {
    const { dir, path } = await writeTempBook();
    await expect(
      handleEditManifest(fakeServer, { action: "edit", path, id: "styles/style.css", fallback: "no/such.xhtml" }),
    ).rejects.toThrow("no/such.xhtml");
    await rm(dir, { recursive: true, force: true });
  });
});

