import { describe, expect, test } from "bun:test";
import { contains, findIndex, removeAt, removeMatching, verbPast } from "./idlist.ts";

interface Item {
  id: string;
  value: number;
}

describe("findIndex", () => {
  test("returns the index of the matching item", () => {
    const items: Item[] = [{ id: "a", value: 1 }, { id: "b", value: 2 }];
    expect(findIndex(items, "b", (i) => i.id)).toBe(1);
  });

  test("returns -1 when no item matches", () => {
    const items: Item[] = [{ id: "a", value: 1 }];
    expect(findIndex(items, "z", (i) => i.id)).toBe(-1);
  });
});

describe("removeAt", () => {
  test("removes the element at the given index, preserving order", () => {
    expect(removeAt([1, 2, 3], 1)).toEqual([1, 3]);
  });

  test("does not mutate the original array", () => {
    const original = [1, 2, 3];
    removeAt(original, 0);
    expect(original).toEqual([1, 2, 3]);
  });
});

describe("removeMatching", () => {
  test("keeps only elements for which keep returns true", () => {
    expect(removeMatching([1, 2, 3, 4], (n) => n % 2 === 0)).toEqual([2, 4]);
  });

  test("preserves order", () => {
    const items: Item[] = [{ id: "a", value: 1 }, { id: "b", value: 2 }, { id: "c", value: 3 }];
    expect(removeMatching(items, (i) => i.id !== "b").map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("contains", () => {
  test("returns true when the value is in the list", () => {
    expect(contains(["a", "b", "c"], "b")).toBe(true);
  });

  test("returns false when it isn't", () => {
    expect(contains(["a", "b", "c"], "z")).toBe(false);
  });
});

describe("verbPast", () => {
  test('returns "Update" for action "edit"', () => {
    expect(verbPast("edit")).toBe("Update");
  });

  test('capitalizes "create" to "Create"', () => {
    expect(verbPast("create")).toBe("Create");
  });

  test('capitalizes "remove" to "Remove"', () => {
    expect(verbPast("remove")).toBe("Remove");
  });
});
