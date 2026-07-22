// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * check-update — at server start, check GitHub for a newer release.
 * Portable Bun/Deno/Node: uses the same runtime-detection pattern as src/index.ts.
 */

interface DenoLike {
  readTextFile(path: string | URL): Promise<string>;
}

function getDeno(): DenoLike | undefined {
  return (globalThis as Record<string, unknown>).Deno as DenoLike | undefined;
}

/** Read a text file in a way that works under Bun, Deno, and Node. */
async function readTextPortable(path: URL): Promise<string> {
  if (typeof Bun !== "undefined") {
    return await Bun.file(path).text();
  }
  const deno = getDeno();
  if (deno) return await deno.readTextFile(path);
  const { readFile } = await import("node:fs/promises");
  return await readFile(path, "utf8");
}

/**
 * Locate and parse package.json by walking up from this module's location.
 * Bundling (e.g. the npm-published dist/index.js) changes how many directory
 * levels separate this file from the package root, so a fixed "../../" is
 * not reliable — walk up instead of hardcoding a depth.
 */
async function findPackageJson(): Promise<{ version: string } | null> {
  let dir = new URL(".", import.meta.url);
  for (let i = 0; i < 5; i++) {
    try {
      const raw = await readTextPortable(new URL("package.json", dir));
      const pkg = JSON.parse(raw) as { name?: string; version: string };
      if (pkg.name === "epub-mcp-server") return pkg;
    } catch {
      // not found at this level — keep walking up
    }
    dir = new URL("..", dir);
  }
  return null;
}

/** Read current version from package.json. */
export async function getCurrentVersion(): Promise<string> {
  const pkg = await findPackageJson();
  return pkg?.version ?? "0.0.0";
}

/** Fetch the latest release tag from GitHub. */
async function getLatestGitHubTag(): Promise<string | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/dmongrel/epub-mcp-server/releases/latest",
      { headers: { "User-Agent": "mcp-server-updater" } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name: string };
    // Strip optional 'v' prefix
    return data.tag_name.replace(/^v/, "");
  } catch {
    return null;
  }
}

/** Parse a version string "X.Y.Z" into [major, minor, patch]. */
function parseVersion(v: string): [number, number, number] {
  const parts = v.split(".").map(Number);
  // Pad missing segments to zero
  while (parts.length < 3) parts.push(0);
  return parts as [number, number, number];
}

/** Return true if `remote` is strictly greater than `local`. */
export function isNewer(local: string, remote: string): boolean {
  const a = parseVersion(local);
  const b = parseVersion(remote);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false; // equal
}

/**
 * Check for an update. Returns:
 *   null            — on any failure (network, parse, etc.) — fail open
 *   { available: true,  latest: "X.Y.Z" }  — newer version exists
 *   { available: false }                     — current is up-to-date
 */
export async function checkForUpdate(): Promise<
  { available: true; latest: string } | { available: false } | null
> {
  const local = await getCurrentVersion();
  const remote = await getLatestGitHubTag();
  if (remote === null) return null; // network error or rate-limited
  if (isNewer(local, remote)) return { available: true, latest: remote };
  return { available: false };
}

