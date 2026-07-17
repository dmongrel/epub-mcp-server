import { zipSync, type Zippable } from "fflate";
import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeBinaryPortable } from "./runtime.ts";
import type { ArchiveId, Container, Epub, Guide, Manifest, Meta, Metadata, Package, Spine } from "./types.ts";

/**
 * Escapes s for safe use as either XML element text or an attribute value.
 * Ports Go's xml.EscapeText (see the Go reference implementation's
 * epub/write.go): besides the five predefined entities, \t/\n/\r are escaped
 * as numeric character references so attribute-value normalization on
 * reparse can't silently rewrite them to plain spaces, and XML-illegal
 * control characters are replaced with U+FFFD so writeEpub never emits a
 * document parseEpub can't read back.
 */
export function escXML(s: string): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&apos;";
        break;
      case "\t":
        out += "&#x9;";
        break;
      case "\n":
        out += "&#xA;";
        break;
      case "\r":
        out += "&#xD;";
        break;
      default: {
        const code = ch.codePointAt(0)!;
        const isIllegalControlChar =
          (code >= 0x1 && code <= 0x8) || code === 0xb || code === 0xc || (code >= 0xe && code <= 0x1f);
        out += isIllegalControlChar ? "�" : ch;
        break;
      }
    }
  }
  return out;
}

/**
 * Extracts the trailing "[...]" token from a fragment id built by parse.ts's
 * fragId, and reports whether it's a real xml:id (recovered so it can be
 * written back out) as opposed to fragId's positional-index fallback. XML
 * NCName ids can't start with a digit, so an all-digit key is unambiguously
 * a synthetic index, not a real id.
 */
export function idFragmentKey(id: ArchiveId): [key: string, isRealId: boolean] {
  const i = id.lastIndexOf("[");
  const j = id.lastIndexOf("]");
  if (i < 0 || j < 0 || j < i) return ["", false];
  const key = id.slice(i + 1, j);
  if (key === "") return ["", false];
  for (const ch of key) {
    if (ch < "0" || ch > "9") return [key, true];
  }
  return [key, false];
}

/**
 * Serializes e as a .epub file at filename. container.xml and every package
 * document are regenerated from the in-memory metadata, manifest, and spine
 * (so edits to those are reflected); every content document, navigation
 * document, NCX, and other resource is written back using its stored raw
 * markup/data verbatim.
 *
 * Builds the archive bytes fully in memory, then writes to a temp file in
 * filename's directory and renames it into place only once fully written,
 * so a failure partway through never corrupts an existing file at filename.
 */
