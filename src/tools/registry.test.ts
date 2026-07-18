import { describe, expect, test } from "bun:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { dispatchTool, getToolRegistry, getTools, registerTool } from "./registry.ts";

const fakeServer = {} as Server;

function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

describe("registerTool", () => {
  test("adds the tool to getTools() and getToolRegistry()", () => {
    const name = uniqueName("basic-tool");
    const tool = { name, description: "A test tool.", inputSchema: { type: "object", properties: {} } };
    registerTool(tool, "Extended notes.", async () => ({ content: [{ type: "text", text: "ok" }] }));

    expect(getTools().find((t) => t.name === name)).toEqual(tool);
    expect(getToolRegistry().find((t) => t.name === name)).toEqual({
      name,
      description: "A test tool.",
      extendedDescription: "Extended notes.",
    });
  });
});

describe("dispatchTool", () => {
  test("calls the registered handler with the server and args, returning its result", async () => {
    const name = uniqueName("echo-tool");
    let receivedArgs: unknown;
    registerTool({ name, description: "", inputSchema: {} }, "", async (_server, args) => {
      receivedArgs = args;
      return { content: [{ type: "text", text: "echoed" }] };
    });

    const result = await dispatchTool(fakeServer, name, { foo: "bar" });

    expect(result).toEqual({ content: [{ type: "text", text: "echoed" }] });
    expect(receivedArgs).toEqual({ foo: "bar" });
  });

  test("returns an isError result naming every registered tool when the name is unknown", async () => {
    const name = uniqueName("known-tool");
    registerTool({ name, description: "", inputSchema: {} }, "", async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const result = await dispatchTool(fakeServer, "does-not-exist", undefined);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool: does-not-exist");
    expect(result.content[0]?.text).toContain(name);
  });

  test("converts a thrown error into an isError result instead of rejecting", async () => {
    const name = uniqueName("throwing-tool");
    registerTool({ name, description: "", inputSchema: {} }, "", async () => {
      throw new Error("boom");
    });

    const result = await dispatchTool(fakeServer, name, undefined);

    expect(result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  });

  test("serializes concurrent calls to different registered tools through the global lock", async () => {
    const nameA = uniqueName("lock-a");
    const nameB = uniqueName("lock-b");
    const order: string[] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    registerTool({ name: nameA, description: "", inputSchema: {} }, "", async () => {
      order.push("a-start");
      await gateA;
      order.push("a-end");
      return { content: [{ type: "text", text: "a" }] };
    });
    registerTool({ name: nameB, description: "", inputSchema: {} }, "", async () => {
      order.push("b-start");
      order.push("b-end");
      return { content: [{ type: "text", text: "b" }] };
    });

    const pA = dispatchTool(fakeServer, nameA, undefined);
    const pB = dispatchTool(fakeServer, nameB, undefined);

    // Let A's handler run up to its await point; B must still be queued
    // behind the lock, not interleaved with it.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a-start"]);

    releaseA();
    await Promise.all([pA, pB]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});
