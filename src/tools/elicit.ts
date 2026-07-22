// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * resolveArg/withHint — shared elicitation helper every tool with
 * omittable string arguments uses, mirroring the Go reference's
 * tools/elicit.go. Since this server is stdio (one client per process,
 * unlike Go's HTTP version which juggles many concurrent sessions), a
 * plain Server instance stands in for Go's req.Session — elicitInput
 * sends directly to the one connected client.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * Returns current if the caller already supplied it (even as an explicit
 * empty string). If the caller omitted it (current === undefined),
 * prompts the human user via MCP elicitation with message, using field as
 * the requested form field's name.
 *
 * A blank answer to that prompt is accepted as the value, not re-prompted
 * or rejected: an empty response is how a user says "I don't know that
 * yet," and it's the caller's job (e.g. a lookup by the returned value)
 * to reject a value that's blank when it needs not to be. Only an
 * explicit decline or cancellation of the prompt is treated as an error,
 * since that means the user refused to answer at all.
 */
export async function resolveArg(
  server: Server,
  current: string | undefined,
  field: string,
  message: string,
): Promise<string> {
  if (current !== undefined) return current;

  const result = await server.elicitInput({
    message,
    requestedSchema: {
      type: "object",
      properties: { [field]: { type: "string" } },
    },
  });

  if (result.action !== "accept") {
    throw new Error(`${field} was not provided (prompt was ${result.action})`);
  }

  const value = result.content?.[field];
  return typeof value === "string" ? value : "";
}

/**
 * Appends an optional, caller-supplied hint to an elicitation message. A
 * prompt built from a field name alone often can't convey which entry,
 * or what it's for — the tool call already knows that context but the
 * human being prompted doesn't. hint === "" leaves message unchanged, so
 * this is always safe to call even when no hint was given.
 */
export function withHint(message: string, hint: string): string {
  return hint === "" ? message : `${message} (${hint})`;
}

