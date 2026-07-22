// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEpub } from "./parse.ts";
import { primaryPackage } from "./resolve.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "testdata", "the-magic-hower.epub");

describe("parseEpub", () => {
  test("parses the OCF container and mimetype", async () => {
    const e = await parseEpub(fixturePath);
    expect(e.mimetype).toBe("application/epub+zip");
    expect(e.container.rootfiles).toEqual([
      { id: "META-INF/container.xml#rootfiles[0]", fullPath: "content.opf", mediaType: "application/oebps-package+xml" },
    ]);
  });

  test("parses package metadata", async () => {
    const e = await parseEpub(fixturePath);
    const pkg = primaryPackage(e)!;
    expect(pkg.baseDir).toBe("");
    expect(pkg.metadata.identifiers[0]).toEqual({
      id: "content.opf#metadata/identifier[bookid]",
      scheme: "UUID",
      value: "a1af6a9864bf4a04b38d8da7336dabe4",
    });
    expect(pkg.metadata.titles[0].value).toBe("The Magic Hower");
    expect(pkg.metadata.creators).toHaveLength(2);
    expect(pkg.metadata.creators[0].name).toBe("");
    expect(pkg.metadata.creators[1]).toMatchObject({ name: "Unknown", role: "aut" });
  });

  test("parses the manifest and spine", async () => {
    const e = await parseEpub(fixturePath);
    const pkg = primaryPackage(e)!;
    expect(pkg.manifest.items).toHaveLength(11);
    expect(pkg.spine.itemRefs).toHaveLength(10);
    expect(pkg.spine.itemRefs[0]).toMatchObject({ idRef: "nav", linear: false });
    expect(pkg.spine.itemRefs[1]).toMatchObject({ idRef: "chapter-03", linear: true });
  });

  test("files content documents, resources, and navigation into the epub by role", async () => {
    const e = await parseEpub(fixturePath);
    expect(Object.keys(e.contentDocuments)).toHaveLength(9);
    expect(e.contentDocuments["OEBPS/text/chapter-03.xhtml"]).toBeDefined();
    expect(e.resources["styles/style.css"]?.mediaType).toBe("text/css");
    expect(Object.keys(e.nCXs)).toHaveLength(0);

    const nav = e.navigation["nav.xhtml"];
    expect(nav).toBeDefined();
    expect(nav!.lists).toHaveLength(1);
    expect(nav!.lists[0]).toMatchObject({ type: "toc", heading: "Contents" });
    expect(nav!.lists[0].items).toHaveLength(9);
    expect(nav!.lists[0].items[0]).toMatchObject({ label: "Chapter 03", href: "OEBPS/text/chapter-03.xhtml" });
  });

  test("rejects a path that doesn't exist", async () => {
    await expect(parseEpub("src/epub/testdata/does-not-exist.epub")).rejects.toThrow();
  });
});

