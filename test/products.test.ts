import { describe, expect, it } from "vitest";
import { imageKey, importProduct, productToRows, variantInputFromRow } from "../app/lib/entities/products";
import type { ImportContext, Row } from "../app/lib/core/types";

/** Mock API: routes by operation name, records every call. */
function mockGql(handlers: Record<string, (vars: any) => any>) {
  const calls: Array<{ op: string; vars: any }> = [];
  const gql = async (query: string, vars: any = {}) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
    calls.push({ op, vars });
    const h = handlers[op];
    if (!h) throw new Error(`Unexpected operation ${op}`);
    return h(vars);
  };
  return { gql, calls, ops: () => calls.map((c) => c.op) };
}

const ctxFor = (gql: any): ImportContext => ({ gql, options: {}, log: () => {}, cache: new Map() });

const LOCATIONS = {
  Locations: () => ({
    locations: {
      nodes: [
        { id: "gid://shopify/Location/1", name: "Warehouse", isActive: true },
        { id: "gid://shopify/Location/2", name: "Shop", isActive: true },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }),
};

const ok = (payload: object) => ({ userErrors: [], ...payload });

describe("product export rows", () => {
  const product = {
    id: "gid://shopify/Product/1",
    handle: "shirt",
    title: "Shirt",
    descriptionHtml: "<p>Hi</p>",
    vendor: "Acme",
    productType: "Tops",
    tags: ["a", "b"],
    status: "ACTIVE",
    publishedAt: "2026-01-01T00:00:00Z",
    isGiftCard: false,
    totalInventory: 7,
    seo: { title: "S", description: null },
    category: { id: "gid://shopify/TaxonomyCategory/aa-1", fullName: "Apparel" },
    metafields: [{ namespace: "custom", key: "fit", type: "single_line_text_field", value: "slim" }],
    media: [
      { id: "gid://shopify/MediaImage/1", mediaContentType: "IMAGE", alt: "front", image: { url: "https://cdn/x/front.jpg", width: 10, height: 20 } },
      { id: "gid://shopify/MediaImage/2", mediaContentType: "IMAGE", alt: "", image: { url: "https://cdn/x/back.jpg" } },
      { id: "gid://shopify/MediaImage/3", mediaContentType: "IMAGE", alt: "", image: { url: "https://cdn/x/side.jpg" } },
    ],
    variants: [
      {
        id: "gid://shopify/ProductVariant/12",
        position: 2,
        sku: "S-L",
        price: "10.00",
        selectedOptions: [{ name: "Size", value: "L" }],
        inventoryPolicy: "DENY",
        inventoryItem: { id: "gid://shopify/InventoryItem/22", tracked: true, measurement: { weight: { value: 1.5, unit: "KILOGRAMS" } }, inventoryLevels: [{ location: { name: "Warehouse" }, quantities: [{ name: "available", quantity: 4 }] }] },
      },
      {
        id: "gid://shopify/ProductVariant/11",
        position: 1,
        sku: "S-M",
        price: "9.00",
        compareAtPrice: "12.00",
        selectedOptions: [{ name: "Size", value: "M" }],
        inventoryItem: { id: "gid://shopify/InventoryItem/21", tracked: false },
        metafields: [{ namespace: "custom", key: "c", type: "list.single_line_text_field", value: '["x","y"]' }],
      },
    ],
  };
  const groups = new Set(["variants", "images", "metafields", "variant_metafields", "inventory", "seo"]);
  const rows = productToRows(product, groups);

  it("emits one row per variant/image, product fields on the top row", () => {
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ID === "1" && r.Handle === "shirt")).toBe(true);
    expect(rows[0]).toMatchObject({ Title: "Shirt", Tags: "a, b", Status: "Active", Published: "TRUE", "Top Row": "TRUE", "Metafield: custom.fit [single_line_text_field]": "slim", "Category: ID": "aa-1" });
    expect(rows[1].Title).toBeUndefined();
    expect(rows[1]["Top Row"]).toBe("FALSE");
  });

  it("sorts variants by position and maps fields", () => {
    expect(rows[0]).toMatchObject({ "Variant ID": "11", "Option1 Name": "Size", "Option1 Value": "M", "Variant Compare At Price": "12.00", "Variant Inventory Tracker": "" });
    expect(rows[0]["Variant Metafield: custom.c [list.single_line_text_field]"]).toBe("x\ny");
    expect(rows[1]).toMatchObject({ "Variant ID": "12", "Variant Weight": "1.5", "Variant Weight Unit": "kg", "Variant Inventory Policy": "deny", "Inventory Available: Warehouse": "4", "Variant Inventory Tracker": "shopify" });
    expect(rows[2]["Variant ID"]).toBeUndefined();
    expect(rows[2]["Image Src"]).toBe("https://cdn/x/side.jpg");
  });
});

