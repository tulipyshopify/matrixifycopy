import { createHash } from "node:crypto";
import type {
  Command,
  Entity,
  ExportContext,
  Gql,
  ImportContext,
  ItemResult,
  Row,
} from "../core/types";
import { ImportError, ImportErrors } from "../core/types";
import type { ItemMeta } from "../core/types";
import { CHECK_GROUPS, RULES, toProductRows } from "../check/rules";
import type { FieldChange, MetafieldsNow } from "./product_compare";
import { compareProduct, compareVariant, priceWarnings } from "./product_compare";
import {
  assertNoUserErrors,
  boolCell,
  buildSearchQuery,
  cell,
  gidToId,
  gqlString,
  has,
  joinTags,
  metafieldsFromRow,
  metafieldsToRow,
  parseBool,
  parseMetafieldColumn,
  parseInt10,
  parseNumber,
  parseSubCommand,
  splitTags,
  str,
  toGid,
} from "../core/util";
import {
  addTags,
  getLocations,
  locationByName,
  onlineStorePublicationId,
  removeTags,
  setOnlineStorePublished,
  writeMetafields,
} from "../core/lookups";

// --- Columns --------------------------------------------------------------------

const PRODUCT_COLUMNS = [
  "ID",
  "Handle",
  "Command",
  "Title",
  "Body HTML",
  "Vendor",
  "Type",
  "Tags",
  "Tags Command",
  "Created At",
  "Updated At",
  "Status",
  "Published",
  "Published At",
  "Template Suffix",
  "Gift Card",
  "URL",
  "Total Inventory Qty",
  "Category: ID",
  "Category: Name",
  "SEO Title",
  "SEO Description",
  "Row #",
  "Top Row",
];

const OPTION_COLUMNS = [
  "Option1 Name",
  "Option1 Value",
  "Option2 Name",
  "Option2 Value",
  "Option3 Name",
  "Option3 Value",
];

const IMAGE_COLUMNS = [
  "Image Type",
  "Image Src",
  "Image Command",
  "Image Position",
  "Image Width",
  "Image Height",
  "Image Alt Text",
];

const VARIANT_COLUMNS = [
  "Variant Inventory Item ID",
  "Variant ID",
  "Variant Command",
  ...OPTION_COLUMNS,
  "Variant Position",
  "Variant SKU",
  "Variant Barcode",
  "Variant Image",
  "Variant Weight",
  "Variant Weight Unit",
  "Variant Price",
  "Variant Compare At Price",
  "Variant Taxable",
  "Variant Tax Code",
  "Variant Inventory Tracker",
  "Variant Inventory Policy",
  "Variant Requires Shipping",
  "Variant Inventory Qty",
  "Variant Inventory Adjust",
  "Variant Cost",
  "Variant HS Code",
  "Variant Country of Origin",
  "Variant Province of Origin",
];

/** Columns that, when non-blank, make a row describe a variant. */
const VARIANT_SIGNAL_COLUMNS = VARIANT_COLUMNS.filter(
  (c) =>
    ![
      "Variant Command",
      "Option1 Name",
      "Option2 Name",
      "Option3 Name",
    ].includes(c),
);

/**
 * Stock quantities per location: "Inventory <Label>: <Location>" columns, and
 * "Inventory <Label> Adjust: <Location>" to add to (or subtract from) one.
 * Committed, reserved and incoming are worked out by Shopify: export only.
 */
export const INVENTORY_KINDS: Array<{ name: string; label: string; writable: boolean }> = [
  { name: "available", label: "Available", writable: true },
  { name: "on_hand", label: "On Hand", writable: true },
  { name: "committed", label: "Committed", writable: false },
  { name: "reserved", label: "Reserved", writable: false },
  { name: "damaged", label: "Damaged", writable: true },
  { name: "safety_stock", label: "Safety Stock", writable: true },
  { name: "quality_control", label: "Quality Control", writable: true },
  { name: "incoming", label: "Incoming", writable: false },
];
const INVENTORY_PREFIX = "Inventory Available: ";
const inventoryPrefix = (label: string) => `Inventory ${label}: `;
/** "Inventory Damaged Adjust: Shop" → { kind: damaged, adjust: true, location: "Shop" }. */
function inventoryColumn(header: string): { name: string; label: string; writable: boolean; adjust: boolean; location: string } | null {
  const m = /^Inventory (.+?)( Adjust)?: (.+)$/.exec(header);
  const kind = m && INVENTORY_KINDS.find((k) => k.label.toLowerCase() === m[1].trim().toLowerCase());
  return kind && m ? { ...kind, adjust: !!m[2], location: m[3].trim() } : null;
}

const WEIGHT_UNITS: Record<string, string> = {
  g: "GRAMS",
  gram: "GRAMS",
  grams: "GRAMS",
  kg: "KILOGRAMS",
  kilograms: "KILOGRAMS",
  oz: "OUNCES",
  ounces: "OUNCES",
  lb: "POUNDS",
  lbs: "POUNDS",
  pounds: "POUNDS",
};
const WEIGHT_UNIT_CELL: Record<string, string> = {
  GRAMS: "g",
  KILOGRAMS: "kg",
  OUNCES: "oz",
  POUNDS: "lb",
};

const STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"];

function titleCase(s: string | null | undefined) {
  return s ? s[0] + s.slice(1).toLowerCase() : "";
}

// --- Export -------------------------------------------------------------------------

/**
 * Shopify allows at most 5 connections per bulk query. Products, product
 * metafields, media, variants and inventory levels already use 5, so with all
 * of those on, variant metafields are fetched by a separate query first.
 */
export function splitVariantMetafields(groups: Set<string>): boolean {
  return (
    groups.has("variant_metafields") &&
    groups.has("variants") &&
    groups.has("metafields") &&
    groups.has("images") &&
    groups.has("inventory")
  );
}

/** Variant metafields only, for the same products as the main query. */
export function variantMetafieldsBulkQuery(search: string): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  return `{
    products${args} { edges { node {
      id
      variants { edges { node {
        id
        metafields { edges { node { id namespace key type value } } }
      } } }
    } } }
  }`;
}

export function productsBulkQuery(search: string, groups: Set<string>, kinds: string[] = ["available"]): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  const metafields = `metafields { edges { node { id namespace key type value } } }`;
  const media = `media { edges { node { id mediaContentType alt ... on MediaImage { image { url width height } } preview { image { url width height } } } } }`;
  const inventoryLevels = `inventoryLevels { edges { node { id location { id name } quantities(names: ${JSON.stringify(kinds)}) { name quantity } } } }`;
  const variants = `variants { edges { node {
      id title sku barcode price compareAtPrice position taxable taxCode inventoryPolicy inventoryQuantity
      image { url }
      selectedOptions { name value }
      inventoryItem {
        id tracked requiresShipping harmonizedSystemCode countryCodeOfOrigin provinceCodeOfOrigin
        unitCost { amount }
        measurement { weight { value unit } }
        ${groups.has("inventory") ? inventoryLevels : ""}
      }
      ${groups.has("variant_metafields") && !splitVariantMetafields(groups) ? metafields : ""}
  } } }`;
  return `{
    products${args} { edges { node {
      id handle title descriptionHtml vendor productType tags status createdAt updatedAt publishedAt
      templateSuffix isGiftCard onlineStoreUrl totalInventory
      seo { title description }
      category { id fullName }
      options { name position values }
      ${groups.has("metafields") ? metafields : ""}
      ${groups.has("images") ? media : ""}
      ${groups.has("variants") ? variants : ""}
    } } }
  }`;
}

export function productToRows(p: any, groups: Set<string>): Row[] {
  const variants: any[] = (p.variants ?? []).sort(
    (a: any, b: any) => (a.position ?? 0) - (b.position ?? 0),
  );
  const media: any[] = p.media ?? [];
  const count = Math.max(1, variants.length, media.length);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const row: Row = {
      ID: gidToId(p.id),
      Handle: p.handle,
      "Row #": String(i + 1),
      "Top Row": boolCell(i === 0),
    };
    if (i === 0) {
      Object.assign(row, {
        Command: "MERGE",
        Title: p.title ?? "",
        "Body HTML": p.descriptionHtml ?? "",
        Vendor: p.vendor ?? "",
        Type: p.productType ?? "",
        Tags: joinTags(p.tags),
        "Tags Command": "REPLACE",
        "Created At": p.createdAt ?? "",
        "Updated At": p.updatedAt ?? "",
        Status: titleCase(p.status),
        Published: boolCell(!!p.publishedAt),
        "Published At": p.publishedAt ?? "",
        "Template Suffix": p.templateSuffix ?? "",
        "Gift Card": boolCell(p.isGiftCard),
        URL: p.onlineStoreUrl ?? "",
        "Total Inventory Qty": str(p.totalInventory),
        "Category: ID": p.category?.id ? gidToId(p.category.id) : "",
        "Category: Name": p.category?.fullName ?? "",
      });
      if (groups.has("seo")) {
        row["SEO Title"] = p.seo?.title ?? "";
        row["SEO Description"] = p.seo?.description ?? "";
      }
      if (groups.has("metafields")) metafieldsToRow(row, p.metafields);
    }
    const m = media[i];
    if (m) {
      const img = m.image ?? m.preview?.image;
      Object.assign(row, {
        "Image Type": titleCase(m.mediaContentType),
        "Image Src": img?.url ?? "",
        "Image Command": "MERGE",
        "Image Position": String(i + 1),
        "Image Width": str(img?.width),
        "Image Height": str(img?.height),
        "Image Alt Text": m.alt ?? "",
      });
    }
    const v = variants[i];
    if (v) {
      const inv = v.inventoryItem ?? {};
      Object.assign(row, {
        "Variant Inventory Item ID": gidToId(inv.id),
        "Variant ID": gidToId(v.id),
        "Variant Command": "MERGE",
        "Variant Position": str(v.position),
        "Variant SKU": v.sku ?? "",
        "Variant Barcode": v.barcode ?? "",
        "Variant Image": v.image?.url ?? "",
        "Variant Weight": str(inv.measurement?.weight?.value),
        "Variant Weight Unit":
          WEIGHT_UNIT_CELL[inv.measurement?.weight?.unit] ?? "",
        "Variant Price": v.price ?? "",
        "Variant Compare At Price": v.compareAtPrice ?? "",
        "Variant Taxable": boolCell(v.taxable),
        "Variant Tax Code": v.taxCode ?? "",
        "Variant Inventory Tracker": inv.tracked ? "shopify" : "",
        "Variant Inventory Policy": (v.inventoryPolicy ?? "").toLowerCase(),
        "Variant Requires Shipping": boolCell(inv.requiresShipping),
        "Variant Inventory Qty": str(v.inventoryQuantity),
        "Variant Cost": inv.unitCost?.amount ?? "",
        "Variant HS Code": inv.harmonizedSystemCode ?? "",
        "Variant Country of Origin": inv.countryCodeOfOrigin ?? "",
        "Variant Province of Origin": inv.provinceCodeOfOrigin ?? "",
      });
      // Options: names on every variant row so rows can be re-sorted safely.
      (v.selectedOptions ?? []).slice(0, 3).forEach((o: any, j: number) => {
        row[`Option${j + 1} Name`] = o.name;
        row[`Option${j + 1} Value`] = o.value;
      });
      for (const lvl of inv.inventoryLevels ?? v.inventoryLevels ?? []) {
        for (const q of lvl.quantities ?? []) {
          const kind = INVENTORY_KINDS.find((k) => k.name === q.name);
          if (kind) row[inventoryPrefix(kind.label) + lvl.location.name] = str(q.quantity ?? "");
        }
      }
      if (groups.has("variant_metafields"))
        metafieldsToRow(row, v.metafields, "Variant Metafield");
    }
    rows.push(row);
  }
  return rows;
}

