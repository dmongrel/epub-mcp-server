/**
 * save_epub — write a cached EPUB, including any edit_chapter/edit_*
 * edits, back to disk. Mirrors Go's tools/save_epub.go.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { archiveIdInUse } from "./edit-resource.ts";
import { insertChapter } from "./edit-chapter.ts";
import { epubCache } from "./epub-cache.ts";
import { defaultChapterLabel } from "./nav-sync.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { primaryPackage } from "../epub/resolve.ts";
import { writeEpub } from "../epub/write.ts";
import type { Epub } from "../epub/types.ts";

interface SaveEpubArgs {
  path: string;
  as?: string;
}

interface SaveEpubResult {
  savedTo: string;
  addedBlankChapter?: string;
}

export const saveEpubTool: EpubTool = {
  name: "save_epub",
  description: "Write a cached EPUB, including any edit_chapter edits, back to disk as a .epub file. Changing.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path of the cached epub to save, as previously passed to read_epub" },
      as: { type: "string", description: "optional different filesystem path to save to instead of overwriting path" },
    },
    required: ["path"],
  },
};

export async function handleSaveEpub(_server: Server, args: SaveEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const e = epubCache.get(abs);
  if (!e) throw new Error(`${JSON.stringify(args.path)} is not currently cached; call read_epub first`);

  const dest = args.as?.trim() ? resolve(args.as) : abs;

  const addedChapterId = ensureAtLeastOneChapter(e);

  await writeEpub(e, dest);
  if (dest === abs) {
    epubCache.clearDirty(abs);
  } else if (addedChapterId) {
    epubCache.markDirty(abs);
  }

  const result: SaveEpubResult = { savedTo: dest };
  if (addedChapterId) result.addedBlankChapter = addedChapterId;

  const addedNote = addedChapterId
    ? ` The book had no chapters yet, so a blank one (${JSON.stringify(addedChapterId)}) was added automatically — EPUB requires at least one; call edit_chapter to fill it in.`
    : "";
  const summary = `Saved ${JSON.stringify(dest)}.${addedNote}`;
  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

/**
 * Adds a single blank chapter to e if it has none, via the same
 * insertChapter path edit_chapter's create action uses, since EPUB
 * requires at least one content document in the spine. new_epub
 * deliberately doesn't create one itself. Returns the new chapter's id,
 * or "" if the book already had at least one.
 */
function ensureAtLeastOneChapter(e: Epub): string {
  if (Object.keys(e.contentDocuments).length > 0) return "";
  const pkg = primaryPackage(e);
  if (!pkg) return "";

  const id = defaultBlankChapterId(e);
  const label = defaultChapterLabel(id);
  const markup = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${label}</title>
</head>
<body>
  <h1>${label}</h1>
</body>
</html>`;

  insertChapter(e, pkg, id, markup, label);
  return id;
}

/** Returns an archive path for ensureAtLeastOneChapter's new chapter that doesn't collide with anything in e. */
function defaultBlankChapterId(e: Epub): string {
  for (let n = 1; ; n++) {
    const id = `text/chapter-${n}.xhtml`;
    if (!archiveIdInUse(e, id)) return id;
  }
}

registerTool(
  saveEpubTool,
  "Takes path, identifying which already-cached EPUB to save (the same path used with read_epub / " +
    "edit_chapter), and an optional as path to save to a different location instead of overwriting the " +
    "original. Fails if path isn't currently cached — call read_epub first. Regenerates container.xml and " +
    "every package document (metadata, manifest, spine) from the in-memory structures, and writes every " +
    "content document, navigation document, NCX, and other resource back using its stored content " +
    "verbatim, including any edits. When saving back to path (no as given), also clears that cache entry's " +
    "unsaved-edits flag, as reported by get_cache_status; saving to a different as path leaves it set, " +
    "since path on disk still doesn't match what's in memory.\n\n" +
    "EPUB requires at least one content document, but new_epub deliberately starts a book with none rather " +
    "than a placeholder chapter you'd have to remember to delete. If the book still has zero chapters when " +
    "save_epub runs, it adds one blank chapter automatically (reported in addedBlankChapter) so the file " +
    "stays valid; call edit_chapter on that id afterwards to fill it in, or edit_chapter/edit_navigation to " +
    "rename or restructure it like any other chapter.",
  handleSaveEpub as never,
);
