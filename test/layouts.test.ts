import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyLayout, matchLayout, suggestColumn, type ColumnLayout } from "../app/lib/core/layouts";
import { runImport } from "../app/lib/core/importer";
import { ENTITIES, getEntity } from "../app/lib/entities";
import { fakeStore, product, variant } from "./helpers/fake_store";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-lay-"));

const supplier: ColumnLayout = {
  id: "a1",
  name: "Acme price list",
  entity: "products",
  map: { "Item Code": "Variant SKU", "Product Name": "Title", RRP: "Variant Price", "Trade Price": "Variant Cost", "Pack Size": "", EAN: "Variant Barcode" },
  savedAt: "2026-11-20T00:00:00Z",
};

describe("column matching", () => {
  it("guesses our column from everyday names", () => {
    const p = getEntity("products")!;
    expect(suggestColumn(p, "Item Code")).toBe("Variant SKU");
    expect(suggestColumn(p, "product_name")).toBe("Title");
    expect(suggestColumn(p, "RRP")).toBe("Variant Price");
    expect(suggestColumn(p, "EAN")).toBe("Variant Barcode");
    expect(suggestColumn(p, "Brand")).toBe("Vendor");
    expect(suggestColumn(p, "Stock")).toBe("Variant Inventory Qty");
    expect(suggestColumn(p, "variant price")).toBe("Variant Price");
    expect(suggestColumn(p, "Pack Size")).toBeNull();
    const c = getEntity("customers")!;
    expect(suggestColumn(c, "Surname")).toBe("Last Name");
    expect(suggestColumn(c, "Postcode")).toBe("Address Zip");
  });

  it("a file fits a saved layout when its matched columns are there, whatever their order or capitals", () => {
    expect(matchLayout(["rrp", "ITEM CODE", "Product Name", "EAN", "Trade Price", "Pack Size"], [supplier])?.name).toBe("Acme price list");
    // One optional column missing is still the same supplier's file.
    expect(matchLayout(["Item Code", "Product Name", "RRP", "Trade Price", "EAN"], [supplier])?.name).toBe("Acme price list");
    // Our own export is not mistaken for it, nor a file that shares one column.
    expect(matchLayout(["ID", "Handle", "Title", "Variant SKU", "Variant Price"], [supplier])).toBeNull();
    expect(matchLayout(["Item Code", "Colour", "Length", "Width", "Height", "Depth"], [supplier])).toBeNull();
    expect(matchLayout(["Item Code"], [])).toBeNull();
  });

  it("a supplier's file is read as products, previewed against the store, with its extra column left alone", async () => {
    const store = fakeStore([product("barrel", "Oak Barrel", [variant("AC-100", "50.00")]), product("hurdle", "Willow Hurdle", [variant("AC-200", "39.99")])]);
    const sheet: any = {
      name: "Sheet1",
      headers: ["Item Code", "Product Name", "RRP", "Trade Price", "Pack Size", "EAN"],
      rows: [
        { "Item Code": "AC-100", "Product Name": "Oak Barrel", RRP: "55.00", "Trade Price": "30.00", "Pack Size": "1", EAN: "5012345678900" },
        { "Item Code": "AC-200", "Product Name": "Willow Hurdle", RRP: "39.99", "Trade Price": "", "Pack Size": "6", EAN: "" },
      ],
    };
    // Without the layout the sheet is not read as products.
    const before = await runImport({ ctx: { gql: store.gql, options: { dryRun: true, defaultCommand: "UPDATE" } as any, log: () => {}, cache: new Map() } as any, sheets: [JSON.parse(JSON.stringify(sheet))], entities: ENTITIES, log: () => {} });
    expect(before[0].entity).not.toBe("products");

    const note = applyLayout(sheet, supplier);
    expect(note).toMatch(/Read with your saved column matching "Acme price list": "Item Code" → Variant SKU, "Product Name" → Title, "RRP" → Variant Price/);
    expect(note).toMatch(/Not imported: "Pack Size"/);
    expect(sheet.headers).toEqual(["Variant SKU", "Title", "Variant Price", "Variant Cost", "Pack Size", "Variant Barcode"]);
    const [s] = await runImport({ ctx: { gql: store.gql, options: { dryRun: true, defaultCommand: "UPDATE" } as any, log: () => {}, cache: new Map() } as any, sheets: [sheet], entities: ENTITIES, log: () => {} });
    expect(s.entity).toBe("products");
    expect((s.warnings ?? []).join()).not.toMatch(/Pack Size/);
    expect(s.preview!.map((p) => p.action)).toEqual(["update", "none"]);
    expect(s.preview![0].changes.join("\n")).toMatch(/Variant Price \(SKU AC-100\): 50 → 55/);
  });

  it("a column of ours already in the file is not overwritten by a match", () => {
    const sheet: any = { name: "x", headers: ["Title", "Product Name", "Item Code"], rows: [{ Title: "Real", "Product Name": "Other", "Item Code": "A" }] };
    applyLayout(sheet, supplier);
    expect(sheet.rows[0]).toEqual({ Title: "Real", "Product Name": "Other", "Variant SKU": "A" });
    expect(sheet.ignoredColumns).toEqual(["Product Name"]);
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("saving column matchings", async () => {
  const { default: prisma } = await import("../app/db.server");
  const { deleteLayout, listLayouts, saveLayout } = await import("../app/lib/jobs/layouts.server");
  const shop = `lay-${Date.now()}.myshopify.com`;

  it("checks a matching before saving it, and replaces one of the same name", async () => {
    await expect(saveLayout(shop, { name: "", entity: "products", map: { A: "Title" } })).rejects.toThrow(/Give this column matching a name/);
    await expect(saveLayout(shop, { name: "X", entity: "products", map: { A: "Nope" } })).rejects.toThrow(/not a Products column/);
    await expect(saveLayout(shop, { name: "X", entity: "products", map: { A: "Title", B: "Title" } })).rejects.toThrow(/Two columns/);
    await expect(saveLayout(shop, { name: "X", entity: "products", map: { A: "Title" } })).rejects.toThrow(/says which product each row is: ID, or Handle/);
    await expect(saveLayout(shop, { name: "X", entity: "payouts", map: { A: "ID" } })).rejects.toThrow(/what kind of data/);
    const a = await saveLayout(shop, { name: "Acme", entity: "products", map: { Code: "Variant SKU", Name: "Title", Junk: "" } });
    expect(a).toMatchObject({ name: "Acme", entity: "products", map: { Code: "Variant SKU", Name: "Title", Junk: "" } });
    await saveLayout(shop, { name: "acme", entity: "products", map: { Code: "Variant SKU" } });
    const list = await listLayouts(shop);
    expect(list).toHaveLength(1);
    expect(list[0].map).toEqual({ Code: "Variant SKU" });
    await deleteLayout(shop, list[0].id);
    expect(await listLayouts(shop)).toEqual([]);
    await prisma.shopSetting.deleteMany({ where: { shop } });
  });
});