describe("product import helpers", () => {
  it("normalises image file names", () => {
    expect(imageKey("https://cdn.shopify.com/s/files/1/products/front_3f2c1b8e-1234-4abc-9def-0123456789ab.jpg?v=1")).toBe("front.jpg");
    expect(imageKey("https://example.com/img/Front.JPEG")).toBe("front.jpg");
    expect(imageKey("https://cdn/x/front_800x.jpg")).toBe("front.jpg");
  });

  it("maps variant columns to API input, blanks clear values", () => {
    const input = variantInputFromRow({
      "Variant Price": "1,234.50",
      "Variant Compare At Price": "",
      "Variant SKU": "X",
      "Variant Barcode": "",
      "Variant Weight": "200",
      "Variant Weight Unit": "g",
      "Variant Inventory Policy": "continue",
      "Variant Inventory Tracker": "shopify",
      "Variant Taxable": "FALSE",
    });
    expect(input).toEqual({
      price: "1234.5",
      compareAtPrice: null,
      barcodes: [],
      taxable: false,
      inventoryPolicy: "CONTINUE",
      inventoryItem: { sku: "X", tracked: true, measurement: { weight: { value: 200, unit: "GRAMS" } } },
    });
    expect(() => variantInputFromRow({ "Variant Weight": "1", "Variant Weight Unit": "stone" })).toThrow(/Weight Unit/);
  });
});

