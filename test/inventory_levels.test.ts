import fs from "node:fs";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { selectColumns } from "../app/lib/core/exporter";
import { getEntity } from "../app/lib/entities";
import { importProduct, productToRows, productsBulkQuery } from "../app/lib/entities/products";
import { orderToRows } from "../app/lib/entities/orders";
import { variableErrors } from "./_variables";

const jobs = await import("../app/lib/jobs/jobs.server");
const SCHEMA_FILE = ".cache/schema/admin_2026-10.json.gz";
const ALL = jobs.INVENTORY_KIND_NAMES;

describe("multi-location inventory levels", () => {
  it("exports each chosen quantity as a column per location", () => {
    const p = {
      id: "gid://shopify/Product/1", handle: "bin", title: "Bin",
      variants: [{ id: "gid://shopify/ProductVariant/10", sku: "A", selectedOptions: [], inventoryItem: { id: "gid://shopify/InventoryItem/100", inventoryLevels: [
        { location: { name: "Main" }, quantities: [{ name: "available", quantity: 7 }, { name: "on_hand", quantity: 12 }, { name: "committed", quantity: 3 }, { name: "damaged", quantity: 2 }, { name: "incoming", quantity: 40 }] },
        { location: { name: "Depot" }, quantities: [{ name: "available", quantity: 0 }, { name: "safety_stock", quantity: 5 }] },
      ] } }],
    };
    const row = productToRows(p, new Set(["variants", "inventory"])).find((r) => r["Variant ID"] === "10")!;
    expect(row).toMatchObject({
      "Inventory Available: Main": "7", "Inventory On Hand: Main": "12", "Inventory Committed: Main": "3", "Inventory Damaged: Main": "2",
      "Inventory Incoming: Main": "40", "Inventory Available: Depot": "0", "Inventory Safety Stock: Depot": "5",
    });
    expect(productsBulkQuery("", new Set(["variants", "inventory"]), ["available", "reserved"])).toContain('quantities(names: ["available","reserved"])');
    // The location choice applies to every quantity.
    const products = getEntity("products")!;
    expect(selectColumns(products, { locations: ["main"] }, ["ID", "Inventory Available: Main", "Inventory On Hand: Main", "Inventory On Hand: Depot", "Inventory Incoming: Depot"])).toEqual([
      "ID", "Inventory Available: Main", "Inventory On Hand: Main",
    ]);
  });

  it("validates the chosen quantities", () => {
    const o = jobs.parseExportConfig({ entities: [{ entity: "products", options: { inventoryKinds: ["incoming", "bogus", "available"] } }] }).entities[0].options;
    expect(o.inventoryKinds).toEqual(["available", "incoming"]);
    expect(jobs.parseExportConfig({ entities: [{ entity: "orders", options: { inventoryKinds: ["incoming"] } as any }] }).entities[0].options.inventoryKinds).toBeUndefined();
  });

  it.skipIf(!fs.existsSync(SCHEMA_FILE))("query with every quantity matches the Admin API schema", () => {
    const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString());
    const q = productsBulkQuery("", new Set(["variants", "inventory"]), ALL);
    expect(validate(buildClientSchema(json.data ?? json), parse(q)).map((e) => e.message)).toEqual([]);
  });

  const product = { id: "gid://shopify/Product/1", handle: "bin", title: "Bin", hasOnlyDefaultVariant: false, options: [{ id: "o", name: "Size", position: 1, optionValues: [] }], media: { nodes: [] } };
  const variants = [{ id: "gid://shopify/ProductVariant/10", sku: "A", position: 1, selectedOptions: [{ name: "Size", value: "S" }], inventoryItem: { id: "gid://shopify/InventoryItem/100", tracked: true, inventoryLevels: { nodes: [] } } }];
  function mock() {
    const calls: Array<{ op: string; vars: any; query: string }> = [];
    const handlers: Record<string, (v: any) => any> = {
      ImportVariantProduct: (v) => ({ productVariant: { id: v.id, product: { id: product.id } } }),
      ImportProductById: () => ({ product }),
      ImportProductVariants: () => ({ product: { variants: { nodes: variants, pageInfo: { hasNextPage: false } } } }),
      ImportVariantsUpdate: () => ({ productVariantsBulkUpdate: { productVariants: [], userErrors: [] } }),
      Locations: () => ({ locations: { nodes: [{ id: "gid://shopify/Location/5", name: "Main", isActive: true }, { id: "gid://shopify/Location/6", name: "Depot", isActive: true }], pageInfo: { hasNextPage: false } } }),
      ImportInventoryActivate: () => ({ inventoryActivate: { userErrors: [] } }),
      ImportInventoryCurrent: () => ({ inventoryItem: { inventoryLevel: { quantities: [{ name: "damaged", quantity: 4 }] } } }),
      ImportInventorySet: () => ({ inventorySetQuantities: { userErrors: [] } }),
      ImportInventoryAdjust: () => ({ inventoryAdjustQuantities: { userErrors: [] } }),
    };
    const gql = async (q: string, v: any = {}) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(q)![1];
      calls.push({ op, vars: v, query: q });
      if (!handlers[op]) throw new Error(`Unexpected operation ${op}`);
      return handlers[op](v);
    };
    return { gql, calls };
  }

  it("imports set and adjust columns for each writable quantity, and ignores the read-only ones", async () => {
    const m = mock();
    const r = await importProduct({ gql: m.gql as any, options: {}, log: () => {}, cache: new Map() }, [{
      "Variant ID": "10",
      "Inventory Available: Main": "9",
      "Inventory On Hand: Depot": "20",
      "Inventory Damaged: Main": "1", // 4 there now
      "Inventory Safety Stock Adjust: Main": "2",
      "Inventory On Hand Adjust: Main": "-5",
      "Inventory Quality Control Adjust: Depot": "",
      "Inventory Committed: Main": "99",
      "Inventory Incoming: Main": "99",
    }], "MERGE");
    expect(r.status).toBe("OK");
    const item = "gid://shopify/InventoryItem/100";
    const main = "gid://shopify/Location/5";
    const depot = "gid://shopify/Location/6";
    const sets = m.calls.filter((c) => c.op === "ImportInventorySet").map((c) => c.vars.input);
    expect(sets).toEqual([
      { name: "available", reason: "correction", quantities: [{ inventoryItemId: item, locationId: main, quantity: 9, changeFromQuantity: null }] },
      { name: "on_hand", reason: "correction", quantities: [{ inventoryItemId: item, locationId: depot, quantity: 20, changeFromQuantity: null }] },
    ]);
    const adjusts = Object.fromEntries(m.calls.filter((c) => c.op === "ImportInventoryAdjust").map((c) => [c.vars.input.name, c.vars.input.changes]));
    expect(adjusts).toEqual({
      safety_stock: [{ inventoryItemId: item, locationId: main, delta: 2, changeFromQuantity: null, ledgerDocumentUri: "bulkport://import" }],
      // On hand moves with available stock.
      available: [{ inventoryItemId: item, locationId: main, delta: -5, changeFromQuantity: null }],
      // Damaged is set by moving it from 4 to 1.
      damaged: [{ inventoryItemId: item, locationId: main, delta: -3, changeFromQuantity: null, ledgerDocumentUri: "bulkport://import" }],
    });
    if (fs.existsSync(SCHEMA_FILE)) {
      for (const c of m.calls.filter((c) => /Inventory/.test(c.op))) expect(variableErrors(c.query, c.vars), c.op).toEqual([]);
    }
  });
});

