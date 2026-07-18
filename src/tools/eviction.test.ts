import { describe, expect, test } from "bun:test";
import { evictionNote } from "./eviction.ts";

describe("evictionNote", () => {
  test("returns an empty string when nothing was evicted", () => {
    expect(evictionNote(undefined)).toBe("");
  });

  test("warns about lost unsaved edits when the evicted entry was dirty", () => {
    const note = evictionNote({ path: "/tmp/book.epub", wasDirty: true });

    expect(note).toContain('"/tmp/book.epub"');
    expect(note).toContain("unsaved edits, now lost");
    expect(note).toContain("save_epub");
  });

  test("reports a plain close for a clean evicted entry, without the data-loss warning", () => {
    const note = evictionNote({ path: "/tmp/book.epub", wasDirty: false });

    expect(note).toBe(' Closed "/tmp/book.epub" to make room in the cache.');
  });
});
