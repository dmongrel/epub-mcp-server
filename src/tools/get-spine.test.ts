// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetSpine } from "./get-spine.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_spine", () => {
  test("lists spine entries with linear/properties", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-spine-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Spine Test", "Author"), path);

    const result = await handleGetSpine(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    const items = result.structuredContent?.items as Array<{ id: string; linear: boolean }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "nav.xhtml", linear: true });

    await rm(dir, { recursive: true, force: true });
  });
});

