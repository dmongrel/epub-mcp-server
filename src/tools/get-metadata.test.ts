import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetMetadata } from "./get-metadata.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_metadata", () => {
  test("returns titles, creators, and identifiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-metadata-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Metadata Test", "Jane Author"), path);

    const result = await handleGetMetadata(fakeServer, { path });

    const titles = result.structuredContent?.titles as Array<{ value: string }>;
    const creators = result.structuredContent?.creators as Array<{ name: string }>;
    expect(titles[0]?.value).toBe("Metadata Test");
    expect(creators[0]?.name).toBe("Jane Author");
    expect((result.structuredContent?.identifiers as unknown[]).length).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });
});
