import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import type { ExportContext, ImportContext, Row } from "../app/lib/core/types";
import { importOrder, orderToRows, ordersBulkQuery, ordersEntity } from "../app/lib/entities/orders";

// --- Mock gql ---------------------------------------------------------------------

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

function importCtx(gql: any): ImportContext {
  return { gql, options: {}, log: () => {}, cache: new Map() };
}

const ok = { userErrors: [] };

// --- Export -----------------------------------------------------------------------

const sampleOrder = {
  id: "gid://shopify/Order/1001",
  name: "#1001",
  email: "a@example.com",
  phone: null,
  createdAt: "2026-01-01T10:00:00Z",
  updatedAt: "2026-01-02T10:00:00Z",
  processedAt: "2026-01-01T10:00:00Z",
  cancelledAt: null,
  cancelReason: null,
  closedAt: null,
  currencyCode: "USD",
  displayFinancialStatus: "PARTIALLY_REFUNDED",
  displayFulfillmentStatus: "FULFILLED",
  tags: ["vip", "wholesale"],
  note: "Leave at door",
  sourceName: "web",
  discountCodes: ["SAVE10"],
  subtotalPriceSet: { shopMoney: { amount: "90.0" } },
  totalDiscountsSet: { shopMoney: { amount: "10.0" } },
  totalShippingPriceSet: { shopMoney: { amount: "5.0" } },
  totalTaxSet: { shopMoney: { amount: "9.0" } },
  totalPriceSet: { shopMoney: { amount: "104.0" } },
  totalRefundedSet: { shopMoney: { amount: "20.0" } },
  customer: { id: "gid://shopify/Customer/7", firstName: "Ann", lastName: "Lee", defaultEmailAddress: { emailAddress: "a@example.com" } },
  billingAddress: { firstName: "Ann", lastName: "Lee", address1: "1 Main St", city: "Springfield", provinceCode: "IL", province: "Illinois", zip: "62701", country: "United States", countryCodeV2: "US" },
  shippingAddress: null,
  shippingLine: { title: "Standard", code: "STD", originalPriceSet: { shopMoney: { amount: "5.0" } } },
  transactions: [
    { id: "gid://shopify/OrderTransaction/1", kind: "SALE", gateway: "shopify_payments", status: "SUCCESS", processedAt: "2026-01-01T10:00:00Z", amountSet: { shopMoney: { amount: "104.0", currencyCode: "USD" } } },
    { id: "gid://shopify/OrderTransaction/2", kind: "REFUND", gateway: "shopify_payments", status: "SUCCESS", processedAt: "2026-01-03T10:00:00Z", amountSet: { shopMoney: { amount: "20.0", currencyCode: "USD" } } },
    { id: "gid://shopify/OrderTransaction/3", kind: "VOID", gateway: "manual", status: "FAILURE", processedAt: null, amountSet: { shopMoney: { amount: "1.0", currencyCode: "USD" } } },
  ],
  metafields: [{ id: "gid://shopify/Metafield/1", namespace: "custom", key: "gift", type: "boolean", value: "true" }],
  lineItems: [
    {
      id: "gid://shopify/LineItem/11", title: "Shirt", variantTitle: "M", sku: "SH-M", quantity: 2, unfulfilledQuantity: 0,
      vendor: "Acme", requiresShipping: true, taxable: true,
      originalUnitPriceSet: { shopMoney: { amount: "40.0" } }, totalDiscountSet: { shopMoney: { amount: "8.0" } },
      variant: { id: "gid://shopify/ProductVariant/55" }, product: { id: "gid://shopify/Product/5" },
    },
    {
      id: "gid://shopify/LineItem/12", title: "Gift wrap", variantTitle: null, sku: null, quantity: 1, unfulfilledQuantity: 1,
      vendor: null, requiresShipping: false, taxable: false,
      originalUnitPriceSet: { shopMoney: { amount: "10.0" } }, totalDiscountSet: { shopMoney: { amount: "0.0" } },
      variant: null, product: null,
    },
  ],
};

const allGroups = new Set(["line_items", "transactions", "metafields"]);