async function exportProducts(
  ctx: ExportContext,
  emit: (rows: Row[]) => Promise<void>,
) {
  const groups = new Set(
    ctx.options.groups ??
      productsEntity.groups!.filter((g) => g.default).map((g) => g.key),
  );
  const search = buildSearchQuery(ctx.options);
  // Pre-pass: variant ID -> metafields (only variants that have any are kept).
  const variantMetafields = new Map<string, any[]>();
  if (splitVariantMetafields(groups)) {
    ctx.log("Fetching variant metafields");
    for await (const p of ctx.bulk(variantMetafieldsBulkQuery(search))) {
      for (const v of p.variants ?? []) if (v.metafields?.length) variantMetafields.set(v.id, v.metafields);
    }
  }
  let n = 0;
  const valid = new Set(INVENTORY_KINDS.map((k) => k.name));
  const kinds = (ctx.options.inventoryKinds ?? ["available"]).filter((k) => valid.has(k));
  // "Data check problem" filters: products the check's rules flag. The rules
  // read variants, images, SEO and metafields, so those are fetched even when
  // the file itself doesn't include them.
  const problems = (ctx.options.filters ?? []).filter((f) => f.field === "problem").map((f) => ({ rule: RULES.find((r) => r.key === f.value), not: f.op === "is_not" }));
  const fetchGroups = problems.length ? new Set([...groups, ...CHECK_GROUPS]) : groups;
  for await (const p of ctx.bulk(productsBulkQuery(search, fetchGroups, kinds.length ? kinds : ["available"]))) {
    if (variantMetafields.size) {
      for (const v of p.variants ?? []) v.metafields ??= variantMetafields.get(v.id);
    }
    if (problems.length) {
      const checked = toProductRows(productToRows(p, fetchGroups));
      if (!problems.every(({ rule, not }) => !rule || rule.test(checked) !== not)) continue;
      // Fetched only for the rules: not part of the file that was asked for.
      if (!groups.has("images")) delete p.media;
      if (!groups.has("variants")) delete p.variants;
      if (!groups.has("metafields")) delete p.metafields;
    }
    await emit(productToRows(p, groups));
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import: fetching existing products --------------------------------------

const PRODUCT_FIELDS = `#graphql
  fragment ImportProduct on Product {
    id handle title hasOnlyDefaultVariant
    descriptionHtml vendor productType status tags templateSuffix publishedAt
    seo { title description }
    category { id }
    options { id name position optionValues { id name } }
    media(first: 250) { nodes { id alt mediaContentType ... on MediaImage { image { url } } } }
  }
`;

const PRODUCT_BY_ID = `#graphql
  query ImportProductById($id: ID!) { product(id: $id) { ...ImportProduct } }
  ${PRODUCT_FIELDS}
`;

const PRODUCT_BY_HANDLE = `#graphql
  query ImportProductByHandle($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) { ...ImportProduct }
  }
  ${PRODUCT_FIELDS}
`;

const PRODUCT_VARIANTS = `#graphql
  query ImportProductVariants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 250, after: $after) {
        nodes {
          id sku position barcode price compareAtPrice taxable taxCode inventoryPolicy inventoryQuantity
          image { url }
          selectedOptions { name value }
          inventoryItem {
            id tracked requiresShipping harmonizedSystemCode countryCodeOfOrigin provinceCodeOfOrigin
            unitCost { amount }
            measurement { weight { value unit } }
            inventoryLevels(first: 100) { nodes { location { id } } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

interface ExistingVariant {
  id: string;
  sku: string | null;
  position: number;
  barcode?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  taxable?: boolean;
  taxCode?: string | null;
  inventoryPolicy?: string;
  inventoryQuantity?: number | null;
  image?: { url: string } | null;
  selectedOptions: Array<{ name: string; value: string }>;
  inventoryItem: {
    id: string;
    tracked: boolean;
    requiresShipping?: boolean;
    harmonizedSystemCode?: string | null;
    countryCodeOfOrigin?: string | null;
    provinceCodeOfOrigin?: string | null;
    unitCost?: { amount: string } | null;
    measurement?: { weight?: { value: number; unit: string } | null } | null;
    inventoryLevels: { nodes: Array<{ location: { id: string } }> };
  };
}

interface ExistingProduct {
  id: string;
  handle: string;
  title: string;
  hasOnlyDefaultVariant: boolean;
  descriptionHtml?: string | null;
  vendor?: string | null;
  productType?: string | null;
  status?: string;
  tags?: string[];
  templateSuffix?: string | null;
  publishedAt?: string | null;
  seo?: { title: string | null; description: string | null } | null;
  category?: { id: string } | null;
  options: Array<{
    id: string;
    name: string;
    position: number;
    optionValues: Array<{ id: string; name: string }>;
  }>;
  media: {
    nodes: Array<{
      id: string;
      alt: string;
      mediaContentType: string;
      image?: { url: string };
    }>;
  };
  variants: ExistingVariant[];
}

async function fetchProduct(
  gql: Gql,
  by: { id?: string; handle?: string },
): Promise<ExistingProduct | null> {
  let p: any = null;
  if (by.id) p = (await gql(PRODUCT_BY_ID, { id: by.id })).product;
  if (!p && by.handle)
    p = (await gql(PRODUCT_BY_HANDLE, { handle: by.handle }))
      .productByIdentifier;
  if (!p) return null;
  const variants: ExistingVariant[] = [];
  let after: string | null = null;
  do {
    const d: any = await gql(PRODUCT_VARIANTS, { id: p.id, after });
    variants.push(...d.product.variants.nodes);
    after = d.product.variants.pageInfo.hasNextPage
      ? d.product.variants.pageInfo.endCursor
      : null;
  } while (after);
  return { ...p, variants };
}

// --- Import: parsing rows -------------------------------------------------------

interface VariantSpec {
  rowIndex: number;
  id?: string;
  command: "MERGE" | "DELETE";
  optionValues: string[]; // by position (1..3)
  input: Record<string, any>; // common ProductVariantsBulkInput/ProductVariantSetInput fields
  imageSrc?: string;
  /** Per-location stock to set; `kind` is the quantity name (available, on_hand, damaged…). */
  inventory: Array<{ locationName: string; quantity: number; kind: string }>;
  totalQty?: number;
  adjust?: number;
  /** Per-location stock adjustments ("Inventory Available Adjust: <Location>"). */
  adjustments: Array<{ locationName: string; delta: number; kind: string }>;
  metafields: ReturnType<typeof metafieldsFromRow>;
}

interface ImageSpec {
  rowIndex: number;
  src: string;
  alt?: string;
  position?: number;
  command: "MERGE" | "DELETE" | "REPLACE";
}

function isVariantRow(row: Row): boolean {
  if (VARIANT_SIGNAL_COLUMNS.some((c) => (cell(row, c) ?? "") !== ""))
    return true;
  return Object.keys(row).some(
    (k) =>
      (inventoryColumn(k)?.writable || k.startsWith("Variant Metafield:")) &&
      (row[k] ?? "").trim() !== "",
  );
}

/**
 * Reads a price cell. Accepts a currency sign ("£79.99"), thousands commas
 * ("1,299.00") and a decimal comma ("89,99"). Refuses anything ambiguous or
 * mangled by a spreadsheet ("1.8E+2"), and negative amounts.
 */
export function parseMoney(v: string, col: string): number {
  let t = v.trim().replace(/^[£$€¥]\s*|\s*[£$€¥]$/g, "").replace(/\s+/g, "");
  if (/e[+-]?\d/i.test(t)) throw new ImportError(`${col} "${v}" is in scientific notation (a spreadsheet changed it). Format the column as a number and export again`);
  if (/^-?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+,\d{1,2}$/.test(t)) t = t.replace(",", ".");
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new ImportError(`${col}: expected a price but got "${v}"`);
  const n = Number(t);
  if (n < 0) throw new ImportError(`${col} cannot be negative (${v})`);
  return n;
}

function money(v: string | undefined, col: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === "") return null;
  return String(parseMoney(v, col));
}

export function variantInputFromRow(row: Row, errors?: string[]): Record<string, any> {
  const input: Record<string, any> = {};
  const inventoryItem: Record<string, any> = {};
  // With `errors`, every bad cell is reported, not just the first.
  const step = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (!errors || !(e instanceof ImportError)) throw e;
      errors.push(e.message);
    }
  };

  step(() => {
    const price = money(cell(row, "Variant Price"), "Variant Price");
    if (price) input.price = price; // blank price = unchanged
  });
  step(() => {
    const cap = money(cell(row, "Variant Compare At Price"), "Variant Compare At Price");
    if (cap !== undefined) input.compareAtPrice = cap;
  });

  const sku = cell(row, "Variant SKU");
  if (sku !== undefined) inventoryItem.sku = sku;
  const barcode = cell(row, "Variant Barcode");
  if (barcode !== undefined) input.barcodes = barcode ? [{ value: barcode }] : [];

  step(() => {
    const taxable = parseBool(cell(row, "Variant Taxable"));
    if (taxable !== undefined) input.taxable = taxable;
  });
  const taxCode = cell(row, "Variant Tax Code");
  if (taxCode) input.taxCode = taxCode;

  step(() => {
    const policy = cell(row, "Variant Inventory Policy");
    if (policy) {
      const p = policy.toUpperCase();
      if (p !== "DENY" && p !== "CONTINUE") throw new ImportError(`Variant Inventory Policy must be deny or continue, not "${policy}"`);
      input.inventoryPolicy = p;
    }
  });

  step(() => {
    const tracker = cell(row, "Variant Inventory Tracker");
    if (tracker !== undefined) inventoryItem.tracked = tracker.toLowerCase() === "shopify" || parseBool(tracker) === true;
  });

  step(() => {
    const ship = parseBool(cell(row, "Variant Requires Shipping"));
    if (ship !== undefined) inventoryItem.requiresShipping = ship;
  });

  step(() => {
    const cost = cell(row, "Variant Cost");
    if (cost) inventoryItem.cost = String(parseMoney(cost, "Variant Cost"));
  });

  const hs = cell(row, "Variant HS Code");
  if (hs !== undefined) inventoryItem.harmonizedSystemCode = hs || null;
  const coo = cell(row, "Variant Country of Origin");
  if (coo !== undefined) inventoryItem.countryCodeOfOrigin = coo ? coo.toUpperCase() : null;
  const poo = cell(row, "Variant Province of Origin");
  if (poo !== undefined) inventoryItem.provinceCodeOfOrigin = poo || null;

  step(() => {
    const weight = parseNumber(cell(row, "Variant Weight"));
    if (weight !== undefined) {
      if (weight < 0) throw new ImportError("Variant Weight cannot be negative");
      const unitCell = (cell(row, "Variant Weight Unit") || "kg").toLowerCase();
      const unit = WEIGHT_UNITS[unitCell];
      if (!unit) throw new ImportError(`Unknown Variant Weight Unit "${unitCell}" (use g, kg, oz or lb)`);
      inventoryItem.measurement = { weight: { value: weight, unit } };
    }
  });

  if (Object.keys(inventoryItem).length) input.inventoryItem = inventoryItem;
  return input;
}

/** Whole number of stock from a cell, with the column named in the error. */
function stockNumber(v: string | undefined, col: string): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const t = v.trim().replace(/,(?=\d{3}\b)/g, "");
  if (!/^[+-]?\d+$/.test(t)) throw new ImportError(`${col} must be a whole number, but is "${v}"`);
  return Number(t);
}

/**
 * Reads the variant rows of an item. With `errors`, a bad row is reported
 * (as "Row 12: …", using sheet row numbers from `rowNo`) and reading goes on,
 * so every problem comes out in one pass.
 */
function parseVariants(
  rows: Row[],
  errors?: string[],
  rowNo: (i: number) => number = (i) => i + 1,
): {
  names: string[];
  variants: VariantSpec[];
} {
  const names: string[] = [];
  for (let n = 1; n <= 3; n++) {
    const r = rows.find((row) => cell(row, `Option${n} Name`));
    if (r) names[n - 1] = cell(r, `Option${n} Name`)!;
  }
  const variants: VariantSpec[] = [];
  rows.forEach((row, rowIndex) => {
    if (!isVariantRow(row)) return;
    const rowErrors: string[] = [];
    const guard = <T,>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (e) {
        if (!errors || !(e instanceof ImportError)) throw e;
        rowErrors.push(e.message);
        return fallback;
      }
    };
    const optionValues: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const v = cell(row, `Option${n} Value`);
      if (v) optionValues[n - 1] = v;
    }
    const inventory: VariantSpec["inventory"] = [];
    const adjustments: VariantSpec["adjustments"] = [];
    for (const k of Object.keys(row)) {
      const col = inventoryColumn(k);
      // Committed, reserved and incoming come from orders and transfers: not importable.
      if (!col?.writable) continue;
      const n = guard(() => stockNumber(row[k], k), undefined);
      if (n === undefined) continue;
      if (col.adjust) {
        if (n) adjustments.push({ locationName: col.location, delta: n, kind: col.name });
      } else if (n < 0 && col.name !== "available") rowErrors.push(`${k} cannot be negative`);
      else inventory.push({ locationName: col.location, quantity: n, kind: col.name });
    }
    variants.push({
      rowIndex,
      adjustments,
      id: guard(() => toGid("ProductVariant", cell(row, "Variant ID")), undefined),
      command:
        guard(() => parseSubCommand(cell(row, "Variant Command"), ["MERGE", "DELETE", "UPDATE"] as const, "MERGE"), "MERGE" as const) === "DELETE"
          ? "DELETE"
          : "MERGE",
      optionValues,
      input: variantInputFromRow(row, errors ? rowErrors : undefined),
      imageSrc: cell(row, "Variant Image") || undefined,
      inventory,
      totalQty: guard(() => stockNumber(cell(row, "Variant Inventory Qty"), "Variant Inventory Qty"), undefined),
      adjust: guard(() => stockNumber(cell(row, "Variant Inventory Adjust"), "Variant Inventory Adjust"), undefined),
      metafields: metafieldsFromRow(row, "Variant Metafield", errors ? rowErrors : undefined),
    });
    for (const e of rowErrors) errors?.push(`Row ${rowNo(rowIndex)}: ${e}`);
  });
  return { names, variants };
}

function parseImages(rows: Row[]): ImageSpec[] {
  const images: ImageSpec[] = [];
  rows.forEach((row, rowIndex) => {
    const src = cell(row, "Image Src");
    if (!src) return;
    images.push({
      rowIndex,
      src,
      alt: cell(row, "Image Alt Text"),
      position: parseInt10(cell(row, "Image Position")),
      command: parseSubCommand(
        cell(row, "Image Command"),
        ["MERGE", "DELETE", "REPLACE"] as const,
        "MERGE",
      ),
    });
  });
  images.sort(
    (a, b) =>
      (a.position ?? 1e9) - (b.position ?? 1e9) || a.rowIndex - b.rowIndex,
  );
  return images;
}

/** True for files already hosted by Shopify, which Shopify re-uses instead of copying. */
export function isShopifyHosted(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "cdn.shopify.com" || u.pathname.includes("/cdn/shop/");
  } catch {
    return false;
  }
}

/**
 * Alt text to send with an image. A Shopify-hosted URL attaches the existing
 * file, which other products may share, so its alt text is left alone:
 * setting it here would change it on those products too.
 */
function altFor(ctx: ImportContext, src: string, alt: string | undefined): string | undefined {
  if (!alt || !isShopifyHosted(src)) return alt;
  if (!ctx.cache.has("warnedSharedAlt")) {
    ctx.cache.set("warnedSharedAlt", true);
    ctx.log(
      "Image Alt Text was not applied to images already hosted on Shopify: those files can be shared with other products, and changing the text would change it there too.",
    );
  }
  return undefined;
}

/** Normalised file name used to decide whether an image is already on the product. */
export function imageKey(url: string): string {
  let name = url;
  try {
    name = new URL(url).pathname;
  } catch {
    // not a URL, use as is
  }
  name = decodeURIComponent(name.split("/").pop() ?? name).toLowerCase();
  const dot = name.lastIndexOf(".");
  let base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  // Shopify appends a UUID on duplicates and size suffixes on resized URLs.
  base = base.replace(
    /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "",
  );
  base = base.replace(/_\d+x\d*$|_x\d+$/, "");
  return base + ext.replace(/\.jpeg$/, ".jpg");
}

function productFields(row: Row): Record<string, any> {
  const f: Record<string, any> = {};
  const title = cell(row, "Title");
  if (title) f.title = title;
  const body = cell(row, "Body HTML");
  if (body !== undefined) f.descriptionHtml = body;
  const vendor = cell(row, "Vendor");
  if (vendor !== undefined) f.vendor = vendor;
  const type = cell(row, "Type");
  if (type !== undefined) f.productType = type;
  const handle = cell(row, "Handle");
  if (handle) f.handle = handle;
  const status = cell(row, "Status");
  if (status) {
    const s = status.toUpperCase();
    if (!STATUSES.includes(s))
      throw new ImportError(
        `Status must be one of Active, Draft, Archived, Unlisted`,
      );
    f.status = s;
  }
  const tpl = cell(row, "Template Suffix");
  if (tpl !== undefined) f.templateSuffix = tpl || null;
  const cat = cell(row, "Category: ID");
  if (cat)
    f.category = cat.startsWith("gid://")
      ? cat
      : `gid://shopify/TaxonomyCategory/${cat}`;
  const seoTitle = cell(row, "SEO Title");
  const seoDesc = cell(row, "SEO Description");
  if (seoTitle !== undefined || seoDesc !== undefined) {
    f.seo = {};
    if (seoTitle !== undefined) f.seo.title = seoTitle;
    if (seoDesc !== undefined) f.seo.description = seoDesc;
  }
  return f;
}

// --- Import: mutations ------------------------------------------------------------

const PRODUCT_SET = `#graphql
  mutation ImportProductSet($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product {
        id handle
        variants(first: 250) { nodes { id selectedOptions { name value } inventoryItem { id } } }
      }
      userErrors { field message code }
    }
  }
`;

const PRODUCT_UPDATE = `#graphql
  mutation ImportProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id handle }
      userErrors { field message }
    }
  }
`;

const PRODUCT_DELETE = `#graphql
  mutation ImportProductDelete($id: ID!) {
    productDelete(input: { id: $id }, synchronous: true) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

const MEDIA_CREATE = `#graphql
  mutation ImportProductMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id alt }
      mediaUserErrors { field message }
    }
  }
