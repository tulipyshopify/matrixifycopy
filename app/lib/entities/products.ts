import type { Command, Entity, ExportContext, Gql, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
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

const OPTION_COLUMNS = ["Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value"];

const IMAGE_COLUMNS = ["Image Type", "Image Src", "Image Command", "Image Position", "Image Width", "Image Height", "Image Alt Text"];

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
  (c) => !["Variant Command", "Option1 Name", "Option2 Name", "Option3 Name"].includes(c),
);

const INVENTORY_PREFIX = "Inventory Available: ";

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
const WEIGHT_UNIT_CELL: Record<string, string> = { GRAMS: "g", KILOGRAMS: "kg", OUNCES: "oz", POUNDS: "lb" };

const STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"];

function titleCase(s: string | null | undefined) {
  return s ? s[0] + s.slice(1).toLowerCase() : "";
}

// --- Export -------------------------------------------------------------------------

export function productsBulkQuery(search: string, groups: Set<string>): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  const metafields = `metafields { edges { node { id namespace key type value } } }`;
  const media = `media { edges { node { id mediaContentType alt ... on MediaImage { image { url width height } } preview { image { url width height } } } } }`;
  const inventoryLevels = `inventoryLevels { edges { node { id location { id name } quantities(names: ["available"]) { name quantity } } } }`;
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
      ${groups.has("variant_metafields") ? metafields : ""}
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
  const variants: any[] = (p.variants ?? []).sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
  const media: any[] = p.media ?? [];
  const count = Math.max(1, variants.length, media.length);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const row: Row = { ID: gidToId(p.id), Handle: p.handle, "Row #": String(i + 1), "Top Row": boolCell(i === 0) };
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
        "Variant Weight Unit": WEIGHT_UNIT_CELL[inv.measurement?.weight?.unit] ?? "",
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
      for (const lvl of inv.inventoryLevels ?? []) {
        const q = (lvl.quantities ?? []).find((x: any) => x.name === "available");
        row[INVENTORY_PREFIX + lvl.location.name] = str(q?.quantity ?? "");
      }
      if (groups.has("variant_metafields")) metafieldsToRow(row, v.metafields, "Variant Metafield");
    }
    rows.push(row);
  }
  return rows;
}

