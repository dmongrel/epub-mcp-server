/**
 * evictionNote — formats a warning suffix for a tool's summary text when
 * loading one EPUB evicted another from the cache, so data loss from an
 * evicted, unsaved edit is visible rather than silent. Mirrors the Go
 * reference's tools/eviction.go.
 */
import type { Eviction } from "../epub/cache.ts";

/** Returns "" if evicted is undefined (no eviction happened). */
export function evictionNote(evicted: Eviction | undefined): string {
  if (!evicted) return "";
  if (evicted.wasDirty) {
    return ` Closed ${JSON.stringify(evicted.path)} to make room in the cache — it had unsaved edits, now lost; call save_epub before this happens if you need them.`;
  }
  return ` Closed ${JSON.stringify(evicted.path)} to make room in the cache.`;
}