`;

const MEDIA_DELETE = `#graphql
  mutation ImportProductMediaDelete($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors { field message }
    }
  }
`;

const OPTIONS_CREATE = `#graphql
  mutation ImportProductOptions($productId: ID!, $options: [OptionCreateInput!]!) {
    productOptionsCreate(productId: $productId, options: $options, variantStrategy: LEAVE_AS_IS) {
      product { options { id name position optionValues { id name } } }
      userErrors { field message }
    }
  }
`;

const VARIANTS_CREATE = `#graphql
  mutation ImportVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $media: [CreateMediaInput!], $strategy: ProductVariantsBulkCreateStrategy) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, media: $media, strategy: $strategy) {
      productVariants { id selectedOptions { name value } inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

const VARIANTS_UPDATE = `#graphql
  mutation ImportVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $media: [CreateMediaInput!]) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, media: $media) {
      productVariants { id inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

const VARIANTS_DELETE = `#graphql
  mutation ImportVariantsDelete($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      userErrors { field message }
    }
  }
`;

const INVENTORY_SET = `#graphql
  mutation ImportInventorySet($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors { field message code }
    }
  }
`;

const INVENTORY_ADJUST = `#graphql
  mutation ImportInventoryAdjust($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      userErrors { field message code }
    }
  }
`;

const INVENTORY_ACTIVATE = `#graphql
  mutation ImportInventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
      userErrors { field message }
    }
  }
`;

interface InventoryWork {
  inventoryItemId: string;
  activeLocations: Set<string>;
  spec: VariantSpec;
}

/**
 * Location used by "Variant Inventory Qty" / "Variant Inventory Adjust" when no
 * per-location column is given. Only defined for single-location stores: the
 * exported quantity is a total across locations, so writing it into one
 * location of a multi-location store would corrupt stock levels.
 */
async function singleLocationId(ctx: ImportContext): Promise<string | null> {
  const active = (await getLocations(ctx.gql, ctx.cache)).filter(
    (l) => l.isActive,
  );
  if (active.length === 1) return active[0].id;
  if (!ctx.cache.has("warnedQty")) {
    ctx.cache.set("warnedQty", true);
    ctx.log(
      active.length
        ? `Variant Inventory Qty/Adjust ignored: this store has ${active.length} locations. Use "Inventory Available: <Location>" columns instead.`
        : "Variant Inventory Qty/Adjust ignored: no active locations.",
    );
  }
  return null;
}

const INVENTORY_CURRENT = `#graphql
  query ImportInventoryCurrent($id: ID!, $locationId: ID!, $names: [String!]!) {
    inventoryItem(id: $id) { inventoryLevel(locationId: $locationId) { quantities(names: $names) { name quantity } } }
  }
