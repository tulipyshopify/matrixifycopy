/** The change actions a plan may hold, and the import columns they become. */

export interface ChangeSpec {
  action: "add_tags" | "remove_tags" | "set_column" | "set_metafield";
  column?: string;
  value: string;
  metafield?: string;
  metafieldType?: string;
}

/** The import columns and cell values a list of changes becomes, row by row. */
export function changeColumns(changes: ChangeSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  const add = changes.filter((c) => c.action === "add_tags").map((c) => c.value);
  const remove = changes.filter((c) => c.action === "remove_tags").map((c) => c.value);
  if (add.length && remove.length) throw new Error("Add and remove tags in two separate requests");
  if (add.length) Object.assign(out, { Tags: add.join(", "), "Tags Command": "MERGE" });
  if (remove.length) Object.assign(out, { Tags: remove.join(", "), "Tags Command": "DELETE" });
  for (const c of changes) {
    if (c.action === "set_column") out[c.column!] = c.value;
    if (c.action === "set_metafield") out[`Metafield: ${c.metafield} [${c.metafieldType}]`] = c.value;
  }
  return out;
}