describe("orders export", () => {
  it("maps a bulk order to rows (line items and transactions share rows)", () => {
    const rows = orderToRows(sampleOrder, allGroups);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ID === "1001" && r.Name === "#1001")).toBe(true);
    const top = rows[0];
    expect(top).toMatchObject({
      Command: "MERGE",
      Email: "a@example.com",
      Currency: "USD",
      "Financial Status": "partially_refunded",
      "Fulfillment Status": "fulfilled",
      Subtotal: "90.0",
      "Total Discounts": "10.0",
      "Total Price": "104.0",
      "Total Refunded": "20.0",
      Tags: "vip, wholesale",
      Note: "Leave at door",
      Source: "web",
      "Customer: ID": "7",
      "Customer: Email": "a@example.com",
      "Discount Codes": "SAVE10",
      "Billing: City": "Springfield",
      "Billing: Country Code": "US",
      "Shipping: City": "",
      "Shipping Line: Title": "Standard",
      "Shipping Line: Price": "5.0",
      "Line: ID": "11",
      "Line: Variant ID": "55",
      "Line: Product ID": "5",
      "Line: SKU": "SH-M",
      "Line: Quantity": "2",
      "Line: Price": "40.0",
      "Line: Discount": "8.0",
      "Line: Requires Shipping": "TRUE",
      "Line: Fulfillable Quantity": "0",
      "Transaction: Kind": "sale",
      "Transaction: Amount": "104.0",
      "Metafield: custom.gift [boolean]": "true",
    });
    expect(rows[1]).toMatchObject({ "Line: Title": "Gift wrap", "Line: Variant ID": "", "Line: Taxable": "FALSE", "Transaction: Kind": "refund" });
    expect(rows[1].Email).toBeUndefined();
    expect(rows[2]["Line: ID"]).toBeUndefined();
    expect(rows[2]["Transaction: Status"]).toBe("failure");
  });

  it("runs the bulk query and emits rows", async () => {
    const queries: string[] = [];
    const emitted: Row[][] = [];
    const ctx: ExportContext = {
      gql: (async () => ({})) as any,
      bulk: (q) => {
        queries.push(q);
        return (async function* () {
          yield sampleOrder;
        })();
      },
      options: { query: "status:open" },
      log: () => {},
      cache: new Map(),
      progress: () => {},
    };
    await ordersEntity.export!(ctx, async (rows) => {
      emitted.push(rows);
    });
    expect(queries[0]).toContain('orders(query: "(status:open)")');
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0].Name).toBe("#1001");
  });

  const SCHEMA_FILE = path.resolve(".cache/schema/admin_2026-10.json.gz");
  it.skipIf(!fs.existsSync(SCHEMA_FILE))("bulk export query matches the Admin API schema", () => {
    const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString("utf8"));
    const schema = buildClientSchema(json.data ?? json);
    const q = ordersBulkQuery("title:x AND updated_at:>='2026-01-01'", new Set(ordersEntity.groups!.map((g) => g.key)));
    expect(validate(schema, parse(q)).map((e) => e.message)).toEqual([]);
    // Bulk limits: at most 5 connections.
    expect((q.match(/edges\s*\{/g) ?? []).length).toBeLessThanOrEqual(5);
  });
});

// --- Import -----------------------------------------------------------------------