`;

/** Shopify wants to know what changed any quantity other than "available". */
const LEDGER_URI = "bulkport://import";

async function applyInventory(ctx: ImportContext, work: InventoryWork[]) {
  type Target = { inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: null };
  type Change = { inventoryItemId: string; locationId: string; delta: number; changeFromQuantity: null; ledgerDocumentUri?: string };
  // Available and on hand can be set outright; the others only moved by a difference.
  const sets = new Map<string, Target[]>();
  const changes = new Map<string, Change[]>();
  const add = <T,>(map: Map<string, T[]>, name: string, v: T) => map.set(name, [...(map.get(name) ?? []), v]);
  const change = (name: string, c: Omit<Change, "changeFromQuantity">) =>
    add(changes, name, { ...c, changeFromQuantity: null, ...(name === "available" ? {} : { ledgerDocumentUri: LEDGER_URI }) });
  for (const w of work) {
    const item = w.inventoryItemId;
    const locs: string[] = [];
    const absolute: Array<{ locationId: string; quantity: number; kind: string }> = [];
    for (const inv of w.spec.inventory) {
      const loc = await locationByName(ctx.gql, ctx.cache, inv.locationName);
      absolute.push({ locationId: loc.id, quantity: inv.quantity, kind: inv.kind });
      locs.push(loc.id);
    }
    if (!w.spec.inventory.some((i) => i.kind === "available") && w.spec.totalQty !== undefined) {
      const locationId = await singleLocationId(ctx);
      if (locationId) {
        absolute.push({ locationId, quantity: w.spec.totalQty, kind: "available" });
        locs.push(locationId);
      }
    }
    if (w.spec.adjust) {
      const locationId = absolute.find((t) => t.kind === "available")?.locationId ?? (await singleLocationId(ctx));
      if (locationId) {
        change("available", { inventoryItemId: item, locationId, delta: w.spec.adjust });
        locs.push(locationId);
      }
    }
    for (const a of w.spec.adjustments) {
      const loc = await locationByName(ctx.gql, ctx.cache, a.locationName);
      // On hand is the sum of the other quantities: adding to it means adding available stock.
      change(a.kind === "on_hand" ? "available" : a.kind, { inventoryItemId: item, locationId: loc.id, delta: a.delta });
      locs.push(loc.id);
    }
    for (const locationId of new Set(locs)) {
      if (w.activeLocations.has(locationId)) continue;
      const d = await ctx.gql(INVENTORY_ACTIVATE, {
        inventoryItemId: w.inventoryItemId,
        locationId,
      });
      const err = d.inventoryActivate.userErrors?.[0];
      if (err && !/already/i.test(err.message))
        throw new ImportError(`Inventory: ${err.message}`);
      w.activeLocations.add(locationId);
    }
    for (const t of absolute) {
      if (t.kind === "available" || t.kind === "on_hand") {
        add(sets, t.kind, { inventoryItemId: item, locationId: t.locationId, quantity: t.quantity, changeFromQuantity: null });
        continue;
      }
      // Damaged, safety stock, quality control: move by the difference from what is there now.
      const d = await ctx.gql(INVENTORY_CURRENT, { id: item, locationId: t.locationId, names: [t.kind] });
      const now = d.inventoryItem?.inventoryLevel?.quantities?.find((q: any) => q.name === t.kind)?.quantity ?? 0;
      if (t.quantity !== now) change(t.kind, { inventoryItemId: item, locationId: t.locationId, delta: t.quantity - now });
    }
  }
  for (const [name, quantities] of sets) {
    for (let i = 0; i < quantities.length; i += 250) {
      const d = await ctx.gql(INVENTORY_SET, {
        input: { name, reason: "correction", quantities: quantities.slice(i, i + 250) },
      });
      assertNoUserErrors(d.inventorySetQuantities, "Inventory");
    }
  }
  for (const [name, list] of changes) {
    for (let i = 0; i < list.length; i += 250) {
      const d = await ctx.gql(INVENTORY_ADJUST, {
        input: { name, reason: "correction", changes: list.slice(i, i + 250) },
      });
      assertNoUserErrors(d.inventoryAdjustQuantities, "Inventory adjust");
    }
  }
}

function setVariantInput(
  spec: VariantSpec,
  names: string[],
  images: Set<string>,
): Record<string, any> {
  const input: Record<string, any> = { ...spec.input };
  if (input.inventoryItem?.sku !== undefined)
    input.sku = input.inventoryItem.sku;
  input.optionValues = names.length
    ? names.map((name, i) => {
        const value = spec.optionValues[i];
        if (!value)
          throw new ImportError(
            `Variant on row ${spec.rowIndex + 1} is missing Option${i + 1} Value`,
          );
        return { optionName: name, name: value };
      })
    : [{ optionName: "Title", name: "Default Title" }];
  if (spec.imageSrc) {
    images.add(spec.imageSrc);
    input.file = { originalSource: spec.imageSrc, contentType: "IMAGE" };
  }
  return input;
}

/**
 * Builds and validates everything needed to create a product (including
 * location and publication lookups) without writing anything, and returns a
 * function that performs the create, plus what it would create in words.
 * REPLACE relies on this so a bad row can't delete the existing product.
 * `omitHandle` lets Shopify pick a free handle.
 */
async function prepareCreate(
  ctx: ImportContext,
  rows: Row[],
  top: Row,
  omitHandle = false,
  rowNo: (i: number) => number = (i) => i + 1,
): Promise<{
  create: () => Promise<{ id: string; rowPatches: Array<Row | undefined> }>;
  changes: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (i: number, message: string) => errors.push(`Row ${rowNo(i)}: ${message}`);
  let fields: Record<string, any> = {};
  try {
    fields = productFields(top);
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
    fail(0, e.message);
  }
  if (omitHandle) delete fields.handle;
  if (!fields.title) fail(0, "Title is required to create a product");
  else if (fields.title.length > 255) fail(0, `Title is ${fields.title.length} characters long; Shopify allows 255`);
  if (/<script\b/i.test(fields.descriptionHtml ?? "")) warnings.push(`Row ${rowNo(0)}: the description contains a <script> tag, which would run code on the product page`);
  // A new product starts as a draft unless the file says otherwise, so a
  // mistyped handle can't put a half-filled product on sale.
  const statusDefaulted = !fields.status;
  if (statusDefaulted) fields.status = "DRAFT";
  const { names, variants } = parseVariants(rows, errors, rowNo);
  const live = variants.filter((v) => v.command !== "DELETE");
  if (!live.length)
    live.push({
      rowIndex: 0,
      command: "MERGE",
      optionValues: [],
      input: {},
      inventory: [],
      adjustments: [],
      metafields: { set: [], blank: [] },
    });
  if (names.length === 0 && live.length > 1) fail(0, "Several variants given but no Option1 Name");
  for (const v of live) {
    if (names.length && names.some((_, i) => !v.optionValues[i])) fail(v.rowIndex, `the variant needs a value for every option (${names.join(", ")})`);
    if (!v.input.price) warnings.push(`Row ${rowNo(v.rowIndex)}: the variant has no price (it will be 0)`);
    else warnings.push(...priceWarnings(`Row ${rowNo(v.rowIndex)}`, {}, { price: v.input.price, compareAtPrice: v.input.compareAtPrice ?? null }));
    const sku = v.input.inventoryItem?.sku;
    if (sku && live.some((o) => o !== v && o.rowIndex < v.rowIndex && o.input.inventoryItem?.sku === sku)) fail(v.rowIndex, `SKU "${sku}" is on more than one variant in this file`);
  }
  for (const v of live.slice(0, 25)) {
    const sku = v.input.inventoryItem?.sku;
    if (!sku) continue;
    const owners = await skuOwners(ctx, sku);
    if (owners.length) warnings.push(`Row ${rowNo(v.rowIndex)}: SKU "${sku}" is already used by another product (${owners[0].handle})`);
  }
  metafieldsFromRow(top, "Metafield", errors);
  let giftCard: boolean | undefined;
  let published: boolean | undefined;
  try {
    giftCard = parseBool(cell(top, "Gift Card"));
    published = parseBool(cell(top, "Published"));
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
    fail(0, e.message);
  }
  if (errors.length) throw new ImportErrors(errors);

  const input: Record<string, any> = { ...fields };
  if (giftCard !== undefined) input.giftCard = giftCard;
  const tags = cell(top, "Tags");
  if (tags) input.tags = splitTags(tags);
  const mf = metafieldsFromRow(top, "Metafield").set;
  if (mf.length) input.metafields = mf;

  const variantImages = new Set<string>();
  const optionNames = names.length ? names : ["Title"];
  input.variants = live.map((v) => setVariantInput(v, names, variantImages));
  // Inventory for new products: set at create time.
  const locationQty = new Map<
    VariantSpec,
    Array<{ locationId: string; name: string; quantity: number }>
  >();
  for (const [i, v] of live.entries()) {
    const q: Array<{ locationId: string; name: string; quantity: number }> = [];
    for (const inv of v.inventory) {
      q.push({
        locationId: (await locationByName(ctx.gql, ctx.cache, inv.locationName))
          .id,
        name: "available",
        quantity: inv.quantity,
      });
    }
    if (!v.inventory.length && v.totalQty !== undefined) {
      const active = (await getLocations(ctx.gql, ctx.cache)).filter((l) => l.isActive);
      if (active.length !== 1) {
        throw new ImportError(
          `Row ${rowNo(v.rowIndex)}: Variant Inventory Qty can't be imported: this store has ${active.length} locations, so there is no single place to put the stock. Use a column per location, e.g. "Inventory Available: ${active[0]?.name ?? "Location name"}".`,
        );
      }
      q.push({ locationId: active[0].id, name: "available", quantity: v.totalQty });
    }
    if (q.length) {
      input.variants[i].inventoryQuantities = q;
      input.variants[i].inventoryItem = {
        tracked: true,
        ...input.variants[i].inventoryItem,
      };
      locationQty.set(v, q);
    }
    if (v.metafields.set.length)
      input.variants[i].metafields = v.metafields.set;
  }
  input.productOptions = optionNames.map((name, i) => {
    const values: string[] = [];
    for (const v of live) {
      const val = names.length ? v.optionValues[i] : "Default Title";
      if (val && !values.includes(val)) values.push(val);
    }
    return { name, position: i + 1, values: values.map((name) => ({ name })) };
  });

  const images = parseImages(rows).filter((im) => im.command !== "DELETE");
  const files = images.map((im) => ({
    originalSource: im.src,
    alt: altFor(ctx, im.src, im.alt) || undefined,
    contentType: "IMAGE",
  }));
  for (const src of variantImages) {
    if (!images.some((im) => im.src === src))
      files.push({ originalSource: src, alt: undefined, contentType: "IMAGE" });
  }
  if (files.length) input.files = files;

  if (ctx.checkImageUrl) {
    const problems: string[] = [];
    for (const f of files) {
      const problem = await ctx.checkImageUrl(f.originalSource);
      if (problem) problems.push(`Image ${fileName(f.originalSource)} ${problem}`);
    }
    if (problems.length) throw new ImportErrors(problems);
  }

  if (published && !(await onlineStorePublicationId(ctx.gql, ctx.cache))) {
    throw new ImportError(
      "Online Store sales channel not found; cannot set Published",
    );
  }

  // In words, for the preview.
  const prices = live.map((v) => Number(v.input.price ?? 0));
  const changes = [
    `Title: ${fields.title}`,
    `Status: ${fields.status[0]}${fields.status.slice(1).toLowerCase()}${statusDefaulted ? " (new products start as drafts unless the Status column says otherwise)" : ""}`,
    `Online Store: ${published ? "published" : "not published"}${fields.status === "ACTIVE" && !published ? " (add Published = TRUE to show it in the shop)" : ""}`,
    ...(fields.handle ? [`Handle: ${fields.handle}`] : []),
    ...(fields.vendor ? [`Vendor: ${fields.vendor}`] : []),
    ...(fields.productType ? [`Type: ${fields.productType}`] : []),
    ...(input.tags?.length ? [`Tags: ${input.tags.join(", ")}`] : []),
    live.length === 1 && !names.length
      ? `Price: ${live[0].input.price ?? "0 (none given)"}${live[0].input.inventoryItem?.sku ? `, SKU ${live[0].input.inventoryItem.sku}` : ""}`
      : `${live.length} variants (${names.join(" / ")}), prices ${Math.min(...prices)}–${Math.max(...prices)}`,
    ...(files.length ? [`${files.length} image${files.length === 1 ? "" : "s"}`] : []),
    ...(mf.length ? [`${mf.length} metafield${mf.length === 1 ? "" : "s"}`] : []),
    ...(locationQty.size ? [`Stock set for ${locationQty.size} variant${locationQty.size === 1 ? "" : "s"}`] : []),
  ];

  const create = async () => {
    const d = await ctx.gql(PRODUCT_SET, { input });
    assertNoUserErrors(d.productSet, "Create product");
    const product = d.productSet.product;

    if (published)
      await setOnlineStorePublished(
        ctx.gql,
        ctx.cache,
        product.id,
        true,
        cell(top, "Published At") || undefined,
      );

    // Variant IDs back into the result file.
    const rowPatches: Array<Row | undefined> = [];
    const created: any[] = product.variants.nodes;
    live.forEach((v) => {
      const match = created.find((c) =>
        (names.length ? names : ["Title"]).every(
          (n, i) =>
            c.selectedOptions.find((o: any) => o.name === n)?.value ===
            (names.length ? v.optionValues[i] : "Default Title"),
        ),
      );
      if (match) {
        rowPatches[v.rowIndex] = {
          "Variant ID": gidToId(match.id),
          "Variant Inventory Item ID": gidToId(match.inventoryItem.id),
        };
      }
    });
    return { id: product.id, rowPatches };
  };
  return { create, changes, warnings: [...new Set(warnings)] };
}

// --- Import: updating an existing product ------------------------------------------

const PRODUCT_METAFIELDS_NOW = `#graphql
  query ImportProductMetafieldsNow($id: ID!, $keys: [String!]!) {
    product(id: $id) { metafields(first: 250, keys: $keys) { nodes { namespace key type value } } }
  }
`;

const VARIANT_METAFIELDS_NOW = `#graphql
  query ImportVariantMetafieldsNow($ids: [ID!]!, $keys: [String!]!) {
    nodes(ids: $ids) { ... on ProductVariant { id metafields(first: 100, keys: $keys) { nodes { namespace key type value } } } }
  }
`;

const STOCK_NOW = `#graphql
  query ImportStockNow($ids: [ID!]!, $names: [String!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem { id inventoryLevels(first: 100) { nodes { location { id name } quantities(names: $names) { name quantity } } } }
    }
  }
`;

const metafieldKeys = (rows: Row[], prefix: string) => [
  ...new Set(
    rows.flatMap((r) =>
      Object.keys(r)
        .map((h) => parseMetafieldColumn(h, prefix))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => `${c.namespace}.${c.key}`),
    ),
  ),
];

const metafieldMap = (nodes: any[] | undefined): MetafieldsNow => new Map((nodes ?? []).map((m: any) => [`${m.namespace}.${m.key}`, { type: m.type, value: m.value }]));

/** Stock per inventory item: location id -> quantity name -> number. */
type StockNow = Map<string, Map<string, { name: string; quantities: Record<string, number> }>>;

