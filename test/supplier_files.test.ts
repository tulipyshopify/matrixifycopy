import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runImport } from "../app/lib/core/importer";
import { applyLayout, stockFromText, suggestAll, type ColumnLayout } from "../app/lib/core/layouts";
import { detectEntity } from "../app/lib/core/registry";
import { readWorkbook } from "../app/lib/core/sheets";
import { ENTITIES, getEntity } from "../app/lib/entities";
import { resolveBarcodes } from "../app/lib/entities/products";
import { jobHealth } from "../app/lib/jobs/health";
import { headerRowFromLayouts, layoutKeys } from "../app/lib/jobs/runner.server";
import { fakeStore, product, variant } from "./helpers/fake_store";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-sup-"));

/** Replays the supplier files of the 23 Nov 2026 report (B12–B17), with made-up data in the same shapes. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sup-"));
const csv = async (name: string, text: string, opts = {}) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return readWorkbook(file, name, opts);
};
const preview = async (sheets: any[], gql: any, extra: Record<string, unknown> = {}) =>
  runImport({ ctx: { gql, options: { dryRun: true, defaultCommand: "UPDATE", blanks: "leave" } as any, log: () => {}, cache: new Map() } as any, sheets, entities: ENTITIES, log: () => {}, ...extra });

const ADDRESS_BLOCK = [
  "2026,,,,",
  "Garden Timber Ltd,,,,",
  "Unit 4, Mill Lane,,,,",
  "Tel:,01234 567890,,,",
  ",,,,",
  ",Description,Pack,Trade Price,RRP",
  "WOODEN SHEDS,,,,",
  "GT-100,Apex shed 6x4,1,210.00,399.00",
  "GT-200,Pent shed 8x6,1,310.00,549.00",
  "GT-300,Log store,2,95.00,179.00",
  ",,,,",
  "GT-400,Planter,4,22.50,44.99",
].join("\n");

describe("supplier files: finding the table", () => {
  it("B13: rows of name and address above the table are passed over, and a code column with no name is kept", async () => {
    const [sheet] = await csv("price list.csv", ADDRESS_BLOCK);
    expect(sheet.headerRow).toBe(6);
    expect(sheet.headers).toEqual(["Column A", "Description", "Pack", "Trade Price", "RRP"]);
    expect(sheet.rows.map((r) => r["Column A"])).toEqual(["WOODEN SHEDS", "GT-100", "GT-200", "GT-300", "GT-400"]);
    expect(sheet.rowNumbers).toEqual([7, 8, 9, 10, 12]);
    expect((sheet.notes ?? []).join(" ")).toMatch(/Rows 1 to 5 .* are above the table.*taken from row 6/);
    expect((sheet.notes ?? []).join(" ")).toMatch(/called "Column A" here/);
    expect(sheet.top?.[1][0]).toBe("Garden Timber Ltd");
  });

  it("B13: the row of column names can be chosen by hand, or said to be missing", async () => {
    const text = "Discontinued lines\nGT-900,Old shed,150.00\nGT-901,Old store,60.00\nGT-902,Old planter,12.00\n";
    const [byRow] = await csv("disc.csv", text, { headerRow: () => 2 });
    expect(byRow.headers).toEqual(["GT-900", "Old shed", "150.00"]);
    const [none] = await csv("disc.csv", text, { headerRow: () => 0 });
    expect(none.headerRow).toBe(0);
    expect(none.headers).toEqual(["Column A", "Column B", "Column C"]);
    expect(none.rows.map((r) => r["Column A"])).toEqual(["GT-900", "GT-901", "GT-902"]);
    expect(none.rowNumbers).toEqual([2, 3, 4]);
  });

  it("an ordinary file is read as before", async () => {
    const [sheet] = await csv("Products.csv", "Handle,Variant SKU,Variant Price\nbin,B1,5\ntub,T1,6\n");
    expect(sheet.headerRow).toBe(1);
    expect(sheet.headers).toEqual(["Handle", "Variant SKU", "Variant Price"]);
    expect(sheet.rowNumbers).toBeUndefined();
    expect(sheet.notes ?? []).toEqual([]);
  });

  it("a matching saved with its own row of column names is used when that row of the file fits it", async () => {
    const layout: ColumnLayout = { id: "x", name: "Disc", entity: "products", map: { "Column A": "Variant SKU", "Column B": "", "Column C": "Variant Cost" }, savedAt: "", headerRow: 0 };
    const [sheet] = await csv("disc.csv", "Discontinued lines\nGT-900,Old shed,150.00\nGT-901,Old store,60.00\nGT-902,Old planter,12.00\n", { headerRow: headerRowFromLayouts([layout]) });
    expect(sheet.headers).toEqual(["Column A", "Column B", "Column C"]);
  });
});

describe("supplier files: what the columns are", () => {
  const products = getEntity("products")!;

  it("B14: a price list with a Code column is products, and its columns are suggested", () => {
    const headers = ["Code", "Description", "Barcode", "2026 HD Trade Price", "RRP", "Pack Qty"];
    expect(detectEntity({ name: "Sheds", headers }, ENTITIES)?.key).toBe("products");
    expect(suggestAll(products, headers)).toEqual({ Code: "Variant SKU", Description: "", Barcode: "Variant Barcode", "2026 HD Trade Price": "Variant Cost", RRP: "Variant Price", "Pack Qty": "" });
  });

  it("B12/B15: stock goes to a location, and the supplier's product name is left alone", () => {
    const map = suggestAll(products, ["SKU", "Product Name", "Quantity in Stock"], { locations: ["Shop", "Norfolk Leisure"], fileName: "Norfolk Leisure stock.xlsx" });
    expect(map).toEqual({ SKU: "Variant SKU", "Product Name": "", "Quantity in Stock": "Inventory Available: Norfolk Leisure" });
  });

  it("B17: stock written in words", () => {
    expect(stockFromText("IN STOCK", 20)).toEqual({ qty: "20", read: "in" });
    expect(stockFromText("In stock", null)).toEqual({ qty: "", read: "in" });
    expect(stockFromText("OUT OF STOCK", 20)).toEqual({ qty: "0", read: "out" });
    expect(stockFromText("1,250", null)).toEqual({ qty: "1250", read: "number" });
    expect(stockFromText("50+", null)).toEqual({ qty: "50", read: "number" });
    expect(stockFromText("Due March", 20)).toEqual({ qty: "", read: "unknown" });
  });
});

describe("supplier files: against the shop", () => {
  const store = () =>
    fakeStore(
      [product("apex", "Our Apex Shed", [variant("GT-100", "399.00", {}, { stock: { "Norfolk Leisure": 0 }, barcode: "5012345000017" })]), product("planter", "Our Planter", [variant("GT-400", "44.99", {}, { stock: { "Norfolk Leisure": 3 }, barcode: "5012345000048" })])],
      ["Norfolk Leisure"],
    );
  const layout: ColumnLayout = { id: "n", name: "Norfolk Leisure", entity: "products", map: { Code: "Variant SKU", "Product Name": "", Stock: "Inventory Available: Norfolk Leisure" }, savedAt: "", inStockQty: 10 };

  it("B12/B16/B17: stock by location; codes not in the shop are skipped, blank and heading rows left out", async () => {
    const [sheet] = await csv("norfolk.csv", "Code,Product Name,Stock\nGT-100,Supplier name for the shed,36\n,,\nGARDEN,,\nGT-400,Supplier planter,IN STOCK\nZZ-1,Not ours,12\nZZ-2,Not ours either,OUT OF STOCK\n");
    const note = applyLayout(sheet, layout, layoutKeys("products"));
    expect(note).toMatch(/1 row has no Variant SKU \(blank lines or headings\): left out/);
    expect(note).toMatch(/"in stock" \(1 row\) is read as 10/);
    expect(sheet.rowNumbers).toEqual([2, 5, 6, 7]);
    const [s] = await preview([sheet], store().gql);
    expect(s).toMatchObject({ entity: "products", ok: 2, failed: 0, skipped: 2 });
    const changes = s.preview!.flatMap((p) => p.changes).join("\n");
    expect(changes).toMatch(/Norfolk Leisure.*0 → 36/);
    expect(changes).toMatch(/Norfolk Leisure.*3 → 10/);
    expect(changes).not.toMatch(/Title/);
    expect((s.warnings ?? []).join(" ")).toMatch(/2 rows are for things not in your shop: skipped/);
    // Only information: such a job is not "with warnings".
    expect(jobHealth({ type: "import", status: "finished", stats: [{ ...s, warnings: ["Blank cells in this sheet leave their fields as they are. To empty a field, type [clear] in its cell.", "2 rows are for things not in your shop: skipped, as this file's column matching says."] }] }).label).toBe("Finished");
  });

  it("B16: with skipping switched off they are failures, as before", async () => {
    const [sheet] = await csv("norfolk.csv", "Code,Product Name,Stock\nGT-100,Shed,36\nZZ-1,Not ours,12\n");
    applyLayout(sheet, { ...layout, skipUnknown: false }, layoutKeys("products"));
    const [s] = await preview([sheet], store().gql);
    expect(s).toMatchObject({ ok: 1, failed: 1, skipped: 0 });
  });

  it("a list with barcodes only is matched to the shop by barcode", async () => {
    const s0 = store();
    const sheet: any = { name: "Products", headers: ["Variant Barcode", "Variant Cost"], rows: [{ "Variant Barcode": "5012345000017", "Variant Cost": "210" }, { "Variant Barcode": "5012345000048", "Variant Cost": "22.5" }, { "Variant Barcode": "5099999999999", "Variant Cost": "1" }] };
    expect(await resolveBarcodes(s0.gql, sheet)).toEqual({ matched: 2, missing: 1, twice: 0 });
    sheet.skipMissing = true;
    const [s] = await preview([sheet], s0.gql);
    expect(s).toMatchObject({ ok: 2, failed: 0, skipped: 1 });
  });

  it("B17: a file with no column that names the product says to match columns", async () => {
    const [s] = await preview([{ name: "PRODUCT LIST", headers: ["Item", "Availability"], rows: [{ Item: "X1", Availability: "IN STOCK" }] }], store().gql);
    expect((s.warnings ?? [])[0]).toMatch(/No column of this sheet says which product each row is.*use "Match columns"/);
  });
});

describe("B29: OpenDocument spreadsheets (.ods)", () => {
  it("reads the sheets of an .ods: numbers as stored, repeated cells, empty rows to the bottom ignored", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const cell = (v: string) => `<table:table-cell office:value-type="string"><text:p>${v}</text:p></table:table-cell>`;
    const num = (v: string, shown: string) => `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${shown}</text:p></table:table-cell>`;
    const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:spreadsheet>
      <table:table table:name="Products"><table:table-column table:number-columns-repeated="3"/>
        <table:table-row>${cell("Handle")}${cell("Variant SKU")}${cell("Variant Price")}<table:table-cell table:number-columns-repeated="1021"/></table:table-row>
        <table:table-row>${cell("bin")}${cell("B1 &amp; co")}${num("12.5", "£12.50")}</table:table-row>
        <table:table-row><table:table-cell office:value-type="string"><text:p>tub<text:s text:c="2"/>x</text:p></table:table-cell><table:table-cell/>${num("6", "6.00")}</table:table-row>
        <table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
      </table:table>
      <table:table table:name="Empty"><table:table-row><table:table-cell/></table:table-row></table:table>
    </office:spreadsheet></office:body></office:document-content>`;
    const file = path.join(dir, "list.ods");
    fs.writeFileSync(file, zipSync({ mimetype: strToU8("application/vnd.oasis.opendocument.spreadsheet"), "content.xml": strToU8(content) }));
    const sheets = await readWorkbook(file, "list.ods");
    expect(sheets.map((s) => s.name)).toEqual(["Products"]);
    expect(sheets[0].headers).toEqual(["Handle", "Variant SKU", "Variant Price"]);
    expect(sheets[0].rows).toEqual([
      { Handle: "bin", "Variant SKU": "B1 & co", "Variant Price": "12.5" },
      { Handle: "tub  x", "Variant SKU": "", "Variant Price": "6" },
    ]);
  });

  it("an old .xls is still refused, with what to do", async () => {
    const file = path.join(dir, "old.xls");
    fs.writeFileSync(file, "x");
    await expect(readWorkbook(file, "old.xls")).rejects.toThrow(/older Excel file \(.xls\).*Save as/);
  });
});

describe("B2: stock is read for many products in one request", () => {
  it("a preview of 12 products with a stock column asks for their stock in far fewer than 12 requests", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const store = fakeStore(names.map((h, i) => product(h, `Product ${i}`, [variant(`S${i}`, "10.00", {}, { stock: { Shop: i } })])), ["Shop"]);
    let stockRequests = 0;
    const gql = (async (q: string, v: any) => {
      if (/ImportStockNow/.test(q)) stockRequests++;
      return store.gql(q, v);
    }) as any;
    const sheet = { name: "Products", headers: ["Handle", "Variant SKU", "Inventory Available: Shop"], rows: names.map((h, i) => ({ Handle: h, "Variant SKU": `S${i}`, "Inventory Available: Shop": String(i + 5) })) };
    const [s] = await preview([sheet], gql);
    expect(s).toMatchObject({ ok: 12, failed: 0 });
    expect(s.preview!.every((p) => p.action === "update")).toBe(true);
    expect(s.preview![3].changes.join(" ")).toMatch(/3 → 8/);
    expect(stockRequests).toBeGreaterThan(0);
    expect(stockRequests).toBeLessThanOrEqual(4);
  });
});
