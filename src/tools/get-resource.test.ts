import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetResource } from "./get-resource.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

async function writeTempBook(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "epub-get-resource-test-"));
  const path = join(dir, "book.epub");
  await writeEpub(newEpub("Resource Test", "Author"), path);
  return { dir, path };
}

describe("get_resource", () => {
  test("returns a text resource inline", async () => {
    const { dir, path } = await writeTempBook();
    const result = await handleGetResource(fakeServer, { path, id: "styles/style.css" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.isText).toBe(true);
    expect(result.structuredContent?.mediaType).toBe("text/css");
    expect(typeof result.structuredContent?.text).toBe("string");
    expect(result.structuredContent?.data).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test("writes to sourcePath instead of returning inline content when given", async () => {
    const { dir, path } = await writeTempBook();
    const outPath = join(dir, "out.css");
    const result = await handleGetResource(fakeServer, { path, id: "styles/style.css", sourcePath: outPath });

    expect(result.structuredContent?.sourcePath).toBe(outPath);
    expect(result.structuredContent?.text).toBeUndefined();
    const written = await readFile(outPath, "utf-8");
    expect(written.length).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("errors when id doesn't name a resource", async () => {
    const { dir, path } = await writeTempBook();
    // handleGetResource throws rather than returning an isError result:
    // per registry.ts's design, converting a thrown error into an isError
    // result is registerTool's job (the single choke point every tool's
    // internal invariant violations flow through), not each handler's own.
    // dispatchTool/registerTool-level conversion is covered by
    // registry.test.ts; here we assert directly on what the handler itself
    // throws.
    await expect(handleGetResource(fakeServer, { path, id: "no/such/resource.css" })).rejects.toThrow(
      "no/such/resource.css",
    );

    await rm(dir, { recursive: true, force: true });
  });
});
