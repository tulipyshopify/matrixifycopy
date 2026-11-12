import { describe, expect, it } from "vitest";
import { analyzeSheets } from "../app/lib/core/analyze";
import { groupRows } from "../app/lib/core/importer";
import { detectEntity } from "../app/lib/core/registry";
import { ENTITIES } from "../app/lib/entities";
import { importProduct } from "../app/lib/entities/products";
import { directDownloadUrl } from "../app/lib/jobs/sources.server";
import type { Row } from "../app/lib/core/types";

// Layout of a real variant-only sheet: no product ID or Handle, a tab name that
// says nothing about the data type, and a per-location stock adjustment column.
const headers = [
  "Variant ID",
  "Variant SKU",
  "Variant Metafield: custom.restock_date [date]",
  "Variant Metafield: custom.delivery_time [single_line_text_field]",
  "Variant Metafield: custom.pre_order [boolean]",
  "Inventory Available Adjust: Preorder Warehouse",
];
const row = (id: string, sku: string, adjust = ""): Row => ({
  "Variant ID": id,
  "Variant SKU": sku,
  "Variant Metafield: custom.restock_date [date]": "2026-12-10",
  "Variant Metafield: custom.delivery_time [single_line_text_field]": "1-2 working day delivery",
  "Variant Metafield: custom.pre_order [boolean]": "TRUE",
  "Inventory Available Adjust: Preorder Warehouse": adjust,
});

describe("Google Sheets links", () => {
  it("leaves 'publish to web' download links alone", () => {
    const pub = "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=1561396288&single=true&output=csv";
    expect(directDownloadUrl(pub)).toBe(pub);
    expect(directDownloadUrl("https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml")).toBe("https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=xlsx");
    // Ordinary share links are still exported as Excel.
    expect(directDownloadUrl("https://docs.google.com/spreadsheets/d/1AbC/edit?usp=sharing")).toBe("https://docs.google.com/spreadsheets/d/1AbC/export?format=xlsx");
  });
});

