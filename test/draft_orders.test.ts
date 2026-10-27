import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import type { ExportContext, ImportContext, Row } from "../app/lib/core/types";
import { draftOrderToRows, draftOrdersBulkQuery, draftOrdersEntity, importDraftOrder } from "../app/lib/entities/draft_orders";

type Handler = (vars: any) => any;

function mockGql(handlers: Record<string, Handler>) {
  const calls: Array<{ op: string; vars: any }> = [];
  const gql = async (query: string, vars: any = {}) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    calls.push({ op, vars });
    const h = handlers[op];
    if (!h) throw new Error(`Unexpected operation ${op}`);
    return h(vars);
  };
  return { gql: gql as any, calls, ops: () => calls.map((c) => c.op) };
}

const importCtx = (gql: any): ImportContext => ({ gql, options: {}, log: () => {}, cache: new Map() });
const ok = { userErrors: [] };

const sampleDraft = {
  id: "gid://shopify/DraftOrder/500",
  name: "#D5",
  status: "OPEN",
  email: "c@example.com",
  phone: null,
  createdAt: "2026-02-01T00:00:00Z",
  updatedAt: "2026-02-02T00:00:00Z",
  completedAt: null,
  invoiceUrl: "https://shop.example/invoices/abc",
  invoiceSentAt: null,
  reserveInventoryUntil: "2026-03-01T00:00:00Z",
  currencyCode: "USD",
  taxesIncluded: false,
  taxExempt: false,
  tags: ["quote"],
  note2: "Call first",
  discountCodes: [],
  order: null,
  subtotalPriceSet: { shopMoney: { amount: "45.0" } },
  totalDiscountsSet: { shopMoney: { amount: "5.0" } },
  totalShippingPriceSet: { shopMoney: { amount: "0.0" } },
  totalTaxSet: { shopMoney: { amount: "0.0" } },
  totalPriceSet: { shopMoney: { amount: "40.0" } },
  appliedDiscount: { title: "Loyalty", description: "", value: 10, valueType: "PERCENTAGE", amountSet: { shopMoney: { amount: "5.0" } } },
  customer: { id: "gid://shopify/Customer/8", defaultEmailAddress: { emailAddress: "c@example.com" } },
  billingAddress: null,
  shippingAddress: { firstName: "Cy", city: "Austin", countryCodeV2: "US", provinceCode: "TX" },
  shippingLine: null,
  metafields: [{ namespace: "custom", key: "po", type: "single_line_text_field", value: "PO-1" }],
  lineItems: [
    {
      id: "gid://shopify/DraftOrderLineItem/1", title: "Mug", variantTitle: null, sku: "MUG", quantity: 3, vendor: "Acme",
      requiresShipping: true, taxable: true, custom: false,
      originalUnitPriceSet: { shopMoney: { amount: "10.0" } }, totalDiscountSet: { shopMoney: { amount: "0.0" } },
      appliedDiscount: null, variant: { id: "gid://shopify/ProductVariant/9" }, product: { id: "gid://shopify/Product/3" },
    },
    {
      id: "gid://shopify/DraftOrderLineItem/2", title: "Setup fee", variantTitle: null, sku: null, quantity: 1, vendor: null,
      requiresShipping: false, taxable: false, custom: true,
      originalUnitPriceSet: { shopMoney: { amount: "15.0" } }, totalDiscountSet: { shopMoney: { amount: "1.5" } },
      appliedDiscount: { title: "Setup promo", description: "first order", value: 1.5, valueType: "FIXED_AMOUNT" }, variant: null, product: null,
      customAttributes: [{ key: "engraving", value: "A & B" }, { key: "gift", value: "" }],
      priceOverride: null,
      weight: { unit: "KILOGRAMS", value: 0.5 },
    },
  ],
};

// sampleDraft's lines as ImportDraftOrderDetail returns them (current state on update).
const currentLines = sampleDraft.lineItems.map((li: any) => ({
  ...li,
  originalUnitPriceWithCurrency: { amount: li.originalUnitPriceSet.shopMoney.amount },
  customAttributes: li.customAttributes ?? [],
  priceOverride: li.id.endsWith("/1") ? { amount: "9.0" } : null,
  weight: li.weight ?? null,
}));
const currentDraft = {
  id: sampleDraft.id,
  appliedDiscount: sampleDraft.appliedDiscount,
  lineItems: { nodes: currentLines, pageInfo: { hasNextPage: false, endCursor: null } },
};

