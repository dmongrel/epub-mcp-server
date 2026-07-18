/**
 * epubCache — the bounded LRU cache every tool shares, so repeated reads
 * of the same file across tool calls don't re-parse it. Mirrors Go's
 * package-level `var epubCache = epub.NewCache(epub.DefaultCacheSize)`,
 * but lives in its own module here rather than inside read-epub.ts (where
 * Go happens to declare it): almost every tool needs epubCache, including
 * ones that must exist before read_epub's own equivalent conceptually
 * would, so a dedicated module avoids an arbitrary "read-epub.ts must be
 * built first" ordering constraint.
 */
import { Cache, DEFAULT_CACHE_SIZE } from "../epub/cache.ts";

export const epubCache = new Cache(DEFAULT_CACHE_SIZE);