describe("variant-only sheets", () => {
  it("are recognised as Products from their columns when the name says nothing", () => {
    expect(detectEntity({ name: "Arrival Dates - Arrival Dates", headers }, ENTITIES)?.key).toBe("products");
    expect(detectEntity({ name: "Sheet1", headers: ["Path", "Target"] }, ENTITIES)?.key).toBe("redirects");
    expect(detectEntity({ name: "Sheet1", headers: ["Title", "Tags"] }, ENTITIES)).toBeNull(); // too generic to guess
    const [a] = analyzeSheets([{ name: "Arrival Dates", headers, rows: [row("10", "PP0063"), row("11", "PP0064")] }], ENTITIES);
    expect(a).toMatchObject({ entity: "products", items: 2, unknown: [], keyColumns: ["Variant ID", "Variant SKU"] });
  });

  it("each variant row is its own item", () => {
    const items = groupRows([row("10", "A"), row("11", "B")], ["ID", "Handle", "Variant ID", "Variant SKU"]);
    expect(items.map((i) => i.rows.length)).toEqual([1, 1]);
  });

  const product = {
    id: "gid://shopify/Product/1", handle: "bin", title: "Bin", hasOnlyDefaultVariant: false,
    options: [{ id: "o", name: "Size", position: 1, optionValues: [] }], media: { nodes: [] },
  };
  const variants = [
    { id: "gid://shopify/ProductVariant/10", sku: "PP0063", position: 1, selectedOptions: [{ name: "Size", value: "S" }], inventoryItem: { id: "gid://shopify/InventoryItem/100", tracked: true, inventoryLevels: { nodes: [] } } },
    { id: "gid://shopify/ProductVariant/11", sku: "PP0064", position: 2, selectedOptions: [{ name: "Size", value: "L" }], inventoryItem: { id: "gid://shopify/InventoryItem/110", tracked: true, inventoryLevels: { nodes: [] } } },
  ];
  function mock(extra: Record<string, (v: any) => any> = {}) {
    const calls: Array<{ op: string; vars: any }> = [];
    const handlers: Record<string, (v: any) => any> = {
      ImportVariantProduct: (v) => ({ productVariant: variants.some((x) => x.id === v.id) ? { id: v.id, product: { id: product.id } } : null }),
      ImportVariantsBySku: () => ({ productVariants: { nodes: variants.map((v) => ({ id: v.id, sku: v.sku, product: { id: product.id } })), pageInfo: { hasNextPage: false } } }),
      ImportProductById: () => ({ product }),
      ImportProductVariants: () => ({ product: { variants: { nodes: variants, pageInfo: { hasNextPage: false } } } }),
      MetafieldsSet: () => ({ metafieldsSet: { userErrors: [] } }),
      ImportVariantsUpdate: () => ({ productVariantsBulkUpdate: { productVariants: [], userErrors: [] } }),
      Locations: () => ({ locations: { nodes: [{ id: "gid://shopify/Location/5", name: "Preorder Warehouse", isActive: true }, { id: "gid://shopify/Location/6", name: "Main", isActive: true }], pageInfo: { hasNextPage: false } } }),
      ImportInventoryActivate: () => ({ inventoryActivate: { userErrors: [] } }),
      ImportInventoryAdjust: () => ({ inventoryAdjustQuantities: { userErrors: [] } }),
      ...extra,
    };
    const gql = async (q: string, v: any = {}) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(q)![1];
      calls.push({ op, vars: v });
      if (!handlers[op]) throw new Error(`Unexpected operation ${op}`);
      return handlers[op](v);
    };
    return { gql, calls };
  }
  const ctx = (gql: any) => ({ gql, options: {}, log: () => {}, cache: new Map() });

  it("updates the variant's metafields and adjusts stock at the named location, found by Variant ID", async () => {
    const m = mock();
    const r = await importProduct(ctx(m.gql), [row("11", "PP0064", "-3")], "MERGE");
    expect(r).toMatchObject({ status: "OK", id: product.id, message: "Updated" });
    const upd = m.calls.find((c) => c.op === "ImportVariantsUpdate")!.vars;
    expect(upd.productId).toBe(product.id);
    expect(upd.variants).toHaveLength(1);
    expect(upd.variants[0]).toMatchObject({
      id: "gid://shopify/ProductVariant/11",
      metafields: [
        { namespace: "custom", key: "restock_date", type: "date", value: "2026-12-10" },
        { namespace: "custom", key: "delivery_time", type: "single_line_text_field", value: "1-2 working day delivery" },
        { namespace: "custom", key: "pre_order", type: "boolean", value: "true" },
      ],
    });
    expect(m.calls.find((c) => c.op === "ImportInventoryAdjust")!.vars.input.changes).toEqual([
      { inventoryItemId: "gid://shopify/InventoryItem/110", locationId: "gid://shopify/Location/5", delta: -3, changeFromQuantity: null },
    ]);
    // The product itself is not touched and nothing is created.
    expect(m.calls.map((c) => c.op)).not.toContain("ImportProductUpdate");
    expect(m.calls.map((c) => c.op)).not.toContain("ImportProductSet");
  });

  it("finds the product by exact Variant SKU when there is no Variant ID; blank adjust cells change no stock", async () => {
    const m = mock();
    const r = await importProduct(ctx(m.gql), [row("", "PP0063")], "MERGE");
    expect(r.status).toBe("OK");
    expect(m.calls.find((c) => c.op === "ImportVariantsUpdate")!.vars.variants[0].id).toBe("gid://shopify/ProductVariant/10");
    expect(m.calls.map((c) => c.op)).not.toContain("ImportInventoryAdjust");
  });

  it("fails clearly, without creating anything, when the variant does not exist", async () => {
    const m = mock();
    expect(await importProduct(ctx(m.gql), [row("999", "X")], "MERGE")).toMatchObject({ status: "Failed", message: "No variant found with Variant ID 999" });
    expect(await importProduct(ctx(m.gql), [row("", "NOPE")], "MERGE")).toMatchObject({ status: "Failed", message: 'No variant found with Variant SKU "NOPE"' });
    expect(m.calls.some((c) => /Set|Update|Adjust/.test(c.op))).toBe(false);
  });
});