async function fetchStock(ctx: ImportContext, inventoryItemIds: string[], names: string[]): Promise<StockNow> {
  const out: StockNow = new Map();
  for (let i = 0; i < inventoryItemIds.length; i += 20) {
    const d = await ctx.gql(STOCK_NOW, { ids: inventoryItemIds.slice(i, i + 20), names });
    for (const node of d?.nodes ?? []) {
      if (!node?.id) continue;
      const levels = new Map<string, { name: string; quantities: Record<string, number> }>();
      for (const lvl of node.inventoryLevels?.nodes ?? []) {
        levels.set(lvl.location.id, { name: lvl.location.name, quantities: Object.fromEntries((lvl.quantities ?? []).map((q: any) => [q.name, q.quantity ?? 0])) });
      }
      out.set(node.id, levels);
    }
  }
  return out;
}

/** Products that have a variant with this exact SKU (cached per import). */
async function skuOwners(ctx: ImportContext, sku: string): Promise<Array<{ id: string; handle: string }>> {
  const key = `skuOwners:${sku}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key) as Array<{ id: string; handle: string }>;
  const owners = new Map<string, string>();
  try {
    const d: any = await ctx.gql(VARIANTS_BY_SKU, { query: `sku:"${sku.replace(/["\\]/g, "\\$&")}"`, after: null });
    for (const v of d?.productVariants?.nodes ?? []) if (v.sku === sku && v.product?.id) owners.set(v.product.id, v.product.handle ?? "");
  } catch {
    // Can't look it up: no warning rather than a wrong one.
  }
  const list = [...owners].map(([id, handle]) => ({ id, handle }));
  ctx.cache.set(key, list);
  return list;
}

const fileName = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url;
  }
};

/** How a variant is named in messages: its SKU, else its option values. */
function variantIdent(v: { sku: string | null; selectedOptions: Array<{ name: string; value: string }> }): string {
  if (v.sku) return `SKU ${v.sku}`;
  const opts = v.selectedOptions.filter((o) => !(o.name === "Title" && o.value === "Default Title")).map((o) => o.value);
  return opts.length ? opts.join(" / ") : "the only variant";
}

interface UpdatePlan {
  errors: string[];
  warnings: string[];
  changes: FieldChange[];
  seen: Record<string, string>;
  creates: number;
  deletes: number;
  /** The top row with untouched cells removed: what the product update sends. */
  top: Row;
  images: { deleteIds: string[]; add: ImageSpec[]; mediaByKey: Map<string, ExistingProduct["media"]["nodes"][number]> };
  names: string[];
  isDefault: boolean;
  toUpdate: Array<{ spec: VariantSpec; existing: ExistingVariant; trackOn: boolean; sourceRow: number }>;
  toCreate: VariantSpec[];
  toDelete: string[];
  /** Variant and inventory item IDs to write back, by row. */
  rowPatches: Array<Row | undefined>;
  notes: string[];
  /** Rows that would put everything back (see ItemResult.undo). */
  undo: Row[];
  /** Stock expected after the import, checked by reading it back. */
  stockAfter: Array<{ inventoryItemId: string; locationId: string; locationName: string; kind: string; quantity: number; ident: string }>;
}

/**
 * Works out everything an update would do to a product, without writing:
 * which fields differ from the store (old → new), which variants are changed,
 * created or deleted, and every problem in the rows. The preview shows it; the
 * real import carries out exactly this plan.
 */