describe("Orders: line item columns", () => {
  const bag = (shop: string, presentment = shop) => ({ shopMoney: { amount: shop }, presentmentMoney: { amount: presentment } });
  const li = {
    id: "gid://shopify/LineItem/1", title: "Shirt", name: "Shirt - Blue", variantTitle: "Blue", sku: "S1", quantity: 4, currentQuantity: 3, refundableQuantity: 3, unfulfilledQuantity: 1,
    vendor: "Acme", requiresShipping: true, taxable: true, isGiftCard: false, weight: { value: 1.5, unit: "KILOGRAMS" },
    originalUnitPriceSet: bag("10.00", "12.00"), totalDiscountSet: bag("4.00", "4.80"), discountedTotalSet: bag("36.00", "43.20"),
    discountAllocations: [{ allocatedAmountSet: bag("4.00", "4.80") }, { allocatedAmountSet: bag("1.50", "1.80") }],
    taxLines: [{ title: "VAT", rate: 0.2, channelLiable: false, priceSet: bag("6.00", "7.20") }, { title: "Eco", rate: 0.01, channelLiable: null, priceSet: bag("0.30", "0.36") }],
    variant: { id: "gid://shopify/ProductVariant/55" }, product: { id: "gid://shopify/Product/9", handle: "shirt" },
  };

  it("has the full set, in order", () => {
    const cols = getEntity("orders")!.columns.filter((c) => c.startsWith("Line: ")).slice(0, 49);
    expect(cols.slice(0, 13)).toEqual(["Line: Type", "Line: ID", "Line: Command", "Line: Product ID", "Line: Product Handle", "Line: Title", "Line: Name", "Line: Variant ID", "Line: Variant Title", "Line: SKU", "Line: Quantity", "Line: Current Quantity", "Line: Refundable Quantity"]);
    for (const c of ["Line: Price (Shop Currency)", "Line: Discount Allocation", "Line: Discount per Item (Shop Currency)", "Line: Total", "Line: Grams", "Line: Gift Card", "Line: Force Gift Card", "Line: Tax Total", "Line: Tax 1 Title", "Line: Tax 3 Channel Liable", "Line: Fulfillable Quantity", "Line: Fulfillment Status"])
      expect(cols, c).toContain(c);
  });

  it("fills them from the order line", () => {
    const row = orderToRows({ id: "gid://shopify/Order/1", name: "#1", lineItems: [li] }, new Set(["line_items"]))[0];
    expect(row).toMatchObject({
      "Line: Type": "Line Item", "Line: ID": "1", "Line: Command": "DEFAULT", "Line: Product ID": "9", "Line: Product Handle": "shirt", "Line: Name": "Shirt - Blue",
      "Line: Quantity": "4", "Line: Current Quantity": "3", "Line: Refundable Quantity": "3",
      "Line: Price": "12.00", "Line: Price (Shop Currency)": "10.00",
      "Line: Discount": "4.80", "Line: Discount (Shop Currency)": "4.00",
      "Line: Discount Allocation": "6.6", "Line: Discount Allocation (Shop Currency)": "5.5",
      "Line: Discount per Item": "1.2", "Line: Discount per Item (Shop Currency)": "1",
      "Line: Total": "43.20", "Line: Total (Shop Currency)": "36.00",
      "Line: Grams": "1500", "Line: Gift Card": "FALSE", "Line: Force Gift Card": "No", "Line: Taxable": "TRUE",
      "Line: Tax Total": "7.56", "Line: Tax Total (Shop Currency)": "6.3",
      "Line: Tax 1 Title": "VAT", "Line: Tax 1 Rate": "0.2", "Line: Tax 1 Price": "7.20", "Line: Tax 1 Price (Shop Currency)": "6.00", "Line: Tax 1 Channel Liable": "FALSE",
      "Line: Tax 2 Title": "Eco", "Line: Tax 2 Channel Liable": "",
      "Line: Fulfillable Quantity": "1", "Line: Fulfillment Status": "partial",
    });
    expect(row["Line: Tax 3 Title"]).toBeUndefined();
  });
});
