import type { NavPoint, Navigation, NCX, NCXNavPoint } from "./types.ts";
import { escXML, idFragmentKey } from "./write.ts";

/**
 * Regenerates nav.markup from nav.lists, using docTitle as the XHTML
 * <title>. Callers that mutate Navigation.lists must call this afterwards
 * — unlike the package document, writeEpub serializes a Navigation's markup
 * verbatim, so structured edits are invisible on disk until the markup is
 * regenerated to match.
 */
export function renderNavigationDocument(nav: Navigation, docTitle: string): void {
  let b = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  b += `<!DOCTYPE html>\n`;
  b += `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2009/ops" lang="en">\n`;
  b += `<head>\n  <meta charset="UTF-8"/>\n`;
  b += `  <title>${escXML(docTitle)}</title>\n`;
  b += `</head>\n<body>\n`;

  for (const list of nav.lists) {
    b += `  <nav`;
    if (list.type) b += ` epub:type="${escXML(list.type)}"`;
    const [key, isRealId] = idFragmentKey(list.id);
    if (isRealId) b += ` id="${escXML(key)}"`;
    b += `>\n`;
    if (list.heading) b += `    <h1>${escXML(list.heading)}</h1>\n`;
    b += `    <ol>\n`;
    b += renderNavPoints(list.items, 3);
    b += `    </ol>\n`;
    b += `  </nav>\n`;
  }

  b += `</body>\n</html>\n`;
  nav.markup = b;
}

function renderNavPoints(points: NavPoint[], indent: number): string {
  const pad = "  ".repeat(indent);
  let s = "";
  for (const p of points) {
    s += pad + `<li`;
    const [key, isRealId] = idFragmentKey(p.id);
    if (isRealId) s += ` id="${escXML(key)}"`;
    s += `>`;
    const typeAttr = p.type ? ` epub:type="${escXML(p.type)}"` : "";
    if (p.href) {
      s += `<a${typeAttr} href="${escXML(p.href)}">${escXML(p.label)}</a>`;
    } else {
      s += `<span${typeAttr}>${escXML(p.label)}</span>`;
    }
    if (p.children.length > 0) {
      s += "\n" + pad + "  <ol>\n";
      s += renderNavPoints(p.children, indent + 2);
      s += pad + "  </ol>\n" + pad;
    }
    s += "</li>\n";
  }
  return s;
}

/**
 * Regenerates ncx.markup from ncx.navMap, using docTitle and uid (the
 * book's unique identifier) for the required <docTitle> and dtb:uid meta.
 * Play order is renumbered sequentially in document order, mutating each
 * point's playOrder field. Like renderNavigationDocument, callers that
 * mutate NCX.navMap must call this afterwards since writeEpub serializes
 * markup verbatim.
 */
export function renderNCXDocument(ncx: NCX, docTitle: string, uid: string): void {
  let b = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  b += `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n`;
  b += `  <head>\n`;
  b += `    <meta name="dtb:uid" content="${escXML(uid)}"/>\n`;
  b += `  </head>\n`;
  b += `  <docTitle><text>${escXML(docTitle)}</text></docTitle>\n`;
  b += `  <navMap>\n`;
  const order = { value: 1 };
  b += renderNCXNavPoints(ncx.navMap, 2, order);
  b += `  </navMap>\n`;
  b += `</ncx>\n`;
  ncx.markup = b;
}

function renderNCXNavPoints(points: NCXNavPoint[], indent: number, order: { value: number }): string {
  const pad = "  ".repeat(indent);
  let s = "";
  for (const p of points) {
    let [id, isRealId] = idFragmentKey(p.id);
    if (!isRealId || id === "") id = `navpoint-${order.value}`;
    p.playOrder = order.value;
    s += `${pad}<navPoint id="${escXML(id)}" playOrder="${p.playOrder}">\n`;
    order.value++;
    s += `${pad}  <navLabel><text>${escXML(p.label)}</text></navLabel>\n`;
    s += `${pad}  <content src="${escXML(p.src)}"/>\n`;
    if (p.children.length > 0) {
      s += renderNCXNavPoints(p.children, indent + 1, order);
    }
    s += `${pad}</navPoint>\n`;
  }
  return s;
}
