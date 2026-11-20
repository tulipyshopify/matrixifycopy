/** The change actions a plan may hold, and the import columns they become. */

export interface ChangeSpec {
  action: "add_tags" | "remove_tags" | "set_column" | "set_metafield" | "adjust_price" | "end_sale" | "replace_text";
  column?: string;
  value: string;
  metafield?: string;
  metafieldType?: string;
  /** adjust_price: change by a percentage (+5, -20) or by an amount of money (+2, -1.50). */
  percent?: number;
  amount?: number;
  /** adjust_price: make the new price end in these pence/cents ("99" → 12.99); empty = plain rounding. */
  ending?: string;
  /** adjust_price: "old_price" shows the price before the change as the compare-at price; "clear" empties it. */
  compareAt?: "keep" | "old_price" | "clear";
  /** end_sale: put the price back to the compare-at price before clearing it. */
  restorePrice?: boolean;
  /** replace_text: the text to find (in `column`); `value` replaces it. */
  find?: string;
  matchCase?: boolean;
}

/** Changes worked out from each item's current values, so the items are read first. */
export const isComputed = (c: ChangeSpec) => c.action === "adjust_price" || c.action === "end_sale" || c.action === "replace_text";
/** Changes made on every variant of a product. */
export const isPerVariant = (c: ChangeSpec) => c.action === "adjust_price" || c.action === "end_sale" || (c.action === "set_column" && /^Variant /.test(c.column ?? ""));

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** A price after an adjust_price change; null when it can't be worked out or would not be above zero. */
export function adjustedPrice(current: string, c: ChangeSpec): string | null {
  const old = Number(current);
  if (current === "" || !Number.isFinite(old)) return null;
  let next = c.percent !== undefined ? old * (1 + c.percent / 100) : old + (c.amount ?? 0);
  next = Math.round(next * 100) / 100;
  const ending = (c.ending ?? "").replace(/\D/g, "");
  if (ending !== "") {
    // The nearest price with that ending (12.40 with "99" → 11.99 or 12.99, whichever is closer).
    const cents = Number(ending.padEnd(2, "0").slice(0, 2)) / 100;
    const below = Math.floor(next) + cents - (Math.floor(next) + cents > next ? 1 : 0);
    const above = below + 1;
    next = next - below <= above - next && below > 0 ? below : above;
  }
  return next > 0 ? money(next) : null;
}

/**
 * The cells a computed change gives one exported row (a product's first row,
 * or one of its variants), from that row's current values. Empty when the
 * row needs no change.
 */
export function computedCells(row: Record<string, string>, changes: ChangeSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of changes) {
    if (c.action === "adjust_price" && row["Variant ID"]) {
      const old = row["Variant Price"] ?? "";
      const next = adjustedPrice(old, c);
      if (next === null) continue;
      if (Number(next) !== Number(old)) out["Variant Price"] = next;
      const compare = row["Variant Compare At Price"] ?? "";
      if (c.compareAt === "clear" && compare !== "") out["Variant Compare At Price"] = "";
      // The price before the sale, unless a higher "was" price is already shown.
      if (c.compareAt === "old_price" && Number(next) < Number(old) && !(Number(compare) > Number(old))) out["Variant Compare At Price"] = money(Number(old));
    }
    if (c.action === "end_sale" && row["Variant ID"]) {
      const compare = row["Variant Compare At Price"] ?? "";
      if (compare === "") continue;
      if (c.restorePrice && Number(compare) > Number(row["Variant Price"] ?? "")) out["Variant Price"] = money(Number(compare));
      out["Variant Compare At Price"] = "";
    }
    if (c.action === "replace_text" && c.column && c.find && row[c.column]) {
      const text = row[c.column];
      const pattern = new RegExp(c.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), c.matchCase ? "g" : "gi");
      const next = text.replace(pattern, () => c.value);
      if (next !== text) out[c.column] = next;
    }
    if (c.action === "set_column" && /^Variant /.test(c.column ?? "") && row["Variant ID"] && (row[c.column!] ?? "") !== c.value) out[c.column!] = c.value;
  }
  return out;
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
    if (c.action === "set_column" && !/^Variant /.test(c.column ?? "")) out[c.column!] = c.value;
    if (c.action === "set_metafield") out[`Metafield: ${c.metafield} [${c.metafieldType}]`] = c.value;
  }
  return out;
}
