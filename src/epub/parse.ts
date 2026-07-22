// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

import { DOMParser, onErrorStopParsing, type Document, type Element } from "@xmldom/xmldom";
import { unzipSync } from "fflate";
import { readBinaryPortable } from "./runtime.ts";
import { resolveHref } from "./resolve.ts";
import type {
  ArchiveId,
  ContentDocument,
  Epub,
  Guide,
  Manifest,
  Metadata,
  NavList,
  NavPoint,
  Navigation,
  NCX,
  NCXNavPoint,
  Package,
  Resource,
  Spine,
} from "./types.ts";

const textDecoder = new TextDecoder("utf-8");
const strictParser = new DOMParser({ onError: onErrorStopParsing });

function parseXML(data: Uint8Array): Document {
  return strictParser.parseFromString(textDecoder.decode(data), "text/xml");
}

function localName(tagName: string): string {
  const i = tagName.indexOf(":");
  return i === -1 ? tagName : tagName.slice(i + 1);
}

function directChildren(parent: Element | Document, local: string): Element[] {
  const out: Element[] = [];
  for (const child of parent.children) {
    if (localName(child.tagName) === local) out.push(child);
  }
  return out;
}

function firstChild(parent: Element | Document, local: string): Element | null {
  for (const child of parent.children) {
    if (localName(child.tagName) === local) return child;
  }
  return null;
}

/** All <local> elements anywhere under parent, depth-first — mirrors Go's findAllLocal. */
function descendants(parent: Element, local: string): Element[] {
  const out: Element[] = [];
  for (const child of parent.children) {
    if (localName(child.tagName) === local) out.push(child);
    out.push(...descendants(child, local));
  }
  return out;
}

/**
 * Attribute lookup by local name, ignoring namespace prefix — mirrors Go's
 * encoding/xml, which matches an unqualified `xml:"scheme,attr"` struct tag
 * against an attribute's local name regardless of namespace. This matters
 * because EPUB producers write legacy refinement attributes as opf:scheme,
 * opf:role, opf:file-as, etc., and nav/NCX type markers as epub:type.
 */
function attr(el: Element, name: string): string {
  const direct = el.getAttribute(name);
  if (direct !== null) return direct;
  for (const a of el.attributes) {
    if (localName(a.name) === name) return a.value;
  }
  return "";
}

/** el's own direct text content, trimmed — mirrors Go's xml:",chardata". */
function chardata(el: Element): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) text += node.nodeValue ?? ""; // TEXT_NODE
  }
  return text.trim();
}

/** All text within el, in document order, including nested inline elements, whitespace-collapsed. */
function chardataDeep(el: Element): string {
  const text = el.textContent ?? "";
  return text.split(/\s+/).filter(Boolean).join(" ");
}

function isHeadingTag(local: string): boolean {
  return /^h[1-6]$/.test(local);
}

function fragId(parent: ArchiveId, name: string, xmlId: string, index: number): ArchiveId {
  return xmlId ? `${parent}/${name}[${xmlId}]` : `${parent}/${name}[${index}]`;
}

export async function parseEpub(filename: string): Promise<Epub> {
  const raw = await readBinaryPortable(filename);
  const files = unzipSync(raw);
  return parseArchive(files);
}

function readZipFile(files: Record<string, Uint8Array>, name: string): Uint8Array {
  const data = files[name];
  if (!data) throw new Error(`${name}: not found in archive`);
  return data;
}

function parseArchive(files: Record<string, Uint8Array>): Epub {
  const mimetype = files["mimetype"] ? textDecoder.decode(files["mimetype"]) : "";

  const containerData = readZipFile(files, "META-INF/container.xml");
  const containerEl = parseXML(containerData).documentElement;
  if (!containerEl) throw new Error("parse container.xml: no root element");

  const e: Epub = {
    id: "",
    mimetype,
    container: { id: "META-INF/container.xml", version: attr(containerEl, "version"), rootfiles: [] },
    packages: {},
    navigation: {},
    nCXs: {},
    contentDocuments: {},
    resources: {},
  };

  const rootfilesEl = firstChild(containerEl, "rootfiles");
  const rootfileEls = rootfilesEl ? directChildren(rootfilesEl, "rootfile") : [];

  rootfileEls.forEach((rf, i) => {
    const fullPath = attr(rf, "full-path");
    e.container.rootfiles.push({
      id: `META-INF/container.xml#rootfiles[${i}]`,
      fullPath,
      mediaType: attr(rf, "media-type"),
    });

    const pkg = parsePackage(files, fullPath);
    e.packages[fullPath] = pkg;
    loadManifestResources(files, pkg, e);
  });

  return e;
}

