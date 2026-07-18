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

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-edit-resource-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Edit Resource Test", "Author"), path);
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
