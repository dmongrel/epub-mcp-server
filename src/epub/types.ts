/**
 * The in-memory EPUB data model, mirroring the OCF/OPF layers defined by
 * the EPUB 3.3 specification (https://www.w3.org/TR/epub-33/). Nothing in
 * this file touches disk or XML — it's the plain-data shape parse.ts fills
 * in and write.ts serializes back out.
 *
 * Every interface carries an `id` that doubles as a locator: an
 * archive-relative path ("OEBPS/chapter1.xhtml") for whole-file entries,
 * or that path plus a "#fragment" built from the identifying reference the
 * EPUB/OPF spec already defines for that node (a manifest item's own id, a
 * spine itemref's idref, ...) for data that lives inside a file.
 */

/** Locates a piece of EPUB data as it would appear on disk. The root Epub itself uses "". */
export type ArchiveId = string;

export interface Epub {
  id: ArchiveId; // always ""
  /** The literal contents of the required OCF "mimetype" entry, always "application/epub+zip". */
  mimetype: string;
  container: Container;
  /** Every package document (rendition), keyed by archive path. Most EPUBs have exactly one. */
  packages: Record<string, Package>;
  /** Every EPUB 3 navigation document (manifest item with properties="nav"), keyed by archive path. */
  navigation: Record<string, Navigation>;
  /** Every legacy EPUB 2 NCX table of contents, keyed by archive path. */
  nCXs: Record<string, NCX>;
  /** Every XHTML content document — the chapter/section text — keyed by archive path. */
  contentDocuments: Record<string, ContentDocument>;
  /** Every other manifest resource (stylesheets, images, fonts, ...), keyed by archive path. */
  resources: Record<string, Resource>;
}

/** The parsed META-INF/container.xml: locates every rootfile (package document) in the archive. */
export interface Container {
  id: ArchiveId; // "META-INF/container.xml"
  version: string;
  rootfiles: Rootfile[];
}

/** One <rootfile> entry in container.xml, pointing at a package document elsewhere in the archive. */
export interface Rootfile {
  id: ArchiveId;
  /** Archive-relative path to the package document, e.g. "OEBPS/content.opf". Keys Epub.packages. */
  fullPath: string;
  mediaType: string;
}

/** A parsed OPF package document: metadata, manifest of resources, and reading order. */
export interface Package {
  id: ArchiveId; // archive path of the package document
  /** Directory portion of id (e.g. "OEBPS/") that every ManifestItem's href resolves against. */
  baseDir: string;
  version: string;
  /** package/@unique-identifier: an IDREF naming the canonical entry in metadata.identifiers. */
  uniqueIdentifierRef: string;
  lang: string;
  metadata: Metadata;
  manifest: Manifest;
  spine: Spine;
  /** The legacy EPUB 2 <guide> element, kept for backward-compatibility. Absent if the doc has none. */
  guide?: Guide;
}

/** The OPF <metadata> element: Dublin Core and EPUB-specific descriptive metadata. */
export interface Metadata {
  id: ArchiveId;
  identifiers: Identifier[];
  titles: Title[];
  languages: Language[];
  creators: Contributor[];
  contributors: Contributor[];
  publishers: string[];
  dates: EpubDate[];
  subjects: Subject[];
  description: string;
  rights: string;
  /** Catch-all for <meta> elements not modeled above (dcterms:modified, cover ref, series, ...). */
  metas: Meta[];
}

export interface Identifier {
  id: ArchiveId;
  /** opf:scheme (or identifier-type refine), e.g. "ISBN", "UUID". Empty if unspecified. */
  scheme: string;
  value: string;
}

export interface Title {
  id: ArchiveId;
  value: string;
  /** title-type refine property, e.g. "main", "subtitle". Empty if unspecified (implies "main"). */
  type: string;
  lang: string;
}

export interface Language {
  id: ArchiveId;
  value: string;
}

/** A dc:creator or dc:contributor element (author, translator, illustrator, ...). */
export interface Contributor {
  id: ArchiveId;
  name: string;
  /** MARC relator code (e.g. "aut", "trl"), from the role refine or legacy opf:role attribute. */
  role: string;
  /** Sort-friendly form of name, from the file-as refine or legacy opf:file-as attribute. */
  fileAs: string;
  lang: string;
}

export interface EpubDate {
  id: ArchiveId;
  /** ISO 8601 string, as stored in the document. */
  value: string;
  /** dcterms event refine property (e.g. "publication", "modification"). Empty if unspecified. */
  event: string;
}

export interface Subject {
  id: ArchiveId;
  value: string;
  /** Subject authority (authority refine or opf:authority attribute), e.g. "BISAC". */
  scheme: string;
  /** Authority-specific term code (term refine or opf:term attribute). */
  code: string;
}