describe("product import", () => {
  const newProductRows: Row[] = [
    {
      Handle: "tee",
      Title: "Tee",
      Vendor: "Acme",
      Tags: "x, y",
      Status: "draft",
      Published: "TRUE",
      "Metafield: custom.fit [single_line_text_field]": "slim",
      "Option1 Name": "Size",
      "Option1 Value": "S",
      "Variant Price": "10",
      "Variant SKU": "T-S",
      "Inventory Available: Warehouse": "5",
      "Image Src": "https://img/a.jpg",
      "Variant Image": "https://img/a.jpg",
    },
    { Handle: "tee", "Option1 Value": "M", "Variant Price": "11", "Variant Inventory Qty": "3", "Image Src": "https://img/b.jpg", "Image Alt Text": "back" },
  ];

  it("creates a product with productSet when it does not exist (MERGE)", async () => {
    const m = mockGql({
      ImportProductByHandle: () => ({ productByIdentifier: null }),
      ...LOCATIONS,
      ImportProductSet: (v) => ({
        productSet: ok({
          product: {
            id: "gid://shopify/Product/5",
            handle: "tee",
            variants: {
              nodes: v.input.variants.map((x: any, i: number) => ({
                id: `gid://shopify/ProductVariant/${50 + i}`,
                selectedOptions: [{ name: "Size", value: x.optionValues[0].name }],
                inventoryItem: { id: `gid://shopify/InventoryItem/${60 + i}` },
              })),
            },
          },
        }),
      }),
      Publications: () => ({ publications: { nodes: [{ id: "gid://shopify/Publication/9", name: "Online Store", catalog: { title: "Online Store" } }] } }),
      Publish: () => ({ publishablePublish: ok({}) }),
    });
    const r = await importProduct(ctxFor(m.gql), newProductRows, "MERGE");
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Product/5", message: "Created" });
    expect(r.rowPatches?.[1]).toEqual({ "Variant ID": "51", "Variant Inventory Item ID": "61" });

    const input = m.calls.find((c) => c.op === "ImportProductSet")!.vars.input;
    expect(input).toMatchObject({ title: "Tee", handle: "tee", vendor: "Acme", status: "DRAFT", tags: ["x", "y"] });
    expect(input.metafields).toEqual([{ namespace: "custom", key: "fit", type: "single_line_text_field", value: "slim" }]);
    expect(input.productOptions).toEqual([{ name: "Size", position: 1, values: [{ name: "S" }, { name: "M" }] }]);
    expect(input.variants[0]).toMatchObject({
      price: "10",
      sku: "T-S",
      optionValues: [{ optionName: "Size", name: "S" }],
      file: { originalSource: "https://img/a.jpg", contentType: "IMAGE" },
      inventoryQuantities: [{ locationId: "gid://shopify/Location/1", name: "available", quantity: 5 }],
      inventoryItem: { tracked: true, sku: "T-S" },
    });
    // Variant Inventory Qty is a cross-location total: ignored in a 2-location store.
    expect(input.variants[1].inventoryQuantities).toBeUndefined();
    expect(input.files).toEqual([
      { originalSource: "https://img/a.jpg", alt: undefined, contentType: "IMAGE" },
      { originalSource: "https://img/b.jpg", alt: "back", contentType: "IMAGE" },
    ]);
    expect(m.ops()).toContain("Publish");
  });

  it("applies Variant Inventory Qty in a single-location store", async () => {
    const m = mockGql({
      ImportProductByHandle: () => ({ productByIdentifier: null }),
      Locations: () => ({ locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main", isActive: true }], pageInfo: { hasNextPage: false } } }),
      ImportProductSet: () => ({ productSet: ok({ product: { id: "gid://shopify/Product/5", handle: "x", variants: { nodes: [] } } }) }),
    });
    await importProduct(ctxFor(m.gql), [{ Handle: "x", Title: "X", "Variant Inventory Qty": "4" }], "NEW");
    const v = m.calls.find((c) => c.op === "ImportProductSet")!.vars.input.variants[0];
    expect(v.inventoryQuantities).toEqual([{ locationId: "gid://shopify/Location/1", name: "available", quantity: 4 }]);
  });

  it("does not change alt text of images already hosted on Shopify (they may be shared)", async () => {
    const logs: string[] = [];
    const m = mockGql({
      ImportProductByHandle: () => ({ productByIdentifier: null }),
      ImportProductSet: () => ({ productSet: ok({ product: { id: "gid://shopify/Product/5", handle: "x", variants: { nodes: [] } } }) }),
    });
    const ctx = { ...ctxFor(m.gql), log: (l: string) => logs.push(l) };
    await importProduct(
      ctx,
      [
        { Handle: "x", Title: "X", "Image Src": "https://cdn.shopify.com/s/files/1/0001/files/bin.jpg?v=1", "Image Alt Text": "Test alt" },
        { Handle: "x", "Image Src": "https://example.com/new.jpg", "Image Alt Text": "New image" },
      ],
      "NEW",
    );
    const files = m.calls.find((c) => c.op === "ImportProductSet")!.vars.input.files;
    expect(files).toEqual([
      { originalSource: "https://cdn.shopify.com/s/files/1/0001/files/bin.jpg?v=1", alt: undefined, contentType: "IMAGE" },
      { originalSource: "https://example.com/new.jpg", alt: "New image", contentType: "IMAGE" },
    ]);
    expect(logs.join(" ")).toMatch(/Alt Text was not applied to images already hosted on Shopify/);
  });

  it("fails NEW when the handle exists and UPDATE when missing", async () => {
    const existing = mockGql({
      ImportProductByHandle: () => ({ productByIdentifier: { id: "gid://shopify/Product/1", handle: "tee", options: [], media: { nodes: [] } } }),
      ImportProductVariants: () => ({ product: { variants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    });
    expect((await importProduct(ctxFor(existing.gql), newProductRows, "NEW")).status).toBe("Failed");
    const missing = mockGql({ ImportProductByHandle: () => ({ productByIdentifier: null }) });
    expect(await importProduct(ctxFor(missing.gql), newProductRows, "UPDATE")).toMatchObject({ status: "Failed", message: "Product not found" });
  });

  const existingProduct = {
    id: "gid://shopify/Product/1",
    handle: "tee",
    title: "Tee",
    hasOnlyDefaultVariant: false,
    options: [{ id: "gid://shopify/ProductOption/1", name: "Size", position: 1, optionValues: [] }],
    media: { nodes: [{ id: "gid://shopify/MediaImage/1", alt: "", mediaContentType: "IMAGE", image: { url: "https://cdn.shopify.com/files/a.jpg?v=2" } }] },
  };
  const existingVariants = [
    { id: "gid://shopify/ProductVariant/10", sku: "T-S", position: 1, selectedOptions: [{ name: "Size", value: "S" }], inventoryItem: { id: "gid://shopify/InventoryItem/100", tracked: true, inventoryLevels: { nodes: [{ location: { id: "gid://shopify/Location/1" } }] } } },
    { id: "gid://shopify/ProductVariant/11", sku: "T-L", position: 2, selectedOptions: [{ name: "Size", value: "L" }], inventoryItem: { id: "gid://shopify/InventoryItem/110", tracked: true, inventoryLevels: { nodes: [] } } },
  ];

  it("merges into an existing product: fields, tags, images, variants and inventory", async () => {
    const m = mockGql({
      ImportProductById: () => ({ product: existingProduct }),
      ImportProductVariants: () => ({ product: { variants: { nodes: existingVariants, pageInfo: { hasNextPage: false, endCursor: null } } } }),
      ImportProductUpdate: () => ({ productUpdate: ok({ product: { id: existingProduct.id, handle: "tee" } }) }),
      TagsAdd: () => ({ tagsAdd: ok({}) }),
      MetafieldsSet: () => ({ metafieldsSet: ok({}) }),
      MetafieldsDelete: () => ({ metafieldsDelete: ok({}) }),
      ImportProductMedia: (v) => ({ productCreateMedia: { media: v.media.map((_: any, i: number) => ({ id: `gid://shopify/MediaImage/${200 + i}`, alt: "" })), mediaUserErrors: [] } }),
      ImportVariantsUpdate: () => ({ productVariantsBulkUpdate: ok({ productVariants: [] }) }),
      ImportVariantsCreate: (v) => ({ productVariantsBulkCreate: ok({ productVariants: v.variants.map((_: any, i: number) => ({ id: `gid://shopify/ProductVariant/${300 + i}`, selectedOptions: [], inventoryItem: { id: `gid://shopify/InventoryItem/${400 + i}` } })) }) }),
      ImportVariantsDelete: () => ({ productVariantsBulkDelete: ok({}) }),
      ...LOCATIONS,
      ImportInventoryActivate: () => ({ inventoryActivate: ok({}) }),
      ImportInventorySet: () => ({ inventorySetQuantities: ok({}) }),
    });
    const rows: Row[] = [
      {
        ID: "1",
        Title: "Tee v2",
        Tags: "new",
        "Tags Command": "MERGE",
        "Metafield: custom.fit [single_line_text_field]": "",
        "Metafield: custom.care [multi_line_text_field]": "Wash cold",
        "Option1 Value": "s",
        "Variant Price": "12",
        "Inventory Available: Warehouse": "8",
        "Inventory Available: Shop": "2",
        "Image Src": "https://example.com/a.jpg",
      },
      { ID: "1", "Option1 Value": "XL", "Variant Price": "14", "Image Src": "https://example.com/c.jpg", "Variant Image": "https://example.com/c.jpg" },
      { ID: "1", "Variant ID": "11", "Variant Command": "DELETE" },
    ];
    const r = await importProduct(ctxFor(m.gql), rows, "MERGE");
    expect(r).toMatchObject({ status: "OK", message: "Updated" });

    const update = m.calls.find((c) => c.op === "ImportProductUpdate")!.vars.product;
    expect(update).toEqual({ id: existingProduct.id, title: "Tee v2" }); // tags merged separately
    expect(m.calls.find((c) => c.op === "TagsAdd")!.vars.tags).toEqual(["new"]);
    expect(m.calls.find((c) => c.op === "MetafieldsDelete")!.vars.metafields).toEqual([{ ownerId: existingProduct.id, namespace: "custom", key: "fit" }]);

    // a.jpg already exists (matched by file name) so only c.jpg is uploaded.
    expect(m.calls.find((c) => c.op === "ImportProductMedia")!.vars.media).toEqual([{ originalSource: "https://example.com/c.jpg", alt: "", mediaContentType: "IMAGE" }]);

    // "s" matches existing variant S case-insensitively.
    const upd = m.calls.find((c) => c.op === "ImportVariantsUpdate")!.vars;
    expect(upd.variants).toEqual([{ id: "gid://shopify/ProductVariant/10", price: "12", optionValues: [{ optionName: "Size", name: "s" }] }]);

    const created = m.calls.find((c) => c.op === "ImportVariantsCreate")!.vars;
    expect(created.strategy).toBe("DEFAULT");
    expect(created.variants[0]).toMatchObject({ price: "14", optionValues: [{ optionName: "Size", name: "XL" }], mediaId: "gid://shopify/MediaImage/200" });

    expect(m.calls.find((c) => c.op === "ImportVariantsDelete")!.vars.variantsIds).toEqual(["gid://shopify/ProductVariant/11"]);

    // Shop location wasn't stocked yet, so it is activated first.
    expect(m.calls.filter((c) => c.op === "ImportInventoryActivate").map((c) => c.vars.locationId)).toEqual(["gid://shopify/Location/2"]);
    expect(m.calls.find((c) => c.op === "ImportInventorySet")!.vars.input.quantities).toEqual([
      { inventoryItemId: "gid://shopify/InventoryItem/100", locationId: "gid://shopify/Location/1", quantity: 8, changeFromQuantity: null },
      { inventoryItemId: "gid://shopify/InventoryItem/100", locationId: "gid://shopify/Location/2", quantity: 2, changeFromQuantity: null },
    ]);
    expect(r.rowPatches?.[1]).toEqual({ "Variant ID": "300", "Variant Inventory Item ID": "400" });
  });

  it("adds options to a product that only had the default variant", async () => {
    const m = mockGql({
      ImportProductByHandle: () => ({
        productByIdentifier: { ...existingProduct, hasOnlyDefaultVariant: true, options: [{ id: "o", name: "Title", position: 1, optionValues: [] }], media: { nodes: [] } },
      }),
      ImportProductVariants: () => ({
        product: { variants: { nodes: [{ ...existingVariants[0], selectedOptions: [{ name: "Title", value: "Default Title" }] }], pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
      ImportProductOptions: () => ({ productOptionsCreate: ok({ product: { options: [] } }) }),
      ImportVariantsCreate: (v) => ({ productVariantsBulkCreate: ok({ productVariants: v.variants.map((_: any, i: number) => ({ id: `gid://shopify/ProductVariant/${i}`, inventoryItem: { id: `gid://shopify/InventoryItem/${i}` } })) }) }),
    });
    const rows: Row[] = [
      { Handle: "tee", "Option1 Name": "Color", "Option1 Value": "Red", "Variant Price": "5" },
      { Handle: "tee", "Option1 Value": "Blue", "Variant Price": "5" },
    ];
    const r = await importProduct(ctxFor(m.gql), rows, "UPDATE");
    expect(r.status).toBe("OK");
    expect(m.calls.find((c) => c.op === "ImportProductOptions")!.vars.options).toEqual([{ name: "Color", values: [{ name: "Red" }, { name: "Blue" }] }]);
    const created = m.calls.find((c) => c.op === "ImportVariantsCreate")!.vars;
    expect(created.strategy).toBe("REMOVE_STANDALONE_VARIANT");
    expect(created.variants).toHaveLength(2);
  });

  it("rejects option renames without REPLACE", async () => {
    const m = mockGql({
      ImportProductByHandle: () => ({ productByIdentifier: existingProduct }),
      ImportProductVariants: () => ({ product: { variants: { nodes: existingVariants, pageInfo: { hasNextPage: false, endCursor: null } } } }),
    });
    await expect(
      importProduct(ctxFor(m.gql), [{ Handle: "tee", "Option1 Name": "Colour", "Option1 Value": "Red" }], "MERGE"),
    ).rejects.toThrow(/Option names/);
  });

  it("deletes and replaces (new product first, then delete, then take the handle)", async () => {
    const m = mockGql({
      ImportProductByHandle: () => ({ productByIdentifier: existingProduct }),
      ImportProductVariants: () => ({ product: { variants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
      ImportProductDelete: () => ({ productDelete: ok({ deletedProductId: existingProduct.id }) }),
      ImportProductSet: () => ({ productSet: ok({ product: { id: "gid://shopify/Product/2", handle: "tee-1", variants: { nodes: [] } } }) }),
      ImportProductUpdate: () => ({ productUpdate: ok({ product: { id: "gid://shopify/Product/2", handle: "tee" } }) }),
    });
    expect(await importProduct(ctxFor(m.gql), [{ Handle: "tee" }], "DELETE")).toMatchObject({ status: "OK", message: "Deleted" });
    m.calls.length = 0;
    const r = await importProduct(ctxFor(m.gql), [{ Handle: "tee", Title: "Tee" }], "REPLACE");
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Product/2", message: "Replaced" });
    expect(m.ops().filter((o) => !o.startsWith("ImportProductBy") && o !== "ImportProductVariants")).toEqual([
      "ImportProductSet",
      "ImportProductDelete",
      "ImportProductUpdate",
    ]);
    const input = m.calls.find((c) => c.op === "ImportProductSet")!.vars.input;
    expect(input.handle).toBeUndefined();
    expect(input.variants).toEqual([{ optionValues: [{ optionName: "Title", name: "Default Title" }] }]);
    expect(input.productOptions).toEqual([{ name: "Title", position: 1, values: [{ name: "Default Title" }] }]);
    expect(m.calls.find((c) => c.op === "ImportProductUpdate")!.vars.product).toEqual({ id: "gid://shopify/Product/2", handle: "tee" });
  });

  it("REPLACE with an invalid row never deletes the existing product", async () => {
    const m = mockGql({
      ImportProductByHandle: () => ({ productByIdentifier: existingProduct }),
      ImportProductVariants: () => ({ product: { variants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
      ...LOCATIONS,
    });
    // No Title, then an unknown location: both must fail before any write.
    await expect(importProduct(ctxFor(m.gql), [{ Handle: "tee" }], "REPLACE")).rejects.toThrow(/Title is required/);
    await expect(
      importProduct(ctxFor(m.gql), [{ Handle: "tee", Title: "T", "Inventory Available: Nowhere": "1" }], "REPLACE"),
    ).rejects.toThrow(/Location "Nowhere" not found/);
    expect(m.ops()).not.toContain("ImportProductDelete");
  });
});
