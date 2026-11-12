import { describe, expect, it } from "vitest";
import { orderToRows, ordersBulkQuery } from "../app/lib/entities/orders";

const bag = (shop: string, cust: string) => ({ shopMoney: { amount: shop }, presentmentMoney: { amount: cust } });
const order = {
  id: "gid://shopify/Order/1", name: "#1001", currencyCode: "GBP", presentmentCurrencyCode: "EUR",
  sourceIdentifier: "abc", registeredSourceUrl: "https://x.test", retailLocation: { name: "Shop" }, cartToken: "c1", checkoutToken: "t1",
  statusPageUrl: "https://s.test/1", totalWeight: "1200", poNumber: "PO-7", customAttributes: [{ key: "Gift", value: "yes" }, { key: "Note", value: null }],
  currentTotalPriceSet: bag("90.00", "105.00"), totalPriceSet: bag("100.00", "117.00"), totalOutstandingSet: bag("0.00", "0.00"),
  taxLines: [{ title: "VAT", rate: 0.2, priceSet: bag("15.00", "17.50") }, { title: "Duty", rate: 0.05, priceSet: bag("1.00", "1.17") }],
  lineItems: [
    {
      id: "gid://shopify/LineItem/1", title: "Tee", quantity: 2, originalUnitPriceSet: bag("10.00", "11.70"),
      product: { id: "gid://shopify/Product/5", productType: "Tops", tags: ["a", "b"] },
      variant: { id: "gid://shopify/ProductVariant/9", sku: "T-NOW", barcode: "0123", price: "12.00", compareAtPrice: "15.00", inventoryQuantity: 4,
        inventoryItem: { unitCost: { amount: "3.50" }, countryCodeOfOrigin: "PT", provinceCodeOfOrigin: null, harmonizedSystemCode: "6109", measurement: { weight: { value: 0.2, unit: "KILOGRAMS" } } } },
    },
    { id: "gid://shopify/LineItem/2", title: "Cap", quantity: 1, originalUnitPriceSet: bag("5.00", "5.85"), product: null, variant: null },
  ],
  fulfillments: [
    { id: "gid://shopify/Fulfillment/3", status: "SUCCESS", displayStatus: "IN_TRANSIT", createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z",
      location: { name: "Warehouse" }, trackingInfo: [{ company: "DPD", number: "111", url: "https://t/111" }, { company: "DPD", number: "222", url: "https://t/222" }] },
  ],
};

describe("order export: extra columns", () => {
  const all = new Set(["line_items", "line_product_data", "fulfillments", "transactions", "metafields"]);
  const rows = orderToRows(order, all);

  it("exports order details, prices in both currencies and tax lines on the top row", () => {
    expect(rows[0]).toMatchObject({
      "Customer Currency": "EUR", "Source Identifier": "abc", "Source URL": "https://x.test", "Physical Location": "Shop",
      "Cart Token": "c1", Token: "t1", "Order Status URL": "https://s.test/1", "Weight Total": "1200", "Purchase Order Number": "PO-7",
      "Additional Details": "Gift: yes\nNote: ",
      "Current Total Price": "90.00",
      "Price: Current Total": "105.00", "Price: Current Total (Shop Currency)": "90.00",
      "Price: Total": "117.00", "Price: Total (Shop Currency)": "100.00",
      "Price: Total Line Items": "29.25", "Price: Total Line Items (Shop Currency)": "25.00",
      "Price: Total Duties": "", // absent on the order
      "Tax 1: Title": "VAT", "Tax 1: Rate": "0.2", "Tax 1: Price": "17.50", "Tax 2: Title": "Duty",
    });
    expect(rows[1]["Price: Total"]).toBeUndefined();
  });

  it("exports current product data per line and fulfillments alongside lines", () => {
    expect(rows[0]).toMatchObject({
      "Line: Product Type": "Tops", "Line: Product Tags": "a, b", "Line: Variant SKU": "T-NOW", "Line: Variant Barcode": "0123",
      "Line: Variant Weight": "0.2", "Line: Variant Weight Unit": "kg", "Line: Variant Inventory Qty": "4", "Line: Variant Cost": "3.50",
      "Line: Variant Price": "12.00", "Line: Variant Compare At Price": "15.00", "Line: Variant Country of Origin": "PT", "Line: Variant HS Code": "6109",
      "Fulfillment: ID": "3", "Fulfillment: Status": "success", "Fulfillment: Shipment Status": "in_transit", "Fulfillment: Location": "Warehouse",
      "Fulfillment: Tracking Company": "DPD, DPD", "Fulfillment: Tracking Number": "111, 222", "Fulfillment: Tracking URL": "https://t/111, https://t/222",
    });
    // A deleted product/variant leaves the cells blank instead of failing.
    expect(rows[1]["Line: Product Type"]).toBe("");
    expect(rows[1]["Fulfillment: ID"]).toBeUndefined();
  });

  it("only fetches the slower data when its group is on", () => {
    const off = ordersBulkQuery("", new Set(["line_items"]));
    expect(off).not.toMatch(/productType|fulfillments \{/);
    expect(ordersBulkQuery("", all)).toMatch(/productType tags/);
    expect(orderToRows(order, new Set(["line_items"]))[0]["Line: Product Type"]).toBeUndefined();
    expect(orderToRows(order, new Set(["line_items"]))[0]["Fulfillment: ID"]).toBeUndefined();
  });
});