async function planUpdate(ctx: ImportContext, existing: ExistingProduct, rows: Row[], rowNo: (i: number) => number): Promise<UpdatePlan> {
  const top = rows[0];
  const plan: UpdatePlan = {
    errors: [],
    warnings: [],
    changes: [],
    seen: {},
    creates: 0,
    deletes: 0,
    top: { ...top },
    images: { deleteIds: [], add: [], mediaByKey: new Map() },
    names: [],
    isDefault: false,
    toUpdate: [],
    toCreate: [],
    toDelete: [],
    rowPatches: [],
    notes: [],
    stockAfter: [],
    undo: [],
  };
  const pid = gidToId(existing.id);
  const fail = (i: number, message: string) => plan.errors.push(`Row ${rowNo(i)}: ${message}`);
  const guard = (i: number, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof ImportError)) throw e;
      fail(i, e.message);
    }
  };

  // 1. Product fields.
  let productMetafields: MetafieldsNow | null = null;
  const productKeys = metafieldKeys([top], "Metafield");
  if (productKeys.length) {
    try {
      productMetafields = metafieldMap((await ctx.gql(PRODUCT_METAFIELDS_NOW, { id: existing.id, keys: productKeys }))?.product?.metafields?.nodes);
    } catch {
      productMetafields = null;
    }
  }
  const pc = compareProduct(top, existing, productMetafields);
  plan.changes.push(...pc.changes);
  Object.assign(plan.seen, pc.seen);
  if (Object.keys(pc.old).length) plan.undo.push({ ID: pid, Command: "UPDATE", ...pc.old });
  for (const e of pc.errors) fail(0, e);
  guard(0, () => void productFields(top));
  guard(0, () => void parseBool(cell(top, "Published")));
  metafieldsFromRow(top, "Metafield", plan.errors);
  const title = cell(top, "Title");
  if (title && title.length > 255) fail(0, `Title is ${title.length} characters long; Shopify allows 255`);
  if (pc.changed.has("Body HTML") && /<script\b/i.test(cell(top, "Body HTML") ?? "")) plan.warnings.push(`Row ${rowNo(0)}: the description contains a <script> tag, which would run code on the product page`);
  // Drop the cells that match the store, so only real changes are sent.
  for (const col of [...PRODUCT_COMPARED, ...Object.keys(top).filter((h) => parseMetafieldColumn(h, "Metafield"))]) {
    if (!pc.changed.has(col)) delete plan.top[col];
  }

  // 2. Images.
  let images: ImageSpec[] = [];
  guard(0, () => {
    images = parseImages(rows);
  });
  const existingMedia = existing.media.nodes.filter((m) => m.image?.url);
  const mediaByKey = new Map(existingMedia.map((m) => [imageKey(m.image!.url), m]));
  plan.images.mediaByKey = mediaByKey;
  const newImageUrls = new Map<string, number>(); // url -> row index, to check they load
  if (images.length) {
    const replace = images.some((im) => im.command === "REPLACE");
    const wanted = images.filter((im) => im.command !== "DELETE");
    const toDelete = new Set<string>();
    for (const im of images.filter((i) => i.command === "DELETE")) {
      const m = mediaByKey.get(imageKey(im.src));
      if (m) toDelete.add(m.id);
      else plan.notes.push(`Image on row ${rowNo(im.rowIndex)} to delete is not on the product`);
    }
    if (replace) {
      const keep = new Set(wanted.map((im) => imageKey(im.src)));
      for (const m of existingMedia) if (!keep.has(imageKey(m.image!.url))) toDelete.add(m.id);
    }
    for (const m of existingMedia) {
      if (!toDelete.has(m.id)) continue;
      plan.changes.push({ label: "Image", old: fileName(m.image!.url), next: "(removed)" });
      plan.undo.push({ ID: pid, Command: "UPDATE", "Image Src": m.image!.url, "Image Command": "MERGE", "Image Alt Text": m.alt ?? "" });
    }
    plan.images.deleteIds = [...toDelete];
    const taken = new Set([...mediaByKey].filter(([, m]) => !toDelete.has(m.id)).map(([k]) => k));
    for (const im of wanted) {
      const key = imageKey(im.src);
      if (taken.has(key)) {
        if (plan.images.add.some((a) => imageKey(a.src) === key)) plan.warnings.push(`Row ${rowNo(im.rowIndex)}: the image ${fileName(im.src)} is in the file twice; it is added once`);
        continue;
      }
      taken.add(key);
      plan.images.add.push(im);
      plan.undo.push({ ID: pid, Command: "UPDATE", "Image Src": im.src, "Image Command": "DELETE" });
      newImageUrls.set(im.src, im.rowIndex);
      plan.changes.push({ label: "Image", old: "(none)", next: `adds ${fileName(im.src)}` });
    }
  }

  // 3. Variants.
  const { names: sheetNames, variants } = parseVariants(rows, plan.errors, rowNo);
  const options = existing.options;
  const isDefault = existing.hasOnlyDefaultVariant && options.length === 1 && options[0].name === "Title";
  plan.isDefault = isDefault;
  let names = sheetNames.length ? sheetNames : isDefault ? [] : options.map((o) => o.name);
  if (sheetNames.length && !isDefault) {
    const existingNames = options.map((o) => o.name.toLowerCase());
    if (sheetNames.some((n, i) => existingNames[i] !== n.toLowerCase())) {
      fail(0, `Option names (${sheetNames.join(", ")}) differ from the product's (${options.map((o) => o.name).join(", ")}). Use command REPLACE to restructure options.`);
    }
    names = options.map((o) => o.name);
  }
  plan.names = names;

  const optionsOf = (e: ExistingVariant) =>
    names.map((n) => e.selectedOptions.find((o) => o.name.toLowerCase() === n.toLowerCase())?.value ?? "");
  const sameOptions = (e: ExistingVariant, values: string[]) => optionsOf(e).every((v, i) => v.toLowerCase() === (values[i] ?? "").toLowerCase());

  // Which existing variant a row means: its Variant ID; else the variant with
  // exactly these option values; else the one variant with this SKU (so a row
  // that changes an option value renames it rather than adding a duplicate).
  const match = async (v: VariantSpec): Promise<ExistingVariant | "create" | null> => {
    if (v.id) {
      const e = existing.variants.find((x) => x.id === v.id);
      if (!e) fail(v.rowIndex, `Variant ID ${gidToId(v.id)} is not on this product`);
      return e ?? null;
    }
    const allOptions = names.length > 0 && names.every((_, i) => v.optionValues[i]);
    if (allOptions) {
      const e = existing.variants.find((x) => sameOptions(x, v.optionValues));
      if (e) return e;
    }
    const sku = cell(rows[v.rowIndex], "Variant SKU");
    if (sku) {
      const bySku = existing.variants.filter((x) => x.sku === sku);
      if (bySku.length === 1) return bySku[0];
      if (bySku.length > 1) {
        fail(v.rowIndex, `SKU "${sku}" is on ${bySku.length} variants of this product, so the row can't tell which one it means. Add the Variant ID.`);
        return null;
      }
    }
    if (!names.length && existing.variants.length === 1) {
      // One variant, no options: the row is about it. A SKU that isn't its own must not belong elsewhere.
      if (sku && existing.variants[0].sku && sku !== existing.variants[0].sku) {
        const others = (await skuOwners(ctx, sku)).filter((o) => o.id !== existing.id);
        if (others.length) {
          fail(v.rowIndex, `SKU "${sku}" belongs to another product (${others[0].handle}), not to this one (its SKU is "${existing.variants[0].sku}"). Check the Handle.`);
          return null;
        }
      }
      return existing.variants[0];
    }
    if (v.command === "DELETE") return null;
    if (!allOptions) {
      const owners = sku ? (await skuOwners(ctx, sku)).filter((o) => o.id !== existing.id) : [];
      fail(
        v.rowIndex,
        owners.length
          ? `SKU "${sku}" belongs to another product (${owners[0].handle}), not to this one. Check the Handle.`
          : sku
            ? `No variant with SKU "${sku}" on this product. To add a new variant, fill in ${names.length ? names.map((_, i) => `Option${i + 1} Value`).join(", ") : "Option1 Name and Option1 Value"}.`
            : `The row doesn't say which variant it means. Add the Variant ID, the SKU, or ${names.length ? `a value for every option (${names.join(", ")})` : "Option1 Name and Option1 Value"}.`,
      );
      return null;
    }
    return "create";
  };

  const targeted = new Map<string, number>(); // existing variant id -> first row that targets it
  const matched: Array<{ spec: VariantSpec; existing: ExistingVariant }> = [];
  for (const v of variants) {
    const m = await match(v);
    if (m === null) {
      if (v.command === "DELETE" && !plan.errors.some((e) => e.startsWith(`Row ${rowNo(v.rowIndex)}:`))) plan.notes.push(`Variant on row ${rowNo(v.rowIndex)} to delete not found`);
      continue;
    }
    if (m === "create") {
      plan.toCreate.push(v);
      continue;
    }
    const first = targeted.get(m.id);
    if (first !== undefined) {
      fail(v.rowIndex, `Rows ${rowNo(first)} and ${rowNo(v.rowIndex)} both change the same variant (${variantIdent(m)}). Keep one of them.`);
      continue;
    }
    targeted.set(m.id, v.rowIndex);
    if (v.command === "DELETE") {
      plan.toDelete.push(m.id);
      plan.deletes++;
      // Undo re-creates the variant from what it was (it gets a new ID).
      const back: Row = { ID: pid, Command: "UPDATE", "Variant SKU": m.sku ?? "", "Variant Price": m.price ?? "", "Variant Compare At Price": m.compareAtPrice ?? "", "Variant Barcode": m.barcode ?? "" };
      m.selectedOptions.slice(0, 3).forEach((o, n) => {
        back[`Option${n + 1} Name`] = o.name;
        back[`Option${n + 1} Value`] = o.value;
      });
      plan.undo.push(back);
      plan.changes.push({ label: `Variant (${variantIdent(m)})`, old: "exists", next: "(deleted)" });
      continue;
    }
    matched.push({ spec: v, existing: m });
  }
  if (plan.toDelete.length && plan.toDelete.length >= existing.variants.length && !plan.toCreate.length) {
    fail(0, "This would delete every variant of the product. To remove the product, use the command DELETE.");
  }

  // Current values the plain variant query doesn't carry: variant metafields and stock.
  let variantMetafields: Map<string, MetafieldsNow> | null = null;
  const variantKeys = metafieldKeys(rows, "Variant Metafield");
  if (variantKeys.length && matched.length) {
    try {
      variantMetafields = new Map();
      for (let i = 0; i < matched.length; i += 50) {
        const d = await ctx.gql(VARIANT_METAFIELDS_NOW, { ids: matched.slice(i, i + 50).map((m) => m.existing.id), keys: variantKeys });
        for (const n of d?.nodes ?? []) if (n?.id) variantMetafields.set(n.id, metafieldMap(n.metafields?.nodes));
      }
    } catch {
      variantMetafields = null;
    }
  }
  const withStock = matched.filter(({ spec }) => spec.inventory.length || spec.adjustments.length || spec.totalQty !== undefined || spec.adjust);
  let stock: StockNow | null = null;
  if (withStock.length) {
    const kinds = [...new Set(["available", ...withStock.flatMap(({ spec }) => [...spec.inventory, ...spec.adjustments].map((x) => (x.kind === "on_hand" ? "on_hand" : x.kind)))])];
    try {
      stock = await fetchStock(ctx, withStock.map((m) => m.existing.inventoryItem.id), kinds);
    } catch {
      stock = null;
    }
  }
  const locations = withStock.length || plan.toCreate.some((v) => v.totalQty !== undefined || v.adjust) ? (await getLocations(ctx.gql, ctx.cache)).filter((l) => l.isActive) : [];

  for (const { spec, existing: ex } of matched) {
    const i = spec.rowIndex;
    const row = rows[i];
    const ident = variantIdent(ex);
    const vc = compareVariant(row, ex, ident, variantMetafields ? (variantMetafields.get(ex.id) ?? new Map()) : null);
    const eff: Row = { ...row };
    for (const col of [...VARIANT_COMPARED, ...Object.keys(row).filter((h) => parseMetafieldColumn(h, "Variant Metafield"))]) {
      if (!vc.changed.has(col)) delete eff[col];
    }
    plan.changes.push(...vc.changes);
    Object.assign(plan.seen, vc.seen);
    const back: Row = { ...vc.old };

    // A changed SKU must not collide with another variant, here or elsewhere.
    if (vc.changed.has("Variant SKU")) {
      const sku = cell(row, "Variant SKU")!;
      if (sku && existing.variants.some((x) => x.id !== ex.id && x.sku === sku)) fail(i, `SKU "${sku}" is already on another variant of this product`);
      else if (sku) {
        const others = (await skuOwners(ctx, sku)).filter((o) => o.id !== existing.id);
        if (others.length) plan.warnings.push(`Row ${rowNo(i)}: SKU "${sku}" is already used by another product (${others[0].handle})`);
      }
    }

    // Option values that differ from the matched variant's: a rename.
    let renamed = false;
    if (names.length && spec.optionValues.some(Boolean)) {
      const now = optionsOf(ex);
      const next = names.map((_, n) => spec.optionValues[n] || now[n]);
      names.forEach((name, n) => {
        plan.seen[`Option ${name} (${ident})`] = now[n];
        if (next[n].toLowerCase() !== now[n].toLowerCase()) {
          renamed = true;
          back[`Option${n + 1} Name`] = name;
          back[`Option${n + 1} Value`] = now[n];
          plan.changes.push({ label: `Option ${name} (${ident})`, old: now[n], next: next[n] });
        }
      });
      if (renamed && existing.variants.some((x) => x.id !== ex.id && sameOptions(x, next))) {
        fail(i, `Another variant already has the options ${next.join(" / ")}`);
      }
    }
    if (!renamed) for (let n = 1; n <= 3; n++) delete eff[`Option${n} Value`];

    // Variant image.
    if (spec.imageSrc) {
      const now = ex.image?.url ? imageKey(ex.image.url) : "";
      plan.seen[`Variant Image (${ident})`] = now;
      if (imageKey(spec.imageSrc) === now) delete eff["Variant Image"];
      else {
        plan.changes.push({ label: `Variant Image (${ident})`, old: now || "(none)", next: fileName(spec.imageSrc) });
        if (ex.image?.url) back["Variant Image"] = ex.image.url;
        if (!mediaByKey.has(imageKey(spec.imageSrc))) newImageUrls.set(spec.imageSrc, i);
      }
    }

    // Stock.
    const levels = stock?.get(ex.inventoryItem.id) ?? null;
    let writesStock = false;
    const stockCols = Object.keys(row).filter((k) => inventoryColumn(k)?.writable);
    for (const k of stockCols) {
      const col = inventoryColumn(k)!;
      const raw = (row[k] ?? "").trim();
      if (raw === "") {
        delete eff[k];
        continue;
      }
      let n: number | undefined;
      try {
        n = stockNumber(raw, k);
      } catch {
        continue; // reported by parseVariants
      }
      let loc: { id: string; name: string } | null = null;
      try {
        loc = await locationByName(ctx.gql, ctx.cache, col.location);
      } catch (e: any) {
        fail(i, `${k}: ${e.message}`);
        continue;
      }
      const kind = col.adjust && col.name === "on_hand" ? "available" : col.name;
      const now = levels?.get(loc.id)?.quantities[kind];
      const label = `${col.label} stock at ${loc.name} (${ident})`;
      if (now !== undefined) plan.seen[label] = String(now);
      if (col.adjust) {
        if (!n) {
          delete eff[k];
          continue;
        }
        writesStock = true;
        back[k] = String(-n);
        plan.changes.push({ label, old: now === undefined ? "?" : String(now), next: now === undefined ? `${n > 0 ? "+" : ""}${n}` : `${now + n} (${n > 0 ? "+" : ""}${n})` });
        if (now !== undefined) plan.stockAfter.push({ inventoryItemId: ex.inventoryItem.id, locationId: loc.id, locationName: loc.name, kind, quantity: now + n, ident });
      } else if (levels && now === n) delete eff[k];
      else {
        writesStock = true;
        if (now !== undefined) back[k] = String(now);
        plan.changes.push({ label, old: now === undefined ? (levels ? "not stocked here" : "?") : String(now), next: String(n) });
        plan.stockAfter.push({ inventoryItemId: ex.inventoryItem.id, locationId: loc.id, locationName: loc.name, kind, quantity: n!, ident });
        if (kind === "available" && now && n === 0) plan.warnings.push(`Row ${rowNo(i)}: stock of ${ident} at ${loc.name} goes from ${now} to 0`);
      }
    }
    // "Variant Inventory Qty" is the total over all locations: it can only be
    // written where there is exactly one location to put it in.
    const hasAvailableColumn = spec.inventory.some((x) => x.kind === "available");
    if (spec.totalQty !== undefined) {
      const total = ex.inventoryQuantity ?? 0;
      plan.seen[`Variant Inventory Qty (${ident})`] = String(total);
      if (hasAvailableColumn || spec.totalQty === total) delete eff["Variant Inventory Qty"];
      else if (locations.length !== 1) {
        delete eff["Variant Inventory Qty"];
        fail(
          i,
          locations.length
            ? `Variant Inventory Qty (${spec.totalQty}) can't be imported: this store has ${locations.length} locations, so there is no single place to put the stock. Use a column per location, e.g. "Inventory Available: ${locations[0].name}".`
            : "Variant Inventory Qty can't be imported: the store has no active location.",
        );
      } else {
        writesStock = true;
        back["Variant Inventory Qty"] = String(total);
        const loc = locations[0];
        const now = levels?.get(loc.id)?.quantities.available;
        plan.changes.push({ label: `Available stock at ${loc.name} (${ident})`, old: String(now ?? total), next: String(spec.totalQty) });
        plan.stockAfter.push({ inventoryItemId: ex.inventoryItem.id, locationId: loc.id, locationName: loc.name, kind: "available", quantity: spec.totalQty, ident });
        if (total > 0 && spec.totalQty === 0) plan.warnings.push(`Row ${rowNo(i)}: stock of ${ident} goes from ${total} to 0`);
      }
    }
    if (spec.adjust) {
      const target = hasAvailableColumn ? null : locations.length === 1 ? locations[0] : null;
      if (hasAvailableColumn) {
        // Existing behaviour: the adjustment applies on top of the location column's value.
        writesStock = true;
        plan.changes.push({ label: `Available stock (${ident})`, old: "after the set above", next: `${spec.adjust > 0 ? "+" : ""}${spec.adjust}` });
      } else if (!target) {
        delete eff["Variant Inventory Adjust"];
        fail(
          i,
          locations.length
            ? `Variant Inventory Adjust (${spec.adjust > 0 ? "+" : ""}${spec.adjust}) can't be imported: this store has ${locations.length} locations. Use a column per location, e.g. "Inventory Available Adjust: ${locations[0].name}".`
            : "Variant Inventory Adjust can't be imported: the store has no active location.",
        );
      } else {
        writesStock = true;
        back["Variant Inventory Adjust"] = String(-spec.adjust);
        const now = levels?.get(target.id)?.quantities.available ?? ex.inventoryQuantity ?? 0;
        plan.seen[`Available stock at ${target.name} (${ident})`] = String(now);
        plan.changes.push({ label: `Available stock at ${target.name} (${ident})`, old: String(now), next: `${now + spec.adjust} (${spec.adjust > 0 ? "+" : ""}${spec.adjust})` });
        plan.stockAfter.push({ inventoryItemId: ex.inventoryItem.id, locationId: target.id, locationName: target.name, kind: "available", quantity: now + spec.adjust, ident });
      }
    } else delete eff["Variant Inventory Adjust"];

    // Stock on an item Shopify isn't tracking would be written and never shown.
    const trackerCell = cell(row, "Variant Inventory Tracker");
    const willTrack = trackerCell === undefined ? ex.inventoryItem.tracked : vc.changed.has("Variant Inventory Tracker") ? !ex.inventoryItem.tracked : ex.inventoryItem.tracked;
    let trackOn = false;
    if (writesStock && !willTrack) {
      if (trackerCell !== undefined) fail(i, `The row sets stock for ${ident} but turns stock tracking off (Variant Inventory Tracker). Set it to "shopify", or remove the stock columns.`);
      else {
        trackOn = true;
        back["Variant Inventory Tracker"] = "";
        plan.changes.push({ label: `Stock tracking (${ident})`, old: "off", next: "on (needed to hold stock)" });
      }
    }

    plan.warnings.push(
      ...priceWarnings(
        `Row ${rowNo(i)} (${ident})`,
        { price: ex.price, compareAtPrice: ex.compareAtPrice },
        {
          price: vc.changed.has("Variant Price") ? (spec.input.price ?? ex.price) : ex.price,
          compareAtPrice: vc.changed.has("Variant Compare At Price") ? (spec.input.compareAtPrice ?? null) : ex.compareAtPrice,
        },
      ),
    );

    plan.rowPatches[i] = { "Variant ID": gidToId(ex.id), "Variant Inventory Item ID": gidToId(ex.inventoryItem.id) };
    if (Object.keys(back).length) plan.undo.push({ ID: pid, Command: "UPDATE", "Variant ID": gidToId(ex.id), ...back });
    // The row as the import sends it: only what differs from the store.
    let effSpec: VariantSpec | null = null;
    try {
      effSpec = parseVariants([eff]).variants[0] ?? null;
    } catch {
      effSpec = null; // its problems are already listed
    }
    const hasWork =
      !!effSpec &&
      (Object.keys(effSpec.input).length > 0 || renamed || !!effSpec.imageSrc || effSpec.metafields.set.length > 0 || effSpec.metafields.blank.length > 0 || writesStock);
    if (hasWork || trackOn) {
      const s: VariantSpec = effSpec ?? { rowIndex: 0, command: "MERGE", optionValues: [], input: {}, inventory: [], adjustments: [], metafields: { set: [], blank: [] } };
      plan.toUpdate.push({ spec: { ...s, rowIndex: i, optionValues: renamed ? spec.optionValues : [] }, existing: ex, trackOn, sourceRow: i });
    }
  }

  // New variants.
  for (const spec of plan.toCreate) {
    const i = spec.rowIndex;
    const sku = cell(rows[i], "Variant SKU");
    if (sku && plan.toCreate.some((o) => o !== spec && o.rowIndex < i && cell(rows[o.rowIndex], "Variant SKU") === sku)) {
      fail(i, `SKU "${sku}" is on more than one new variant in this file`);
    } else if (sku) {
      const others = (await skuOwners(ctx, sku)).filter((o) => o.id !== existing.id);
      if (others.length) plan.warnings.push(`Row ${rowNo(i)}: SKU "${sku}" is already used by another product (${others[0].handle})`);
    }
    if (plan.toCreate.some((o) => o !== spec && o.rowIndex < i && names.every((_, n) => (o.optionValues[n] ?? "").toLowerCase() === (spec.optionValues[n] ?? "").toLowerCase()))) {
      fail(i, `The options ${spec.optionValues.join(" / ")} are on more than one row`);
    }
    if ((spec.totalQty !== undefined && !spec.inventory.length) || spec.adjust) {
      if (locations.length !== 1) fail(i, `Variant Inventory Qty can't be imported for the new variant: this store has ${locations.length} locations. Use a column per location, e.g. "Inventory Available: ${locations[0]?.name ?? "Location name"}".`);
    }
    for (const inv of spec.inventory) {
      try {
        await locationByName(ctx.gql, ctx.cache, inv.locationName);
      } catch (e: any) {
        fail(i, e.message);
      }
    }
    if (spec.imageSrc && !mediaByKey.has(imageKey(spec.imageSrc))) newImageUrls.set(spec.imageSrc, i);
    plan.creates++;
    const what = [spec.optionValues.filter(Boolean).join(" / "), sku ? `SKU ${sku}` : "", spec.input.price ? `price ${spec.input.price}` : "no price"].filter(Boolean).join(", ");
    plan.changes.push({ label: "New variant", old: "(none)", next: what });
    if (!spec.input.price) plan.warnings.push(`Row ${rowNo(i)}: the new variant has no price (it will be 0)`);
  }

  // New image links must load and be images, or Shopify attaches a broken placeholder.
  if (ctx.checkImageUrl) {
    for (const [url, i] of newImageUrls) {
      const problem = await ctx.checkImageUrl(url);
      if (problem) fail(i, `Image ${fileName(url)} ${problem}`);
    }
  }

  return plan;
}