describe("draft orders export", () => {
  it("maps a bulk draft order to rows", () => {
    const rows = draftOrderToRows(sampleDraft, new Set(["line_items", "metafields"]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ID: "500",
      Name: "#D5",
      Command: "MERGE",
      Status: "open",
      "Invoice URL": "https://shop.example/invoices/abc",
      "Reserve Inventory Until": "2026-03-01T00:00:00Z",
      Note: "Call first",
      Tags: "quote",
      "Customer: ID": "8",
      "Applied Discount: Title": "Loyalty",
      "Applied Discount: Value Type": "percentage",
      "Applied Discount: Value": "10",
      "Applied Discount: Amount": "5.0",
      "Shipping: City": "Austin",
      "Shipping: Province Code": "TX",
      "Line: Variant ID": "9",
      "Line: Quantity": "3",
      "Line: Custom": "FALSE",
      "Metafield: custom.po [single_line_text_field]": "PO-1",
    });
    expect(rows[1]).toMatchObject({
      ID: "500",
      Name: "#D5",
      "Line: Title": "Setup fee",
      "Line: Custom": "TRUE",
      "Line: Price": "15.0",
      "Line: Applied Discount: Value Type": "fixed_amount",
      "Line: Applied Discount: Value": "1.5",
    });
    expect(rows[1].Status).toBeUndefined();
  });

  it("emits rows from the bulk runner", async () => {
    const queries: string[] = [];
    const out: Row[][] = [];
    const ctx: ExportContext = {
      gql: (async () => ({})) as any,
      bulk: (q) => {
        queries.push(q);
        return (async function* () {
          yield sampleDraft;
        })();
      },
      options: { groups: ["line_items"] },
      log: () => {},
      cache: new Map(),
      progress: () => {},
    };
    await draftOrdersEntity.export!(ctx, async (rows) => {
      out.push(rows);
    });
    expect(queries[0]).not.toContain("metafields");
    expect(out[0]).toHaveLength(2);
  });

  const SCHEMA_FILE = path.resolve(".cache/schema/admin_2026-10.json.gz");
  it.skipIf(!fs.existsSync(SCHEMA_FILE))("bulk export query matches the Admin API schema", () => {
    const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString("utf8"));
    const schema = buildClientSchema(json.data ?? json);
    const q = draftOrdersBulkQuery("status:open", new Set(draftOrdersEntity.groups!.map((g) => g.key)));
    expect(validate(schema, parse(q)).map((e) => e.message)).toEqual([]);
  });
});

