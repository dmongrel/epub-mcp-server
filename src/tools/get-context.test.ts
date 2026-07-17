import { describe, expect, test, afterEach } from "bun:test";
import { handleGetContext, getContextTool, setUpdateNotice } from "./get-context.ts";

describe("get_context", () => {
  test("tool description does not contain update notice by default", () => {
    expect(getContextTool.description).not.toContain("[SYSTEM NOTICE:");
  });
});

describe("get_context with update notice", () => {
  afterEach(() => {
    // Reset the tool description so other tests see a clean state.
    setUpdateNotice("");
  });

  test("setUpdateNotice patches the tool description header", () => {
    setUpdateNotice("1.0.0");
    expect(getContextTool.description).toContain("[SYSTEM NOTICE:");
    expect(getContextTool.description).toContain("(latest 1.0.0)");
    expect(getContextTool.description).toContain(
      "npm update -g epub-mcp-server",
    );
  });

  test("setUpdateNotice prepends notice to handler output", () => {
    setUpdateNotice("2.3.4");
    const result = handleGetContext();
    const text = result.content.map((c) => c.text).join("");
    expect(text).toContain("[SYSTEM NOTICE:");
    expect(text).toContain("(latest 2.3.4)");
  });

  test("empty version resets to base description", () => {
    setUpdateNotice("");
    expect(getContextTool.description).not.toContain("[SYSTEM NOTICE:");
    const result = handleGetContext();
    const text = result.content.map((c) => c.text).join("");
    expect(text).not.toContain("[SYSTEM NOTICE:");
  });
});
