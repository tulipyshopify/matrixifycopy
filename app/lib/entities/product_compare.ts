import type { Row } from "../core/types";
import { ImportError } from "../core/types";
import { cell, cellToMetafieldValue, gidToId, joinTags, metafieldToCell, parseBool, parseMetafieldColumn, parseSubCommand, splitTags } from "../core/util";

/**
 * Compares the cells of an import row with what the store holds now, in the
 * same text form an export writes them. This is what lets a preview say
 * "44.99 → 45.99" and "no change", and lets the import leave untouched
 * fields alone: a column whose cell matches the store is simply not sent.
 */

export interface FieldChange {
  /** "Title", or "Variant Price (SKU PB001)". */
  label: string;
  old: string;
  next: string;
  /** The field would be emptied. */
  clears?: boolean;
}

export interface RowComparison {
  changes: FieldChange[];
  /** Current store value of every field the row touches, by label. */
  seen: Record<string, string>;
  /** Columns whose cell differs from the store: the only ones the import sends. */
  changed: Set<string>;
  /** For each changed column, the cell that puts the store's current value back (for undo). */
  old: Record<string, string>;
  errors: string[];
}

type Kind = "text" | "money" | "bool" | "caseless" | "number" | "id";

interface ColumnSpec {
  kind: Kind;
  /** What a blank cell means: "clears" empties the field, "leaves" doesn't touch it. */
  blank: "clears" | "leaves";
}

const short = (v: string, max = 70) => {
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** How values are shown in a change line. */
export function shown(v: string): string {
  return v === "" ? "(empty)" : short(v);
}

function moneyNumber(v: string): number | null {
  let t = v.trim().replace(/^[£$€¥]\s*|\s*[£$€¥]$/g, "").replace(/\s+/g, "");
  if (/^-?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+,\d{1,2}$/.test(t)) t = t.replace(",", ".");
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

/** Canonical form of a cell for comparing; null when it can't be read (the import reports that itself). */
function canon(kind: Kind, v: string): string | null {
  const t = v.trim();
  if (t === "") return "";
  switch (kind) {
    case "money": {
      const n = moneyNumber(t);
      return n === null ? null : String(n);
    }
    case "number": {
      const n = Number(t.replace(/,/g, ""));
      return Number.isNaN(n) ? null : String(n);
    }
    case "bool":
      try {
        return String(parseBool(t));
      } catch {
        return null;
      }
    case "caseless":
      return t.toLowerCase();
    case "id":
      return gidToId(t);
    default:
      return t;
  }
}

/**
 * Compares one cell. Returns null when the cell leaves the field alone (the
 * column is absent, or blank in a column where blank means "no change").
 */
function compareCell(
  row: Row,
  col: string,
  spec: ColumnSpec,
  current: string,
  label: string,
  out: RowComparison,
) {
  const raw = cell(row, col);
  if (raw === undefined) return;
  if (raw === "" && spec.blank === "leaves") return;
  const now = canon(spec.kind, current) ?? current;
  out.seen[label] = now;
  const want = canon(spec.kind, raw);
  // Unreadable value: keep the column so the import's own check reports it.
  if (want === null) return void out.changed.add(col);
  if (want === now) return;
  out.changed.add(col);
  out.old[col] = current;
  out.changes.push({ label, old: shown(now), next: want === "" ? "(cleared)" : shown(want), ...(want === "" && now !== "" ? { clears: true } : {}) });
}

// --- Product-level columns ------------------------------------------------------

export interface ProductNow {
  handle: string;
  title: string;
  descriptionHtml?: string | null;
  vendor?: string | null;
  productType?: string | null;
  status?: string;
  tags?: string[];
  templateSuffix?: string | null;
  publishedAt?: string | null;
  seo?: { title: string | null; description: string | null } | null;
  category?: { id: string } | null;
}

const PRODUCT_SPECS: Array<[string, ColumnSpec, (p: ProductNow) => string]> = [
  ["Title", { kind: "text", blank: "leaves" }, (p) => p.title ?? ""],
  ["Body HTML", { kind: "text", blank: "clears" }, (p) => p.descriptionHtml ?? ""],
  ["Vendor", { kind: "text", blank: "clears" }, (p) => p.vendor ?? ""],
  ["Type", { kind: "text", blank: "clears" }, (p) => p.productType ?? ""],
  ["Status", { kind: "caseless", blank: "leaves" }, (p) => p.status ?? ""],
  ["Template Suffix", { kind: "text", blank: "clears" }, (p) => p.templateSuffix ?? ""],
  ["Category: ID", { kind: "id", blank: "leaves" }, (p) => (p.category?.id ? gidToId(p.category.id) : "")],
  ["SEO Title", { kind: "text", blank: "clears" }, (p) => p.seo?.title ?? ""],
  ["SEO Description", { kind: "text", blank: "clears" }, (p) => p.seo?.description ?? ""],
  ["Published", { kind: "bool", blank: "leaves" }, (p) => String(!!p.publishedAt)],
];

export type MetafieldsNow = Map<string, { type: string; value: string }>;

/** Canonical metafield value: JSON values compare by content, not by spacing. */
function metafieldCanon(type: string, value: string): string {
  if (type.startsWith("list.") || type === "json" || type === "rich_text_field" || type === "money" || type === "dimension" || type === "weight" || type === "volume" || type === "rating") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value.trim();
    }
  }
  if (type === "number_decimal" || type === "number_integer") {
    const n = Number(value);
    return Number.isNaN(n) ? value.trim() : String(n);
  }
  return value.trim();
}

