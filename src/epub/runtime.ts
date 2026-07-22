// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * Bun/Deno portability helpers shared across the epub/ package. Nothing
 * else in this package should reimplement runtime detection locally —
 * Phase 1 briefly had two near-identical copies of this pattern
 * (parse.ts's file read, cache.ts's platform check) before this file
 * consolidated them.
 */

/** Reads a file's bytes in a way that works under Bun and Deno. */
export async function readBinaryPortable(path: string): Promise<Uint8Array> {
  if (typeof Bun !== "undefined") {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  }
  const deno = (globalThis as Record<string, unknown>).Deno as
    | { readFile(path: string): Promise<Uint8Array> }
    | undefined;
  if (deno) return await deno.readFile(path);
  throw new Error("Unsupported runtime — requires Bun or Deno.");
}

/** Writes a file's bytes in a way that works under Bun and Deno, creating or overwriting it. */
export async function writeBinaryPortable(path: string, data: Uint8Array): Promise<void> {
  if (typeof Bun !== "undefined") {
    await Bun.write(path, data);
    return;
  }
  const deno = (globalThis as Record<string, unknown>).Deno as
    | { writeFile(path: string, data: Uint8Array): Promise<void> }
    | undefined;
  if (deno) {
    await deno.writeFile(path, data);
    return;
  }
  throw new Error("Unsupported runtime — requires Bun or Deno.");
}

/** The running platform, spelled the way each runtime reports it ("win32"/"windows", "darwin", "linux", ...). */
export function currentPlatform(): string {
  if (typeof Bun !== "undefined") return process.platform; // "win32" | "darwin" | "linux" | ...
  const deno = (globalThis as Record<string, unknown>).Deno as { build?: { os?: string } } | undefined;
  return deno?.build?.os ?? "linux"; // Deno spells it "windows", not "win32"
}

