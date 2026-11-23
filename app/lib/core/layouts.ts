import type { Sheet } from "./sheets";
import type { Entity, Row } from "./types";

/**
 * A saved way of reading someone else's file (a supplier's price list, an
 * export of another system): which data type it is, and which of its columns
 * is which of ours. A file whose columns fit a saved layout is read that way
 * without asking again.
 */
export interface ColumnLayout {
  id: string;
  name: string;
  /** Data type key ("products"). */
  entity: string;
  /** The file's column name -> our column; "" = not imported. */
  map: Record<string, string>;
  savedAt: string;
  /** The row of the file that holds the column names, when it isn't the one the reader finds by itself (0 = none). */
  headerRow?: number;
  /** Rows whose product (customer…) isn't in the shop are skipped, not failed. Default: yes. */
  skipUnknown?: boolean;
  /** What stock written as "IN STOCK" counts as. Unset: such a cell leaves the stock as it is. */
  inStockQty?: number | null;
}

/** The column that sets the stock at one location. */
export const stockColumn = (location: string) => `Inventory Available: ${location}`;
const STOCK_TARGET = /^(Inventory Available: .+|Variant Inventory Qty)$/;

const norm = (h: string) => h.toLowerCase().replace(/[\s_]+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();

/** Everyday names for our columns, as other systems and suppliers write them. */
const SYNONYMS: Record<string, Record<string, string[]>> = {
  products: {
    // A supplier's name or description for a product is never suggested as ours: it would rename the shop's products.
    "Body HTML": ["body", "body html"],
    Vendor: ["brand", "manufacturer", "supplier", "make"],
    Type: ["category", "product type", "product category", "group", "department"],
    Tags: ["keywords", "labels"],
    "Variant SKU": ["sku", "item code", "product code", "code", "part number", "part no", "stock code", "item number", "item no", "article number", "ref", "reference", "model", "model no", "model number", "mpn", "supplier code", "supplier sku", "our code", "product ref", "product no"],
    "Variant Barcode": ["barcode", "ean", "ean13", "ean 13", "ean code", "upc", "gtin", "isbn", "bar code", "barcode ean", "ean barcode"],
    "Variant Price": ["price", "retail price", "rrp", "selling price", "sale price", "our price", "price inc vat", "unit price"],
    "Variant Compare At Price": ["compare at price", "was price", "list price", "msrp", "original price"],
    "Variant Cost": ["cost", "cost price", "trade price", "wholesale price", "buy price", "purchase price", "net price"],
    "Variant Inventory Qty": ["qty", "quantity", "stock", "stock level", "stock qty", "in stock", "available", "inventory", "on hand", "free stock"],
    "Variant Weight": ["weight", "weight kg", "gross weight"],
    "Image Src": ["image", "image url", "image link", "picture", "photo", "main image"],
    "Option1 Value": ["size", "colour", "color", "variant"],
    Handle: ["url handle", "slug", "url key"],
    Status: ["state", "active"],
    "SEO Title": ["meta title", "page title"],
    "SEO Description": ["meta description"],
    "Variant HS Code": ["hs code", "commodity code", "tariff code"],
    "Variant Country of Origin": ["country of origin", "origin", "made in"],
  },
  customers: {
    Email: ["email address", "e mail", "customer email"],
    "First Name": ["firstname", "forename", "given name"],
    "Last Name": ["lastname", "surname", "family name"],
    Phone: ["telephone", "mobile", "phone number", "tel"],
    Note: ["notes", "comment", "comments"],
    "Address Line 1": ["address", "address 1", "address1", "street"],
    "Address Line 2": ["address 2", "address2"],
    "Address City": ["city", "town"],
    "Address Zip": ["postcode", "post code", "zip", "zip code", "postal code"],
    "Address Country Code": ["country", "country code"],
    "Address Province Code": ["county", "state", "province", "region"],
    "Address Company": ["company", "company name", "business"],
  },
  redirects: { Path: ["from", "old url", "source", "redirect from", "old path"], Target: ["to", "new url", "destination", "redirect to", "new path"] },
};

export interface SuggestHints {
  /** The shop's locations, for stock columns. */
  locations?: string[];
  /** The file's (or supplier's) name: a location named in it is the likely one. */
  fileName?: string;
}

/** A supplier's wording for a column, where the exact words vary ("2026 HD Trade Price", "Qty in Stock"). */
const LOOSE: Array<[RegExp, string]> = [
  [/\b(trade|cost|wholesale|net|buy|buying|purchase|dealer)\b.*\bprice\b|\bprice\b.*\b(trade|cost|wholesale|net)\b|^(unit )?cost\b/, "Variant Cost"],
  [/\b(barcode|ean|gtin|upc)\b/, "Variant Barcode"],
  [/\b(sku|product code|item code|stock code|part (no|number)|item (no|number))\b/, "Variant SKU"],
  [/\b(qty|quantity|stock|available|availability)\b/, "#stock"],
  [/\b(rrp|srp|msrp|retail price|selling price)\b/, "Variant Price"],
];

const NOT_STOCK = /\b(pack|carton|case|box|min|minimum|order|moq|outer|inner|per|pallet|code|status date|due)\b/;

/** Our column a file's column most likely means; null when there is no good guess. */
export function suggestColumn(entity: Pick<Entity, "key" | "columns">, header: string, hints: SuggestHints = {}): string | null {
  const h = norm(header);
  if (!h) return null;
  const exact = entity.columns.find((c) => norm(c) === h);
  if (exact) return exact;
  const stock = (): string | null => {
    const locations = hints.locations ?? [];
    if (!locations.length) return entity.columns.includes("Variant Inventory Qty") ? "Variant Inventory Qty" : null;
    if (locations.length === 1) return stockColumn(locations[0]);
    // Several places hold stock: the one named in the column or in the file's name, else it is asked.
    const squash = (v: string) => norm(v.replace(/[-_.]+/g, " ")).replace(/ /g, "");
    const named = locations.find((l) => squash(h).includes(squash(l))) ?? locations.find((l) => squash(hints.fileName ?? "").includes(squash(l)));
    return named ? stockColumn(named) : null;
  };
  for (const [target, names] of Object.entries(SYNONYMS[entity.key] ?? {})) {
    if (!names.includes(h) || !entity.columns.includes(target)) continue;
    return target === "Variant Inventory Qty" ? stock() : target;
  }
  // "Variant Price" written as "price", "Address City" as "city".
  const tail = entity.columns.filter((c) => norm(c.replace(/^(Variant|Address|Image) /, "")) === h);
  if (tail.length === 1) return tail[0];
  if (entity.key === "products") {
    for (const [re, target] of LOOSE) {
      if (!re.test(h)) continue;
      // "Pack Qty", "Minimum order quantity": a number, but not how many there are.
      if (target === "#stock") return NOT_STOCK.test(h) ? null : stock();
      return entity.columns.includes(target) ? target : null;
    }
  }
  return null;
}

/** Whether a column's name reads like stock, for asking which location it is for. */
export function looksLikeStock(header: string): boolean {
  const h = norm(header);
  return SYNONYMS.products["Variant Inventory Qty"].includes(h) || (/\b(qty|quantity|stock|available|availability)\b/.test(h) && !NOT_STOCK.test(h));
}

/** Suggestions for every column of a sheet: each of our columns is given once, to the first column that fits. */
export function suggestAll(entity: Pick<Entity, "key" | "columns">, headers: string[], hints: SuggestHints = {}): Record<string, string> {
  const map: Record<string, string> = {};
  const taken = new Set<string>();
  // Exact names first, so a loose guess never takes a column's place.
  for (const pass of [0, 1]) {
    for (const h of headers) {
      if (map[h]) continue;
      const exact = entity.columns.find((c) => norm(c) === norm(h));
      const to = pass === 0 ? (exact ?? "") : (suggestColumn(entity, h, hints) ?? "");
      map[h] = to && !taken.has(to) ? to : "";
      if (map[h]) taken.add(map[h]);
    }
  }
  return map;
}

/** Stock written in words: what number it means (null: leave the stock as it is). */
export function stockFromText(value: string, inStockQty: number | null | undefined): { qty: string; read: "number" | "out" | "in" | "unknown" } {
  const v = value.trim();
  if (v === "") return { qty: "", read: "number" };
  const plain = v.replace(/,/g, "").replace(/\s*(\+|pcs?|units?|in stock)$/i, "").trim();
  if (/^-?\d+(\.\d+)?$/.test(plain)) return { qty: String(Math.round(Number(plain))), read: "number" };
  if (/^(>|over|more than)\s*\d+$/i.test(plain)) return { qty: plain.replace(/\D/g, ""), read: "number" };
  if (/^(out of stock|out|sold out|no|none|nil|no stock|unavailable|not available|discontinued|oos|n|0 in stock)$/i.test(v)) return { qty: "0", read: "out" };
  if (/^(in stock|in|yes|y|available|stock|good stock|plenty|low stock|limited stock|limited)$/i.test(v)) return { qty: inStockQty === null || inStockQty === undefined ? "" : String(inStockQty), read: "in" };
  return { qty: "", read: "unknown" };
}

/** The saved layout a sheet's columns fit best, if any: most of the layout's columns must be in the sheet. */
export function matchLayout(headers: string[], layouts: ColumnLayout[]): ColumnLayout | null {
  const have = new Set(headers.map(norm));
  let best: { layout: ColumnLayout; score: number } | null = null;
  for (const layout of layouts) {
    const mapped = Object.entries(layout.map).filter(([, to]) => to);
    if (!mapped.length) continue;
    const all = Object.keys(layout.map);
    const present = all.filter((h) => have.has(norm(h))).length;
    const mappedPresent = mapped.filter(([h]) => have.has(norm(h))).length;
    // Its matched columns are (nearly) all here, and the file doesn't hold many columns the layout never saw.
    if (mappedPresent / mapped.length < 0.8 || present / Math.max(1, headers.length) < 0.6) continue;
    const score = mappedPresent * 2 + present;
    if (!best || score > best.score) best = { layout, score };
  }
  return best?.layout ?? null;
}

/**
 * Reads a sheet the way a layout says: its columns get our names and the
 * sheet its data type. Columns the layout sets aside stay in the sheet (and
 * so in the results file) but are not imported. Returns a line for the notes.
 */
export function applyLayout(sheet: Sheet, layout: ColumnLayout, keyColumns: string[] = []): string {
  const byNorm = new Map(Object.entries(layout.map).map(([from, to]) => [norm(from), to]));
  const taken = new Set<string>();
  const rename = new Map<string, string>();
  const ignored: string[] = [];
  // Columns that already carry one of our names keep it.
  for (const h of sheet.headers) if (byNorm.get(norm(h)) === h) taken.add(h);
  for (const h of sheet.headers) {
    const to = byNorm.get(norm(h));
    if (to === undefined || to === h) continue;
    if (to === "" || taken.has(to) || sheet.headers.includes(to)) {
      ignored.push(h);
      continue;
    }
    taken.add(to);
    rename.set(h, to);
  }
  if (rename.size) {
    const headers = sheet.headers;
    sheet.rows = sheet.rows.map((r) => {
      const out: Row = {};
      for (const h of headers) out[rename.get(h) ?? h] = r[h] ?? "";
      return out;
    });
    sheet.headers = headers.map((h) => rename.get(h) ?? h);
  }
  sheet.entity = layout.entity;
  sheet.ignoredColumns = ignored;
  sheet.skipMissing = layout.skipUnknown !== false;
  const extra: string[] = [];
  // Rows that name no item (blank lines, section headings such as "Wooden Sheds") are not rows of the table.
  const keys = keyColumns.filter((k) => sheet.headers.includes(k));
  if (keys.length) {
    const keep: number[] = [];
    sheet.rows.forEach((r, i) => {
      // A lone value on a row is a heading, wherever it sits.
      if (keys.some((k) => (r[k] ?? "").trim() !== "") && Object.values(r).filter((v) => (v ?? "").trim() !== "").length > 1) keep.push(i);
    });
    const dropped = sheet.rows.length - keep.length;
    if (dropped) {
      const numbers = sheet.rowNumbers ?? sheet.rows.map((_, i) => i + 2);
      sheet.rowNumbers = keep.map((i) => numbers[i]);
      sheet.rows = keep.map((i) => sheet.rows[i]);
      extra.push(`${dropped.toLocaleString("en-GB")} ${dropped === 1 ? "row has" : "rows have"} no ${keys.join(" or ")} (blank lines or headings): left out.`);
    }
  }
  // Stock written in words.
  const stockColumns = sheet.headers.filter((h) => STOCK_TARGET.test(h));
  const seen = { out: 0, in: 0, unknown: 0, example: "" };
  for (const col of stockColumns) {
    for (const r of sheet.rows) {
      const v = r[col] ?? "";
      if (v === "") continue;
      const s = stockFromText(v, layout.inStockQty);
      if (s.read === "number") {
        if (s.qty !== v) r[col] = s.qty;
        continue;
      }
      seen[s.read]++;
      if (s.read === "unknown" && !seen.example) seen.example = v;
      r[col] = s.qty;
    }
  }
  if (seen.out) extra.push(`Stock written as "out of stock" (${seen.out.toLocaleString("en-GB")} ${seen.out === 1 ? "row" : "rows"}) is read as 0.`);
  if (seen.in) extra.push(layout.inStockQty === null || layout.inStockQty === undefined ? `Stock written as "in stock" (${seen.in.toLocaleString("en-GB")} ${seen.in === 1 ? "row" : "rows"}) says no number: those rows' stock is left as it is. Set what "in stock" counts as in the column matching to change that.` : `Stock written as "in stock" (${seen.in.toLocaleString("en-GB")} ${seen.in === 1 ? "row" : "rows"}) is read as ${layout.inStockQty}.`);
  if (seen.unknown) extra.push(`${seen.unknown.toLocaleString("en-GB")} stock ${seen.unknown === 1 ? "cell holds" : "cells hold"} text that is not a number (such as "${seen.example.slice(0, 30)}"): the stock of those rows is left as it is.`);
  const shown = [...rename.entries()].slice(0, 8).map(([from, to]) => `"${from}" → ${to}`);
  return `Read with your saved column matching "${layout.name}"${shown.length ? `: ${shown.join(", ")}${rename.size > 8 ? `, and ${rename.size - 8} more` : ""}` : ""}.${ignored.length ? ` Not imported: ${ignored.slice(0, 8).map((h) => `"${h}"`).join(", ")}${ignored.length > 8 ? "…" : ""}.` : ""}${extra.length ? ` ${extra.join(" ")}` : ""}`;
}

/**
 * Matches that are probably a slip: a column of what the shop pays, read as
 * what the shop charges (or the other way round). Each is a sentence to show.
 */
export function oddMatches(map: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [from, to] of Object.entries(map)) {
    const h = from.toLowerCase();
    const pays = /\b(cost|trade|wholesale|buy|buying|purchase|net|landed|supplier price)\b/.test(h) && !/\b(rrp|retail|selling|sell)\b/.test(h);
    const charges = /\b(rrp|retail|selling|sell|srp|msrp)\b/.test(h);
    if (pays && (to === "Variant Price" || to === "Variant Compare At Price")) out.push(`"${from}" looks like what you pay the supplier, and is matched to ${to} (what shoppers pay). Prices in the shop would become cost prices`);
    if (charges && to === "Variant Cost") out.push(`"${from}" looks like a selling price, and is matched to Variant Cost`);
  }
  return out;
}
