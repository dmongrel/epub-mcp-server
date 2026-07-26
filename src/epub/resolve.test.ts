// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  relativeArchiveHref,
  resolveHref,
  relativeHref,
  manifestItemByHref,
  primaryPackage,
  manifestItemById,
  navItem,
  ncxItem,
  proseSpineDocuments,
} from "./resolve.ts";
import type { Epub, Package } from "./types.ts";
import { newEpub } from "./new-epub.ts";

function emptyPackage(baseDir: string): Package {
  return {
    id: `${baseDir}content.opf`,
    baseDir,
    version: "3.0",
    uniqueIdentifierRef: "uid",
    lang: "en",
    metadata: {
      id: "meta",
      identifiers: [],
      titles: [],
      languages: [],
      creators: [],
      contributors: [],
      publishers: [],
      dates: [],
      subjects: [],
      description: "",
      rights: "",
      metas: [],
    },
    manifest: { id: "manifest", items: [] },
    spine: { id: "spine", tocRef: "", pageProgressionDirection: "", itemRefs: [] },
  };
}

describe("relativeArchiveHref", () => {
  test("same directory", () => {
    expect(relativeArchiveHref("OEBPS/chapter1.xhtml", "OEBPS/chapter2.xhtml")).toBe("chapter2.xhtml");
  });

  test("target in a subdirectory", () => {
    expect(relativeArchiveHref("OEBPS/chapter1.xhtml", "OEBPS/images/cover.jpg")).toBe("images/cover.jpg");
  });

  test("target requires walking up a directory", () => {
    expect(relativeArchiveHref("OEBPS/text/chapter1.xhtml", "OEBPS/styles/style.css")).toBe(
      "../styles/style.css",
    );
  });

  test("source at archive root", () => {
    expect(relativeArchiveHref("nav.xhtml", "OEBPS/chapter1.xhtml")).toBe("OEBPS/chapter1.xhtml");
  });
});

describe("resolveHref", () => {
  test("resolves against baseDir", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(resolveHref(pkg, "chapter1.xhtml")).toBe("OEBPS/chapter1.xhtml");
  });

  test("strips a fragment", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(resolveHref(pkg, "chapter1.xhtml#section2")).toBe("OEBPS/chapter1.xhtml");
  });

  test("empty baseDir resolves relative to archive root", () => {
    const pkg = emptyPackage("");
    expect(resolveHref(pkg, "chapter1.xhtml")).toBe("chapter1.xhtml");
  });

  test("empty href returns empty string", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(resolveHref(pkg, "")).toBe("");
  });

  test("cleans a relative path", () => {
    const pkg = emptyPackage("OEBPS/text/");
    expect(resolveHref(pkg, "../images/cover.jpg")).toBe("OEBPS/images/cover.jpg");
  });
});

describe("relativeHref", () => {
  test("strips baseDir prefix", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(relativeHref(pkg, "OEBPS/chapter1.xhtml")).toBe("chapter1.xhtml");
  });

  test("returns unchanged if archivePath doesn't fall under baseDir", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(relativeHref(pkg, "META-INF/container.xml")).toBe("META-INF/container.xml");
  });
});

