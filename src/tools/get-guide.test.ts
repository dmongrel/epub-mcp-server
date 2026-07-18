import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetGuide } from "./get-guide.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_guide", () => {
  test("reports present=false for a book with no guide", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-guide-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Guide Test", "Author"), path);

    const result = await handleGetGuide(fakeServer, { path });

    expect(result.structuredContent?.present).toBe(false);
    expect(result.structuredContent?.references).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});