/** Compares "Metafield: ns.key [type]" columns of a row. `owner` words the label ("" for the product). */
export function compareMetafields(row: Row, prefix: string, now: MetafieldsNow | null, owner: string, out: RowComparison) {
  for (const header of Object.keys(row)) {
    const col = parseMetafieldColumn(header, prefix);
    if (!col) continue;
    const raw = (row[header] ?? "").trim();
    const key = `${col.namespace}.${col.key}`;
    const label = `Metafield ${key}${owner}`;
    // Current values unknown (not fetched): send the cell as before, shown as a set.
    if (!now) {
      out.changed.add(header);
      if (raw !== "") out.changes.push({ label, old: "?", next: shown(raw) });
      continue;
    }
    const cur = now.get(key);
    out.seen[label] = cur?.value ?? "";
    if (raw === "") {
      if (!cur) continue;
      out.changed.add(header);
      out.old[header] = metafieldToCell(cur.type, cur.value);
      out.changes.push({ label, old: shown(cur.value), next: "(cleared)", clears: true });
      continue;
    }
    let want: string;
    try {
      want = cellToMetafieldValue(cur?.type ?? col.type, raw);
    } catch {
      out.changed.add(header);
      continue;
    }
    const type = cur?.type ?? col.type;
    if (cur && metafieldCanon(type, cur.value) === metafieldCanon(type, want)) continue;
    out.changed.add(header);
    out.old[header] = cur ? metafieldToCell(cur.type, cur.value) : "";
    out.changes.push({ label, old: cur ? shown(cur.value) : "(empty)", next: shown(want) });
  }
}

