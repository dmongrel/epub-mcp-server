// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleGetManifest } from "./get-manifest.ts";
import { newEpub } from "../epub/new-epub.ts";
import { writeEpub } from "../epub/write.ts";

const fakeServer = {} as Server;

describe("get_manifest", () => {
  test("lists every manifest item with inSpine correctly set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-get-manifest-test-"));
    const path = join(dir, "book.epub");
    await writeEpub(newEpub("Manifest Test", "Author"), path);

    const result = await handleGetManifest(fakeServer, { path });

    expect(result.isError).toBeUndefined();
    const items = result.structuredContent?.items as Array<{ id: string; inSpine: boolean }>;
    expect(items).toHaveLength(2); // nav.xhtml + styles/style.css
    const nav = items.find((i) => i.id === "nav.xhtml");
    const style = items.find((i) => i.id === "styles/style.css");
    expect(nav?.inSpine).toBe(true);
    expect(style?.inSpine).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });
});

