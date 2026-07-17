/**
 * check-update — at server start, check GitHub for a newer release.
 * Portable Bun/Deno: uses the same runtime-detection pattern as src/index.ts.
 */

interface DenoLike {
  readTextFile(path: string | URL): Promise<string>;
}

function getDeno(): DenoLike | undefined {
  return (globalThis as Record<string, unknown>).Deno as DenoLike | undefined;
}

/** Read a text file in a way that works under Bun and Deno. */
async function readTextPortable(path: URL): Promise<string> {
  if (typeof Bun !== "undefined") {
    return await Bun.file(path).text();
  }
  const deno = getDeno();
  if (deno) return await deno.readTextFile(path);
  throw new Error("Unsupported runtime — requires Bun or Deno.");
}

/** Resolve package.json using import.meta.url (works under Bun and Deno). */
function resolvePackagePath(): URL {
  // src/tools/check-update.ts → ../../package.json
  return new URL("../../package.json", import.meta.url);
}

/** Read current version from package.json. */
export async function getCurrentVersion(): Promise<string> {
  try {
    const pkgPath = resolvePackagePath();
    const raw = await readTextPortable(pkgPath);
    const pkg = JSON.parse(raw) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
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