const sameTags = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export function compareProduct(top: Row, p: ProductNow, metafields: MetafieldsNow | null): RowComparison {
  const out: RowComparison = { changes: [], seen: {}, changed: new Set(), old: {}, errors: [] };
  for (const [col, spec, get] of PRODUCT_SPECS) compareCell(top, col, spec, get(p), col, out);

  // A different Handle on a product found by its ID renames it.
  const handle = cell(top, "Handle");
  if (handle && cell(top, "ID") && handle.toLowerCase() !== (p.handle ?? "").toLowerCase()) {
    out.seen.Handle = p.handle;
    out.changed.add("Handle");
    out.old.Handle = p.handle;
    out.changes.push({ label: "Handle", old: p.handle, next: handle });
  }

  const tagsCell = cell(top, "Tags");
  if (tagsCell !== undefined) {
    let command: "REPLACE" | "MERGE" | "DELETE" = "REPLACE";
    try {
      command = parseSubCommand(cell(top, "Tags Command"), ["REPLACE", "MERGE", "DELETE"] as const, "REPLACE");
    } catch (e: any) {
      out.errors.push(e instanceof ImportError ? e.message : String(e));
    }
    const now = p.tags ?? [];
    const want = splitTags(tagsCell);
    const lower = new Set(now.map((t) => t.toLowerCase()));
    out.seen.Tags = joinTags([...now].sort());
    if (command === "REPLACE") {
      if (!sameTags(now.map((t) => t.toLowerCase()), [...new Set(want.map((t) => t.toLowerCase()))])) {
        out.changed.add("Tags");
        out.changed.add("Tags Command");
        const removed = now.filter((t) => !want.some((w) => w.toLowerCase() === t.toLowerCase()));
        const added = want.filter((w) => !lower.has(w.toLowerCase()));
        if (!want.length) out.changes.push({ label: "Tags", old: shown(joinTags(now)), next: `(cleared: all ${now.length} tags removed)`, clears: true });
        else {
          out.changes.push({
            label: "Tags",
            old: shown(joinTags(now)),
            next: `${shown(joinTags(want))}${removed.length ? ` (removes: ${short(joinTags(removed), 60)})` : ""}${added.length ? ` (adds: ${short(joinTags(added), 60)})` : ""}`,
          });
        }
      }
    } else if (command === "MERGE") {
      const added = want.filter((w) => !lower.has(w.toLowerCase()));
      if (added.length) {
        out.changed.add("Tags");
        out.changed.add("Tags Command");
        out.changes.push({ label: "Tags", old: shown(joinTags(now)), next: `adds ${shown(joinTags(added))}` });
      }
    } else {
      const removed = now.filter((t) => want.some((w) => w.toLowerCase() === t.toLowerCase()));
      if (removed.length) {
        out.changed.add("Tags");
        out.changed.add("Tags Command");
        out.changes.push({ label: "Tags", old: shown(joinTags(now)), next: `removes ${shown(joinTags(removed))}`, ...(removed.length === now.length ? { clears: true } : {}) });
      }
    }
  }

  if (out.changed.has("Tags")) {
    out.old.Tags = joinTags(p.tags ?? []);
    out.old["Tags Command"] = "REPLACE";
  }
  compareMetafields(top, "Metafield", metafields, "", out);
  // "Published At" only matters together with a change of Published.
  if (out.changed.has("Published")) out.changed.add("Published At");
  return out;
}

// --- Variant-level columns ------------------------------------------------------

export interface VariantNow {
  sku: string | null;
  barcode?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  taxable?: boolean;
  taxCode?: string | null;
  inventoryPolicy?: string;
  inventoryQuantity?: number | null;
  inventoryItem: {
    tracked: boolean;
    requiresShipping?: boolean;
    harmonizedSystemCode?: string | null;
    countryCodeOfOrigin?: string | null;
    provinceCodeOfOrigin?: string | null;
    unitCost?: { amount: string } | null;
    measurement?: { weight?: { value: number; unit: string } | null } | null;
  };
}

const WEIGHT_CELL: Record<string, string> = { GRAMS: "g", KILOGRAMS: "kg", OUNCES: "oz", POUNDS: "lb" };
const WEIGHT_ALIAS: Record<string, string> = { gram: "g", grams: "g", kilograms: "kg", ounces: "oz", lbs: "lb", pounds: "lb" };

const VARIANT_SPECS: Array<[string, ColumnSpec, (v: VariantNow) => string]> = [
  ["Variant SKU", { kind: "text", blank: "clears" }, (v) => v.sku ?? ""],
  ["Variant Barcode", { kind: "text", blank: "clears" }, (v) => v.barcode ?? ""],
  ["Variant Price", { kind: "money", blank: "leaves" }, (v) => v.price ?? ""],
  ["Variant Compare At Price", { kind: "money", blank: "clears" }, (v) => v.compareAtPrice ?? ""],
  ["Variant Taxable", { kind: "bool", blank: "leaves" }, (v) => String(!!v.taxable)],
  ["Variant Tax Code", { kind: "text", blank: "leaves" }, (v) => v.taxCode ?? ""],
  ["Variant Inventory Policy", { kind: "caseless", blank: "leaves" }, (v) => v.inventoryPolicy ?? ""],
  ["Variant Requires Shipping", { kind: "bool", blank: "leaves" }, (v) => String(!!v.inventoryItem.requiresShipping)],
  ["Variant Cost", { kind: "money", blank: "leaves" }, (v) => v.inventoryItem.unitCost?.amount ?? ""],
  ["Variant HS Code", { kind: "text", blank: "clears" }, (v) => v.inventoryItem.harmonizedSystemCode ?? ""],
  ["Variant Country of Origin", { kind: "caseless", blank: "clears" }, (v) => v.inventoryItem.countryCodeOfOrigin ?? ""],
  ["Variant Province of Origin", { kind: "text", blank: "clears" }, (v) => v.inventoryItem.provinceCodeOfOrigin ?? ""],
];

