// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { epubCache } from "./epub-cache.ts";

describe("epubCache", () => {
  test("is a singleton Cache instance with the default capacity", () => {
    expect(epubCache.capacity).toBe(4);
  });

  test("is the same instance across multiple imports", async () => {
    const { epubCache: again } = await import("./epub-cache.ts");
    expect(again).toBe(epubCache);
  });
});

