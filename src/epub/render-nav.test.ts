import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEpub } from "./new-epub.ts";
import { parseEpub } from "./parse.ts";
import { renderNavigationDocument, renderNCXDocument } from "./render-nav.ts";
import { primaryPackage } from "./resolve.ts";
import type { NCX, Navigation } from "./types.ts";
import { writeEpub } from "./write.ts";

describe("renderNavigationDocument", () => {
  test("regenerates markup from structured lists, including nested items", () => {
    const nav: Navigation = {
      id: "nav.xhtml",
      mediaType: "application/xhtml+xml",
      markup: "",
      lists: [
        {
          id: "nav.xhtml#toc",
          type: "toc",
          heading: "Contents",
          items: [
            {
              id: "nav.xhtml#toc/item[0]",
              label: "Chapter 1",
              href: "chapter1.xhtml",
              type: "",
              children: [
                {
                  id: "nav.xhtml#toc/item[0]/item[0]",
                  label: "Section 1.1",
                  href: "chapter1.xhtml#s1",
                  type: "",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };

    renderNavigationDocument(nav, "Table of Contents");

    expect(nav.markup).toContain("<title>Table of Contents</title>");
    expect(nav.markup).toContain('epub:type="toc"');
    expect(nav.markup).toContain("<h1>Contents</h1>");
    expect(nav.markup).toContain('<a href="chapter1.xhtml">Chapter 1</a>');
    expect(nav.markup).toContain('<a href="chapter1.xhtml#s1">Section 1.1</a>');
  });

  test("escapes special characters in headings and labels", () => {
    const nav: Navigation = {
      id: "nav.xhtml",
      mediaType: "application/xhtml+xml",
      markup: "",
      lists: [
        {
          id: "nav.xhtml#toc",
          type: "toc",
          heading: "A & B",
          items: [{ id: "nav.xhtml#toc/item[0]", label: '<Ch. 1> "intro"', href: "c1.xhtml", type: "", children: [] }],
        },
      ],
    };

    renderNavigationDocument(nav, "Contents");

    expect(nav.markup).toContain("<h1>A &amp; B</h1>");
    expect(nav.markup).toContain("&lt;Ch. 1&gt; &quot;intro&quot;");
  });
});

describe("renderNCXDocument", () => {
  test("regenerates markup and renumbers playOrder sequentially", () => {
    const ncx: NCX = {
      id: "toc.ncx",
      markup: "",
      navMap: [
        {
          id: "toc.ncx#chap1",
          playOrder: 0,
          label: "Chapter 1",
          src: "chapter1.xhtml",
          children: [{ id: "toc.ncx#chap1sec1", playOrder: 0, label: "Section 1.1", src: "chapter1.xhtml#s1", children: [] }],
        },
        { id: "toc.ncx#chap2", playOrder: 0, label: "Chapter 2", src: "chapter2.xhtml", children: [] },
      ],
    };

    renderNCXDocument(ncx, "My Book", "test-uid-123");

    expect(ncx.markup).toContain('<meta name="dtb:uid" content="test-uid-123"/>');
    expect(ncx.markup).toContain("<docTitle><text>My Book</text></docTitle>");
    expect(ncx.navMap[0]!.playOrder).toBe(1);
    expect(ncx.navMap[0]!.children[0]!.playOrder).toBe(2);
    expect(ncx.navMap[1]!.playOrder).toBe(3);
  });
});

describe("navigation and NCX round-trip through a real write/parse cycle", () => {
  test("a rendered nav and NCX survive writeEpub -> parseEpub with structure intact", async () => {
    const e = newEpub("Round Trip Book", "Author");
    const pkg = primaryPackage(e)!;

    const nav = e.navigation["nav.xhtml"]!;
    nav.lists = [
      {
        id: "nav.xhtml#toc",
        type: "toc",
        heading: "Contents",
        items: [
          { id: "nav.xhtml#toc/item[0]", label: "Chapter One", href: "chapter1.xhtml", type: "", children: [] },
          { id: "nav.xhtml#toc/item[1]", label: "Chapter Two", href: "chapter2.xhtml", type: "", children: [] },
        ],
      },
    ];
    renderNavigationDocument(nav, "Table of Contents");

    const ncx: NCX = {
      id: "toc.ncx",
      markup: "",
      navMap: [
        { id: "toc.ncx#chap1", playOrder: 0, label: "Chapter One", src: "chapter1.xhtml", children: [] },
        { id: "toc.ncx#chap2", playOrder: 0, label: "Chapter Two", src: "chapter2.xhtml", children: [] },
      ],
    };
    renderNCXDocument(ncx, "Round Trip Book", "round-trip-uid");
    e.nCXs["toc.ncx"] = ncx;
    pkg.manifest.items.push({
      id: `${pkg.manifest.id}/ncx`,
      href: "toc.ncx",
      mediaType: "application/x-dtbncx+xml",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    pkg.spine.tocRef = "ncx";

    const dir = await mkdtemp(join(tmpdir(), "epub-render-nav-test-"));
    const out = join(dir, "book.epub");
    await writeEpub(e, out);
    const reparsed = await parseEpub(out);

    const reparsedNav = reparsed.navigation["nav.xhtml"];
    expect(reparsedNav?.lists[0]?.heading).toBe("Contents");
    expect(reparsedNav?.lists[0]?.items).toHaveLength(2);
    expect(reparsedNav?.lists[0]?.items[0]).toMatchObject({ label: "Chapter One", href: "chapter1.xhtml" });
    expect(reparsedNav?.lists[0]?.items[1]).toMatchObject({ label: "Chapter Two", href: "chapter2.xhtml" });

    const reparsedNcx = reparsed.nCXs["toc.ncx"];
    expect(reparsedNcx?.navMap).toHaveLength(2);
    expect(reparsedNcx?.navMap[0]).toMatchObject({ label: "Chapter One", src: "chapter1.xhtml", playOrder: 1 });
    expect(reparsedNcx?.navMap[1]).toMatchObject({ label: "Chapter Two", src: "chapter2.xhtml", playOrder: 2 });

    await rm(dir, { recursive: true, force: true });
  });
});