async function exportProducts(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? productsEntity.groups!.filter((g) => g.default).map((g) => g.key));
  const search = buildSearchQuery(ctx.options);
  let n = 0;
  for await (const p of ctx.bulk(productsBulkQuery(search, groups))) {
    await emit(productToRows(p, groups));
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import: fetching existing products --------------------------------------

const PRODUCT_FIELDS = `#graphql
  fragment ImportProduct on Product {
    id handle title hasOnlyDefaultVariant
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
          id sku position
          selectedOptions { name value }
          inventoryItem { id tracked inventoryLevels(first: 100) { nodes { location { id } } } }
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
  selectedOptions: Array<{ name: string; value: string }>;
  inventoryItem: { id: string; tracked: boolean; inventoryLevels: { nodes: Array<{ location: { id: string } }> } };
}

interface ExistingProduct {
  id: string;
  handle: string;
  title: string;
  hasOnlyDefaultVariant: boolean;
  options: Array<{ id: string; name: string; position: number; optionValues: Array<{ id: string; name: string }> }>;
  media: { nodes: Array<{ id: string; alt: string; mediaContentType: string; image?: { url: string } }> };
  variants: ExistingVariant[];
}

async function fetchProduct(gql: Gql, by: { id?: string; handle?: string }): Promise<ExistingProduct | null> {
  let p: any = null;
  if (by.id) p = (await gql(PRODUCT_BY_ID, { id: by.id })).product;
  if (!p && by.handle) p = (await gql(PRODUCT_BY_HANDLE, { handle: by.handle })).productByIdentifier;
  if (!p) return null;
  const variants: ExistingVariant[] = [];
  let after: string | null = null;
  do {
    const d: any = await gql(PRODUCT_VARIANTS, { id: p.id, after });
    variants.push(...d.product.variants.nodes);
    after = d.product.variants.pageInfo.hasNextPage ? d.product.variants.pageInfo.endCursor : null;
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
  inventory: Array<{ locationName: string; quantity: number }>;
  totalQty?: number;
  adjust?: number;
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
  if (VARIANT_SIGNAL_COLUMNS.some((c) => (cell(row, c) ?? "") !== "")) return true;
  return Object.keys(row).some((k) => (k.startsWith(INVENTORY_PREFIX) || k.startsWith("Variant Metafield:")) && (row[k] ?? "").trim() !== "");
}

function money(v: string | undefined, col: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === "") return null;
  const n = parseNumber(v);
  if (n === undefined) return null;
  if (n < 0) throw new ImportError(`${col} cannot be negative`);
  return String(n);
}

export function variantInputFromRow(row: Row): Record<string, any> {
  const input: Record<string, any> = {};
  const inventoryItem: Record<string, any> = {};

  const price = money(cell(row, "Variant Price"), "Variant Price");
  if (price) input.price = price; // blank price = unchanged
  const cap = money(cell(row, "Variant Compare At Price"), "Variant Compare At Price");
  if (cap !== undefined) input.compareAtPrice = cap;

  const sku = cell(row, "Variant SKU");
  if (sku !== undefined) inventoryItem.sku = sku;
  const barcode = cell(row, "Variant Barcode");
  if (barcode !== undefined) input.barcodes = barcode ? [{ value: barcode }] : [];

  const taxable = parseBool(cell(row, "Variant Taxable"));
  if (taxable !== undefined) input.taxable = taxable;
  const taxCode = cell(row, "Variant Tax Code");
  if (taxCode) input.taxCode = taxCode;

  const policy = cell(row, "Variant Inventory Policy");
  if (policy) {
    const p = policy.toUpperCase();
    if (p !== "DENY" && p !== "CONTINUE") throw new ImportError(`Variant Inventory Policy must be deny or continue`);
    input.inventoryPolicy = p;
  }

  const tracker = cell(row, "Variant Inventory Tracker");
  if (tracker !== undefined) inventoryItem.tracked = tracker.toLowerCase() === "shopify" || parseBool(tracker) === true;

  const ship = parseBool(cell(row, "Variant Requires Shipping"));
  if (ship !== undefined) inventoryItem.requiresShipping = ship;

  const cost = cell(row, "Variant Cost");
  if (cost) inventoryItem.cost = String(parseNumber(cost));

  const hs = cell(row, "Variant HS Code");
  if (hs !== undefined) inventoryItem.harmonizedSystemCode = hs || null;
  const coo = cell(row, "Variant Country of Origin");
  if (coo !== undefined) inventoryItem.countryCodeOfOrigin = coo ? coo.toUpperCase() : null;
  const poo = cell(row, "Variant Province of Origin");
  if (poo !== undefined) inventoryItem.provinceCodeOfOrigin = poo || null;

  const weight = parseNumber(cell(row, "Variant Weight"));
  if (weight !== undefined) {
    const unitCell = (cell(row, "Variant Weight Unit") || "kg").toLowerCase();
    const unit = WEIGHT_UNITS[unitCell];
    if (!unit) throw new ImportError(`Unknown Variant Weight Unit "${unitCell}" (use g, kg, oz or lb)`);
    inventoryItem.measurement = { weight: { value: weight, unit } };
  }

  if (Object.keys(inventoryItem).length) input.inventoryItem = inventoryItem;
  return input;
}

function parseVariants(rows: Row[]): { names: string[]; variants: VariantSpec[] } {
  const names: string[] = [];
  for (let n = 1; n <= 3; n++) {
    const r = rows.find((row) => cell(row, `Option${n} Name`));
    if (r) names[n - 1] = cell(r, `Option${n} Name`)!;
  }
  const variants: VariantSpec[] = [];
  rows.forEach((row, rowIndex) => {
    if (!isVariantRow(row)) return;
    const optionValues: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const v = cell(row, `Option${n} Value`);
      if (v) optionValues[n - 1] = v;
    }
    const inventory: VariantSpec["inventory"] = [];
    for (const k of Object.keys(row)) {
      if (!k.startsWith(INVENTORY_PREFIX)) continue;
      const q = parseInt10(row[k]);
      if (q !== undefined) inventory.push({ locationName: k.slice(INVENTORY_PREFIX.length).trim(), quantity: q });
    }
    variants.push({
      rowIndex,
      id: toGid("ProductVariant", cell(row, "Variant ID")),
      command: parseSubCommand(cell(row, "Variant Command"), ["MERGE", "DELETE", "UPDATE"] as const, "MERGE") === "DELETE" ? "DELETE" : "MERGE",
      optionValues,
      input: variantInputFromRow(row),
      imageSrc: cell(row, "Variant Image") || undefined,
      inventory,
      totalQty: parseInt10(cell(row, "Variant Inventory Qty")),
      adjust: parseInt10(cell(row, "Variant Inventory Adjust")),
      metafields: metafieldsFromRow(row, "Variant Metafield"),
    });
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
      command: parseSubCommand(cell(row, "Image Command"), ["MERGE", "DELETE", "REPLACE"] as const, "MERGE"),
    });
  });
  images.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.rowIndex - b.rowIndex);
  return images;
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
  base = base.replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "");
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
    if (!STATUSES.includes(s)) throw new ImportError(`Status must be one of Active, Draft, Archived, Unlisted`);
    f.status = s;
  }
  const tpl = cell(row, "Template Suffix");
  if (tpl !== undefined) f.templateSuffix = tpl || null;
  const cat = cell(row, "Category: ID");
  if (cat) f.category = cat.startsWith("gid://") ? cat : `gid://shopify/TaxonomyCategory/${cat}`;
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
  const active = (await getLocations(ctx.gql, ctx.cache)).filter((l) => l.isActive);
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

async function applyInventory(ctx: ImportContext, work: InventoryWork[]) {
  const quantities: Array<{ inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: null }> = [];
  const changes: Array<{ inventoryItemId: string; locationId: string; delta: number; changeFromQuantity: null }> = [];
  for (const w of work) {
    const targets: Array<{ locationId: string; quantity: number }> = [];
    for (const inv of w.spec.inventory) {
      const loc = await locationByName(ctx.gql, ctx.cache, inv.locationName);
      targets.push({ locationId: loc.id, quantity: inv.quantity });
    }
    if (!w.spec.inventory.length && w.spec.totalQty !== undefined) {
      const locationId = await singleLocationId(ctx);
      if (locationId) targets.push({ locationId, quantity: w.spec.totalQty });
    }
    const locs = targets.map((t) => t.locationId);
    if (w.spec.adjust) {
      const locationId = locs[0] ?? (await singleLocationId(ctx));
      if (locationId) {
        changes.push({ inventoryItemId: w.inventoryItemId, locationId, delta: w.spec.adjust, changeFromQuantity: null });
        locs.push(locationId);
      }
    }
    for (const locationId of new Set(locs)) {
      if (w.activeLocations.has(locationId)) continue;
      const d = await ctx.gql(INVENTORY_ACTIVATE, { inventoryItemId: w.inventoryItemId, locationId });
      const err = d.inventoryActivate.userErrors?.[0];
      if (err && !/already/i.test(err.message)) throw new ImportError(`Inventory: ${err.message}`);
      w.activeLocations.add(locationId);
    }
    for (const t of targets) quantities.push({ inventoryItemId: w.inventoryItemId, ...t, changeFromQuantity: null });
  }
  for (let i = 0; i < quantities.length; i += 250) {
    const d = await ctx.gql(INVENTORY_SET, {
      input: { name: "available", reason: "correction", quantities: quantities.slice(i, i + 250) },
    });
    assertNoUserErrors(d.inventorySetQuantities, "Inventory");
  }
  if (changes.length) {
    const d = await ctx.gql(INVENTORY_ADJUST, { input: { name: "available", reason: "correction", changes } });
    assertNoUserErrors(d.inventoryAdjustQuantities, "Inventory adjust");
  }
}

function setVariantInput(spec: VariantSpec, names: string[], images: Set<string>): Record<string, any> {
  const input: Record<string, any> = { ...spec.input };
  if (input.inventoryItem?.sku !== undefined) input.sku = input.inventoryItem.sku;
  input.optionValues = names.length
    ? names.map((name, i) => {
        const value = spec.optionValues[i];
        if (!value) throw new ImportError(`Variant on row ${spec.rowIndex + 1} is missing Option${i + 1} Value`);
        return { optionName: name, name: value };
      })
    : [{ optionName: "Title", name: "Default Title" }];
  if (spec.imageSrc) {
    images.add(spec.imageSrc);
    input.file = { originalSource: spec.imageSrc, contentType: "IMAGE" };
  }
  return input;
}

async function createProduct(
  ctx: ImportContext,
  rows: Row[],
  top: Row,
): Promise<{ id: string; rowPatches: Array<Row | undefined> }> {
  const fields = productFields(top);
  if (!fields.title) throw new ImportError("Title is required to create a product");
  const { names, variants } = parseVariants(rows);
  const live = variants.filter((v) => v.command !== "DELETE");
  if (!live.length) live.push({ rowIndex: 0, command: "MERGE", optionValues: [], input: {}, inventory: [], metafields: { set: [], blank: [] } });
  if (names.length === 0 && live.length > 1) throw new ImportError("Several variants given but no Option1 Name");

  const input: Record<string, any> = { ...fields };
  const giftCard = parseBool(cell(top, "Gift Card"));
  if (giftCard !== undefined) input.giftCard = giftCard;
  const tags = cell(top, "Tags");
  if (tags) input.tags = splitTags(tags);
  const mf = metafieldsFromRow(top).set;
  if (mf.length) input.metafields = mf;

  const variantImages = new Set<string>();
  const optionNames = names.length ? names : ["Title"];
  input.variants = live.map((v) => setVariantInput(v, names, variantImages));
  // Inventory for new products: set at create time.
  const locationQty = new Map<VariantSpec, Array<{ locationId: string; name: string; quantity: number }>>();
  for (const [i, v] of live.entries()) {
    const q: Array<{ locationId: string; name: string; quantity: number }> = [];
    for (const inv of v.inventory) {
      q.push({ locationId: (await locationByName(ctx.gql, ctx.cache, inv.locationName)).id, name: "available", quantity: inv.quantity });
    }
    if (!v.inventory.length && v.totalQty !== undefined) {
      const locationId = await singleLocationId(ctx);
      if (locationId) q.push({ locationId, name: "available", quantity: v.totalQty });
    }
    if (q.length) {
      input.variants[i].inventoryQuantities = q;
      input.variants[i].inventoryItem = { tracked: true, ...input.variants[i].inventoryItem };
      locationQty.set(v, q);
    }
    if (v.metafields.set.length) input.variants[i].metafields = v.metafields.set;
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
  const files = images.map((im) => ({ originalSource: im.src, alt: im.alt || undefined, contentType: "IMAGE" }));
  for (const src of variantImages) {
    if (!images.some((im) => im.src === src)) files.push({ originalSource: src, alt: undefined, contentType: "IMAGE" });
  }
  if (files.length) input.files = files;

  const d = await ctx.gql(PRODUCT_SET, { input });
  assertNoUserErrors(d.productSet, "Create product");
  const product = d.productSet.product;

  const published = parseBool(cell(top, "Published"));
  if (published) await setOnlineStorePublished(ctx.gql, ctx.cache, product.id, true, cell(top, "Published At") || undefined);

  // Variant IDs back into the result file.
  const rowPatches: Array<Row | undefined> = [];
  const created: any[] = product.variants.nodes;
  live.forEach((v) => {
    const match = created.find((c) =>
      (names.length ? names : ["Title"]).every(
        (n, i) => c.selectedOptions.find((o: any) => o.name === n)?.value === (names.length ? v.optionValues[i] : "Default Title"),
      ),
    );
    if (match) {
      rowPatches[v.rowIndex] = { "Variant ID": gidToId(match.id), "Variant Inventory Item ID": gidToId(match.inventoryItem.id) };
    }
  });
  return { id: product.id, rowPatches };
}

async function updateProduct(
  ctx: ImportContext,
  existing: ExistingProduct,
  rows: Row[],
  top: Row,
  command: Command,
): Promise<{ rowPatches: Array<Row | undefined>; notes: string[] }> {
  const notes: string[] = [];
  const productId = existing.id;

  // 1. Product fields.
  const fields = productFields(top);
  if (fields.handle === existing.handle) delete fields.handle;
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
  const images = parseImages(rows);
  const existingMedia = existing.media.nodes.filter((m) => m.image?.url);
  const mediaByKey = new Map(existingMedia.map((m) => [imageKey(m.image!.url), m]));
  if (images.length) {
    const replace = images.some((im) => im.command === "REPLACE");
    const wanted = images.filter((im) => im.command !== "DELETE");
    const toDelete = new Set<string>();
    for (const im of images.filter((i) => i.command === "DELETE")) {
      const m = mediaByKey.get(imageKey(im.src));
      if (m) toDelete.add(m.id);
    }
    if (replace) {
      const keep = new Set(wanted.map((im) => imageKey(im.src)));
      for (const m of existingMedia) if (!keep.has(imageKey(m.image!.url))) toDelete.add(m.id);
    }
    if (toDelete.size) {
      const d = await ctx.gql(MEDIA_DELETE, { productId, mediaIds: [...toDelete] });
      if (d.productDeleteMedia.mediaUserErrors?.length) {
        throw new ImportError(`Images: ${d.productDeleteMedia.mediaUserErrors[0].message}`);
      }
      for (const [k, m] of mediaByKey) if (toDelete.has(m.id)) mediaByKey.delete(k);
    }
    const toAdd = wanted.filter((im) => !mediaByKey.has(imageKey(im.src)));
    if (toAdd.length) {
      const d = await ctx.gql(MEDIA_CREATE, {
        productId,
        media: toAdd.map((im) => ({ originalSource: im.src, alt: im.alt ?? "", mediaContentType: "IMAGE" })),
      });
      if (d.productCreateMedia.mediaUserErrors?.length) {
        throw new ImportError(`Images: ${d.productCreateMedia.mediaUserErrors[0].message}`);
      }
      d.productCreateMedia.media.forEach((m: any, i: number) => {
        mediaByKey.set(imageKey(toAdd[i].src), { id: m.id, alt: m.alt, mediaContentType: "IMAGE", image: { url: toAdd[i].src } });
      });
    }
  }

  // 3. Variants.
  const { names: sheetNames, variants } = parseVariants(rows);
  const rowPatches: Array<Row | undefined> = [];
  if (!variants.length) return { rowPatches, notes };

  let options = existing.options;
  const isDefault = existing.hasOnlyDefaultVariant && options.length === 1 && options[0].name === "Title";
  let names = sheetNames.length ? sheetNames : isDefault ? [] : options.map((o) => o.name);
  if (sheetNames.length && !isDefault) {
    const existingNames = options.map((o) => o.name.toLowerCase());
    const mismatch = sheetNames.some((n, i) => existingNames[i] !== n.toLowerCase());
    if (mismatch) {
      throw new ImportError(
        `Option names (${sheetNames.join(", ")}) differ from the product's (${options.map((o) => o.name).join(", ")}). Use command REPLACE to restructure options.`,
      );
    }
    names = options.map((o) => o.name);
  }

  const findExisting = (v: VariantSpec): ExistingVariant | undefined => {
    if (v.id) return existing.variants.find((e) => e.id === v.id);
    if (names.length && v.optionValues.length) {
      return existing.variants.find((e) =>
        names.every(
          (n, i) =>
            (e.selectedOptions.find((o) => o.name.toLowerCase() === n.toLowerCase())?.value ?? "").toLowerCase() ===
            (v.optionValues[i] ?? "").toLowerCase(),
        ),
      );
    }
    const sku = v.input.inventoryItem?.sku;
    if (sku) return existing.variants.find((e) => e.sku === sku);
    if (!names.length && existing.variants.length === 1) return existing.variants[0];
    return undefined;
  };

  const toUpdate: Array<{ spec: VariantSpec; existing: ExistingVariant }> = [];
  const toCreate: VariantSpec[] = [];
  const toDelete: string[] = [];
  for (const v of variants) {
    const ex = findExisting(v);
    if (v.command === "DELETE") {
      if (ex) toDelete.push(ex.id);
      else notes.push(`Variant on row ${v.rowIndex + 1} to delete not found`);
      continue;
    }
    if (ex) toUpdate.push({ spec: v, existing: ex });
    else if (v.id) throw new ImportError(`Variant ID ${gidToId(v.id)} not found on this product`);
    else toCreate.push(v);
  }

  const newMedia: Array<{ originalSource: string; mediaContentType: string }> = [];
  const mediaFor = (spec: VariantSpec): Record<string, any> => {
    if (!spec.imageSrc) return {};
    const m = mediaByKey.get(imageKey(spec.imageSrc));
    if (m) return { mediaId: m.id };
    if (!newMedia.some((x) => x.originalSource === spec.imageSrc)) {
      newMedia.push({ originalSource: spec.imageSrc, mediaContentType: "IMAGE" });
    }
    return { mediaSrc: [spec.imageSrc] };
  };

  const inventoryWork: InventoryWork[] = [];

  if (toUpdate.length) {
    newMedia.length = 0;
    const inputs = toUpdate.map(({ spec, existing: ex }) => ({
      id: ex.id,
      ...spec.input,
      ...mediaFor(spec),
      ...(spec.metafields.set.length ? { metafields: spec.metafields.set } : {}),
      ...(names.length && spec.optionValues.length
        ? { optionValues: names.map((name, i) => ({ optionName: name, name: spec.optionValues[i] })).filter((o) => o.name) }
        : {}),
    }));
    const d = await ctx.gql(VARIANTS_UPDATE, { productId, variants: inputs, media: newMedia.length ? [...newMedia] : null });
    assertNoUserErrors(d.productVariantsBulkUpdate, "Update variants");
    for (const { spec, existing: ex } of toUpdate) {
      rowPatches[spec.rowIndex] = { "Variant ID": gidToId(ex.id), "Variant Inventory Item ID": gidToId(ex.inventoryItem.id) };
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
      options = d.productOptionsCreate.product.options;
    }
    newMedia.length = 0;
    const inputs = [];
    for (const spec of toCreate) {
      if (names.length && names.some((_, i) => !spec.optionValues[i])) {
        throw new ImportError(`New variant on row ${spec.rowIndex + 1} needs a value for every option (${names.join(", ")})`);
      }
      if (!names.length) throw new ImportError(`New variant on row ${spec.rowIndex + 1} needs Option1 Name/Value`);
      const inventoryQuantities: Array<{ locationId: string; availableQuantity: number }> = [];
      for (const inv of spec.inventory) {
        inventoryQuantities.push({
          locationId: (await locationByName(ctx.gql, ctx.cache, inv.locationName)).id,
          availableQuantity: inv.quantity,
        });
      }
      if (!spec.inventory.length && spec.totalQty !== undefined) {
        const locationId = await singleLocationId(ctx);
        if (locationId) inventoryQuantities.push({ locationId, availableQuantity: spec.totalQty });
      }
      inputs.push({
        ...spec.input,
        ...mediaFor(spec),
        ...(spec.metafields.set.length ? { metafields: spec.metafields.set } : {}),
        ...(inventoryQuantities.length
          ? { inventoryQuantities, inventoryItem: { tracked: true, ...spec.input.inventoryItem } }
          : {}),
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
      rowPatches[spec.rowIndex] = { "Variant ID": gidToId(c.id), "Variant Inventory Item ID": gidToId(c.inventoryItem.id) };
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

  const needsInventory = inventoryWork.filter((w) => w.spec.inventory.length || w.spec.totalQty !== undefined || w.spec.adjust);
  if (needsInventory.length) await applyInventory(ctx, needsInventory);

  return { rowPatches, notes };
}

async function deleteProduct(gql: Gql, id: string) {
  const d = await gql(PRODUCT_DELETE, { id });
  assertNoUserErrors(d.productDelete, "Delete product");
}

export async function importProduct(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const top = rows[0];
  const id = toGid("Product", cell(top, "ID"));
  const handle = cell(top, "Handle");
  let existing = id || handle ? await fetchProduct(ctx.gql, { id, handle }) : null;

  switch (command) {
    case "DELETE": {
      if (!existing) return { status: "Failed", command, message: "Product not found" };
      await deleteProduct(ctx.gql, existing.id);
      return { status: "OK", command, id: existing.id, message: "Deleted" };
    }
    case "NEW": {
      if (existing) return { status: "Failed", command, id: existing.id, message: `Product with handle "${existing.handle}" already exists` };
      const r = await createProduct(ctx, rows, top);
      return { status: "OK", command, id: r.id, message: "Created", rowPatches: r.rowPatches };
    }
    case "REPLACE": {
      if (existing) await deleteProduct(ctx.gql, existing.id);
      const r = await createProduct(ctx, rows, top);
      return { status: "OK", command, id: r.id, message: existing ? "Replaced" : "Created", rowPatches: r.rowPatches };
    }
    case "UPDATE":
    case "MERGE": {
      if (!existing) {
        if (command === "UPDATE") return { status: "Failed", command, message: "Product not found" };
        const r = await createProduct(ctx, rows, top);
        return { status: "OK", command, id: r.id, message: "Created", rowPatches: r.rowPatches };
      }
      const r = await updateProduct(ctx, existing, rows, top, command);
      return {
        status: "OK",
        command,
        id: existing.id,
        message: ["Updated", ...r.notes].join("; "),
        rowPatches: r.rowPatches,
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
  description: "Products with variants, options, images, metafields and inventory per location.",
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
  import: { keyColumns: ["ID", "Handle"], apply: importProduct },
};

// Exported for tests.
export const _internal = { parseVariants, parseImages, productFields, has };
