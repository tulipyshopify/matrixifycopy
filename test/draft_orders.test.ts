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
      appliedDiscount: { value: 1.5, valueType: "FIXED_AMOUNT" }, variant: null, product: null,
    },
  ],
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
    expect(m.ops()).toEqual(["ImportDraftOrderById", "OrderCommonShopCurrency", "ImportDraftOrderUpdate", "MetafieldsSet"]);
    expect(m.calls[2].vars).toEqual({
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
});
