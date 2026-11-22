import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { runImport } from "../app/lib/core/importer";
import type { PreviewItem } from "../app/lib/core/importer";
import { runExport } from "../app/lib/core/exporter";
import { createCsvOut, FileError, MAX_UNPACKED_BYTES, parseCsv, readWorkbook } from "../app/lib/core/sheets";
import type { Sheet } from "../app/lib/core/sheets";
import { getLocations, locationByName, narrowToLimit } from "../app/lib/core/lookups";
import { splitTags } from "../app/lib/core/util";
import { ENTITIES } from "../app/lib/entities";
import { customersEntity } from "../app/lib/entities/customers";
import { customCollectionsEntity } from "../app/lib/entities/collections";
import { settleDecimalMark } from "../app/lib/entities/products";
import { jobHealth } from "../app/lib/jobs/health";
import { addSecurityHeaders } from "../app/lib/security";
import { fakeStore, product, variant } from "./helpers/fake_store";

/**
 * Replays the findings of the second test round (19 Nov 2026, R2…R40)
 * against a stand-in store and checks each one is fixed.
 */
const FIX = path.resolve("test/fixtures/audit");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-r2-"));
const write = (name: string, data: string | Uint8Array) => {
  const f = path.join(tmp(), name);
  fs.writeFileSync(f, data);
  return f;
};
const csv = (text: string, name = "Products.csv") => readWorkbook(write(name, text));
const notes = (sheets: Sheet[]) => sheets.flatMap((s) => s.notes ?? []).join("\n");

function store() {
  return fakeStore([
    product("potato-barrel", "66 Litre Wooden Potato Planter Barrel", [variant("PB001", "44.99", {}, { barcode: "5061011512567" })]),
    product("dracaena", "Dracaena Planter", [variant("LEAF-7435", "16.99")]),
    product("hurdle", "Willow Hurdle", [variant("WS010", "39.99")]),
  ]);
}

async function preview(sheets: Sheet[], s = store(), options: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const stats = await runImport({
    ctx: { gql: s.gql, options: { dryRun: true, defaultCommand: "UPDATE", ...options } as any, log: (m: string) => logs.push(m), cache: new Map() } as any,
    sheets,
    entities: ENTITIES,
    log: (m) => logs.push(m),
  });
  const items = stats.flatMap((x) => x.preview ?? []);
  return { stats, items, row: (n: number) => items.find((i) => i.row === n) as PreviewItem, warnings: stats.flatMap((x) => x.warnings ?? []).join("\n") };
}

const products = (headers: string[], ...rows: string[][]): Sheet[] => [{ name: "Products", headers, rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) }];

