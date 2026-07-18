import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { applyGuideEdit, handleEditGuide } from "./edit-guide.ts";
import { epubCache } from "./epub-cache.ts";
import { newEpub } from "../epub/new-epub.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-guide-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Guide Test", "Author"), path);
  return { dir, path };
}

describe("edit_guide", () => {
  test("create adds a reference, creating the guide element if absent", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleEditGuide(fakeServer, { action: "create", path, id: "toc", href: "nav.xhtml" });

    expect(result.isError).toBeUndefined();
    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.guide?.references).toHaveLength(1);
    expect(pkg.guide?.references[0]).toMatchObject({ type: "toc", href: "nav.xhtml" });

    await rm(dir, { recursive: true, force: true });
  });

  test("create fails if a reference of that type already exists", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditGuide(fakeServer, { action: "create", path, id: "toc", href: "nav.xhtml" });
    // handleEditGuide throws rather than returning an isError result: per
    // registry.ts's design, converting a thrown error into an isError
    // result is registerTool's job, not each handler's own — see the same
    // note in edit-spine.test.ts.
    await expect(
      handleEditGuide(fakeServer, { action: "create", path, id: "toc", href: "other.xhtml" }),
    ).rejects.toThrow("toc");

    await rm(dir, { recursive: true, force: true });
  });

  test("edit replaces href and title", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditGuide(fakeServer, { action: "create", path, id: "toc", href: "nav.xhtml" });
    await handleEditGuide(fakeServer, { action: "edit", path, id: "toc", href: "toc2.xhtml", title: "Contents" });

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.guide?.references[0]).toMatchObject({ href: "toc2.xhtml", title: "Contents" });

    await rm(dir, { recursive: true, force: true });
  });

  test("remove deletes the reference", async () => {
    const { dir, path } = await writeTempBook();
    await handleEditGuide(fakeServer, { action: "create", path, id: "toc", href: "nav.xhtml" });
    await handleEditGuide(fakeServer, { action: "remove", path, id: "toc" });

    const cached = epubCache.get(resolve(path));
    const pkg = primaryPackage(cached!)!;
    expect(pkg.guide?.references).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("applyGuideEdit", () => {
  test("edit on a nonexistent reference throws", () => {
    const pkg = primaryPackage(newEpub("Direct Test", "Author"))!;
    expect(() => applyGuideEdit(pkg, "edit", "cover", "", "cover.xhtml")).toThrow();
  });
});
