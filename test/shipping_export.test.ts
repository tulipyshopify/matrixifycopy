import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-ship-"));
const { executeJob } = await import("../app/lib/jobs/runner.server");
const { readWorkbook } = await import("../app/lib/core/sheets");
const jobs = await import("../app/lib/jobs/jobs.server");

const bag = (a: string) => ({ shopMoney: { amount: a } });
// A real order's shape as it arrives from Shopify's bulk export (#WW105597).
const order = {
  id: "gid://shopify/Order/13443698917755",
  name: "#WW105597",
  currentTotalPriceSet: { shopMoney: { amount: "340.86" }, presentmentMoney: { amount: "340.86" } },
  totalShippingPriceSet: bag("14.99"),
  shippingLine: { title: "Safe & Secure Delivery", code: "safe_& secure delivery", originalPriceSet: bag("14.99") },
  lineItems: [
    { id: "gid://shopify/LineItem/1", sku: "CABLETIE", quantity: 1, originalUnitPriceSet: bag("16.99"), product: { id: "gid://shopify/Product/1", productType: "Other" } },
    { id: "gid://shopify/LineItem/2", sku: "HH013", quantity: 5, originalUnitPriceSet: bag("44.99"), product: { id: "gid://shopify/Product/2", productType: "Hazel Hurdles" } },
  ],
};
const columns = ["ID", "Name", "Current Total Price", "Line: SKU", "Line: Quantity", "Line: Price", "Line: Product Type"];

async function exportWith(options: Record<string, unknown>, id: string) {
  const res = await executeJob(
    { id, shop: "t.myshopify.com", type: "export", config: JSON.stringify({ entities: [{ entity: "orders", options }] }), format: "csv", name: "", inputFile: null, inputName: null },
    { gql: (async () => ({})) as any, bulk: async function* () { yield structuredClone(order); }, log: () => {}, progress: () => {}, isCancelled: async () => false },
  );
  return (await readWorkbook(res.resultFile, "Orders.csv"))[0].rows;
}

describe("orders export: shipping row with a report-style column choice", () => {
  const shippingRow = { ID: "13443698917755", Name: "#WW105597", "Current Total Price": "", "Line: SKU": "", "Line: Quantity": "", "Line: Price": "14.99", "Line: Product Type": "" };

  it("new settings with the option on: one shipping row after the line items", async () => {
    const options = jobs.parseExportConfig({ entities: [{ entity: "orders", options: { columns, groups: ["line_items", "line_product_data", "shipping_lines"] } }] }).entities[0].options;
    expect(options.v).toBe(2);
    const rows = await exportWith(options, "s1");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ "Line: SKU": "CABLETIE", "Line: Price": "16.99", "Current Total Price": "340.86" });
    expect(rows[2]).toEqual(shippingRow);
  });

  it("settings saved before shipping rows existed (old preset, schedule, Run again) still get the row", async () => {
    const rows = await exportWith({ columns, groups: ["line_items", "line_product_data"] }, "s2");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual(shippingRow);
  });

  it("new settings with the option switched off: no shipping row", async () => {
    const rows = await exportWith({ v: 2, columns, groups: ["line_items", "line_product_data"] }, "s3");
    expect(rows).toHaveLength(2);
  });
});