function parsePackage(files: Record<string, Uint8Array>, fullPath: string): Package {
  const data = readZipFile(files, fullPath);
  const root = parseXML(data).documentElement;
  if (!root) throw new Error(`parse package ${fullPath}: no root element`);

  const pkgId: ArchiveId = fullPath;
  const slash = fullPath.lastIndexOf("/");
  const baseDir = slash >= 0 ? fullPath.slice(0, slash + 1) : "";

  return {
    id: pkgId,
    baseDir,
    version: attr(root, "version"),
    uniqueIdentifierRef: attr(root, "unique-identifier"),
    lang: attr(root, "lang"),
    metadata: buildMetadata(firstChild(root, "metadata"), pkgId),
    manifest: buildManifest(firstChild(root, "manifest"), pkgId),
    spine: buildSpine(firstChild(root, "spine"), pkgId),
    guide: buildGuide(firstChild(root, "guide"), pkgId),
  };
}

function buildMetadata(el: Element | null, pkgId: ArchiveId): Metadata {
  const metaId: ArchiveId = `${pkgId}#metadata`;
  const m: Metadata = {
    id: metaId,
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
  };
  if (!el) return m;

  directChildren(el, "identifier").forEach((v, i) => {
    m.identifiers.push({ id: fragId(metaId, "identifier", attr(v, "id"), i), scheme: attr(v, "scheme"), value: chardata(v) });
  });
  directChildren(el, "title").forEach((v, i) => {
    m.titles.push({ id: fragId(metaId, "title", attr(v, "id"), i), value: chardata(v), type: "", lang: attr(v, "lang") });
  });
  directChildren(el, "language").forEach((v, i) => {
    m.languages.push({ id: fragId(metaId, "language", attr(v, "id"), i), value: chardata(v) });
  });
  directChildren(el, "creator").forEach((v, i) => {
    m.creators.push({
      id: fragId(metaId, "creator", attr(v, "id"), i),
      name: chardata(v),
      role: attr(v, "role"),
      fileAs: attr(v, "file-as"),
      lang: attr(v, "lang"),
    });
  });
  directChildren(el, "contributor").forEach((v, i) => {
    m.contributors.push({
      id: fragId(metaId, "contributor", attr(v, "id"), i),
      name: chardata(v),
      role: attr(v, "role"),
      fileAs: attr(v, "file-as"),
      lang: attr(v, "lang"),
    });
  });
  directChildren(el, "publisher").forEach((v) => m.publishers.push(chardata(v)));
  directChildren(el, "date").forEach((v, i) => {
    m.dates.push({ id: fragId(metaId, "date", attr(v, "id"), i), value: chardata(v), event: attr(v, "event") });
  });
  directChildren(el, "subject").forEach((v, i) => {
    m.subjects.push({
      id: fragId(metaId, "subject", attr(v, "id"), i),
      value: chardata(v),
      scheme: attr(v, "authority"),
      code: attr(v, "term"),
    });
  });
  const descriptions = directChildren(el, "description");
  if (descriptions.length > 0) m.description = chardata(descriptions[0]);
  const rights = directChildren(el, "rights");
  if (rights.length > 0) m.rights = chardata(rights[0]);
  directChildren(el, "meta").forEach((v, i) => {
    const name = attr(v, "name");
    const value = name ? attr(v, "content") : chardata(v);
    m.metas.push({
      id: fragId(metaId, "meta", attr(v, "id"), i),
      property: attr(v, "property"),
      refines: attr(v, "refines"),
      scheme: attr(v, "scheme"),
      value,
      name,
    });
  });

  return m;
}

function buildManifest(el: Element | null, pkgId: ArchiveId): Manifest {
  const manifestId: ArchiveId = `${pkgId}#manifest`;
  const man: Manifest = { id: manifestId, items: [] };
  if (!el) return man;

  directChildren(el, "item").forEach((v, i) => {
    const opfId = attr(v, "id") || `item[${i}]`;
    man.items.push({
      id: `${manifestId}/${opfId}`,
      href: attr(v, "href"),
      mediaType: attr(v, "media-type"),
      properties: attr(v, "properties").split(/\s+/).filter(Boolean),
      fallback: attr(v, "fallback"),
      mediaOverlay: attr(v, "media-overlay"),
    });
  });
  return man;
}

function buildSpine(el: Element | null, pkgId: ArchiveId): Spine {
  const spineId: ArchiveId = `${pkgId}#spine`;
  const sp: Spine = { id: spineId, tocRef: "", pageProgressionDirection: "", itemRefs: [] };
  if (!el) return sp;

  sp.tocRef = attr(el, "toc");
  sp.pageProgressionDirection = attr(el, "page-progression-direction");
  directChildren(el, "itemref").forEach((v, i) => {
    sp.itemRefs.push({
      id: `${spineId}/itemref[${i}]`,
      idRef: attr(v, "idref"),
      linear: attr(v, "linear") !== "no",
      properties: attr(v, "properties").split(/\s+/).filter(Boolean),
    });
  });
  return sp;
}