/** Compares the plain variant columns of a row. Stock, options, image and metafields are compared by the importer. */
export function compareVariant(row: Row, v: VariantNow, ident: string, metafields: MetafieldsNow | null): RowComparison {
  const out: RowComparison = { changes: [], seen: {}, changed: new Set(), old: {}, errors: [] };
  for (const [col, spec, get] of VARIANT_SPECS) compareCell(row, col, spec, get(v), `${col} (${ident})`, out);

  // Tracker: "shopify" (or TRUE) tracks stock; anything else, blank included, doesn't.
  const tracker = cell(row, "Variant Inventory Tracker");
  if (tracker !== undefined) {
    let want = false;
    try {
      want = tracker.toLowerCase() === "shopify" || parseBool(tracker) === true;
    } catch {
      want = false;
    }
    const label = `Variant Inventory Tracker (${ident})`;
    out.seen[label] = v.inventoryItem.tracked ? "shopify" : "";
    if (want !== v.inventoryItem.tracked) {
      out.changed.add("Variant Inventory Tracker");
      out.old["Variant Inventory Tracker"] = v.inventoryItem.tracked ? "shopify" : "";
      out.changes.push({ label: `Stock tracking (${ident})`, old: v.inventoryItem.tracked ? "on" : "off", next: want ? "on" : "off" });
    }
  }

  // Weight and its unit travel together.
  const weight = cell(row, "Variant Weight");
  if (weight) {
    const now = v.inventoryItem.measurement?.weight;
    const nowUnit = WEIGHT_CELL[now?.unit ?? ""] ?? "";
    const unitCell = (cell(row, "Variant Weight Unit") || "kg").toLowerCase();
    const unit = WEIGHT_ALIAS[unitCell] ?? unitCell;
    const label = `Variant Weight (${ident})`;
    out.seen[label] = now ? `${now.value} ${nowUnit}` : "";
    const n = Number(weight.replace(/,/g, ""));
    if (Number.isNaN(n) || !now || n !== Number(now.value) || unit !== nowUnit) {
      out.changed.add("Variant Weight");
      out.changed.add("Variant Weight Unit");
      if (now) {
        out.old["Variant Weight"] = String(now.value);
        out.old["Variant Weight Unit"] = nowUnit;
      }
      if (!Number.isNaN(n)) out.changes.push({ label, old: now ? `${now.value} ${nowUnit}` : "(empty)", next: `${n} ${unit}` });
    }
  }

  compareMetafields(row, "Variant Metafield", metafields, ` (${ident})`, out);
  return out;
}

/** Things that are allowed but look like mistakes, from a variant's resulting price fields. */
export function priceWarnings(ident: string, before: { price?: string | null; compareAtPrice?: string | null }, after: { price?: string | null; compareAtPrice?: string | null }): string[] {
  const out: string[] = [];
  const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));
  const oldPrice = num(before.price);
  const price = num(after.price);
  const compareAt = num(after.compareAtPrice);
  const priceChanged = price !== oldPrice;
  if (priceChanged && price === 0) out.push(`${ident}: the price would be 0`);
  if (priceChanged && price !== null && oldPrice && price > 0 && price < oldPrice * 0.5) {
    out.push(`${ident}: the price drops ${Math.round((1 - price / oldPrice) * 100)}% (${oldPrice} → ${price})`);
  }
  if (priceChanged && price !== null && oldPrice && price > oldPrice * 3) {
    out.push(`${ident}: the price rises ${(price / oldPrice).toFixed(1)}× (${oldPrice} → ${price})`);
  }
  if ((priceChanged || compareAt !== num(before.compareAtPrice)) && compareAt !== null && price !== null && compareAt <= price) {
    out.push(`${ident}: the compare-at price (${compareAt}) is not above the price (${price}), so no saving is shown`);
  }
  if (priceChanged && price !== null && !Number.isInteger(Math.round(price * 1000) / 10)) {
    out.push(`${ident}: the price ${price} has more than 2 decimal places; Shopify rounds it`);
  }
  return out;
}
