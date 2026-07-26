// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * validate_epub — check an already-read EPUB's data structures against each
 * other and against the spec, reporting what's wrong and how to fix it.
 *
 * Read-only by design. Repairs belong to the tools that own them: the table
 * of contents is rebuilt by convert_manuscript, entries are edited by
 * edit_navigation, wiring by edit_manifest and edit_spine. Keeping the
 * validator diagnostic means it's safe to run at any point, and every
 * finding names the tool call that fixes it so a caller can act on the
 * report directly.
 */
import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { epubCache } from "./epub-cache.ts";
import { evictionNote } from "./eviction.ts";
import type { EpubTool, ToolHandlerResult } from "./registry.ts";
import { registerTool } from "./registry.ts";
import { CHECKS, type ValidateEpubFinding } from "./validate-checks.ts";
import { primaryPackage } from "../epub/resolve.ts";

interface ValidateEpubArgs {
  path: string;
  checks?: string[];
}

interface ValidateEpubResult {
  path: string;
  ok: boolean;
  errorCount: number;
  warningCount: number;
  checksRun: string[];
  findings: ValidateEpubFinding[];
}

const CHECK_NAMES = Object.keys(CHECKS);

export const validateEpubTool: EpubTool = {
  name: "validate_epub",
  description:
    "Check an already-read EPUB for misalignment between its table of contents, spine, manifest, and chapter text, plus structural and metadata defects. Every finding names the tool call that fixes it. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "filesystem path to the .epub file, as previously passed to read_epub" },
      checks: {
        type: "array",
        items: { type: "string" },
        description: `check names to run; omit to run all of them. Valid names: ${CHECK_NAMES.join(", ")}`,
      },
    },
    required: ["path"],
  },
};

export async function handleValidateEpub(_server: Server, args: ValidateEpubArgs): Promise<ToolHandlerResult> {
  if (!args.path?.trim()) throw new Error("path is required");
  const abs = resolve(args.path);

  const { epub: e, eviction } = await epubCache.load(abs);
  const pkg = primaryPackage(e);
  if (!pkg) throw new Error(`${JSON.stringify(abs)} has no package document to validate`);

  let checksRun = CHECK_NAMES;
  if (args.checks !== undefined) {
    if (!Array.isArray(args.checks) || args.checks.length === 0) {
      throw new Error(`checks must be a non-empty array of check names; valid names are: ${CHECK_NAMES.join(", ")}`);
    }
    for (const name of args.checks) {
      if (!(name in CHECKS)) throw new Error(`unknown check ${JSON.stringify(name)}; valid names are: ${CHECK_NAMES.join(", ")}`);
    }
    // Filtered from CHECK_NAMES rather than mapped from args.checks, so the
    // report order is always the registry's regardless of argument order.
    checksRun = CHECK_NAMES.filter((name) => args.checks!.includes(name));
  }

  const findings = checksRun.flatMap((name) => CHECKS[name]!(e, pkg));
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.length - errorCount;

  const result: ValidateEpubResult = { path: abs, ok: errorCount === 0, errorCount, warningCount, checksRun, findings };

  let summary =
    findings.length === 0
      ? `Validated ${JSON.stringify(abs)}: no problems found across ${checksRun.length} check(s).`
      : `Validated ${JSON.stringify(abs)}: ${errorCount} error(s) and ${warningCount} warning(s) across ${checksRun.length} check(s).`;
  for (const f of findings) {
    summary += `\n  [${f.severity}] ${f.check}: ${f.message}\n    Fix: ${f.remedy}`;
  }
  summary += evictionNote(eviction);

  return { content: [{ type: "text", text: summary }], structuredContent: result as unknown as Record<string, unknown> };
}

registerTool(
  validateEpubTool,
  "Takes path, the same .epub filesystem path passed to read_epub, and an optional checks array naming a " +
    "subset of checks to run (omit it to run all of them; an unrecognized name is an error listing the " +
    "valid ones). Loads the EPUB through the same cache read_epub uses.\n\n" +
    "Read-only: it never changes the book, never marks the cache dirty, and never writes to disk. It " +
    "reports problems and names the repair; you make the repair with the tool that owns it.\n\n" +
    "Returns ok (true when nothing of severity \"error\" was found), errorCount, warningCount, checksRun, " +
    "and findings. Each finding carries check (the check's name), severity (\"error\" or \"warning\"), " +
    "message (what is wrong, naming the values involved), ids (the affected archive paths and structure " +
    "ids), and remedy (a sentence naming the tool and arguments that fix it). An EPUB with nothing wrong " +
    "returns ok true and an empty findings array.\n\n" +
    "-- Alignment checks --\n\n" +
    "toc-spine-order (error): the table of contents must reach every prose document in the spine, reach " +
    "nothing else, and reach them in the same order. Nesting and multiple fragment entries into one " +
    "document are tolerated.\n" +
    "toc-label-heading-mismatch (error): a toc entry labelled \"Chapter 5\" points at a document whose " +
    "own heading says a different chapter number. This is the misalignment that survives every structural " +
    "check.\n" +
    "chapter-number-sequence (warning): chapter numbers read from chapter headings, in spine order, have " +
    "a gap, a repeat, or run backwards. Unnumbered front matter is ignored.\n" +
    "ncx-toc-divergence (warning): the legacy EPUB 2 NCX disagrees with the navigation document's table " +
    "of contents in label, target, or order.\n\n" +
    "-- Referential integrity checks --\n\n" +
    "dangling-href (error): a table-of-contents, NCX, landmarks, or guide target names a file the archive " +
    "does not contain.\n" +
    "spine-missing-manifest-item (error): a spine entry names a manifest item that does not exist.\n" +
    "manifest-missing-file (error): a manifest item names a file the archive does not contain.\n" +
    "orphan-content-document (warning): a chapter absent from the manifest, or in the manifest but not " +
    "the spine, so a linear read never reaches it.\n" +
    "duplicate-id (error): a manifest id, spine entry, or manifest href appears more than once.\n\n" +
    "-- Structure and metadata checks --\n\n" +
    "malformed-xhtml (error): a chapter or the navigation document is not well-formed XHTML.\n" +
    "missing-nav (error): no manifest item is marked properties=\"nav\", the item marked as such points " +
    "at no navigation document, or the spine's toc attribute names nothing.\n" +
    "missing-metadata (error): no dc:identifier, dc:title, or dc:language, or the package's " +
    "unique-identifier names no identifier that exists.\n" +
    "empty-spine (error): the book has no reading order at all. EPUB 3 requires at least one spine " +
    "entry, so a book still empty at save time is not yet a valid EPUB.\n" +
    "cover-image-missing (warning): a cover-image manifest item or legacy cover meta names something " +
    "absent.\n" +
    "back-cover-not-last (warning): the book has a back cover that is not the last thing in the reading " +
    "order.\n" +
    "empty-chapter (warning): a chapter in the reading order has no readable text.",
  handleValidateEpub as never,
);