/** Columns planUpdate compares with the store; a cell equal to the store's value is not sent. */
const PRODUCT_COMPARED = ["Title", "Body HTML", "Vendor", "Type", "Status", "Template Suffix", "Category: ID", "SEO Title", "SEO Description", "Published", "Published At", "Handle", "Tags", "Tags Command"];
const VARIANT_COMPARED = [
  "Variant SKU",
  "Variant Barcode",
  "Variant Price",
  "Variant Compare At Price",
  "Variant Taxable",
  "Variant Tax Code",
  "Variant Inventory Policy",
  "Variant Requires Shipping",
  "Variant Cost",
  "Variant HS Code",
  "Variant Country of Origin",
  "Variant Province of Origin",
  "Variant Inventory Tracker",
  "Variant Weight",
  "Variant Weight Unit",
];

/** Carries out a plan made by planUpdate. */
async function applyUpdate(ctx: ImportContext, existing: ExistingProduct, plan: UpdatePlan): Promise<void> {
  const productId = existing.id;
  const top = plan.top;

  // 1. Product fields.
  const fields = productFields(top);
  if (!has(top, "Handle") || fields.handle === existing.handle) delete fields.handle;
  const tagsCell = cell(top, "Tags");
  const tagsCommand = parseSubCommand(cell(top, "Tags Command"), ["REPLACE", "MERGE", "DELETE"] as const, "REPLACE");
  if (tagsCell !== undefined && tagsCommand === "REPLACE") fields.tags = splitTags(tagsCell);
  if (Object.keys(fields).length) {
    const d = await ctx.gql(PRODUCT_UPDATE, { product: { id: productId, ...fields } });
    assertNoUserErrors(d.productUpdate, "Update product");
  }
  if (tagsCell && tagsCommand === "MERGE") await addTags(ctx.gql, productId, splitTags(tagsCell));
  if (tagsCell && tagsCommand === "DELETE") await removeTags(ctx.gql, productId, splitTags(tagsCell));

  const mf = metafieldsFromRow(top);
  await writeMetafields(ctx.gql, productId, mf.set, mf.blank);

  const published = parseBool(cell(top, "Published"));
  if (published !== undefined) {
    await setOnlineStorePublished(ctx.gql, ctx.cache, productId, published, cell(top, "Published At") || undefined);
  }

  // 2. Images.
  const mediaByKey = plan.images.mediaByKey;
  if (plan.images.deleteIds.length) {
    const d = await ctx.gql(MEDIA_DELETE, { productId, mediaIds: plan.images.deleteIds });
    if (d.productDeleteMedia.mediaUserErrors?.length) throw new ImportError(`Images: ${d.productDeleteMedia.mediaUserErrors[0].message}`);
    for (const [k, m] of mediaByKey) if (plan.images.deleteIds.includes(m.id)) mediaByKey.delete(k);
  }
  if (plan.images.add.length) {
    const toAdd = plan.images.add;
    const d = await ctx.gql(MEDIA_CREATE, {
      productId,
      media: toAdd.map((im) => ({ originalSource: im.src, alt: altFor(ctx, im.src, im.alt) ?? "", mediaContentType: "IMAGE" })),
    });
    if (d.productCreateMedia.mediaUserErrors?.length) throw new ImportError(`Images: ${d.productCreateMedia.mediaUserErrors[0].message}`);
    d.productCreateMedia.media.forEach((m: any, i: number) => {
      mediaByKey.set(imageKey(toAdd[i].src), { id: m.id, alt: m.alt, mediaContentType: "IMAGE", image: { url: toAdd[i].src } });
    });
  }

  // 3. Variants.
  const { names, isDefault, toUpdate, toCreate, toDelete } = plan;
  const newMedia: Array<{ originalSource: string; mediaContentType: string }> = [];
  const mediaFor = (spec: VariantSpec): Record<string, any> => {
    if (!spec.imageSrc) return {};
    const m = mediaByKey.get(imageKey(spec.imageSrc));
    if (m) return { mediaId: m.id };
    if (!newMedia.some((x) => x.originalSource === spec.imageSrc)) newMedia.push({ originalSource: spec.imageSrc, mediaContentType: "IMAGE" });
    return { mediaSrc: [spec.imageSrc] };
  };
  const inventoryWork: InventoryWork[] = [];

  if (toUpdate.length) {
    newMedia.length = 0;
    const inputs = toUpdate
      .map(({ spec, existing: ex, trackOn }) => {
        const input: Record<string, any> = {
          ...spec.input,
          ...mediaFor(spec),
          ...(spec.metafields.set.length ? { metafields: spec.metafields.set } : {}),
          ...(names.length && spec.optionValues.some(Boolean)
            ? { optionValues: names.map((name, i) => ({ optionName: name, name: spec.optionValues[i] })).filter((o) => o.name) }
            : {}),
        };
        if (trackOn) input.inventoryItem = { ...input.inventoryItem, tracked: true };
        return Object.keys(input).length ? { id: ex.id, ...input } : null;
      })
      .filter(Boolean);
    if (inputs.length) {
      const d = await ctx.gql(VARIANTS_UPDATE, { productId, variants: inputs, media: newMedia.length ? [...newMedia] : null });
      assertNoUserErrors(d.productVariantsBulkUpdate, "Update variants");
    }
    for (const { spec, existing: ex } of toUpdate) {
      if (spec.metafields.blank.length) await writeMetafields(ctx.gql, ex.id, [], spec.metafields.blank);
      inventoryWork.push({
        inventoryItemId: ex.inventoryItem.id,
        activeLocations: new Set(ex.inventoryItem.inventoryLevels.nodes.map((n) => n.location.id)),
        spec,
      });
    }
  }

  if (toCreate.length) {
    if (isDefault && names.length) {
      // Product had only the default variant: add the real options first.
      const d = await ctx.gql(OPTIONS_CREATE, {
        productId,
        options: names.map((name, i) => ({
          name,
          values: [...new Set(toCreate.map((v) => v.optionValues[i]).filter(Boolean))].map((n) => ({ name: n })),
        })),
      });
      assertNoUserErrors(d.productOptionsCreate, "Create options");
    }
    newMedia.length = 0;
    const inputs = [];
    for (const spec of toCreate) {
      const inventoryQuantities: Array<{ locationId: string; availableQuantity: number }> = [];
      for (const inv of spec.inventory) {
        inventoryQuantities.push({ locationId: (await locationByName(ctx.gql, ctx.cache, inv.locationName)).id, availableQuantity: inv.quantity });
      }
      if (!spec.inventory.length && spec.totalQty !== undefined) {
        const locationId = await singleLocationId(ctx);
        if (locationId) inventoryQuantities.push({ locationId, availableQuantity: spec.totalQty });
      }
      inputs.push({
        ...spec.input,
        ...mediaFor(spec),
        ...(spec.metafields.set.length ? { metafields: spec.metafields.set } : {}),
        ...(inventoryQuantities.length ? { inventoryQuantities, inventoryItem: { tracked: true, ...spec.input.inventoryItem } } : {}),
        optionValues: names.map((name, i) => ({ optionName: name, name: spec.optionValues[i] })),
      });
    }
    const d = await ctx.gql(VARIANTS_CREATE, {
      productId,
      variants: inputs,
      media: newMedia.length ? [...newMedia] : null,
      strategy: isDefault ? "REMOVE_STANDALONE_VARIANT" : "DEFAULT",
    });
    assertNoUserErrors(d.productVariantsBulkCreate, "Create variants");
    const created: any[] = d.productVariantsBulkCreate.productVariants;
    toCreate.forEach((spec, i) => {
      const c = created[i];
      if (!c) return;
      plan.rowPatches[spec.rowIndex] = { "Variant ID": gidToId(c.id), "Variant Inventory Item ID": gidToId(c.inventoryItem.id) };
      // Quantities were set on create; only adjustments remain.
      if (spec.adjust) {
        inventoryWork.push({ inventoryItemId: c.inventoryItem.id, activeLocations: new Set(), spec: { ...spec, inventory: [], totalQty: undefined } });
      }
    });
  }

  if (toDelete.length) {
    const d = await ctx.gql(VARIANTS_DELETE, { productId, variantsIds: toDelete });
    assertNoUserErrors(d.productVariantsBulkDelete, "Delete variants");
  }

  const needsInventory = inventoryWork.filter((w) => w.spec.inventory.length || w.spec.totalQty !== undefined || w.spec.adjust || w.spec.adjustments.length);
  if (needsInventory.length) {
    await applyInventory(ctx, needsInventory);
    // Read the stock back: a write that didn't take must not be reported as done.
    if (plan.stockAfter.length) {
      let after: StockNow | null = null;
      try {
        after = await fetchStock(ctx, [...new Set(plan.stockAfter.map((s) => s.inventoryItemId))], [...new Set(plan.stockAfter.map((s) => s.kind))]);
      } catch {
        after = null;
      }
      const wrong = (after ? plan.stockAfter : []).filter((s) => {
        const now = after!.get(s.inventoryItemId)?.get(s.locationId)?.quantities[s.kind];
        return now !== undefined && now !== s.quantity;
      });
      if (wrong.length) {
        throw new ImportError(
          `Stock was written but did not take: ${wrong
            .slice(0, 5)
            .map((s) => `${s.ident} at ${s.locationName} is ${after!.get(s.inventoryItemId)!.get(s.locationId)!.quantities[s.kind]}, expected ${s.quantity}`)
            .join("; ")}. Check the stock in Shopify (an order or another app may have changed it at the same moment).`,
        );
      }
    }
  }
}