export async function writeEpub(e: Epub, filename: string): Promise<void> {
  const bytes = buildArchive(e);

  const dir = dirname(filename);
  const tmpPath = join(dir, `.epub-tmp-${crypto.randomUUID()}`);
  try {
    await writeBinaryPortable(tmpPath, bytes);
    await rename(tmpPath, filename);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function buildArchive(e: Epub): Uint8Array {
  const mimetype = e.mimetype || "application/epub+zip";
  const files: Zippable = {
    mimetype: [new TextEncoder().encode(mimetype), { level: 0 }],
  };

  files["META-INF/container.xml"] = renderContainer(e.container);

  for (const rf of e.container.rootfiles) {
    const pkg = e.packages[rf.fullPath];
    if (!pkg) continue;
    files[rf.fullPath] = renderPackage(pkg);
  }

  for (const [path, doc] of Object.entries(e.contentDocuments)) {
    files[path] = new TextEncoder().encode(doc.markup);
  }
  for (const [path, nav] of Object.entries(e.navigation)) {
    files[path] = new TextEncoder().encode(nav.markup);
  }
  for (const [path, ncx] of Object.entries(e.nCXs)) {
    files[path] = new TextEncoder().encode(ncx.markup);
  }
  for (const [path, res] of Object.entries(e.resources)) {
    files[path] = res.data;
  }

  return zipSync(files);
}

function renderContainer(c: Container): Uint8Array {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<container version="${escXML(c.version)}" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">`,
    `  <rootfiles>`,
    ...c.rootfiles.map(
      (rf) => `    <rootfile full-path="${escXML(rf.fullPath)}" media-type="${escXML(rf.mediaType)}"/>`,
    ),
    `  </rootfiles>`,
    `</container>`,
  ];
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

function renderPackage(pkg: Package): Uint8Array {
  let b = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  b += `<package xmlns="http://www.idpf.org/2007/opf" version="${escXML(pkg.version)}"`;
  if (pkg.uniqueIdentifierRef) b += ` unique-identifier="${escXML(pkg.uniqueIdentifierRef)}"`;
  if (pkg.lang) b += ` xml:lang="${escXML(pkg.lang)}"`;
  b += `>\n`;

  b += `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n`;
  b += renderMetadata(pkg.metadata);
  b += `  </metadata>\n`;

  b += `  <manifest>\n`;
  b += renderManifest(pkg.manifest);
  b += `  </manifest>\n`;

  b += `  <spine`;
  if (pkg.spine.tocRef) b += ` toc="${escXML(pkg.spine.tocRef)}"`;
  if (pkg.spine.pageProgressionDirection) b += ` page-progression-direction="${escXML(pkg.spine.pageProgressionDirection)}"`;
  b += `>\n`;
  b += renderSpine(pkg.spine);
  b += `  </spine>\n`;

  if (pkg.guide) {
    b += `  <guide>\n`;
    b += renderGuide(pkg.guide);
    b += `  </guide>\n`;
  }

  b += `</package>\n`;
  return new TextEncoder().encode(b);
}

function writeIdElem(tag: string, id: ArchiveId, value: string, attrs: Array<[string, string]> = []): string {
  let s = `    <${tag}`;
  const [key, isRealId] = idFragmentKey(id);
  if (isRealId) s += ` id="${escXML(key)}"`;
  for (const [name, val] of attrs) {
    if (val === "") continue;
    s += ` ${name}="${escXML(val)}"`;
  }
  s += `>${escXML(value)}</${tag}>\n`;
  return s;
}

function renderMetadata(m: Metadata): string {
  let s = "";
  for (const v of m.identifiers) s += writeIdElem("dc:identifier", v.id, v.value, [["opf:scheme", v.scheme]]);
  for (const v of m.titles) s += writeIdElem("dc:title", v.id, v.value, [["xml:lang", v.lang]]);
  for (const v of m.languages) s += writeIdElem("dc:language", v.id, v.value);
  for (const v of m.creators) {
    s += writeIdElem("dc:creator", v.id, v.name, [
      ["opf:role", v.role],
      ["opf:file-as", v.fileAs],
      ["xml:lang", v.lang],
    ]);
  }
  for (const v of m.contributors) {
    s += writeIdElem("dc:contributor", v.id, v.name, [
      ["opf:role", v.role],
      ["opf:file-as", v.fileAs],
      ["xml:lang", v.lang],
    ]);
  }
  for (const v of m.publishers) s += `    <dc:publisher>${escXML(v)}</dc:publisher>\n`;
  for (const v of m.dates) s += writeIdElem("dc:date", v.id, v.value, [["opf:event", v.event]]);
  for (const v of m.subjects) {
    s += writeIdElem("dc:subject", v.id, v.value, [
      ["opf:authority", v.scheme],
      ["opf:term", v.code],
    ]);
  }
  if (m.description) s += `    <dc:description>${escXML(m.description)}</dc:description>\n`;
  if (m.rights) s += `    <dc:rights>${escXML(m.rights)}</dc:rights>\n`;
  for (const v of m.metas) s += writeMetaElem(v);
  return s;
}

function writeMetaElem(m: Meta): string {
  let s = `    <meta`;
  const [key, isRealId] = idFragmentKey(m.id);
  if (isRealId) s += ` id="${escXML(key)}"`;
  if (m.name) {
    s += ` name="${escXML(m.name)}" content="${escXML(m.value)}"/>\n`;
    return s;
  }
  if (m.property) s += ` property="${escXML(m.property)}"`;
  if (m.refines) s += ` refines="${escXML(m.refines)}"`;
  if (m.scheme) s += ` scheme="${escXML(m.scheme)}"`;
  s += `>${escXML(m.value)}</meta>\n`;
  return s;
}

function renderManifest(man: Manifest): string {
  const prefix = man.id + "/";
  let s = "";
  for (const item of man.items) {
    const id = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
    s += `    <item id="${escXML(id)}" href="${escXML(item.href)}" media-type="${escXML(item.mediaType)}"`;
    if (item.properties.length > 0) s += ` properties="${escXML(item.properties.join(" "))}"`;
    if (item.fallback) s += ` fallback="${escXML(item.fallback)}"`;
    if (item.mediaOverlay) s += ` media-overlay="${escXML(item.mediaOverlay)}"`;
    s += `/>\n`;
  }
  return s;
}

function renderSpine(sp: Spine): string {
  let s = "";
  for (const ref of sp.itemRefs) {
    s += `    <itemref idref="${escXML(ref.idRef)}"`;
    if (!ref.linear) s += ` linear="no"`;
    if (ref.properties.length > 0) s += ` properties="${escXML(ref.properties.join(" "))}"`;
    s += `/>\n`;
  }
  return s;
}

function renderGuide(g: Guide): string {
  let s = "";
  for (const r of g.references) {
    s += `    <reference type="${escXML(r.type)}"`;
    if (r.title) s += ` title="${escXML(r.title)}"`;
    s += ` href="${escXML(r.href)}"/>\n`;
  }
  return s;
}