/** A generic OPF <meta> element: either the EPUB 3 property/refines form or legacy name/content form. */
export interface Meta {
  id: ArchiveId;
  /** meta/@property, e.g. "belongs-to-collection", "dcterms:modified". Empty for legacy metas. */
  property: string;
  /** meta/@refines IDREF (e.g. "#bookid") naming the element this meta describes. */
  refines: string;
  scheme: string;
  value: string;
  /** Legacy EPUB 2 meta/@name attribute (e.g. "calibre:series"). Empty for EPUB 3 property-form metas. */
  name: string;
}

/** The OPF <manifest> element: the exhaustive list of every file that belongs to the rendition. */
export interface Manifest {
  id: ArchiveId;
  items: ManifestItem[];
}

/** One <item> in the manifest, describing a single file in the archive. */
export interface ManifestItem {
  /** "<manifest id>/<opf:id>", reusing the item's own required id attribute. */
  id: ArchiveId;
  /** Path relative to the owning Package's baseDir. Resolve via resolveHref() to get the archive path. */
  href: string;
  mediaType: string;
  /** Manifest properties, e.g. "nav", "cover-image", "scripted", "svg", "mathml", "remote-resources". */
  properties: string[];
  /** IDREF to another manifest item to use as a fallback. Empty if absent. */
  fallback: string;
  /** IDREF to this item's SMIL media overlay (narrated audio sync). Empty if absent. */
  mediaOverlay: string;
}

/** The OPF <spine> element: the default linear reading order. */
export interface Spine {
  id: ArchiveId;
  /** Legacy spine/@toc attribute: an IDREF to the manifest item for the EPUB 2 NCX. */
  tocRef: string;
  /** spine/@page-progression-direction ("ltr", "rtl", or "" for unspecified). */
  pageProgressionDirection: string;
  itemRefs: SpineItemRef[];
}

/** One <itemref> in the spine, placing one manifest item into the reading order. */
export interface SpineItemRef {
  id: ArchiveId;
  /** The manifest item this entry places into the reading order. */
  idRef: string;
  /** False only when explicitly marked linear="no". Defaults to true. */
  linear: boolean;
  /** Itemref properties, e.g. "page-spread-left", "page-spread-right". */
  properties: string[];
}

/** The legacy EPUB 2 <guide> element, superseded by EPUB 3 navigation landmarks. */
export interface Guide {
  id: ArchiveId;
  references: GuideReference[];
}

/** One <reference> in the guide, e.g. pointing at the cover page or table of contents. */
export interface GuideReference {
  id: ArchiveId;
  /** e.g. "cover", "toc", "text". */
  type: string;
  title: string;
  /** Target, relative to the owning Package's baseDir, as an archive path plus optional "#fragment". */
  href: string;
}

/** An EPUB 3 navigation document: table of contents, landmarks, and (optionally) a page list. */
export interface Navigation {
  /** The navigation document's archive path, e.g. "OEBPS/nav.xhtml". */
  id: ArchiveId;
  mediaType: string;
  /** Raw serialized XHTML, kept for full-fidelity editing alongside the structured lists below. */
  markup: string;
  /** Every <nav> element in the document: toc, landmarks, page-list, or any custom epub:type nav. */
  lists: NavList[];
}

/** One <nav> element within a Navigation document. */
export interface NavList {
  id: ArchiveId; // "<navigation id>#<type>"
  /** The nav's epub:type (e.g. "toc", "landmarks", "page-list") or, absent that, its own xml:id. */
  type: string;
  /** The nav's heading text (h1-h6 child), if present. */
  heading: string;
  items: NavPoint[];
}

/** One <li> entry in a Navigation NavList, possibly with nested children forming a sub-list. */
export interface NavPoint {
  id: ArchiveId;
  label: string;
  /** Target: an archive path plus optional "#fragment". Empty for a heading-only entry. */
  href: string;
  /** The entry's own epub:type attribute, distinct from the NavList's type. */
  type: string;
  children: NavPoint[];
}

/** A legacy EPUB 2 "toc.ncx" table of contents, kept for reading systems predating EPUB 3 nav. */
export interface NCX {
  /** Archive path, e.g. "OEBPS/toc.ncx". */
  id: ArchiveId;
  markup: string;
  navMap: NCXNavPoint[];
}

/** One <navPoint> in an NCX's navMap, possibly nested. */
export interface NCXNavPoint {
  id: ArchiveId;
  playOrder: number;
  label: string;
  /** Target: an archive path plus optional "#fragment". */
  src: string;
  children: NCXNavPoint[];
}

/** One XHTML content document: a chapter, front-matter page, or other section of the novel's text. */
export interface ContentDocument {
  /** The document's archive path, e.g. "OEBPS/chapter1.xhtml". */
  id: ArchiveId;
  mediaType: string;
  /** Raw serialized XHTML content. */
  markup: string;
}

/** Any manifest file not modeled as a Package, Navigation, NCX, or ContentDocument. */
export interface Resource {
  /** The resource's archive path, e.g. "OEBPS/styles/main.css" or "OEBPS/images/cover.jpg". */
  id: ArchiveId;
  mediaType: string;
  /** Raw bytes (text resources such as CSS are simply valid UTF-8 in this array). */
  data: Uint8Array;
}
