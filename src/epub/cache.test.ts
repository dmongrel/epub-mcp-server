import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cache, canonicalPath } from "./cache.ts";
import type { Epub } from "./types.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "testdata", "the-magic-hower.epub");

function fakeEpub(tag: string): Epub {
  return {
    id: "",
    mimetype: tag,
    container: { id: "META-INF/container.xml", version: "1.0", rootfiles: [] },
    packages: {},
    navigation: {},
    nCXs: {},
    contentDocuments: {},
    resources: {},
  };
}

describe("Cache LRU eviction", () => {
  test("evicts the least recently used entry once past capacity", () => {
    const cache = new Cache(4);
    cache.put("a", fakeEpub("a"));
    cache.put("b", fakeEpub("b"));
    cache.put("c", fakeEpub("c"));
    cache.put("d", fakeEpub("d"));

    // touch "a" so "b" becomes least recently used
    expect(cache.get("a")).toBeDefined();

    cache.put("e", fakeEpub("e"));

    expect(cache.get("b")).toBeUndefined();
    for (const k of ["a", "c", "d", "e"]) {
      expect(cache.get(k)).toBeDefined();
    }
  });
});

describe("Cache eviction reports dirty state", () => {
  test("reports the evicted entry's path and dirty flag", () => {
    const cache = new Cache(2);
    expect(cache.put("a", fakeEpub("a"))).toBeUndefined();
    cache.put("b", fakeEpub("b"));
    cache.markDirty("a");

    const evicted = cache.put("c", fakeEpub("c"));
    expect(evicted).toEqual({ path: "a", wasDirty: true });
  });
});

describe("Cache mark and clear dirty", () => {
  test("toggles the dirty flag reported by entries()", () => {
    const cache = new Cache(4);
    cache.put("a", fakeEpub("a"));

    expect(cache.entries()).toEqual([{ path: "a", dirty: false }]);

    cache.markDirty("a");
    expect(cache.entries()).toEqual([{ path: "a", dirty: true }]);

    cache.clearDirty("a");
    expect(cache.entries()).toEqual([{ path: "a", dirty: false }]);
  });
});

describe("Cache entries ordering", () => {
  test("orders most-recently-used first", () => {
    const cache = new Cache(4);
    cache.put("a", fakeEpub("a"));
    cache.put("b", fakeEpub("b"));
    cache.put("c", fakeEpub("c"));

    cache.get("a"); // touch a, moving it to the front

    expect(cache.entries().map((e) => e.path)).toEqual(["a", "c", "b"]);
  });
});

describe("Cache remove", () => {
  test("removes an entry and reports its prior dirty state", () => {
    const cache = new Cache(4);
    cache.put("a", fakeEpub("a"));
    cache.markDirty("a");

    expect(cache.remove("a")).toEqual({ removed: true, wasDirty: true });
    expect(cache.get("a")).toBeUndefined();
    expect(cache.remove("a")).toEqual({ removed: false, wasDirty: false });
  });
});

describe("Cache.load", () => {
  test("parses a real file on first load and returns the cached instance on the next", async () => {
    const cache = new Cache(4);
    const first = await cache.load(fixturePath);
    expect(first.eviction).toBeUndefined();
    expect(first.epub.mimetype).toBe("application/epub+zip");

    const second = await cache.load(fixturePath);
    expect(second.epub).toBe(first.epub);
    expect(second.eviction).toBeUndefined();
  });
});

describe("canonicalPath", () => {
  test("folds differently-cased spellings of the same file to one cache entry, on a case-insensitive filesystem", async () => {
    const altPath = fixturePath.toUpperCase();
    if (canonicalPath(altPath) !== canonicalPath(fixturePath)) {
      return; // case-sensitive filesystem — nothing to test here
    }

    const cache = new Cache(4);
    await cache.load(fixturePath);
    cache.markDirty(fixturePath);

    expect(cache.remove(altPath)).toEqual({ removed: true, wasDirty: true });
    expect(cache.get(fixturePath)).toBeUndefined();
  });
});
