/**
 * Small generic helpers shared by every edit_ tool that addresses one
 * entry of an array-valued field by id, or needs the same tiny bit of
 * action-name string formatting. Mirrors Go's tools/idlist.go (findIndex,
 * removeAt, removeMatching) plus verbPast/contains — in Go those two live
 * in tools/edit_metadata.go, called from six other tool files as a
 * happenstance of Go's flat single-package namespace; relocated here
 * since they're conceptually generic, not metadata-specific, and every
 * edit_ tool in this port already imports idlist.ts for the other three.
 */

/** Returns the index of the item in items whose id (via getId) equals id, or -1 if none matches. */
export function findIndex<T>(items: T[], id: string, getId: (item: T) => string): number {
  return items.findIndex((item) => getId(item) === id);
}

/** Returns items with the element at index i removed, preserving order. Does not mutate items. */
export function removeAt<T>(items: T[], i: number): T[] {
  return [...items.slice(0, i), ...items.slice(i + 1)];
}

/** Returns items with every element for which keep returns false removed, preserving order. */
export function removeMatching<T>(items: T[], keep: (item: T) => boolean): T[] {
  return items.filter(keep);
}

/** Reports whether v is present in list. */
export function contains(list: string[], v: string): boolean {
  return list.includes(v);
}

/** Returns the capitalized past-tense-ready verb for an edit_ action: "create"->"Create", "edit"->"Update", "remove"->"Remove". Callers append "d". */
export function verbPast(action: string): string {
  if (action === "edit") return "Update";
  return action.charAt(0).toUpperCase() + action.slice(1);
}