/** Words a plan as "old → new" lines. */
const changeLines = (changes: FieldChange[]) => changes.map((c) => `${c.label}: ${c.old} → ${c.next}`);

/**
 * What a preview keeps of an item's store values, small enough to keep for
 * every item of a large file: one fingerprint of everything the item touches,
 * plus the readable values of just the fields that would change.
 */
function compactSeen(seen: Record<string, string>, changedLabels: string[]): Record<string, string> {
  const out: Record<string, string> = { "#": fingerprint(seen) };
  for (const label of changedLabels) {
    const v = seen[label];
    if (v !== undefined) out[label] = v.length > 60 ? `#${fingerprint({ v })}` : v;
  }
  if ("(product exists)" in seen) out["(product exists)"] = seen["(product exists)"];
  return out;
}

function fingerprint(values: Record<string, string>): string {
  const h = createHash("sha1");
  for (const k of Object.keys(values).sort()) h.update(k).update("\u0000").update(values[k]).update("\u0001");
  return h.digest("base64url").slice(0, 12);
}

/** What changed in the store between a preview and now, among the fields the preview looked at. */
function staleFields(expected: Record<string, string> | undefined, now: Record<string, string>): string[] {
  if (!expected) return [];
  const out: string[] = [];
  const show = (v: string) => (v === "" ? "(empty)" : v);
  for (const [label, was] of Object.entries(expected)) {
    if (label === "#" || !(label in now)) continue;
    const current = was.startsWith("#") && now[label].length > 60 ? `#${fingerprint({ v: now[label] })}` : now[label];
    if (current === was) continue;
    out.push(was.startsWith("#") ? `${label} was edited` : `${label} was ${show(was)} at the preview and is now ${show(current)}`);
  }
  // None of the fields it would change moved, but something else it looked at did.
  if (!out.length && expected["#"] && expected["#"] !== fingerprint(now)) out.push("the item was edited (a field this file touches now has a different value)");
  return out;
}

async function deleteProduct(gql: Gql, id: string) {
  const d = await gql(PRODUCT_DELETE, { id });
  assertNoUserErrors(d.productDelete, "Delete product");
}

const VARIANT_PRODUCT = `#graphql
  query ImportVariantProduct($id: ID!) { productVariant(id: $id) { id product { id } } }
`;

const VARIANTS_BY_SKU = `#graphql
  query ImportVariantsBySku($query: String!, $after: String) {
    productVariants(first: 50, query: $query, after: $after) {
      nodes { id sku product { id handle } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Product that owns a variant, looked up by Variant ID, else by exact SKU. */
async function productIdForVariant(gql: Gql, variantId: string | undefined, sku: string | undefined): Promise<string | null> {
  if (variantId) {
    const v = (await gql(VARIANT_PRODUCT, { id: toGid("ProductVariant", variantId) })).productVariant;
    return v?.product?.id ?? null;
  }
  if (!sku) return null;
  const products = new Set<string>();
  let after: string | null = null;
  do {
    const d: any = await gql(VARIANTS_BY_SKU, { query: `sku:"${sku.replace(/["\\]/g, "\\$&")}"`, after });
    for (const v of d.productVariants.nodes) if (v.sku === sku) products.add(v.product.id);
    after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
  } while (after && products.size < 2);
  if (products.size > 1) throw new ImportError(`Variant SKU "${sku}" is used by several products; add the Variant ID`);
  return [...products][0] ?? null;
}

export async function importProduct(
  ctx: ImportContext,
  rows: Row[],
  command: Command,
  meta: ItemMeta = {},
): Promise<ItemResult> {
  const top = rows[0];
  const dry = !!ctx.options.dryRun;
  const rowNo = (i: number) => meta.rowNumbers?.[i] ?? i + 1;
  const id = toGid("Product", cell(top, "ID"));
  const handle = cell(top, "Handle");
  let existing = id || handle ? await fetchProduct(ctx.gql, { id, handle }) : null;
  // Variant-only sheets (no product ID or Handle): find the product through
  // the row's Variant ID or Variant SKU.
  if (!id && !handle) {
    const productId = await productIdForVariant(ctx.gql, cell(top, "Variant ID"), cell(top, "Variant SKU"));
    if (productId) existing = await fetchProduct(ctx.gql, { id: productId });
    else if (cell(top, "Variant ID") || cell(top, "Variant SKU")) {
      return {
        status: "Failed",
        command,
        message: `No variant found with ${cell(top, "Variant ID") ? `Variant ID ${cell(top, "Variant ID")}` : `Variant SKU "${cell(top, "Variant SKU")}"`}`,
      };
    }
  }

  // Following a preview: the product must still be (or still not be) there.
  const existence = { "(product exists)": existing ? "yes" : "no" };
  const failStale = (lines: string[]): ItemResult => ({
    status: "Failed",
    command,
    id: existing?.id,
    message: `Changed in the store since the preview, so nothing was imported for this item: ${lines.join("; ")}. Preview the file again.`,
  });
  if (!dry) {
    const was = meta.expectedSeen?.["(product exists)"];
    if (was !== undefined && was !== existence["(product exists)"]) {
      return failStale([existing ? "the product now exists (it didn't at the preview)" : "the product no longer exists"]);
    }
  }

  const created = async (omitHandle = false): Promise<ItemResult> => {
    const prepared = await prepareCreate(ctx, rows, top, omitHandle, rowNo);
    if (dry) {
      return {
        status: "OK",
        command,
        title: cell(top, "Title") || undefined,
        seen: existence,
        preview: { action: "create", changes: prepared.changes, warnings: prepared.warnings, creates: 1 },
      };
    }
    const r = await prepared.create();
    return { status: "OK", command, id: r.id, message: "Created", rowPatches: r.rowPatches, undo: [{ ID: gidToId(r.id), Command: "DELETE" }] };
  };

  switch (command) {
    case "DELETE": {
      if (!existing) return { status: "Failed", command, message: "Product not found" };
      const what = `"${existing.title}" with its ${existing.variants.length} variant${existing.variants.length === 1 ? "" : "s"} and ${existing.media.nodes.length} image${existing.media.nodes.length === 1 ? "" : "s"}`;
      if (dry) {
        return {
          status: "OK",
          command,
          id: existing.id,
          title: existing.title,
          seen: existence,
          preview: { action: "delete", changes: [`Deletes the product ${what}. This cannot be undone.`], warnings: [], deletes: 1 },
        };
      }
      await deleteProduct(ctx.gql, existing.id);
      return { status: "OK", command, id: existing.id, message: `Deleted ${what}`, undoNote: `the deleted product "${existing.title}" (restore it from a backup)` };
    }
    case "NEW": {
      if (existing)
        return {
          status: "Failed",
          command,
          id: existing.id,
          message: `Product with handle "${existing.handle}" already exists`,
        };
      return created();
    }
    case "REPLACE": {
      if (!existing) return created();
      // Create the new product first (under a temporary handle) so a failure
      // leaves the old one intact, and so images can still be fetched from the
      // old product's CDN URLs. Then delete the old one and take its handle.
      const prepared = await prepareCreate(ctx, rows, top, true, rowNo);
      if (dry) {
        return {
          status: "OK",
          command,
          id: existing.id,
          seen: existence,
          preview: {
            action: "replace",
            changes: [`Deletes the product "${existing.title}" (${existing.variants.length} variants, ${existing.media.nodes.length} images) and creates it again from this file. Anything not in the file is lost.`, ...prepared.changes],
            warnings: prepared.warnings,
            deletes: 1,
            creates: 1,
          },
        };
      }
      const r = await prepared.create();
      await deleteProduct(ctx.gql, existing.id);
      const handle = cell(top, "Handle") || existing.handle;
      const d = await ctx.gql(PRODUCT_UPDATE, {
        product: { id: r.id, handle },
      });
      const renamed = !d.productUpdate.userErrors?.length;
      return {
        status: "OK",
        command,
        id: r.id,
        message: renamed
          ? "Replaced"
          : `Replaced, but could not set handle "${handle}": ${d.productUpdate.userErrors[0].message}`,
        rowPatches: r.rowPatches,
      };
    }
    case "UPDATE":
    case "MERGE": {
      if (!existing) {
        if (command === "UPDATE") {
          return {
            status: "Failed",
            command,
            message: `Product not found${handle ? ` (no product has the handle "${handle}")` : ""}. To create it, use the command MERGE or NEW.`,
          };
        }
        return created();
      }
      const plan = await planUpdate(ctx, existing, rows, rowNo);
      const seen = { ...existence, ...plan.seen };
      if (plan.errors.length) {
        return { status: "Failed", command, id: existing.id, title: existing.title, message: plan.errors.join("; "), errors: plan.errors };
      }
      const changes = changeLines(plan.changes);
      const clears = plan.changes.filter((c) => c.clears).map((c) => c.label);
      const preview = {
        action: changes.length ? ("update" as const) : ("none" as const),
        changes,
        warnings: [...new Set(plan.warnings)],
        ...(clears.length ? { clears } : {}),
        ...(plan.deletes ? { deletes: plan.deletes } : {}),
        ...(plan.creates ? { creates: plan.creates } : {}),
      };
      if (dry) return { status: "OK", command, id: existing.id, title: existing.title, message: plan.notes.join("; ") || undefined, seen: compactSeen(seen, plan.changes.map((c) => c.label)), preview };
      const stale = staleFields(meta.expectedSeen, seen);
      if (stale.length) return failStale(stale);
      if (!changes.length) {
        return { status: "OK", command, id: existing.id, message: ["No change: already as in the file", ...plan.notes].join("; "), rowPatches: plan.rowPatches, preview };
      }
      // New variants are undone by deleting them, once their IDs are known.
      const undo = () => [
        ...plan.undo,
        ...plan.toCreate.map((v) => plan.rowPatches[v.rowIndex]?.["Variant ID"]).filter(Boolean).map((vid) => ({ ID: gidToId(existing.id), Command: "UPDATE", "Variant ID": vid!, "Variant Command": "DELETE" })),
      ];
      try {
        await applyUpdate(ctx, existing, plan);
      } catch (e: any) {
        // It may have been partly applied: the undo rows still put back whatever was.
        return { status: "Failed", command, id: existing.id, title: existing.title, message: e instanceof ImportError ? e.message : `Error: ${e?.message ?? e}`, undo: undo() };
      }
      return {
        status: "OK",
        command,
        id: existing.id,
        message: [`Updated (${changes.length} change${changes.length === 1 ? "" : "s"})`, ...plan.notes].join("; "),
        rowPatches: plan.rowPatches,
        preview,
        undo: undo(),
      };
    }
    default:
      return { status: "Skipped", command };
  }
}

export const productsEntity: Entity = {
  key: "products",
  sheet: "Products",
  aliases: ["product"],
  description:
    "Products with variants, options, images, metafields and inventory per location.",
  columns: [...PRODUCT_COLUMNS, ...IMAGE_COLUMNS, ...VARIANT_COLUMNS],
  supportsQuery: true,
  groups: [
    { key: "variants", label: "Variants & options", default: true },
    { key: "images", label: "Images & media", default: true },
    { key: "inventory", label: "Inventory by location", default: true },
    { key: "metafields", label: "Product metafields", default: true },
    { key: "variant_metafields", label: "Variant metafields", default: true },
    { key: "seo", label: "SEO", default: true },
  ],
  export: exportProducts,
  // Variant ID / SKU come last: they only identify rows that have no product ID or Handle.
  import: { keyColumns: ["ID", "Handle", "Variant ID", "Variant SKU"], apply: importProduct },
};

// Exported for tests.
export const _internal = { parseVariants, parseImages, productFields, has };
