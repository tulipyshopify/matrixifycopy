import { describe, expect, it } from "vitest";
import { detectEntity } from "../app/lib/core/registry";
import { ENTITIES } from "../app/lib/entities";

const type = (name: string, headers: string[]) => detectEntity({ name, headers }, ENTITIES)?.key ?? null;

describe("recognising what a file holds", () => {
  it("goes by the columns when the name says nothing", () => {
    expect(type("Sheet1", ["Handle", "Title", "Vendor", "Variant SKU", "Variant Price"])).toBe("products");
    expect(type("stock update", ["Variant SKU", "Inventory Available: Main", "Inventory Available Adjust: Depot"])).toBe("products");
    expect(type("data", ["Variant ID", "Variant Metafield: custom.restock_date [date]"])).toBe("products");
    expect(type("upload (3)", ["Email", "First Name", "Last Name", "Total Spent", "Tags"])).toBe("customers");
    expect(type("Book1", ["Name", "Email", "Financial Status", "Line: SKU", "Line: Quantity", "Line: Price", "Shipping: City"])).toBe("orders");
    expect(type("x", ["Path", "Target"])).toBe("redirects");
    expect(type("x", ["Title", "Code", "Value Type", "Value", "Starts At"])).toBe("discounts");
  });

  it("goes by the columns even when the file name mentions another data type", () => {
    // "customers" is in the name, but these are product columns.
    expect(type("prices for trade customers", ["Handle", "Variant SKU", "Variant Price", "Variant Compare At Price"])).toBe("products");
    expect(type("orders to restock", ["Variant SKU", "Variant Inventory Qty", "Variant Cost"])).toBe("products");
  });

  it("keeps a sheet named exactly after a data type, and file names that carry one", () => {
    expect(type("Customers", ["Handle", "Variant SKU", "Variant Price"])).toBe("customers");
    expect(type("Export_2026-10-27_Products", ["ID", "Title"])).toBe("products");
    // Same columns for both kinds of collection: the name decides.
    expect(type("Smart Collections", ["ID", "Handle", "Title"])).toBe("smart_collections");
    expect(type("my custom collections", ["ID", "Handle", "Title"])).toBe("custom_collections");
  });

  it("ignores result columns and does not guess when nothing points one way", () => {
    expect(type("result", ["Variant SKU", "Variant Price", "Import Result", "Import Comment"])).toBe("products");
    expect(type("Sheet1", ["Title", "Tags"])).toBeNull();
    expect(type("Sheet1", ["ID"])).toBeNull();
    expect(type("Sheet1", [])).toBeNull();
    expect(type("Sheet1", ["Something", "Else"])).toBeNull();
  });
});
