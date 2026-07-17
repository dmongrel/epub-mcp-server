import type { Epub, Package } from "./types.ts";

/**
 * Builds a minimal valid EPUB 3 publication in memory with the given
 * title and author: a container.xml, mimetype, navigation document
 * (nav.xhtml, with an empty toc list), and an empty stylesheet —
 * everything the edit_chapter/save_epub tools (Phase 4/5) need to work
 * immediately after creation. It intentionally has no chapters yet:
 * unlike a real book, there's nothing to place there sight unseen. The
 * save_epub tool fills in a single blank chapter automatically if the
 * book still has none by the time it's saved, since EPUB requires at
 * least one content document.
 */
export function newEpub(title: string, author: string): Epub {
  const now = new Date().toISOString();

  const e: Epub = {
    id: "",
    mimetype: "application/epub+zip",
    container: {
      id: "META-INF/container.xml",
      version: "1.0",
      rootfiles: [{ id: "META-INF/container.xml#rootfiles[0]", fullPath: "content.opf", mediaType: "application/oebps-package+xml" }],
    },
    packages: {},
    navigation: {},
    nCXs: {},
    contentDocuments: {},
    resources: {},
  };

  const pkg: Package = {
    id: "content.opf",
    baseDir: "",
    version: "3.0",
    uniqueIdentifierRef: "uid",
    lang: "en",
    metadata: {
      id: "content.opf#metadata",
      identifiers: [{ id: "content.opf#metadata/identifier[bookid]", scheme: "UUID", value: crypto.randomUUID() }],
      titles: [{ id: "content.opf#metadata/title[0]", value: title, type: "main", lang: "" }],
      languages: [{ id: "content.opf#metadata/language[0]", value: "en" }],
      creators: [],
      contributors: [],
      publishers: [],
      dates: [],
      subjects: [],
      description: "",
      rights: "",
      metas: [{ id: "content.opf#metadata/meta[modified]", property: "dcterms:modified", refines: "", scheme: "", value: now, name: "" }],
    },
    manifest: {
      id: "content.opf#manifest",
      items: [
        { id: "content.opf#manifest/nav", href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: ["nav"], fallback: "", mediaOverlay: "" },
        { id: "content.opf#manifest/style", href: "styles/style.css", mediaType: "text/css", properties: [], fallback: "", mediaOverlay: "" },
      ],
    },
    spine: {
      id: "content.opf#spine",
      tocRef: "nav",
      pageProgressionDirection: "ltr",
      itemRefs: [{ id: "content.opf#spine/itemref[0]", idRef: "nav", linear: true, properties: [] }],
    },
  };

  addCreator(pkg, author, "aut");
  e.packages["content.opf"] = pkg;

  e.navigation["nav.xhtml"] = {
    id: "nav.xhtml",
    mediaType: "application/xhtml+xml",
    markup: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2009/ops" lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Table of Contents</title>
  <link rel="stylesheet" href="styles/style.css" type="text/css"/>
</head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
    </ol>
  </nav>
</body>
</html>`,
    lists: [{ id: "nav.xhtml#toc", type: "toc", heading: "Contents", items: [] }],
  };

  e.resources["styles/style.css"] = {
    id: "styles/style.css",
    mediaType: "text/css",
    data: new TextEncoder().encode(
      "body { font-family: serif; line-height: 1.5; margin: 1em; }\n\nh1 { text-align: center; page-break-before: always; }\n\np { text-indent: 1em; margin: 0; }",
    ),
  };

  return e;
}

function addCreator(pkg: Package, name: string, role: string): void {
  const existing = pkg.metadata.creators.find((c) => c.name === name && c.role === role);
  if (existing) return;
  pkg.metadata.creators.push({
    id: `${pkg.metadata.id}/creator[${pkg.metadata.creators.length}]`,
    name,
    role,
    fileAs: "",
    lang: "",
  });
}
