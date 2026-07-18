import { describe, expect, test } from "bun:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveArg, withHint } from "./elicit.ts";

function fakeServer(elicitInput: (params: unknown) => Promise<ElicitResult>): Server {
  return { elicitInput } as unknown as Server;
}

describe("resolveArg", () => {
  test("returns current immediately without eliciting when already supplied", async () => {
    let called = false;
    const server = fakeServer(async () => {
      called = true;
      return { action: "accept", content: {} };
    });

    const value = await resolveArg(server, "explicit value", "path", "What path?");

    expect(value).toBe("explicit value");
    expect(called).toBe(false);
  });

  test("returns current even when it's an explicit empty string, without eliciting", async () => {
    let called = false;
    const server = fakeServer(async () => {
      called = true;
      return { action: "accept", content: {} };
    });

    const value = await resolveArg(server, "", "path", "What path?");

    expect(value).toBe("");
    expect(called).toBe(false);
  });

  test("elicits and returns the accepted value when current is omitted", async () => {
    const server = fakeServer(async (params) => {
      expect(params).toEqual({
        message: "What path?",
        requestedSchema: { type: "object", properties: { path: { type: "string" } } },
      });
      return { action: "accept", content: { path: "/tmp/book.epub" } };
    });

    const value = await resolveArg(server, undefined, "path", "What path?");

    expect(value).toBe("/tmp/book.epub");
  });

  test("accepts a blank answer as the value rather than rejecting it", async () => {
    const server = fakeServer(async () => ({ action: "accept", content: {} }));

    const value = await resolveArg(server, undefined, "path", "What path?");

    expect(value).toBe("");
  });

  test("throws when the prompt is declined", async () => {
    const server = fakeServer(async () => ({ action: "decline", content: {} }));

    await expect(resolveArg(server, undefined, "path", "What path?")).rejects.toThrow(
      "path was not provided (prompt was decline)",
    );
  });

  test("throws when the prompt is cancelled", async () => {
    const server = fakeServer(async () => ({ action: "cancel", content: {} }));

    await expect(resolveArg(server, undefined, "path", "What path?")).rejects.toThrow(
      "path was not provided (prompt was cancel)",
    );
  });
});

describe("withHint", () => {
  test("returns message unchanged when hint is empty", () => {
    expect(withHint("What path?", "")).toBe("What path?");
  });

  test("appends the hint in parentheses when present", () => {
    expect(withHint("What path?", "the book you just created")).toBe("What path? (the book you just created)");
  });
});
