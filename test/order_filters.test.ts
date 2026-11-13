import fs from "node:fs";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import type { ExportContext, FilterCondition, Row } from "../app/lib/core/types";
import { buildSearchQuery, compileDateRange } from "../app/lib/core/util";
import { getEntity } from "../app/lib/entities";
import { localOrderFilters, ordersBulkQuery, ordersEntity } from "../app/lib/entities/orders";

const jobs = await import("../app/lib/jobs/jobs.server");
const { countItems } = await import("../app/lib/jobs/counts.server");
const orders = getEntity("orders")!;
const now = new Date("2026-11-13T12:00:00Z");
const SCHEMA_FILE = ".cache/schema/admin_2026-10.json.gz";

const li = (o: Record<string, any>) => ({ id: "gid://shopify/LineItem/1", title: "Shirt", name: "Shirt - Blue", variantTitle: "Blue", vendor: "Acme", sku: "S1", variant: { id: "gid://shopify/ProductVariant/55", inventoryQuantity: 3 }, product: { handle: "shirt" }, ...o });
const sample = [
  { id: "gid://shopify/Order/1", name: "#1", customer: { taxExempt: true }, billingAddress: { countryCodeV2: "GB" }, shippingAddress: { countryCodeV2: "FR" }, shippingLine: { title: "Post" },
    lineItems: [li({})], fulfillments: [{ createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-12T10:00:00Z" }], refunds: [] },
  { id: "gid://shopify/Order/2", name: "#2", customer: null, billingAddress: { countryCodeV2: "US" }, shippingAddress: null, shippingLine: null,
    lineItems: [li({ title: "Mug", name: "Mug", variantTitle: null, vendor: "Potter", variant: { id: "gid://shopify/ProductVariant/77", inventoryQuantity: 40 }, product: { handle: "mug" } })],
    // Fulfilled long ago, but the order was edited yesterday.
    fulfillments: [{ createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T10:00:00Z" }], refunds: [{ createdAt: "2026-11-10T09:00:00Z" }] },
  { id: "gid://shopify/Order/3", name: "#3", customer: { taxExempt: false }, billingAddress: null, shippingAddress: { countryCodeV2: "GB" }, shippingLine: { title: "Post" }, lineItems: [], fulfillments: [], refunds: [] },
];
const names = (filters: FilterCondition[], extra: Record<string, any> = {}) => {
  const f = localOrderFilters({ filters: jobs.parseFilters(orders, filters), timezone: "Europe/London", ...extra }, now);
  return sample.filter((o) => f.test(o)).map((o) => o.name).join(",");
};

describe("order filters", () => {
  it("offers every filter from the list", () => {
    const labels = orders.filters!.map((f) => f.label);
    for (const l of ["ID", "Tag", "Order status", "Payment status", "Fulfillment status", "Discount code", "Payment gateway", "Source", "Customer: Tax Exempt", "Billing: Country Code",
      "Shipping: Country Code", "Line: Type", "Line: Product Handle", "Line: Title", "Line: Name", "Line: Variant ID", "Line: Variant Title", "Line: SKU", "Line: Vendor",
      "Line: Variant Inventory Qty", "Fulfillment: Created At", "Fulfillment: Updated At", "Refund: Created At", "Metafield", "Created", "Updated", "Processed"])
      expect(labels, l).toContain(l);
  });

  it("sends searchable filters to Shopify and keeps the rest for itself", () => {
    const filters = jobs.parseFilters(orders, [
      { field: "id", op: "is", value: "gid://shopify/Order/123" },
      { field: "metafield", op: "is", value: "custom.batch=A 12" },
      { field: "line_vendor", op: "is", value: "Acme" },
      { field: "fulfillment_created_at", op: "gte", value: "2026-10-24" },
    ]);
    expect(filters[2]).toEqual({ field: "line_vendor", op: "is", value: "Acme", local: true });
    expect(filters[3]).toMatchObject({ local: true, searchBy: "updated_at" });
    expect(buildSearchQuery({ filters })).toBe('id:123 AND metafields.custom.batch:"A 12"');
    // The date filter still narrows what is fetched: a new fulfillment updates its order.
    expect(localOrderFilters({ filters, timezone: "Europe/London" }, now).narrow).toEqual(["updated_at:>='2026-10-23T23:00:00Z'"]);
    expect(() => jobs.parseFilters(orders, [{ field: "metafield", op: "is", value: "batch A12" }])).toThrow(/namespace\.key=value/);
    // A request can't mark a searchable filter as local to skip it.
    expect(jobs.parseFilters(orders, [{ field: "name", op: "is", value: "#1", local: true } as any])[0]).toEqual({ field: "name", op: "is", value: "#1" });
  });

  it("checks line, address, customer and date filters on each order", () => {
    expect(names([{ field: "line_vendor", op: "is", value: "acme" }])).toBe("#1");
    expect(names([{ field: "line_vendor", op: "is_not", value: "Acme" }])).toBe("#2,#3");
    expect(names([{ field: "line_title", op: "starts_with", value: "mu" }])).toBe("#2");
    expect(names([{ field: "line_name", op: "is", value: "Shirt - Blue" }])).toBe("#1");
    expect(names([{ field: "line_product_handle", op: "is", value: "mug" }])).toBe("#2");
    expect(names([{ field: "line_variant_id", op: "is", value: "gid://shopify/ProductVariant/55" }])).toBe("#1");
    expect(names([{ field: "line_variant_title", op: "is", value: "Blue" }])).toBe("#1");
    expect(names([{ field: "line_variant_inventory_qty", op: "gt", value: "10" }])).toBe("#2");
    expect(names([{ field: "line_variant_inventory_qty", op: "between", value: "1", value2: "5" }])).toBe("#1");
    expect(names([{ field: "line_type", op: "is", value: "Shipping Line" }])).toBe("#1,#3");
    expect(names([{ field: "line_type", op: "any_of", value: "Line Item,Shipping Line" }])).toBe("#1,#2,#3");
    expect(names([{ field: "customer_tax_exempt", op: "is", value: "true" }])).toBe("#1");
    expect(names([{ field: "customer_tax_exempt", op: "is", value: "false" }])).toBe("#2,#3");
    expect(names([{ field: "billing_country_code", op: "is", value: "gb" }])).toBe("#1");
    expect(names([{ field: "shipping_country_code", op: "is", value: "GB" }])).toBe("#3");
    expect(names([{ field: "refund_created_at", op: "gte", value: "2026-11-01" }])).toBe("#2");
    expect(names([{ field: "fulfillment_updated_at", op: "between", value: "2026-11-12", value2: "2026-11-12" }])).toBe("#1");
    expect(names([{ field: "fulfillment_created_at", op: "lte", value: "2026-09-30" }])).toBe("#2");
    // Combined with AND.
    expect(names([{ field: "line_vendor", op: "is", value: "Acme" }, { field: "shipping_country_code", op: "is", value: "GB" }])).toBe("");
  });

  it("'Fulfillment created in the last 21 days' ignores orders that were only updated", () => {
    const range = jobs.parseDateRange(orders, { field: "fulfillment_created_at", preset: "last_n", amount: 21, unit: "days" })!;
    expect(range).toEqual({ field: "fulfillment_created_at", preset: "last_n", amount: 21, unit: "days", searchBy: "updated_at" });
    // Shopify narrows by update time; the export then checks the fulfillment dates.
    expect(compileDateRange(range, now, "Europe/London")).toBe("updated_at:>='2026-10-23T23:00:00Z'");
    expect(names([], { dateRange: range })).toBe("#1");
  });

  it("'Last …' counts back minutes, hours, days or months", () => {
    const last = (amount: number, unit: any, tz = "UTC") => compileDateRange(jobs.parseDateRange(orders, { field: "created_at", preset: "last_n", amount, unit })!, now, tz);
    expect(last(1440, "minutes")).toBe("created_at:>='2026-11-12T12:00:00Z'");
    expect(last(6, "hours")).toBe("created_at:>='2026-11-13T06:00:00Z'");
    expect(last(21, "days")).toBe("created_at:>='2026-10-24T00:00:00Z' AND created_at:<'2026-11-14T00:00:00Z'");
    expect(last(1, "months", "Europe/London")).toBe("created_at:>='2026-10-12T23:00:00Z'");
    expect(last(3, "months")).toBe("created_at:>='2026-08-13T00:00:00Z'");
    // Set-ups saved as "last N days" keep working.
    expect(jobs.parseDateRange(orders, { field: "created_at", preset: "last_n_days" as any, days: 21 })).toEqual({ field: "created_at", preset: "last_n", amount: 21, unit: "days" });
    expect(compileDateRange({ field: "created_at", preset: "last_n_days", days: 21 }, now)).toBe("created_at:>='2026-10-24T00:00:00Z' AND created_at:<'2026-11-14T00:00:00Z'");
    expect(() => jobs.parseDateRange(orders, { field: "created_at", preset: "last_n", amount: 0, unit: "hours" })).toThrow(/how many hours/);
    expect(() => jobs.parseDateRange(orders, { field: "created_at", preset: "last_n", amount: 5, unit: "years" as any })).toThrow(/minutes, hours, days or months/);
  });

  it("fetches what the filters need without adding it to the file", async () => {
    const queries: string[] = [];
    const rows: Row[] = [];
    const ctx: ExportContext = {
      gql: (async () => ({})) as any,
      bulk: async function* (q: string) {
        queries.push(q);
        yield* structuredClone(sample);
      },
      options: { v: 2, groups: [], timezone: "Europe/London", filters: jobs.parseFilters(orders, [{ field: "line_product_handle", op: "is", value: "shirt" }, { field: "refund_created_at", op: "lte", value: "2026-12-01" }]) },
      log: () => {},
      cache: new Map(),
      progress: () => {},
    };
    await ordersEntity.export!(ctx, async (r) => void rows.push(...r));
    expect(queries[0]).toMatch(/lineItems/);
    expect(queries[0]).toMatch(/product \{ id handle/);
    expect(queries[0]).toMatch(/refunds \{ id createdAt/);
    expect(rows).toEqual([]); // #1 has the handle but no refund
    ctx.options.filters = jobs.parseFilters(orders, [{ field: "line_product_handle", op: "is", value: "shirt" }]);
    await ordersEntity.export!(ctx, async (r) => void rows.push(...r));
    expect(rows.map((r) => r.Name)).toEqual(["#1"]);
    expect(rows[0]["Line: Title"]).toBeUndefined(); // line items were not asked for
  });

  it("gives no total beforehand when it has to check orders itself", async () => {
    const gql = (async () => ({ ordersCount: { count: 5, precision: "EXACT" } })) as any;
    expect(await countItems(gql, "orders", { filters: [{ field: "line_vendor", op: "is", value: "x", local: true }] })).toBeNull();
    expect(await countItems(gql, "orders", { dateRange: { field: "fulfillment_created_at", preset: "today", searchBy: "updated_at" } })).toBeNull();
    expect(await countItems(gql, "orders", {})).toMatchObject({ count: 5 });
  });

  it.skipIf(!fs.existsSync(SCHEMA_FILE))("query with every extra field matches the Admin API schema", () => {
    const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString());
    const schema = buildClientSchema(json.data ?? json);
    const q = ordersBulkQuery("", new Set(["line_items", "fulfillments"]), new Set(["refunds", "line_handle", "line_name", "line_inventory"]));
    expect(validate(schema, parse(q)).map((e) => e.message)).toEqual([]);
    expect((q.match(/edges/g) ?? []).length).toBeLessThanOrEqual(6); // root + at most 5 connections
  });
});