function buildGuide(el: Element | null, pkgId: ArchiveId): Guide | undefined {
  if (!el) return undefined;
  const guideId: ArchiveId = `${pkgId}#guide`;
  const g: Guide = { id: guideId, references: [] };
  directChildren(el, "reference").forEach((v, i) => {
    const type = attr(v, "type");
    const key = type || String(i);
    g.references.push({ id: `${guideId}/reference[${key}]`, type, title: attr(v, "title"), href: attr(v, "href") });
  });
  return g;
}

function loadManifestResources(files: Record<string, Uint8Array>, pkg: Package, e: Epub): void {
  for (const item of pkg.manifest.items) {
    const archivePath = resolveHref(pkg, item.href);
    if (!archivePath) continue;

    const data = readZipFile(files, archivePath);
    const isNav = item.properties.includes("nav");

    if (isNav) {
      e.navigation[archivePath] = parseNavigation(archivePath, item.mediaType, data);
    } else if (item.mediaType === "application/x-dtbncx+xml") {
      e.nCXs[archivePath] = parseNCX(archivePath, data);
    } else if (item.mediaType === "application/xhtml+xml") {
      e.contentDocuments[archivePath] = { id: archivePath, mediaType: item.mediaType, markup: textDecoder.decode(data) };
    } else {
      e.resources[archivePath] = { id: archivePath, mediaType: item.mediaType, data };
    }
  }
}

/** Structured lists are best-effort; markup always holds the full raw document regardless. */
function parseNavigation(archivePath: ArchiveId, mediaType: string, data: Uint8Array): Navigation {
  const markup = textDecoder.decode(data);
  const nav: Navigation = { id: archivePath, mediaType, markup, lists: [] };

  let root: Element | null;
  try {
    root = parseXML(data).documentElement;
  } catch {
    return nav;
  }
  if (!root) return nav;

  descendants(root, "nav").forEach((navEl, i) => {
    nav.lists.push(buildNavList(nav.id, navEl, i));
  });
  return nav;
}

function buildNavList(navId: ArchiveId, n: Element, index: number): NavList {
  const typ = attr(n, "type");
  const xmlId = attr(n, "id");
  const key = typ || xmlId || `list[${index}]`;
  const listId: ArchiveId = `${navId}#${key}`;
  const displayType = typ || xmlId;

  let heading = "";
  for (const child of n.children) {
    if (isHeadingTag(localName(child.tagName))) {
      heading = chardataDeep(child);
      break;
    }
  }

  let items: NavPoint[] = [];
  for (const child of n.children) {
    if (localName(child.tagName) === "ol") {
      items = buildNavPoints(listId, child);
      break;
    }
  }

  return { id: listId, type: displayType, heading, items };
}

function buildNavPoints(listId: ArchiveId, ol: Element): NavPoint[] {
  const points: NavPoint[] = [];
  let index = 0;
  for (const li of ol.children) {
    if (localName(li.tagName) !== "li") continue;

    const xmlId = attr(li, "id");
    const pointId: ArchiveId = xmlId ? `${listId}/${xmlId}` : `${listId}/item[${index}]`;
    index++;

    let label = "";
    let href = "";
    let typ = "";
    let children: NavPoint[] = [];
    for (const child of li.children) {
      const local = localName(child.tagName);
      if (local === "a") {
        href = attr(child, "href");
        label = chardataDeep(child);
        typ = attr(child, "type");
      } else if (local === "span") {
        if (!label) label = chardataDeep(child);
        if (!typ) typ = attr(child, "type");
      } else if (local === "ol") {
        children = buildNavPoints(pointId, child);
      }
    }

    points.push({ id: pointId, label, href, type: typ, children });
  }
  return points;
}

/** navMap is best-effort; markup always holds the full raw document regardless. */
function parseNCX(archivePath: ArchiveId, data: Uint8Array): NCX {
  const markup = textDecoder.decode(data);
  const ncx: NCX = { id: archivePath, markup, navMap: [] };

  let root: Element | null;
  try {
    root = parseXML(data).documentElement;
  } catch {
    return ncx;
  }
  if (!root) return ncx;

  const navMapEl = firstChild(root, "navMap");
  if (!navMapEl) return ncx;

  ncx.navMap = buildNCXNavPoints(ncx.id, directChildren(navMapEl, "navPoint"));
  return ncx;
}

function buildNCXNavPoints(ncxId: ArchiveId, els: Element[]): NCXNavPoint[] {
  return els.map((p) => {
    const id = attr(p, "id");
    const playOrder = parseInt(attr(p, "playOrder"), 10) || 0;
    const navLabelEl = firstChild(p, "navLabel");
    const textEl = navLabelEl ? firstChild(navLabelEl, "text") : null;
    const label = textEl ? chardata(textEl) : "";
    const contentEl = firstChild(p, "content");
    const src = contentEl ? attr(contentEl, "src") : "";
    return {
      id: `${ncxId}#${id}`,
      playOrder,
      label,
      src,
      children: buildNCXNavPoints(ncxId, directChildren(p, "navPoint")),
    };
  });
}

