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
}

const norm = (h: string) => h.toLowerCase().replace(/[\s_]+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();

/** Everyday names for our columns, as other systems and suppliers write them. */
const SYNONYMS: Record<string, Record<string, string[]>> = {
  products: {
    Title: ["name", "product name", "product title", "product", "item name", "item", "description short"],
    "Body HTML": ["description", "long description", "product description", "body", "details", "body html"],
    Vendor: ["brand", "manufacturer", "supplier", "make"],
    Type: ["category", "product type", "product category", "group", "department"],
    Tags: ["keywords", "labels"],
    "Variant SKU": ["sku", "item code", "product code", "code", "part number", "part no", "stock code", "item number", "article number", "ref", "reference"],
    "Variant Barcode": ["barcode", "ean", "ean13", "upc", "gtin", "isbn"],
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

/** Our column a file's column most likely means; null when there is no good guess. */
export function suggestColumn(entity: Entity, header: string): string | null {
  const h = norm(header);
  if (!h) return null;
  const exact = entity.columns.find((c) => norm(c) === h);
  if (exact) return exact;
  for (const [target, names] of Object.entries(SYNONYMS[entity.key] ?? {})) if (names.includes(h) && entity.columns.includes(target)) return target;
  // "Variant Price" written as "price", "Address City" as "city".
  const tail = entity.columns.filter((c) => norm(c.replace(/^(Variant|Address|Image) /, "")) === h);
  if (tail.length === 1) return tail[0];
  return null;
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
export function applyLayout(sheet: Sheet, layout: ColumnLayout): string {
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
  const shown = [...rename.entries()].slice(0, 8).map(([from, to]) => `"${from}" → ${to}`);
  return `Read with your saved column matching "${layout.name}"${shown.length ? `: ${shown.join(", ")}${rename.size > 8 ? `, and ${rename.size - 8} more` : ""}` : ""}.${ignored.length ? ` Not imported: ${ignored.slice(0, 8).map((h) => `"${h}"`).join(", ")}${ignored.length > 8 ? "…" : ""}.` : ""}`;
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