describe("round 2: reading files", () => {
  it("R5/R14: reads workbooks written by SheetJS and openpyxl, comments and tables included", async () => {
    for (const f of ["sheetjs_plain.xlsx", "sheetjs_comment_hidden.xlsx"]) {
      const sheets = await readWorkbook(path.join(FIX, f));
      expect(sheets[0]).toMatchObject({ name: "Products", headers: ["Handle", "Variant SKU", "Variant Price"] });
      expect(sheets[0].rows).toEqual([
        { Handle: "bin", "Variant SKU": "A", "Variant Price": "5" },
        { Handle: "panel", "Variant SKU": "B", "Variant Price": "7.50" },
        { Handle: "x", "Variant SKU": "0012", "Variant Price": "9" },
      ]);
    }
    for (const f of ["opx_comment.xlsx", "opx_table.xlsx"]) {
      const [sheet] = await readWorkbook(path.join(FIX, f));
      expect(sheet.rows).toHaveLength(4);
      expect(sheet.rows[0]).toMatchObject({ Handle: "bin", Title: "Café <b>&amp; Co</b>", "Variant Barcode": "0012345678905", "Published At": "2026-11-19T09:30:00.000Z", Flag: "TRUE", Note: "line1\nline2" });
      expect(sheet.rows[1]).toMatchObject({ "Variant Barcode": "5061011512567", "Variant Price": "7.5", Flag: "FALSE" });
    }
    // Dates, rich text, links, formulas with results and Excel errors, as the library writes them.
    const [mixed] = await readWorkbook(path.join(FIX, "exceljs_mixed.xlsx"));
    expect(mixed.rows[0]).toMatchObject({ When: "2026-11-19T10:00:00.000Z", Rich: "ab", Link: "site", Formula: "2", Err: "#N/A", Pct: "0.25" });
    expect(mixed.rows[1]).toMatchObject({ Formula: "az", Pct: "1234.5" });
  });

  it("R10: hidden sheets are skipped and said so; hidden rows are counted", async () => {
    const sheets = await readWorkbook(path.join(FIX, "opx_hidden.xlsx"));
    expect(sheets.map((s) => s.name)).toEqual(["Products", "Customers"]);
    expect(notes(sheets)).toMatch(/The hidden sheet "Old prices" was skipped/);
    expect(notes(sheets)).toMatch(/1 hidden or filtered-out row on this sheet is included/);
    const sj = await readWorkbook(path.join(FIX, "sheetjs_comment_hidden.xlsx"));
    expect(sj.map((s) => s.name)).toEqual(["Products"]);
  });

  it("R22/R34: a title line above the column names, the names repeated further down, and cells past the last column", async () => {
    const [sheet] = await readWorkbook(path.join(FIX, "opx_banner.xlsx"));
    expect(sheet.headers).toEqual(["Handle", "Variant Price"]);
    expect(sheet.rows).toEqual([
      { Handle: "bin", "Variant Price": "5" },
      { Handle: "panel", "Variant Price": "6" },
    ]);
    expect(notes([sheet])).toMatch(/Row 1 \("Woven Wood price list – November"\) was read as a title line.*taken from row 3/);
    expect(notes([sheet])).toMatch(/column names appears 1 more time further down/);
    expect(notes([sheet])).toMatch(/1 row has values to the right of the last named column/);
    // A one-column file is not mistaken for a title.
    expect((await csv("Handle\nbin\npanel\n"))[0].rows).toHaveLength(2);
  });

  it("R2: a ZIP that would unpack huge is refused from its directory, before anything is unpacked", async () => {
    const zip = zipSync({ "Products.csv": strToU8("Handle,Title\nbin,Bin\n") });
    // Say in the directory that the file is 600 MB.
    const buf = Buffer.from(zip);
    const at = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(600 * 1024 * 1024, at + 24);
    await expect(readWorkbook(write("bomb.zip", buf))).rejects.toThrow(/unpacks to 629 MB, more than the 524 MB/);
    expect(MAX_UNPACKED_BYTES).toBe(500 * 1024 * 1024);
    // The memory check judges an archive by what it unpacks to.
    const { assertFitsInMemory } = await import("../app/lib/jobs/runner.server").catch(() => ({ assertFitsInMemory: null as any }));
    if (assertFitsInMemory) {
      const small = zipSync({ "Products.csv": strToU8("Handle\n" + "a\n".repeat(10)) });
      const b2 = Buffer.from(small);
      b2.writeUInt32LE(300 * 1024 * 1024, b2.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
      await expect(assertFitsInMemory(write("big.zip", b2), "big.zip", { heap_size_limit: 1.5e9, used_heap_size: 2e8 } as any)).rejects.toThrow(/315 MB once unpacked/);
    }
  });

  it("R6: an unclosed quote stops the file with its row, instead of swallowing the next product", async () => {
    await expect(csv('Handle,Title\npotato-barrel,"Barrel with "unbalanced quote\ndracaena,Dracaena\nhurdle,"Hurdle"\n')).rejects.toThrow(/Row \d+ has an unclosed or misplaced quote mark/);
    await expect(csv('Handle,Title\npotato-barrel,"Barrel\ndracaena,Dracaena\n')).rejects.toThrow(FileError);
    // Quotes used properly are fine.
    expect((await csv('Handle,Title\npotato-barrel,"A ""quoted"" title, with a comma"\n'))[0].rows[0].Title).toBe('A "quoted" title, with a comma');
  });

  it("R19/R20: duplicate columns are said; Excel's sep= line sets the delimiter", async () => {
    const [dup] = await csv("Handle,Variant Price,Variant Price\npotato-barrel,16.99,99.00\n");
    expect(dup.rows[0]["Variant Price"]).toBe("16.99");
    expect(notes([dup])).toMatch(/Column "Variant Price" appears twice in this sheet. Only the first is used/);
    const [sep] = await csv("sep=;\nHandle;Title\npotato-barrel;A, B\n");
    expect(sep.headers).toEqual(["Handle", "Title"]);
    expect(sep.rows).toEqual([{ Handle: "potato-barrel", Title: "A, B" }]);
  });

  it("R26/R27: password-protected and older formats get a plain message; .tsv and .txt are read", async () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
    await expect(readWorkbook(write("locked.xlsx", ole))).rejects.toThrow(/"locked.xlsx" is password-protected, or is an older Excel file/);
    await expect(readWorkbook(write("old.xls", ole))).rejects.toThrow(/older Excel file \(\.xls\).*Save as/);
    await expect(readWorkbook(write("book.ods", "x"))).rejects.toThrow(/OpenDocument spreadsheet/);
    await expect(readWorkbook(write("book.numbers", "x"))).rejects.toThrow(/Apple Numbers/);
    await expect(readWorkbook(write("junk.xlsx", "not a workbook at all"))).rejects.toThrow(/"junk.xlsx" is not a real Excel file/);
    expect((await readWorkbook(write("Products.tsv", "Handle\tTitle\nbin\tBin\n")))[0].rows).toEqual([{ Handle: "bin", Title: "Bin" }]);
    expect((await readWorkbook(write("Products.txt", "Handle|Title\nbin|Bin\n")))[0].rows).toEqual([{ Handle: "bin", Title: "Bin" }]);
  });

  it("R13/R38: one unreadable file doesn't sink a ZIP; it is named, and sheets say which file they are from", async () => {
    const good = fs.readFileSync(path.join(FIX, "sheetjs_plain.xlsx"));
    const zip = zipSync({
      "a/first.xlsx": new Uint8Array(good),
      "second.xlsx": new Uint8Array(good),
      "broken.xlsx": strToU8("this is not a workbook"),
      "inner.zip": zipSync({ "x.csv": strToU8("Handle\nx\n") }),
      "Redirects.csv": strToU8("Path,Target\n/a,/b\n"),
      "__MACOSX/._first.xlsx": strToU8("junk"),
    });
    const sheets = await readWorkbook(write("many.zip", zip));
    expect(sheets.map((s) => s.label ?? s.name)).toEqual(["first.xlsx › Products", "second.xlsx › Products", "Redirects"]);
    expect(notes(sheets)).toMatch(/"broken.xlsx" is not a real Excel file/);
    expect(notes(sheets)).toMatch(/"inner.zip" was skipped: ZIP files inside a ZIP are not read/);
    // The label is what the import reports, so two "Products" sheets stay apart.
    const p = await preview(sheets);
    expect(p.stats.map((s) => s.sheet)).toEqual(["first.xlsx › Products", "second.xlsx › Products", "Redirects"]);
    await expect(readWorkbook(write("none.zip", zipSync({ "broken.xlsx": strToU8("nope") })))).rejects.toThrow(/Nothing in "none.zip" could be read.*"broken.xlsx"/);
  });

  it("R29: a web page in place of a file is refused, with none of it echoed", async () => {
    const err = await csv("<!doctype html><html lang=en><head><title>secret internal page</title></head><body>hello</body></html>", "Redirects.csv").catch((e) => e);
    expect(err).toBeInstanceOf(FileError);
    expect(err.message).toMatch(/This is a web page, not a spreadsheet/);
    expect(err.message).not.toMatch(/secret/);
  });

  it("R9/R16/R17: look-alike and invisible characters in key columns are put right; elsewhere they are pointed out", async () => {
    const [sheet] = await csv("Handle,Variant SKU,Title\npotato​-barrel,ＬＥＡＦ-７４３５,Planter ‮gnp.exe\n");
    expect(sheet.rows[0].Handle).toBe("potato-barrel");
    expect(sheet.rows[0]["Variant SKU"]).toBe("LEAF-7435");
    expect(sheet.rows[0].Title).toBe("Planter ‮gnp.exe");
    const n = notes([sheet]);
    expect(n).toMatch(/1 value in key columns was typed in full-width characters/);
    expect(n).toMatch(/1 cell contains an invisible character.*row 2, "Handle"/);
    expect(n).toMatch(/1 cell contains a hidden character that reverses the direction of text.*row 2, "Title"/);
  });

  it("R18: formula-style text is pointed out on import, and CSV exports guard it for Excel", async () => {
    const [sheet] = await csv('Handle,Tags\npotato-barrel,"=HYPERLINK(""http://example.com"", ""click"")"\ndracaena,+cmd|x\nhurdle,-20% off\n');
    expect(notes([sheet])).toMatch(/2 cells start like a spreadsheet formula \(first: row 2, "Tags": =HYPERLINK/);
    const dir = tmp();
    const out = createCsvOut(path.join(dir, "Export"));
    await out.addSheet("Products", ["Handle", "Tags"], [{ Handle: "a", Tags: "=1+1" }, { Handle: "b", Tags: "-20% off" }, { Handle: "c", Tags: "@SUM(A1)" }]);
    const file = await out.close();
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("a,'=1+1");
    expect(text).toContain("b,-20% off");
    expect(text).toContain("c,'@SUM(A1)");
    // Read back here, the guard comes off again: the round trip is unchanged.
    expect(parseCsv(text).rows.map((r) => r.Tags)).toEqual(["=1+1", "-20% off", "@SUM(A1)"]);
  });

  it("R32: the same tag typed two ways is one tag", () => {
    expect(splitTags("Café, Café, garden")).toEqual(["Café", "garden"]);
  });
});

describe("round 2: checks on every import", () => {
  it("R7/R8: a barcode shortened by Excel and an Excel error value fail the row, in any column", async () => {
    const p = await preview(products(["Handle", "Title", "Variant SKU", "Variant Barcode"], ["potato-barrel", "", "PB001", "1.23457E+12"], ["dracaena", "#REF!", "LEAF-7435", ""]));
    expect(p.row(2)).toMatchObject({ action: "failed" });
    expect(p.row(2).message).toMatch(/"Variant Barcode" holds 1.23457E\+12, which is how Excel writes a long number it has shortened/);
    expect(p.row(3)).toMatchObject({ action: "failed" });
    expect(p.row(3).message).toMatch(/"Title" holds an Excel error \(#REF!\)/);
  });

  it("R7/R24: replacing a barcode and switching stock tracking off are warnings", async () => {
    const p = await preview(products(["Handle", "Variant SKU", "Variant Barcode", "Variant Inventory Tracker"], ["potato-barrel", "PB001", "5061011599999", ""]));
    const w = (p.row(2).warnings ?? []).join("\n");
    expect(w).toMatch(/the barcode of .*PB001.* is replaced \(5061011512567 → 5061011599999\)/);
    expect(w).toMatch(/stock tracking for .*PB001.* is switched off/);
    expect(p.stats[0].risk).toMatchObject({ warned: 1 });
  });

  it("R23: Shopify's own export column names are read as the columns they mean", async () => {
    const p = await preview(products(["Handle", "Body (HTML)", "Variant SKU", "Cost per item", "Variant Grams", "Product Category", "Variant Fulfillment Service"], ["potato-barrel", "<p>New text</p>", "PB001", "12.50", "2500", "Home & Garden", "manual"]));
    expect(p.warnings).toMatch(/Column names from Shopify's own export were recognised: "Body \(HTML\)" is read as "Body HTML"; "Cost per item" is read as "Variant Cost"; "Variant Grams" is read as "Variant Weight" \(in grams\)/);
    expect(p.warnings).not.toMatch(/"Body \(HTML\)" is not a Products column/);
    expect(p.warnings).toMatch(/Column "Product Category" is not a Products column and is ignored. Use "Category: ID"/);
    const changes = p.row(2).changes.join("\n");
    expect(changes).toMatch(/Body HTML: .* → <p>New text<\/p>/);
    expect(changes).toMatch(/Variant Weight .*→ 2500 g/);
  });

  it("R28: a thousand unknown columns are one line, not a thousand", async () => {
    const junk = Array.from({ length: 1000 }, (_, i) => `Junk ${i + 1}`);
    const p = await preview(products(["Handle", "Title", ...junk], ["potato-barrel", "66 Litre Wooden Potato Planter Barrel"]));
    const lines = p.warnings.split("\n").filter((l) => /not .*Products column/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^1,000 columns are not Products columns and are ignored: "Junk 1", .* … "Junk 1000"\.$/);
    // A near-miss still gets its own line with the suggestion.
    const q = await preview(products(["Handle", "Titel"], ["potato-barrel", "x"]));
    expect(q.warnings).toMatch(/Column "Titel" is not a Products column and is ignored. Did you mean "Title"\?/);
  });

  it("R21/R35/R33: a bad publish date is an error, HTML in a title and an odd handle are warnings", async () => {
    const p = await preview(
      products(["Handle", "Title", "Published At", "Command"], ["potato-barrel", "", "2026-13-01", ""], ["dracaena", '<img src=x onerror="alert(1)">', "", ""], ["planter-🌳-test", "New planter", "", "NEW"]),
    );
    expect(p.row(2)).toMatchObject({ action: "failed" });
    expect(p.row(2).message).toMatch(/Published At "2026-13-01" is not a date/);
    expect((p.row(3).warnings ?? []).join()).toMatch(/the new title contains HTML tags/);
    expect((p.row(4).warnings ?? []).join()).toMatch(/the handle "planter-🌳-test" has characters Shopify may change or remove/);
    // A valid date on its own is not imported, and the sheet says so once.
    const q = await preview(products(["Handle", "Published At"], ["potato-barrel", "2026-12-01T09:00:00Z"]));
    expect(q.row(2)).toMatchObject({ action: "none" });
    expect(q.warnings).toMatch(/"Published At" is only used when "Published" changes in the same row/);
  });

  it("R25: a video's preview picture in its own export is not taken as a new image", async () => {
    const p = await preview(products(["Handle", "Image Type", "Image Src", "Image Command"], ["potato-barrel", "Video", "https://cdn.shopify.com/s/files/1/eb7380522beb.thumbnail.0000000000.jpg", "MERGE"]));
    expect(p.row(2)).toMatchObject({ action: "none", changes: [] });
  });

  it("R15: the decimal mark is decided once for the sheet, and said", async () => {
    const p = await preview(products(["Handle", "Variant SKU", "Variant Price"], ["potato-barrel", "PB001", "44,99"], ["hurdle", "WS010", "39,990"]));
    expect(p.row(2)).toMatchObject({ action: "none" });
    expect(p.row(3)).toMatchObject({ action: "none" });
    expect(p.warnings).toMatch(/use a comma as the decimal mark.*"39,990" was read as 39.99, not as thousands/);
    // With a decimal point elsewhere in the sheet, a comma is a thousands separator as before.
    const rows = [{ "Variant Price": "1,299.00" }, { "Variant Price": "39,990" }];
    expect(settleDecimalMark(rows)).toBe("point");
    expect(rows[1]["Variant Price"]).toBe("39,990");
  });
});

describe("round 2: locations, exports and limits", () => {
  const locationsGql = (nodes: any[]) => async (_q: string) => ({ locations: { nodes, pageInfo: { hasNextPage: false } } });

  it("R3: a fulfilment app's location is found by its exported name", async () => {
    let asked = "";
    const gql = (async (q: string) => {
      asked = q;
      return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Warehouse", isActive: true, fulfillmentService: null }, { id: "gid://shopify/Location/2", name: "Charles Taylor (GURU)", isActive: true, fulfillmentService: { serviceName: "GURU", inventoryManagement: true } }], pageInfo: { hasNextPage: false } } };
    }) as any;
    const cache = new Map<string, unknown>();
    expect(await locationByName(gql, cache, "Charles Taylor (GURU)")).toMatchObject({ id: "gid://shopify/Location/2", service: { name: "GURU", managed: true } });
    // The store's own query leaves fulfilment-service locations out unless asked.
    expect(asked).toMatch(/includeLegacy: true/);
    expect(await locationByName(gql, cache, " charles  taylor (guru) ")).toMatchObject({ id: "gid://shopify/Location/2" });
    await expect(locationByName(gql, cache, "Nowhere")).rejects.toThrow(/no location called "Nowhere". Its locations are: "Warehouse", "Charles Taylor \(GURU\)"/);
    expect(await getLocations(locationsGql([]) as any, new Map())).toEqual([]);
  });

  it("R4: exports leave the Command column blank", async () => {
    const dir = tmp();
    const out = createCsvOut(path.join(dir, "Export"));
    const entity: any = { key: "redirects", sheet: "Redirects", columns: ["ID", "Command", "Path", "Target"], export: async (_ctx: any, emit: any) => emit([{ ID: "1", Command: "MERGE", Path: "/a", Target: "/b" }]) };
    await runExport({ gql: (async () => ({})) as any, bulk: (async function* () {}) as any, requests: [{ entity, options: { columns: ["ID", "Command", "Path", "Target"] } as any }], out, tmpDir: dir, log: () => {} } as any);
    const text = fs.readFileSync(await out.close(), "utf8");
    expect(text).toContain("ID,Command,Path,Target");
    expect(text).toContain("1,,/a,/b");
    expect(text).not.toContain("MERGE");
  });

  it("R12: a small 'first N' export looks those N up first, so the bulk read fetches only them", async () => {
    const calls: any[] = [];
    const ctx: any = {
      options: { limit: 2 },
      log: () => {},
      gql: async (q: string, v: any) => {
        calls.push({ q, v });
        return { customers: { nodes: [{ id: "gid://shopify/Customer/11" }, { id: "gid://shopify/Customer/12" }] } };
      },
    };
    expect(await narrowToLimit(ctx, "customers", "tag:vip")).toBe("id:11 OR id:12");
    expect(calls[0].v).toEqual({ n: 2, q: "tag:vip" });
    // No limit, or a large one: the search is used as it is.
    expect(await narrowToLimit({ ...ctx, options: {} }, "customers", "tag:vip")).toBe("tag:vip");
    expect(await narrowToLimit({ ...ctx, options: { limit: 5000 } }, "customers", "")).toBe("");
    expect(await narrowToLimit({ ...ctx, gql: async () => ({ customers: { nodes: [] } }) }, "customers", "tag:none")).toBe("id:0");
    expect(await narrowToLimit({ ...ctx, gql: async () => Promise.reject(new Error("no access")) }, "customers", "tag:vip")).toBe("tag:vip");
  });
});

describe("round 2: customers and collections are compared with the store (R11)", () => {
  const ann = {
    id: "gid://shopify/Customer/7",
    firstName: "Ann",
    lastName: "Lee",
    displayName: "Ann Lee",
    note: "",
    locale: "en",
    taxExempt: false,
    taxExemptions: [],
    tags: ["vip", "trade"],
    defaultEmailAddress: { emailAddress: "ann@example.com", marketingState: "UNSUBSCRIBED", marketingOptInLevel: null },
    defaultPhoneNumber: null,
    defaultAddress: null,
    addressesV2: { nodes: [] },
  };
  const gqlFor = (handlers: Record<string, (v: any) => any>) => {
    const ops: string[] = [];
    const gql = async (query: string, vars?: any) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
      ops.push(op);
      if (!handlers[op]) throw new Error(`Unexpected operation ${op}`);
      return handlers[op](vars ?? {});
    };
    return { ctx: { gql, options: { dryRun: true }, log: () => {}, cache: new Map() } as any, ops };
  };
  const customers = { ImportCustomerById: () => ({ customer: ann }), ImportCustomerByIdentifier: () => ({ customerByIdentifier: null }) };

  it("a customer's own values fed back are no change", async () => {
    const m = gqlFor(customers);
    const r = await customersEntity.import!.apply(m.ctx, [{ ID: "7", Email: "ann@example.com", "First Name": "Ann", "Last Name": "Lee", "Tax Exempt": "FALSE", Tags: "trade, vip", "Accepts Email Marketing": "FALSE", Language: "EN" }], "UPDATE");
    expect(r).toMatchObject({ status: "OK", title: "Ann Lee, ann@example.com", preview: { action: "none", changes: [], warnings: [] } });
  });

  it("consent, tax-exempt and tag changes are shown old → new and flagged", async () => {
    const m = gqlFor(customers);
    const r = await customersEntity.import!.apply(m.ctx, [{ ID: "7", "Accepts Email Marketing": "TRUE", "Tax Exempt": "TRUE", Tags: "", "First Name": "Anne" }], "UPDATE");
    expect(r.status).toBe("OK");
    expect(r.preview!.action).toBe("update");
    expect(r.preview!.changes).toEqual(
      expect.arrayContaining(["First Name: Ann → Anne", "Tax Exempt: no → yes", "Tags: vip, trade → (cleared: all 2 tags removed)", "Email marketing: unsubscribed → subscribed"]),
    );
    expect(r.preview!.clears).toEqual(["Tags"]);
    const w = r.preview!.warnings.join("\n");
    expect(w).toMatch(/the customer is set to receive email marketing \(now: unsubscribed\). Only do this if they agreed to it/);
    expect(w).toMatch(/the customer becomes tax exempt/);
    // Nothing was written.
    expect(m.ops.filter((o) => !/^ImportCustomerBy/.test(o))).toEqual([]);
  });

  it("bad values are refused, every one named", async () => {
    const m = gqlFor(customers);
    const r = await customersEntity.import!.apply(m.ctx, [{ ID: "7", Email: "not-an-email", Phone: "12345", "Tax Exempt": "maybe" }], "UPDATE");
    expect(r.status).toBe("Failed");
    expect(r.errors).toEqual(expect.arrayContaining(['Email "not-an-email" is not an email address', expect.stringMatching(/Phone "12345" is not a full phone number/), expect.stringMatching(/Expected TRUE or FALSE but got "maybe"/)]));
  });

  it("a delete row names the customer; an unknown one says how to create it", async () => {
    const m = gqlFor(customers);
    const del = await customersEntity.import!.apply(m.ctx, [{ ID: "7" }], "DELETE");
    expect(del).toMatchObject({ title: "Ann Lee, ann@example.com", preview: { action: "delete", deletes: 1 } });
    expect(del.preview!.changes[0]).toMatch(/Deletes the customer Ann Lee, ann@example.com/);
    const none = gqlFor({ ...customers, ImportCustomerById: () => ({ customer: null }) });
    const r = await customersEntity.import!.apply(none.ctx, [{ ID: "9", "First Name": "X" }], "UPDATE");
    expect(r.message).toMatch(/Customer not found \(ID 9\). Rows only update customers that exist; to create this customer, set Command to MERGE or NEW/);
  });

  it("a collection's fields are compared, and its own values are no change", async () => {
    const existing = { id: "gid://shopify/Collection/5", handle: "planters", title: "Planters", sortOrder: "BEST_SELLING", image: null, ruleSet: null };
    const handlers = {
      ImportCollectionById: () => ({ collection: existing }),
      ImportCollectionNow: () => ({ collection: { descriptionHtml: "<p>All planters</p>", templateSuffix: null, seo: { title: "Planters", description: "" }, metafields: { nodes: [] } } }),
      Publications: () => ({ publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store", catalog: null }] } }),
      ImportCollectionPublishedNow: () => ({ collection: { publishedOnPublication: true } }),
    };
    const same = gqlFor(handlers);
    const r = await customCollectionsEntity.import!.apply(same.ctx, [{ ID: "5", Handle: "planters", Title: "Planters", "Body HTML": "<p>All planters</p>", "Sort Order": "Best Selling", "SEO Title": "Planters", Published: "TRUE" }], "UPDATE");
    expect(r).toMatchObject({ status: "OK", title: "Planters", preview: { action: "none", changes: [] } });
    const m = gqlFor(handlers);
    const c = await customCollectionsEntity.import!.apply(m.ctx, [{ ID: "5", Title: "Garden planters", "Body HTML": "", Published: "FALSE" }], "UPDATE");
    expect(c.preview!.changes).toEqual(["Title: Planters → Garden planters", "Body HTML: <p>All planters</p> → (cleared)", "Published: yes → no"]);
    expect(c.preview!.clears).toEqual(["Body HTML"]);
    expect(c.preview!.warnings.join()).toMatch(/taken off the online store/);
  });
});

describe("round 2: connector, messages and security", () => {
  it("R36: a file with only column names is 'Nothing to import', not 'Preview ready'", () => {
    expect(jobHealth({ type: "import", status: "finished", dryRun: true, stats: [{ sheet: "Products", entity: "products", items: 0, ok: 0, failed: 0, skipped: 0 }] as any })).toMatchObject({ level: "warning", label: "Nothing to import" });
    expect(jobHealth({ type: "import", status: "finished", dryRun: true, stats: [{ sheet: "Products", entity: "products", items: 2, ok: 2, failed: 0, skipped: 0 }] as any })).toMatchObject({ level: "ok", label: "Preview ready" });
  });

  it("R37: an unknown redirect says what to do; a plain Path,Target file adds redirects", async () => {
    const s = fakeStore([]);
    const gql = (async (q: string, v: any) => (/UrlRedirect|urlRedirects/.test(q) ? { urlRedirects: { nodes: [], pageInfo: { hasNextPage: false } }, urlRedirect: null } : s.gql(q, v))) as any;
    const go = (row: Record<string, string>) =>
      runImport({
        ctx: { gql, options: { dryRun: true, defaultCommand: "UPDATE" } as any, log: () => {}, cache: new Map() } as any,
        sheets: [{ name: "Redirects", headers: Object.keys(row), rows: [row] }],
        entities: ENTITIES,
        log: () => {},
      });
    // Asked outright to update one that isn't there.
    expect((await go({ Path: "/old-page", Target: "/new-page", Command: "UPDATE" }))[0].preview![0].message).toMatch(/Redirect not found.*set Command to MERGE or NEW/);
    // No Command at all: the usual way to add redirects. It would be created (and starts on Skip like any new item).
    expect((await go({ Path: "/old-page", Target: "/new-page" }))[0].preview![0]).toMatchObject({ action: "create" });
  });

  it("R39: every response says HTTPS only and no type guessing; pages can only be framed by the Shopify admin", () => {
    const h = addSecurityHeaders(new Headers());
    expect(h.get("Strict-Transport-Security")).toMatch(/max-age=31536000/);
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Content-Security-Policy")).toMatch(/frame-ancestors https:\/\/admin\.shopify\.com/);
    // Shopify's own policy for the shop, when it is set, is kept.
    const own = addSecurityHeaders(new Headers({ "Content-Security-Policy": "frame-ancestors https://x.myshopify.com https://admin.shopify.com;" }));
    expect(own.get("Content-Security-Policy")).toBe("frame-ancestors https://x.myshopify.com https://admin.shopify.com;");
  });
});
