import type { Gql, Row } from "../core/types";
import { ImportError } from "../core/types";
import { boolCell, cell, gidToId, parseBool, parseNumber, str, toGid } from "../core/util";

/**
 * Helpers shared by the Orders and Draft Orders entities: address columns,
 * money cells, line item columns and variant lookups.
 */

// --- Addresses ------------------------------------------------------------------------

/** Address sub-columns, used as `Billing: City`, `Shipping: Zip`... */
export const ADDRESS_FIELDS = [
  "First Name",
  "Last Name",
  "Company",
  "Phone",
  "Address 1",
  "Address 2",
  "City",
  "Province",
  "Province Code",
  "Zip",
  "Country",
  "Country Code",
] as const;

export function addressColumns(prefix: string): string[] {
  return ADDRESS_FIELDS.map((f) => `${prefix}: ${f}`);
}

/** GraphQL selection for a MailingAddress, used in bulk queries. */
export const ADDRESS_SELECTION =
  "firstName lastName company phone address1 address2 city province provinceCode zip country countryCodeV2";

export function addressToRow(row: Row, prefix: string, a: any) {
  const v: Record<(typeof ADDRESS_FIELDS)[number], string> = {
    "First Name": a?.firstName ?? "",
    "Last Name": a?.lastName ?? "",
    Company: a?.company ?? "",
    Phone: a?.phone ?? "",
    "Address 1": a?.address1 ?? "",
    "Address 2": a?.address2 ?? "",
    City: a?.city ?? "",
    Province: a?.province ?? "",
    "Province Code": a?.provinceCode ?? "",
    Zip: a?.zip ?? "",
    Country: a?.country ?? "",
    "Country Code": a?.countryCodeV2 ?? "",
  };
  for (const f of ADDRESS_FIELDS) row[`${prefix}: ${f}`] = v[f];
}

/**
 * MailingAddressInput from the prefixed columns, or undefined when no column
 * of the address has a value (blank addresses are left unchanged, the API has
 * no way to clear them).
 */
export function addressFromRow(row: Row, prefix: string): Record<string, string> | undefined {
  const get = (f: string) => cell(row, `${prefix}: ${f}`) ?? "";
  if (!ADDRESS_FIELDS.some((f) => get(f) !== "")) return undefined;
  const out: Record<string, string> = {};
  const map: Array<[string, string]> = [
    ["First Name", "firstName"],
    ["Last Name", "lastName"],
    ["Company", "company"],
    ["Phone", "phone"],
    ["Address 1", "address1"],
    ["Address 2", "address2"],
    ["City", "city"],
    ["Zip", "zip"],
  ];
  for (const [col, key] of map) if (get(col)) out[key] = get(col);
  // `country` and `province` (names) are deprecated on input: use the codes.
  const country = get("Country Code") || (/^[a-z]{2}$/i.test(get("Country")) ? get("Country") : "");
  if (country) out.countryCode = country.toUpperCase();
  else if (get("Country")) throw new ImportError(`${prefix}: Country Code is required (e.g. US, GB)`);
  const province = get("Province Code") || (/^[a-z0-9]{1,3}$/i.test(get("Province")) ? get("Province") : "");
  if (province) out.provinceCode = province.toUpperCase();
  return out;
}

// --- Money ----------------------------------------------------------------------------

/** Shop money amount of a MoneyBag. */
export function bagAmount(bag: { shopMoney?: { amount?: string } } | null | undefined): string {
  return bag?.shopMoney?.amount ?? "";
}

/** Parses a money cell; undefined when blank/absent. */
export function parseMoney(v: string | undefined, col: string): string | undefined {
  const n = parseNumber(v);
  if (n === undefined) return undefined;
  if (n < 0) throw new ImportError(`${col} cannot be negative`);
  return String(n);
}

export function moneyInput(amount: string, currencyCode: string) {
  return { amount, currencyCode };
}

export function moneyBagInput(amount: string, currencyCode: string) {
  return { shopMoney: { amount, currencyCode } };
}

const SHOP_CURRENCY = `#graphql
  query OrderCommonShopCurrency { shop { currencyCode } }
`;

export async function shopCurrency(gql: Gql, cache: Map<string, unknown>): Promise<string> {
  if (!cache.has("shopCurrency")) cache.set("shopCurrency", gql(SHOP_CURRENCY).then((d: any) => d.shop.currencyCode));
  return cache.get("shopCurrency") as Promise<string>;
}

/** Currency from the "Currency" column of the top row, else the shop's currency. */
export async function rowCurrency(gql: Gql, cache: Map<string, unknown>, top: Row): Promise<string> {
  const c = cell(top, "Currency");
  if (c) {
    if (!/^[A-Za-z]{3}$/.test(c)) throw new ImportError(`Currency must be a 3 letter code, got "${c}"`);
    return c.toUpperCase();
  }
  return shopCurrency(gql, cache);
}

// --- Line items -----------------------------------------------------------------------

export const LINE_COLUMNS = [
  "Line: ID",
  "Line: Title",
  "Line: Variant Title",
  "Line: Variant ID",
  "Line: SKU",
  "Line: Quantity",
  "Line: Price",
  "Line: Discount",
  "Line: Product ID",
  "Line: Vendor",
  "Line: Requires Shipping",
  "Line: Taxable",
];

