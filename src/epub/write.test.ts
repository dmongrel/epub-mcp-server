// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newEpub } from "./new-epub.ts";
import { parseEpub } from "./parse.ts";
import { primaryPackage } from "./resolve.ts";
import { escXML, writeEpub } from "./write.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "testdata", "the-magic-hower.epub");

describe("escXML", () => {
  test("escapes the five predefined XML entities and passes ordinary text through unchanged", () => {
    expect(escXML(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &apos;");
    expect(escXML("ordinary text 123")).toBe("ordinary text 123");
  });

  test("escapes tab, newline, and carriage return as numeric character references", () => {
    expect(escXML("\t")).toBe("&#x9;");
    expect(escXML("\n")).toBe("&#xA;");
    expect(escXML("\r")).toBe("&#xD;");
    expect(escXML("a\tb\nc\rd")).toBe("a&#x9;b&#xA;c&#xD;d");
  });

  test("replaces XML-illegal control characters with the Unicode replacement character", () => {
    expect(escXML("\x00")).toBe("�");
    expect(escXML("\x01")).toBe("�");
    expect(escXML("\x0b")).toBe("�");
    expect(escXML(`a\x00b\x01c\x0bd`)).toBe("a�b�c�d");
  });

  test("round-trips a tab and newline in an attribute value (xml:lang) through writeEpub/parseEpub", async () => {
    const lang = "en\tGB\nUS";
    const e = newEpub("Title", "Author");
    const pkg = primaryPackage(e)!;
    pkg.metadata.titles[0]!.lang = lang;

    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);
    const reparsed = await parseEpub(out);

    const reparsedPkg = primaryPackage(reparsed)!;
    expect(reparsedPkg.metadata.titles[0]?.lang).toBe(lang);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("writeEpub", () => {
  test("round-trips a real, messy EPUB with one edited chapter", async () => {
    const original = await parseEpub(fixturePath);

    const chapterId = "OEBPS/text/chapter-03.xhtml";
    const newMarkup =
      '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Edited &amp; tested</p></body></html>';
    original.contentDocuments[chapterId]!.markup = newMarkup;

    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "edited.epub");
    await writeEpub(original, out);

    const reparsed = await parseEpub(out);

    expect(Object.keys(reparsed.packages)).toHaveLength(Object.keys(original.packages).length);
    expect(Object.keys(reparsed.contentDocuments)).toHaveLength(Object.keys(original.contentDocuments).length);
    expect(reparsed.contentDocuments[chapterId]?.markup).toBe(newMarkup);

    const untouchedId = "OEBPS/text/chapter-04.xhtml";
    expect(reparsed.contentDocuments[untouchedId]?.markup).toBe(original.contentDocuments[untouchedId]?.markup);

    const origPkg = primaryPackage(original)!;
    const newPkg = primaryPackage(reparsed)!;
    expect(newPkg.metadata.titles[0]?.value).toBe(origPkg.metadata.titles[0]?.value);
    expect(newPkg.metadata.creators[1]?.name).toBe(origPkg.metadata.creators[1]?.name);
    expect(newPkg.spine.itemRefs).toHaveLength(origPkg.spine.itemRefs.length);
    expect(newPkg.manifest.items).toHaveLength(origPkg.manifest.items.length);

    await rm(dir, { recursive: true, force: true });
  });

  test("writes mimetype as the first, uncompressed archive entry", async () => {
    const e = newEpub("Mimetype Test", "Author");
    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);

    const raw = await Bun.file(out).arrayBuffer();
    const bytes = new Uint8Array(raw);
    const asLatin1 = Array.from(bytes.slice(0, 80))
      .map((b) => String.fromCharCode(b))
      .join("");

    // A stored (uncompressed) entry has its content readable verbatim in
    // the raw archive bytes, right after its local file header + filename.
    expect(asLatin1).toContain("mimetype");
    expect(asLatin1).toContain("application/epub+zip");

    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips a package's guide", async () => {
    const e = newEpub("Guide Test", "Author");
    const pkg = primaryPackage(e)!;
    pkg.guide = {
      id: `${pkg.id}#guide`,
      references: [
        { id: `${pkg.id}#guide/reference[cover]`, type: "cover", title: "Cover", href: "cover.xhtml" },
        { id: `${pkg.id}#guide/reference[toc]`, type: "toc", title: "", href: "nav.xhtml" },
      ],
    };

    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);
    const reparsed = await parseEpub(out);

    const reparsedPkg = primaryPackage(reparsed)!;
    expect(reparsedPkg.guide?.references).toHaveLength(2);
    expect(reparsedPkg.guide?.references[0]).toMatchObject({ type: "cover", title: "Cover", href: "cover.xhtml" });
    expect(reparsedPkg.guide?.references[1]).toMatchObject({ type: "toc", href: "nav.xhtml" });

    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips an NCX document's structure", async () => {
    const e = newEpub("NCX Test", "Author");
    const pkg = primaryPackage(e)!;

    const ncxMarkup = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="test-uid"/>
  </head>
  <docTitle><text>NCX Test</text></docTitle>
  <navMap>
    <navPoint id="chapter-1" playOrder="1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="nav.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
`;
    e.nCXs["toc.ncx"] = { id: "toc.ncx", markup: ncxMarkup, navMap: [] };
    pkg.manifest.items.push({
      id: `${pkg.manifest.id}/ncx`,
      href: "toc.ncx",
      mediaType: "application/x-dtbncx+xml",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    pkg.spine.tocRef = "ncx";

    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);
    const reparsed = await parseEpub(out);

    const ncx = reparsed.nCXs["toc.ncx"];
    expect(ncx).toBeDefined();
    expect(ncx!.navMap).toHaveLength(1);
    expect(ncx!.navMap[0]).toMatchObject({ label: "Chapter 1", src: "nav.xhtml", playOrder: 1 });

    await rm(dir, { recursive: true, force: true });
  });

  test("escapes special characters in rendered metadata", async () => {
    const e = newEpub('Title with <tags> & "quotes"', "Author & Co.");
    const dir = await mkdtemp(join(tmpdir(), "epub-write-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);
    const reparsed = await parseEpub(out);

    const pkg = primaryPackage(reparsed)!;
    expect(pkg.metadata.titles[0]?.value).toBe('Title with <tags> & "quotes"');
    expect(pkg.metadata.creators[0]?.name).toBe("Author & Co.");

    await rm(dir, { recursive: true, force: true });
  });
});

