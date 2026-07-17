import { posix } from "node:path";
import type { Epub, ManifestItem, Package } from "./types.ts";

/**
 * Returns the href, relative to the directory containing fromArchivePath,
 * that reaches toArchivePath — both full archive paths (always
 * "/"-separated). Unlike resolveHref/relativeHref (which are relative to
 * a package document's baseDir, the convention this module's own href
 * fields use), this is genuine document-relative resolution: the kind an
 * <img src="..."> or <a href="..."> written inside one content document
 * needs to reach another archive member, wherever each one lives.
 */
export function relativeArchiveHref(fromArchivePath: string, toArchivePath: string): string {
  const slash = fromArchivePath.lastIndexOf("/");
  const fromDir = slash === -1 ? "" : fromArchivePath.slice(0, slash);
  const fromParts = fromDir ? fromDir.split("/") : [];
  const toParts = toArchivePath.split("/");

  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) i++;

  const rel = "../".repeat(fromParts.length - i) + toParts.slice(i).join("/");
  return rel === "" ? toParts[toParts.length - 1] : rel;
}

/**
 * Turns an href as stored in a ManifestItem, SpineItemRef, GuideReference,
 * or nav/NCX target (relative to pkg.baseDir, possibly carrying a
 * "#fragment") into the archive path used to key Epub.resources,
 * Epub.contentDocuments, Epub.navigation, and Epub.nCXs.
 */
export function resolveHref(pkg: Package, href: string): string {
  const hashIndex = href.indexOf("#");
  const h = hashIndex === -1 ? href : href.slice(0, hashIndex);
  if (h === "") return "";
  const joined = pkg.baseDir ? pkg.baseDir + h : h;
  return posix.normalize(joined);
}

/**
 * The inverse of resolveHref: turns an archive path back into an href
 * relative to pkg.baseDir, suitable for a new ManifestItem's href. If
 * archivePath doesn't fall under baseDir, it's returned unchanged.
 */
export function relativeHref(pkg: Package, archivePath: string): string {
  if (pkg.baseDir && archivePath.startsWith(pkg.baseDir)) {
    return archivePath.slice(pkg.baseDir.length);
  }
  return archivePath;
}

/** Returns the manifest item whose href resolves to archivePath, or undefined if there is none. */
export function manifestItemByHref(pkg: Package, archivePath: string): ManifestItem | undefined {
  return pkg.manifest.items.find((item) => resolveHref(pkg, item.href) === archivePath);
}

/**
 * Returns the Package for the first rootfile listed in the container, or
 * undefined if e has none. Most EPUBs have exactly one rendition; this is
 * the one tools operate on unless told otherwise.
 */
export function primaryPackage(e: Epub): Package | undefined {
  if (e.container.rootfiles.length === 0) return undefined;
  return e.packages[e.container.rootfiles[0].fullPath];
}

/**
 * Returns the manifest item whose own opf:id attribute equals id — the
 * same id a SpineItemRef.idRef, ManifestItem.fallback, or Spine.tocRef
 * would reference — or undefined if there is none.
 */
export function manifestItemById(pkg: Package, id: string): ManifestItem | undefined {
  if (!id) return undefined;
  const suffix = "/" + id;
  return pkg.manifest.items.find((item) => item.id.endsWith(suffix));
}

/** Returns the manifest item marked as the EPUB 3 navigation document (properties="nav"). */
export function navItem(pkg: Package): ManifestItem | undefined {
  return pkg.manifest.items.find((item) => item.properties.includes("nav"));
}

/**
 * Returns the manifest item for the legacy EPUB 2 NCX, found via the
 * spine's toc attribute, falling back to a media-type search for
 * producers that omit it. Returns undefined if the rendition has no NCX.
 */
export function ncxItem(pkg: Package): ManifestItem | undefined {
  const byTocRef = manifestItemById(pkg, pkg.spine.tocRef);
  if (byTocRef) return byTocRef;
  return pkg.manifest.items.find((item) => item.mediaType === "application/x-dtbncx+xml");
}