/** Columns that, when non-blank, make a row describe a line item. */
export const LINE_SIGNAL_COLUMNS = ["Line: Title", "Line: Variant ID", "Line: SKU", "Line: Quantity", "Line: Price"];

export function isLineRow(row: Row): boolean {
  // Exports can list shipping lines as rows too; those are not line items.
  const type = (cell(row, "Line: Type") ?? "").toLowerCase();
  if (type && type !== "line item") return false;
  return LINE_SIGNAL_COLUMNS.some((c) => (cell(row, c) ?? "") !== "");
}

/** Common Line: cells of an order / draft order line item. */
export function lineToRow(row: Row, li: any) {
  Object.assign(row, {
    "Line: ID": gidToId(li.id),
    "Line: Title": li.title ?? "",
    "Line: Variant Title": li.variantTitle ?? "",
    "Line: Variant ID": gidToId(li.variant?.id),
    "Line: SKU": li.sku ?? "",
    "Line: Quantity": str(li.quantity),
    "Line: Price": bagAmount(li.originalUnitPriceSet),
    "Line: Discount": bagAmount(li.totalDiscountSet),
    "Line: Product ID": gidToId(li.product?.id),
    "Line: Vendor": li.vendor ?? "",
    "Line: Requires Shipping": boolCell(li.requiresShipping),
    "Line: Taxable": boolCell(li.taxable),
  });
}

export interface LineSpec {
  rowIndex: number;
  variantId?: string;
  sku?: string;
  title?: string;
  variantTitle?: string;
  quantity: number;
  price?: string;
  vendor?: string;
  requiresShipping?: boolean;
  taxable?: boolean;
}

export function parseLines(rows: Row[]): LineSpec[] {
  const out: LineSpec[] = [];
  rows.forEach((row, rowIndex) => {
    if (!isLineRow(row)) return;
    const q = parseNumber(cell(row, "Line: Quantity"));
    if (q !== undefined && (!Number.isInteger(q) || q < 1)) {
      throw new ImportError(`Line: Quantity on row ${rowIndex + 1} must be a whole number of at least 1`);
    }
    out.push({
      rowIndex,
      variantId: toGid("ProductVariant", cell(row, "Line: Variant ID")),
      sku: cell(row, "Line: SKU") || undefined,
      title: cell(row, "Line: Title") || undefined,
      variantTitle: cell(row, "Line: Variant Title") || undefined,
      quantity: q ?? 1,
      // Order exports carry the shop-currency price beside the order-currency one.
      price: parseMoney(cell(row, "Line: Price (Shop Currency)") || cell(row, "Line: Price"), "Line: Price"),
      vendor: cell(row, "Line: Vendor") || undefined,
      requiresShipping: parseBool(cell(row, "Line: Requires Shipping")),
      taxable: parseBool(cell(row, "Line: Taxable")),
    });
  });
  return out;
}

const VARIANT_BY_SKU = `#graphql
  query OrderCommonVariantBySku($query: String!) {
    productVariants(first: 5, query: $query) { nodes { id sku } }
  }
`;

/** Finds a variant by exact SKU (cached per job); null when not found. */
export async function variantIdBySku(gql: Gql, cache: Map<string, unknown>, sku: string): Promise<string | null> {
  const key = `variantBySku:${sku}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      gql(VARIANT_BY_SKU, { query: `sku:${JSON.stringify(sku)}` }).then(
        (d: any) => (d.productVariants.nodes as any[]).find((v) => v.sku === sku)?.id ?? null,
      ),
    );
  }
  return cache.get(key) as Promise<string | null>;
}

// --- Name lookups -----------------------------------------------------------------------

/**
 * Finds the single node whose `name` equals `name` (case-insensitive) by paging
 * through a `name:"..."` search. The search is a prefix match (`#D1` also
 * returns #D10, #D100...), so one short page can miss the exact match: pages
 * are read until a page contains an exact match or results are exhausted.
 * More than one exact match on that page is an error (ambiguous name).
 * `query` must take `$query: String!` and `$after: String` and return a
 * connection with `nodes { name ... }` and `pageInfo`.
 */
export async function findByExactName<T extends { name: string }>(
  gql: Gql,
  query: string,
  pick: (data: any) => { nodes: T[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } },
  name: string,
  what: string,
): Promise<T | null> {
  const want = name.toLowerCase();
  let after: string | null = null;
  do {
    const conn = pick(await gql(query, { query: `name:${JSON.stringify(name)}`, after }));
    const hits = (conn.nodes ?? []).filter((n) => (n.name ?? "").toLowerCase() === want);
    if (hits.length > 1) throw new ImportError(`Several ${what}s are named "${name}"; use the ID column`);
    if (hits.length) return hits[0];
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return null;
}

/** "partially_paid", "Partially Paid" -> "PARTIALLY_PAID". */
export function enumCell(v: string): string {
  return v.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/** "PARTIALLY_PAID" -> "partially_paid" (Matrixify style). */
export function enumToCell(v: string | null | undefined): string {
  return (v ?? "").toLowerCase();
}