describe("draft orders import", () => {
  it("creates a draft order with variant and custom lines", async () => {
    const m = mockGql({
      ImportDraftOrderByName: () => ({ draftOrders: { nodes: [] } }),
      OrderCommonShopCurrency: () => ({ shop: { currencyCode: "USD" } }),
      ImportDraftOrderCustomer: (v) => {
        expect(v).toEqual({ email: "c@example.com" });
        return { customerByIdentifier: { id: "gid://shopify/Customer/8" } };
      },
      ImportDraftOrderCreate: () => ({
        draftOrderCreate: {
          ...ok,
          draftOrder: {
            id: "gid://shopify/DraftOrder/77",
            name: "#D77",
            invoiceUrl: "https://x/inv",
            lineItems: { nodes: [{ id: "gid://shopify/DraftOrderLineItem/a" }, { id: "gid://shopify/DraftOrderLineItem/b" }] },
          },
        },
      }),
    });
    const rows: Row[] = [
      {
        Name: "#Q-1",
        Command: "NEW",
        Note: "quote",
        Tags: "b2b",
        "Customer: Email": "c@example.com",
        "Reserve Inventory Until": "2026-12-01T00:00:00Z",
        "Applied Discount: Value": "10",
        "Applied Discount: Value Type": "percentage",
        "Applied Discount: Title": "Promo",
        "Shipping Line: Title": "Courier",
        "Shipping Line: Price": "4",
        "Metafield: custom.po [single_line_text_field]": "PO-9",
        "Line: Variant ID": "9",
        "Line: Quantity": "3",
        "Line: Price": "10",
      },
      { "Line: Title": "Setup fee", "Line: Price": "15", "Line: Applied Discount: Value": "1.5", "Line: Applied Discount: Value Type": "fixed_amount" },
    ];
    const r = await importDraftOrder(importCtx(m.gql), rows, "NEW");
    expect(r.status).toBe("OK");
    const input = m.calls.find((c) => c.op === "ImportDraftOrderCreate")!.vars.input;
    expect(input).toEqual({
      lineItems: [
        { quantity: 3, variantId: "gid://shopify/ProductVariant/9" },
        {
          quantity: 1,
          title: "Setup fee",
          originalUnitPriceWithCurrency: { amount: "15", currencyCode: "USD" },
          appliedDiscount: { value: 1.5, valueType: "FIXED_AMOUNT", amountWithCurrency: { amount: "1.5", currencyCode: "USD" } },
        },
      ],
      note: "quote",
      reserveInventoryUntil: "2026-12-01T00:00:00Z",
      purchasingEntity: { customerId: "gid://shopify/Customer/8" },
      shippingLine: { title: "Courier", priceWithCurrency: { amount: "4", currencyCode: "USD" } },
      appliedDiscount: { value: 10, valueType: "PERCENTAGE", title: "Promo" },
      tags: ["b2b"],
      metafields: [{ namespace: "custom", key: "po", type: "single_line_text_field", value: "PO-9" }],
    });
    expect(r.rowPatches?.[0]).toMatchObject({ ID: "77", Name: "#D77", "Invoice URL": "https://x/inv", "Line: ID": "a" });
    expect(r.rowPatches?.[1]).toMatchObject({ ID: "77", "Line: ID": "b" });
  });

  it("updates an existing draft (MERGE): replaces lines, tags and removes the discount", async () => {
    const m = mockGql({
      ImportDraftOrderById: () => ({ draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5", status: "OPEN" } }),
      ImportDraftOrderDetail: () => ({ draftOrder: currentDraft }),
      OrderCommonShopCurrency: () => ({ shop: { currencyCode: "USD" } }),
      ImportDraftOrderUpdate: () => ({
        draftOrderUpdate: { ...ok, draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5", invoiceUrl: null, lineItems: { nodes: [{ id: "x/1" }] } } },
      }),
      MetafieldsSet: () => ({ metafieldsSet: ok }),
    });
    const rows: Row[] = [
      {
        ID: "500",
        Email: "d@example.com",
        Tags: "a, b",
        "Tags Command": "REPLACE",
        "Applied Discount: Value": "",
        "Metafield: custom.po [single_line_text_field]": "PO-2",
        "Line: Variant ID": "9",
        "Line: Quantity": "4",
      },
    ];
    const r = await importDraftOrder(importCtx(m.gql), rows, "MERGE");
    expect(r.status).toBe("OK");
    expect(m.ops()).toEqual(["ImportDraftOrderById", "ImportDraftOrderDetail", "OrderCommonShopCurrency", "ImportDraftOrderUpdate", "MetafieldsSet"]);
    expect(m.calls[3].vars).toEqual({
      id: "gid://shopify/DraftOrder/500",
      input: {
        lineItems: [{ quantity: 4, variantId: "gid://shopify/ProductVariant/9" }],
        email: "d@example.com",
        appliedDiscount: null,
        tags: ["a", "b"],
      },
    });
  });

  it("refuses to update a completed draft", async () => {
    const m = mockGql({ ImportDraftOrderById: () => ({ draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1", status: "COMPLETED" } }) });
    await expect(importDraftOrder(importCtx(m.gql), [{ ID: "1", Note: "x" }], "UPDATE")).rejects.toThrow(/completed/);
  });

  it("deletes a draft order", async () => {
    const m = mockGql({
      ImportDraftOrderByName: () => ({ draftOrders: { nodes: [{ id: "gid://shopify/DraftOrder/5", name: "#D5", status: "OPEN" }] } }),
      ImportDraftOrderDelete: () => ({ draftOrderDelete: { ...ok, deletedId: "gid://shopify/DraftOrder/5" } }),
    });
    const r = await importDraftOrder(importCtx(m.gql), [{ Name: "#D5" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted" });
    expect(m.calls[1].vars).toEqual({ input: { id: "gid://shopify/DraftOrder/5" } });
  });

  it("DELETE fails when not found", async () => {
    const m = mockGql({ ImportDraftOrderByName: () => ({ draftOrders: { nodes: [{ id: "x", name: "#D50", status: "OPEN" }] } }) });
    const r = await importDraftOrder(importCtx(m.gql), [{ Name: "#D5" }], "DELETE");
    expect(r.status).toBe("Failed");
  });

  // --- Regression tests ---------------------------------------------------------

  it("REPLACE without line columns fails before deleting the draft", async () => {
    const m = mockGql({
      ImportDraftOrderById: () => ({ draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5", status: "OPEN" } }),
      OrderCommonShopCurrency: () => ({ shop: { currencyCode: "USD" } }),
      ImportDraftOrderDelete: () => ({ draftOrderDelete: { ...ok, deletedId: "x" } }),
    });
    await expect(importDraftOrder(importCtx(m.gql), [{ ID: "500", Note: "x" }], "REPLACE")).rejects.toThrow(/line item is required/);
    expect(m.ops()).not.toContain("ImportDraftOrderDelete");
  });

  it("REPLACE with an unknown SKU fails before deleting the draft", async () => {
    const m = mockGql({
      ImportDraftOrderById: () => ({ draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5", status: "OPEN" } }),
      OrderCommonShopCurrency: () => ({ shop: { currencyCode: "USD" } }),
      OrderCommonVariantBySku: () => ({ productVariants: { nodes: [] } }),
      ImportDraftOrderDelete: () => ({ draftOrderDelete: { ...ok, deletedId: "x" } }),
    });
    await expect(importDraftOrder(importCtx(m.gql), [{ ID: "500", "Line: SKU": "NOPE" }], "REPLACE")).rejects.toThrow(/Line: Title/);
    expect(m.ops()).not.toContain("ImportDraftOrderDelete");
  });

  it("REPLACE builds the input, then deletes and creates", async () => {
    const m = mockGql({
      ImportDraftOrderById: () => ({ draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5", status: "OPEN" } }),
      OrderCommonShopCurrency: () => ({ shop: { currencyCode: "USD" } }),
      ImportDraftOrderDelete: () => ({ draftOrderDelete: { ...ok, deletedId: "x" } }),
      ImportDraftOrderCreate: () => ({ draftOrderCreate: { ...ok, draftOrder: { id: "gid://shopify/DraftOrder/9", name: "#D9", lineItems: { nodes: [] } } } }),
    });
    const r = await importDraftOrder(importCtx(m.gql), [{ ID: "500", "Line: Variant ID": "9" }], "REPLACE");
    expect(r).toMatchObject({ status: "OK", message: "Replaced" });
    expect(m.ops()).toEqual(["ImportDraftOrderById", "OrderCommonShopCurrency", "ImportDraftOrderDelete", "ImportDraftOrderCreate"]);
  });

  it("exports custom attributes, price override, weight and line discount title/description", () => {
    const rows = draftOrderToRows({ ...sampleDraft, lineItems: currentLines }, new Set(["line_items"]));
    expect(rows[0]["Line: Price Override"]).toBe("9.0");
    expect(rows[1]).toMatchObject({
      "Line: Applied Discount: Title": "Setup promo",
      "Line: Applied Discount: Description": "first order",
      "Line: Weight": "0.5",
      "Line: Weight Unit": "kilograms",
      "Line: Custom Attributes": "engraving: A & B\ngift: ",
    });
  });

  it("MERGE of an unchanged exported draft does not send lineItems", async () => {
    const m = mockGql({
      ImportDraftOrderById: () => ({ draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5", status: "OPEN" } }),
      ImportDraftOrderDetail: () => ({ draftOrder: currentDraft }),
      ImportDraftOrderUpdate: () => ({ draftOrderUpdate: { ...ok, draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5", lineItems: { nodes: [] } } } }),
      MetafieldsSet: () => ({ metafieldsSet: ok }),
    });
    const rows = draftOrderToRows({ ...sampleDraft, lineItems: currentLines }, new Set(["line_items"]));
    const r = await importDraftOrder(importCtx(m.gql), rows, "MERGE");
    expect(r.status).toBe("OK");
    const input = m.calls.find((c) => c.op === "ImportDraftOrderUpdate")!.vars.input;
    expect(input.lineItems).toBeUndefined();
    expect(input.appliedDiscount).toEqual({ value: 10, valueType: "PERCENTAGE", title: "Loyalty" });
  });

  it("MERGE with a changed line re-sends every line losslessly", async () => {
    const m = mockGql({
      ImportDraftOrderById: () => ({ draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5", status: "OPEN" } }),
      ImportDraftOrderDetail: () => ({ draftOrder: currentDraft }),
      ImportDraftOrderUpdate: () => ({
        draftOrderUpdate: { ...ok, draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5", lineItems: { nodes: [{ id: "gid://shopify/DraftOrderLineItem/71" }, { id: "gid://shopify/DraftOrderLineItem/72" }] } } },
      }),
    });
    // Partial sheet: Line: ID + Quantity only; everything else comes from the current lines.
    const rows: Row[] = [
      { ID: "500", Currency: "USD", "Line: ID": "1", "Line: Quantity": "5" },
      { ID: "500", "Line: ID": "2", "Line: Quantity": "1" },
    ];
    const r = await importDraftOrder(importCtx(m.gql), rows, "MERGE");
    expect(r.status).toBe("OK");
    const input = m.calls.find((c) => c.op === "ImportDraftOrderUpdate")!.vars.input;
    expect(input.lineItems).toEqual([
      { quantity: 5, variantId: "gid://shopify/ProductVariant/9", priceOverride: { amount: "9", currencyCode: "USD" } },
      {
        quantity: 1,
        title: "Setup fee",
        originalUnitPriceWithCurrency: { amount: "15", currencyCode: "USD" },
        requiresShipping: false,
        taxable: false,
        weight: { unit: "KILOGRAMS", value: 0.5 },
        appliedDiscount: {
          value: 1.5,
          valueType: "FIXED_AMOUNT",
          amountWithCurrency: { amount: "1.5", currencyCode: "USD" },
          title: "Setup promo",
          description: "first order",
        },
        customAttributes: [{ key: "engraving", value: "A & B" }, { key: "gift", value: "" }],
      },
    ]);
    expect(r.rowPatches?.[1]).toMatchObject({ "Line: ID": "72" });
  });

  it("applied discount Value without Value Type keeps the current type and title", async () => {
    const m = mockGql({
      ImportDraftOrderById: () => ({ draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5", status: "OPEN" } }),
      ImportDraftOrderDetail: () => ({ draftOrder: currentDraft }),
      OrderCommonShopCurrency: () => ({ shop: { currencyCode: "USD" } }),
      ImportDraftOrderUpdate: () => ({ draftOrderUpdate: { ...ok, draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D5" } } }),
    });
    await importDraftOrder(importCtx(m.gql), [{ ID: "500", "Applied Discount: Value": "20" }], "MERGE");
    const input = m.calls.find((c) => c.op === "ImportDraftOrderUpdate")!.vars.input;
    expect(input.appliedDiscount).toEqual({ value: 20, valueType: "PERCENTAGE", title: "Loyalty" });
  });

  it("finds a draft by exact Name past prefix matches on later pages", async () => {
    const m = mockGql({
      ImportDraftOrderByName: (v) =>
        v.after
          ? { draftOrders: { nodes: [{ id: "gid://shopify/DraftOrder/1", name: "#D1", status: "OPEN" }], pageInfo: { hasNextPage: false, endCursor: null } } }
          : {
              draftOrders: {
                nodes: Array.from({ length: 250 }, (_, i) => ({ id: `gid://shopify/DraftOrder/${i + 10}`, name: `#D1${i}`, status: "OPEN" })),
                pageInfo: { hasNextPage: true, endCursor: "c1" },
              },
            },
      ImportDraftOrderDelete: () => ({ draftOrderDelete: { ...ok, deletedId: "x" } }),
    });
    const r = await importDraftOrder(importCtx(m.gql), [{ Name: "#D1" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/DraftOrder/1" });
    expect(m.calls[1].vars).toMatchObject({ query: 'name:"#D1"', after: "c1" });
  });

  it("fails when several drafts have the exact Name", async () => {
    const m = mockGql({
      ImportDraftOrderByName: () => ({
        draftOrders: { nodes: [{ id: "a", name: "#D1", status: "OPEN" }, { id: "b", name: "#d1", status: "OPEN" }], pageInfo: { hasNextPage: false } },
      }),
    });
    await expect(importDraftOrder(importCtx(m.gql), [{ Name: "#D1" }], "DELETE")).rejects.toThrow(/Several draft orders/);
  });
});