describe("manifestItemByHref", () => {
  test("finds the item whose resolved href matches", () => {
    const pkg = emptyPackage("OEBPS/");
    pkg.manifest.items.push({
      id: "manifest/chap1",
      href: "chapter1.xhtml",
      mediaType: "application/xhtml+xml",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    expect(manifestItemByHref(pkg, "OEBPS/chapter1.xhtml")?.id).toBe("manifest/chap1");
  });

  test("returns undefined when no item matches", () => {
    const pkg = emptyPackage("OEBPS/");
    expect(manifestItemByHref(pkg, "OEBPS/missing.xhtml")).toBeUndefined();
  });
});

describe("primaryPackage", () => {
  test("returns the package for the first rootfile", () => {
    const pkg = emptyPackage("");
    const e: Epub = {
      id: "",
      mimetype: "application/epub+zip",
      container: {
        id: "META-INF/container.xml",
        version: "1.0",
        rootfiles: [{ id: "r0", fullPath: "content.opf", mediaType: "application/oebps-package+xml" }],
      },
      packages: { "content.opf": pkg },
      navigation: {},
      nCXs: {},
      contentDocuments: {},
      resources: {},
    };
    expect(primaryPackage(e)).toBe(pkg);
  });

  test("returns undefined when there are no rootfiles", () => {
    const e: Epub = {
      id: "",
      mimetype: "application/epub+zip",
      container: { id: "META-INF/container.xml", version: "1.0", rootfiles: [] },
      packages: {},
      navigation: {},
      nCXs: {},
      contentDocuments: {},
      resources: {},
    };
    expect(primaryPackage(e)).toBeUndefined();
  });
});

describe("manifestItemById", () => {
  test("finds the item whose id ends with /<id>", () => {
    const pkg = emptyPackage("");
    pkg.manifest.items.push({
      id: "content.opf#manifest/nav",
      href: "nav.xhtml",
      mediaType: "application/xhtml+xml",
      properties: ["nav"],
      fallback: "",
      mediaOverlay: "",
    });
    expect(manifestItemById(pkg, "nav")?.href).toBe("nav.xhtml");
  });

  test("returns undefined for an empty id", () => {
    const pkg = emptyPackage("");
    expect(manifestItemById(pkg, "")).toBeUndefined();
  });
});

describe("navItem", () => {
  test("finds the item with a nav property", () => {
    const pkg = emptyPackage("");
    pkg.manifest.items.push({
      id: "content.opf#manifest/style",
      href: "style.css",
      mediaType: "text/css",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    pkg.manifest.items.push({
      id: "content.opf#manifest/nav",
      href: "nav.xhtml",
      mediaType: "application/xhtml+xml",
      properties: ["nav"],
      fallback: "",
      mediaOverlay: "",
    });
    expect(navItem(pkg)?.href).toBe("nav.xhtml");
  });

  test("returns undefined when no item is marked nav", () => {
    const pkg = emptyPackage("");
    expect(navItem(pkg)).toBeUndefined();
  });
});

describe("ncxItem", () => {
  test("finds the item referenced by spine.tocRef", () => {
    const pkg = emptyPackage("");
    pkg.spine.tocRef = "ncx";
    pkg.manifest.items.push({
      id: "content.opf#manifest/ncx",
      href: "toc.ncx",
      mediaType: "application/x-dtbncx+xml",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    expect(ncxItem(pkg)?.href).toBe("toc.ncx");
  });

  test("falls back to media-type search when tocRef is unset", () => {
    const pkg = emptyPackage("");
    pkg.manifest.items.push({
      id: "content.opf#manifest/ncx",
      href: "toc.ncx",
      mediaType: "application/x-dtbncx+xml",
      properties: [],
      fallback: "",
      mediaOverlay: "",
    });
    expect(ncxItem(pkg)?.href).toBe("toc.ncx");
  });

  test("returns undefined when there is no NCX", () => {
    const pkg = emptyPackage("");
    expect(ncxItem(pkg)).toBeUndefined();
  });

  test("returns undefined for a freshly created book (regression: tocRef placeholder must not be mistaken for an NCX)", () => {
    // newEpub() used to set spine.tocRef = "nav" as a placeholder. Since
    // manifestItemById() matches by id suffix without checking media type,
    // that value collided with the nav.xhtml manifest item's own id
    // ("content.opf#manifest/nav" ends with "/nav"), so ncxItem() would
    // wrongly report the EPUB 3 navigation document as a legacy NCX. A
    // freshly created EPUB-3-only book has no NCX at all.
    const pkg = primaryPackage(newEpub("NCX Regression Test", "Author"))!;
    expect(ncxItem(pkg)).toBeUndefined();
  });
});

describe("proseSpineDocuments", () => {
  /** Adds a content document to e with a manifest item and a spine entry at the end, mirroring what insertChapter does. */
  function addDoc(e: ReturnType<typeof newEpub>, archivePath: string, opfId: string, markup: string): void {
    const pkg = primaryPackage(e)!;
    pkg.manifest.items.push({ id: `${pkg.manifest.id}/${opfId}`, href: archivePath, mediaType: "application/xhtml+xml", properties: [], fallback: "", mediaOverlay: "" });
    pkg.spine.itemRefs.push({ id: "", idRef: opfId, linear: true, properties: [] });
    e.contentDocuments[archivePath] = { id: archivePath, mediaType: "application/xhtml+xml", markup };
  }

  test("returns prose documents in spine order", () => {
    const e = newEpub("Prose Order", "Author");
    addDoc(e, "text/b.xhtml", "b", "<body><h2>Chapter 2</h2></body>");
    addDoc(e, "text/a.xhtml", "a", "<body><h2>Chapter 1</h2></body>");

    expect(proseSpineDocuments(e, primaryPackage(e)!).map((d) => d.archivePath)).toEqual(["text/b.xhtml", "text/a.xhtml"]);
  });

  test("skips cover pages", () => {
    const e = newEpub("Prose Covers", "Author");
    addDoc(e, "text/cover.xhtml", "cov", `<body><section epub:type="cover"><img src="c.jpg"/></section></body>`);
    addDoc(e, "text/ch1.xhtml", "ch1", "<body><h2>Chapter 1</h2></body>");
    addDoc(e, "text/back.xhtml", "back", `<body><section epub:type="backmatter cover"><img src="b.jpg"/></section></body>`);

    expect(proseSpineDocuments(e, primaryPackage(e)!).map((d) => d.archivePath)).toEqual(["text/ch1.xhtml"]);
  });

  test("skips spine entries that resolve to no content document", () => {
    const e = newEpub("Prose Dangling", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", "<body><h2>Chapter 1</h2></body>");
    const pkg = primaryPackage(e)!;
    pkg.spine.itemRefs.push({ id: "", idRef: "ghost", linear: true, properties: [] });

    expect(proseSpineDocuments(e, pkg).map((d) => d.archivePath)).toEqual(["text/ch1.xhtml"]);
  });

  test("carries each document's markup alongside its path", () => {
    const e = newEpub("Prose Markup", "Author");
    addDoc(e, "text/ch1.xhtml", "ch1", "<body><h2>Chapter 1: Dawn</h2></body>");

    expect(proseSpineDocuments(e, primaryPackage(e)!)[0]?.markup).toContain("Chapter 1: Dawn");
  });
});

