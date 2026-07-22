// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { realpathSync } from "node:fs";
import { currentPlatform } from "./runtime.ts";
import { parseEpub } from "./parse.ts";
import type { Epub } from "./types.ts";

/** Number of parsed EPUBs a Cache holds by default. */
export const DEFAULT_CACHE_SIZE = 4;

/**
 * Returns a best-effort canonical form of path, used as Cache's internal
 * lookup key so two different spellings of the same file (different case
 * on a case-insensitive filesystem, or a symlink) resolve to the same
 * entry instead of silently desyncing. Resolves symlinks via
 * node:fs.realpathSync, falling back to path unresolved if that throws
 * (e.g. the file doesn't exist yet), and folds case on platforms that are
 * case-insensitive by default (Windows, macOS) — a heuristic, not a true
 * filesystem-capability probe.
 */
export function canonicalPath(path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    resolved = path;
  }
  const platform = currentPlatform();
  if (platform === "win32" || platform === "windows" || platform === "darwin") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

export interface CacheEntry {
  path: string;
  dirty: boolean;
}

export interface Eviction {
  path: string;
  wasDirty: boolean;
}

interface InternalEntry {
  path: string;
  epub: Epub;
  dirty: boolean;
}

/**
 * A bounded, LRU path -> Epub cache, keyed by canonicalPath(path). Once
 * full, inserting a new entry evicts the least recently used one.
 *
 * Each entry tracks whether it's dirty: changed in memory since it was
 * last loaded fresh from disk or written back out. Callers that mutate a
 * loaded Epub are responsible for calling markDirty; callers that persist
 * one are responsible for calling clearDirty once the write actually
 * succeeds. The cache itself never inspects an Epub's contents, so it
 * can't detect edits on its own.
 *
 * Backed by a Map, whose iteration order tracks insertion order: deleting
 * and re-inserting a key moves it to the end (most recently used), and
 * eviction removes the first key (least recently used).
 */
export class Cache {
  #capacity: number;
  #items = new Map<string, InternalEntry>();

  constructor(capacity: number = DEFAULT_CACHE_SIZE) {
    this.#capacity = capacity < 1 ? 1 : capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** Returns the cached Epub for path, if present, marking it most recently used. */
  get(path: string): Epub | undefined {
    const key = canonicalPath(path);
    const entry = this.#items.get(key);
    if (!entry) return undefined;
    this.#items.delete(key);
    this.#items.set(key, entry);
    return entry.epub;
  }

  /**
   * Inserts or replaces the cached Epub for path, marking it most recently
   * used and clean. If the cache is already at capacity, the least
   * recently used entry is evicted first; returns that eviction, or
   * undefined if none occurred.
   */
  put(path: string, epub: Epub): Eviction | undefined {
    const key = canonicalPath(path);
    const existing = this.#items.get(key);
    if (existing) {
      existing.epub = epub;
      existing.dirty = false;
      this.#items.delete(key);
      this.#items.set(key, existing);
      return undefined;
    }

    let evicted: Eviction | undefined;
    if (this.#items.size >= this.#capacity) {
      const oldestKey = this.#items.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.#items.get(oldestKey)!;
        evicted = { path: oldest.path, wasDirty: oldest.dirty };
        this.#items.delete(oldestKey);
      }
    }
    this.#items.set(key, { path, epub, dirty: false });
    return evicted;
  }

  /**
   * Returns the cached Epub for path if present; otherwise parses path
   * from disk and caches the result — evicting the least recently used
   * entry if the cache is full. A cache hit always reports no eviction.
   */
  async load(path: string): Promise<{ epub: Epub; eviction: Eviction | undefined }> {
    const cached = this.get(path);
    if (cached) return { epub: cached, eviction: undefined };
    const epub = await parseEpub(path);
    const eviction = this.put(path, epub);
    return { epub, eviction };
  }

  /** Records that the cached Epub for path has changed in memory. No-op if path isn't cached. */
  markDirty(path: string): void {
    const entry = this.#items.get(canonicalPath(path));
    if (entry) entry.dirty = true;
  }

  /** Records that the cached Epub for path now matches what's on disk. No-op if path isn't cached. */
  clearDirty(path: string): void {
    const entry = this.#items.get(canonicalPath(path));
    if (entry) entry.dirty = false;
  }

  /** Evicts path from the cache outright, reporting whether it was present and, if so, whether dirty. */
  remove(path: string): { removed: boolean; wasDirty: boolean } {
    const key = canonicalPath(path);
    const entry = this.#items.get(key);
    if (!entry) return { removed: false, wasDirty: false };
    this.#items.delete(key);
    return { removed: true, wasDirty: entry.dirty };
  }

  /** Returns a snapshot of every cached path and its dirty flag, most- to least-recently-used. */
  entries(): CacheEntry[] {
    const out: CacheEntry[] = [];
    for (const entry of this.#items.values()) out.push({ path: entry.path, dirty: entry.dirty });
    return out.reverse();
  }
}

