import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentPlatform, readBinaryPortable, writeBinaryPortable } from "./runtime.ts";

describe("writeBinaryPortable / readBinaryPortable", () => {
  test("round-trips bytes through a real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-runtime-test-"));
    const path = join(dir, "data.bin");
    const original = new Uint8Array([1, 2, 3, 4, 250, 251, 252]);

    await writeBinaryPortable(path, original);
    const readBack = await readBinaryPortable(path);

    expect(Array.from(readBack)).toEqual(Array.from(original));
    await rm(dir, { recursive: true, force: true });
  });

  test("overwrites an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epub-runtime-test-"));
    const path = join(dir, "data.bin");

    await writeBinaryPortable(path, new Uint8Array([1, 1, 1]));
    await writeBinaryPortable(path, new Uint8Array([2, 2]));
    const readBack = await readBinaryPortable(path);

    expect(Array.from(readBack)).toEqual([2, 2]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("currentPlatform", () => {
  test("returns process.platform under Bun", () => {
    expect(currentPlatform()).toBe(process.platform);
  });
});
