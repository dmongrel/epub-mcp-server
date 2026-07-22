// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { newEpub } from "./new-epub.ts";
import { primaryPackage } from "./resolve.ts";

describe("newEpub", () => {
  test("builds a minimal valid EPUB 3 skeleton with no chapters", () => {
    const e = newEpub("My Book", "Jane Author");

    expect(e.mimetype).toBe("application/epub+zip");
    expect(e.container.rootfiles).toEqual([
      { id: "META-INF/container.xml#rootfiles[0]", fullPath: "content.opf", mediaType: "application/oebps-package+xml" },
    ]);

    const pkg = primaryPackage(e)!;
    expect(pkg.metadata.titles[0].value).toBe("My Book");
    expect(pkg.metadata.creators).toEqual([
      { id: "content.opf#metadata/creator[0]", name: "Jane Author", role: "aut", fileAs: "", lang: "" },
    ]);
    expect(pkg.metadata.identifiers[0].scheme).toBe("UUID");
    expect(pkg.metadata.identifiers[0].value.length).toBeGreaterThan(0);

    expect(pkg.manifest.items.map((i) => i.href)).toEqual(["nav.xhtml", "styles/style.css"]);
    expect(pkg.spine.itemRefs).toEqual([
      { id: "content.opf#spine/itemref[0]", idRef: "nav", linear: true, properties: [] },
    ]);

    expect(Object.keys(e.contentDocuments)).toHaveLength(0);
    expect(e.navigation["nav.xhtml"]?.lists).toEqual([
      { id: "nav.xhtml#toc", type: "toc", heading: "Contents", items: [] },
    ]);
    expect(e.resources["styles/style.css"]?.mediaType).toBe("text/css");
  });

  test("generates a different identifier for each call", () => {
    const a = newEpub("Book A", "Author");
    const b = newEpub("Book B", "Author");
    expect(primaryPackage(a)!.metadata.identifiers[0].value).not.toBe(
      primaryPackage(b)!.metadata.identifiers[0].value,
    );
  });
});