describe("orders import", () => {
  it("creates an order (NEW) with variant, SKU and custom lines", async () => {
    const m = mockGql({
      ImportOrderByName: () => ({ orders: { nodes: [] } }),
      OrderCommonVariantBySku: (v) => {
        expect(v.query).toBe('sku:"SKU-2"');
        return { productVariants: { nodes: [{ id: "gid://shopify/ProductVariant/22", sku: "SKU-2" }] } };
      },
      ImportOrderCreate: () => ({
        orderCreate: {
          ...ok,
          order: {
            id: "gid://shopify/Order/9",
            name: "#M1",
            lineItems: { nodes: [{ id: "gid://shopify/LineItem/1" }, { id: "gid://shopify/LineItem/2" }, { id: "gid://shopify/LineItem/3" }] },
          },
        },
      }),
    });
    const rows: Row[] = [
      {
        Name: "#M1",
        Command: "NEW",
        Email: "b@example.com",
        Currency: "EUR",
        "Processed At": "2025-05-01T00:00:00Z",
        "Financial Status": "Paid",
        "Fulfillment Status": "fulfilled",
        Tags: "imported, legacy",
        Note: "from old store",
        "Customer: Email": "b@example.com",
        "Customer: First Name": "Bo",
        "Shipping: First Name": "Bo",
        "Shipping: Address 1": "2 High St",
        "Shipping: City": "Paris",
        "Shipping: Country Code": "fr",
        "Shipping Line: Title": "Express",
        "Shipping Line: Price": "7.5",
        "Discount Codes": "WELCOME",
        "Total Discounts": "3",
        "Metafield: custom.source [single_line_text_field]": "legacy",
        "Line: Variant ID": "11",
        "Line: Quantity": "2",
        "Line: Price": "10",
      },
      { Name: "#M1", "Line: SKU": "SKU-2", "Line: Quantity": "1" },
      { Name: "#M1", "Line: Title": "Custom engraving", "Line: Price": "5", "Line: Taxable": "no" },
    ];
    const r = await importOrder(importCtx(m.gql), rows, "NEW");
    expect(r.status).toBe("OK");
    expect(r.id).toBe("gid://shopify/Order/9");
    const create = m.calls.find((c) => c.op === "ImportOrderCreate")!.vars;
    expect(create.options).toEqual({ inventoryBehaviour: "BYPASS", sendReceipt: false, sendFulfillmentReceipt: false });
    expect(create.order).toMatchObject({
      currency: "EUR",
      name: "#M1",
      email: "b@example.com",
      note: "from old store",
      tags: ["imported", "legacy"],
      processedAt: "2025-05-01T00:00:00Z",
      financialStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      customer: { toUpsert: { email: "b@example.com", firstName: "Bo" } },
      shippingAddress: { firstName: "Bo", address1: "2 High St", city: "Paris", countryCode: "FR" },
      shippingLines: [{ title: "Express", priceSet: { shopMoney: { amount: "7.5", currencyCode: "EUR" } } }],
      discountCode: { itemFixedDiscountCode: { code: "WELCOME", amountSet: { shopMoney: { amount: "3", currencyCode: "EUR" } } } },
      metafields: [{ namespace: "custom", key: "source", type: "single_line_text_field", value: "legacy" }],
    });
    expect(create.order.lineItems).toEqual([
      { quantity: 2, variantId: "gid://shopify/ProductVariant/11", priceSet: { shopMoney: { amount: "10", currencyCode: "EUR" } } },
      { quantity: 1, variantId: "gid://shopify/ProductVariant/22", sku: "SKU-2" },
      { quantity: 1, title: "Custom engraving", priceSet: { shopMoney: { amount: "5", currencyCode: "EUR" } }, taxable: false },
    ]);
    expect(create.order.billingAddress).toBeUndefined();
    expect(r.rowPatches?.[0]).toMatchObject({ ID: "9", Name: "#M1", "Line: ID": "1" });
    expect(r.rowPatches?.[2]).toMatchObject({ "Line: ID": "3" });
  });

  it("sends transactions instead of a financial status and uses the shop currency", async () => {
    const m = mockGql({
      OrderCommonShopCurrency: () => ({ shop: { currencyCode: "GBP" } }),
      ImportOrderCreate: () => ({ orderCreate: { ...ok, order: { id: "gid://shopify/Order/3", name: "#1003", lineItems: { nodes: [] } } } }),
    });
    const rows: Row[] = [
      { "Financial Status": "paid", "Line: Title": "Thing", "Line: Price": "12", "Transaction: Kind": "sale", "Transaction: Amount": "12", "Transaction: Gateway": "manual", "Inventory Behaviour": "decrement obeying policy", "Send Receipt": "yes" },
    ];
    const r = await importOrder(importCtx(m.gql), rows, "MERGE");
    expect(r.status).toBe("OK");
    const create = m.calls.find((c) => c.op === "ImportOrderCreate")!.vars;
    expect(create.order.financialStatus).toBeUndefined();
    expect(create.order.transactions).toEqual([
      { amountSet: { shopMoney: { amount: "12", currencyCode: "GBP" } }, kind: "SALE", status: "SUCCESS", gateway: "manual" },
    ]);
    expect(create.options).toMatchObject({ inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: true });
  });

  it("rejects an invalid custom line", async () => {
    const m = mockGql({
      OrderCommonShopCurrency: () => ({ shop: { currencyCode: "USD" } }),
      OrderCommonVariantBySku: () => ({ productVariants: { nodes: [] } }),
    });
    await expect(importOrder(importCtx(m.gql), [{ "Line: SKU": "NOPE" }], "NEW")).rejects.toThrow(/Line: Title/);
  });

  it("NEW fails when the order exists", async () => {
    const m = mockGql({ ImportOrderById: () => ({ order: { id: "gid://shopify/Order/1", name: "#1001" } }) });
    const r = await importOrder(importCtx(m.gql), [{ ID: "1", "Line: Title": "x", "Line: Price": "1" }], "NEW");
    expect(r.status).toBe("Failed");
    expect(m.ops()).toEqual(["ImportOrderById"]);
  });

  it("updates editable fields of an existing order found by Name (MERGE)", async () => {
    const m = mockGql({
      ImportOrderByName: (v) => {
        expect(v.query).toBe('name:"#1001"');
        return { orders: { nodes: [{ id: "gid://shopify/Order/1", name: "#1001" }] } };
      },
      ImportOrderUpdate: () => ({ orderUpdate: { ...ok, order: { id: "gid://shopify/Order/1" } } }),
      TagsAdd: () => ({ tagsAdd: ok }),
      MetafieldsSet: () => ({ metafieldsSet: ok }),
      MetafieldsDelete: () => ({ metafieldsDelete: ok }),
    });
    const rows: Row[] = [
      {
        Name: "#1001",
        Email: "new@example.com",
        Note: "",
        Tags: "followup",
        "Tags Command": "MERGE",
        "Shipping: Address 1": "3 Side St",
        "Shipping: Country Code": "US",
        "Shipping: Province Code": "ny",
        "Metafield: custom.gift [boolean]": "no",
        "Metafield: custom.old [single_line_text_field]": "",
        "Line: ID": "11",
        "Line: Title": "Shirt",
      },
    ];
    const r = await importOrder(importCtx(m.gql), rows, "MERGE");
    expect(r.status).toBe("OK");
    expect(r.message).toMatch(/Updated; line items of existing orders are not changed/);
    expect(m.ops()).toEqual(["ImportOrderByName", "ImportOrderUpdate", "TagsAdd", "MetafieldsSet", "MetafieldsDelete"]);
    const input = m.calls[1].vars.input;
    expect(input).toEqual({
      id: "gid://shopify/Order/1",
      email: "new@example.com",
      note: "",
      shippingAddress: { address1: "3 Side St", countryCode: "US", provinceCode: "NY" },
    });
    expect(m.calls[2].vars).toEqual({ id: "gid://shopify/Order/1", tags: ["followup"] });
    expect(m.calls[3].vars.metafields[0]).toMatchObject({ ownerId: "gid://shopify/Order/1", key: "gift", value: "false" });
  });

  it("UPDATE fails when the order is missing", async () => {
    const m = mockGql({ ImportOrderById: () => ({ order: null }), ImportOrderByName: () => ({ orders: { nodes: [] } }) });
    const r = await importOrder(importCtx(m.gql), [{ ID: "5", Name: "#5" }], "UPDATE");
    expect(r).toMatchObject({ status: "Failed", message: "Order not found" });
  });

  it("deletes an order", async () => {
    const m = mockGql({
      ImportOrderById: () => ({ order: { id: "gid://shopify/Order/1", name: "#1001" } }),
      ImportOrderDelete: () => ({ orderDelete: { ...ok, deletedId: "gid://shopify/Order/1" } }),
    });
    const r = await importOrder(importCtx(m.gql), [{ ID: "1" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted" });
    expect(m.calls[1].vars).toEqual({ orderId: "gid://shopify/Order/1" });
  });
});
