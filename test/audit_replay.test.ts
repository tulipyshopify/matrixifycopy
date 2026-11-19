import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runImport } from "../app/lib/core/importer";
import type { ImportSummary, PreviewItem } from "../app/lib/core/importer";
import { readWorkbook } from "../app/lib/core/sheets";
import type { Sheet } from "../app/lib/core/sheets";
import { ENTITIES } from "../app/lib/entities";
import { fakeStore, product, variant } from "./helpers/fake_store";

/**
 * Replays the files of the 19 Nov 2026 audit against a stand-in store and
 * checks each finding it raised (C1…L11) is fixed.
 */
const FIX = path.resolve("test/fixtures/audit");

function wovenWood(locations = ["Warehouse"]) {
  return fakeStore(
    [
      product("66-litre-wooden-potato-planter-barrel", "66 Litre Wooden Potato Planter Barrel", [variant("PB001", "44.99", {}, { stock: { Warehouse: 12 } })]),
      product("20cm-ceramic-green-glazed-barrel-planter-with-artificial-green-dracaena-plant-3", "Dracaena Planter", [variant("LEAF-7435", "16.99")], {
        tags: ["a", "b", "c", "d", "e", "f", "g", "h", "safety"],
      }),
      product("18cm-ceramic-green-glazed-barrel-planter-with-artificial-sedum-clavatum-plant-2", "Sedum Planter", [variant("LEAF-7434", "14.99")]),
      product("70cm-half-whisky-barrel-tree-planter", "70cm Half Whisky Barrel Tree Planter", [
        variant("WP057N", "79.99", { Finish: "Natural", Size: "Standard" }),
        variant("WP058", "79.99", { Finish: "Rustic", Size: "Standard" }),
        variant("WP057-BUR", "89.99", { Finish: "Burnt", Size: "Standard" }),
        variant("WP057N-L", "99.99", { Finish: "Natural", Size: "Large" }),
        variant("WP058-L", "99.99", { Finish: "Rustic", Size: "Large" }),
      ]),
      product("70cm-wildlife-whisky-barrel-pond-in-a-pot-kit", "Oak Half Barrel Wildlife Pond In A Pot Kit", [
        variant("WP057L", "159.99", { Kit: "Basic" }),
        variant("WP057L25WF", "179.99", { Kit: "Wildflower" }),
        variant("WP057L25WFLI", "180.00", { Kit: "Wildflower Lily" }),
        variant("WP057L5W", "180.00", { Kit: "5 Plants" }),
        variant("WP057L25WFL", "189.99", { Kit: "Wildflower Large" }),
      ]),
      product("willow-bunch-weave-hurdle-fence-panel", "Willow Bunch Weave Hurdle Fence Panel", [variant("WS009", "45.00")]),
    ],
    locations,
  );
}

async function preview(sheets: Sheet[], store: ReturnType<typeof fakeStore>, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const stats = await runImport({
    ctx: { gql: store.gql, options: { dryRun: true, defaultCommand: "MERGE", ...options } as any, log: (m: string) => logs.push(m), cache: new Map(), ...extra } as any,
    sheets,
    entities: ENTITIES,
    log: (m) => logs.push(m),
  });
  const items = stats.flatMap((s) => s.preview ?? []);
  const row = (n: number) => items.find((i) => i.row === n) as PreviewItem;
  return { stats, items, row, logs, log: logs.join("\n") };
}

const file = (name: string) => readWorkbook(path.join(FIX, name));

describe("audit: dry-run test with a real file (section 2)", () => {
  it("C1/H1/M4: compares with the store, shows old → new, and counts an unchanged row as no change", async () => {
    const store = wovenWood();
    const p = await preview(await file("dryrun_products_test.csv"), store);
    expect(store.mutations()).toEqual([]);
    // Row 2: a real price change, with the old value, and a warning about the compare-at price.
    expect(p.row(2)).toMatchObject({ action: "update", compared: true });
    expect(p.row(2).changes).toEqual(["Variant Price (SKU PB001): 44.99 → 45.99", "Variant Compare At Price (SKU PB001): (empty) → 30"]);
    expect(p.row(2).warnings?.join(" ")).toMatch(/compare-at price \(30\) is not above the price \(45\.99\)/);
    // Row 3: same price as the store. Not an update.
    expect(p.row(3)).toMatchObject({ action: "none", changes: [] });
    // Row 4: a create, as a draft, said plainly.
    expect(p.row(4)).toMatchObject({ action: "create", creates: 1 });
    expect(p.row(4).changes.join("\n")).toMatch(/Status: Draft \(new products start as drafts/);
    expect(p.row(4).changes.join("\n")).toMatch(/Online Store: not published/);
    // Row 5: a clear error.
    expect(p.row(5)).toMatchObject({ action: "failed" });
    expect(p.row(5).message).toMatch(/Row 5: Variant Price: expected a price but got "abc"/);
    expect(p.stats[0].risk).toEqual({ creates: 1, updates: 1, deletes: 0, unchanged: 1, clearing: 0, warned: 1 });
    expect(p.stats[0]).toMatchObject({ ok: 3, failed: 1 });
  });

  it("C3: with the update-only default, an unknown handle fails instead of creating a product", async () => {
    const p = await preview(await file("dryrun_products_test.csv"), wovenWood(), { defaultCommand: "UPDATE" });
    expect(p.row(4)).toMatchObject({ action: "failed" });
    expect(p.row(4).message).toMatch(/Product not found \(no product has the handle "bulkport-test-does-not-exist"\)\. To create it, use the command MERGE or NEW/);
  });
});

describe("audit: edge_cases_products.csv (section 3)", () => {
  it("C4/H9: every bad value in a multi-row product is reported with its row, in one pass", async () => {
    const p = await preview(await file("edge_cases_products.csv"), wovenWood());
    const errors = p.row(2).errors ?? [];
    // Rows 2–6 of one product: £79.99 and 89,99 are read; -10 is refused.
    expect(p.row(2).action).toBe("failed");
    expect(errors.join("\n")).toMatch(/Row 5: Variant Price cannot be negative \(-10\)/);
    // Rows 7–12 of the next product.
    const e7 = (p.row(7).errors ?? []).join("\n");
    expect(e7).toMatch(/Row 9: Variant Price "1\.8E\+2" is in scientific notation/);
    expect(e7).toMatch(/Rows 10 and 11 both change the same variant \(SKU WP057L5W\)/);
    expect(e7).toMatch(/Row 12: No variant with SKU "NOT-A-REAL-SKU" on this product/);
    // Rows 13–14: a SKU of another product, and stock "ten".
    const e13 = (p.row(13).errors ?? []).join("\n");
    expect(e13).toMatch(/Row 13: SKU "WP057L25WFL" belongs to another product \(70cm-wildlife-whisky-barrel-pond-in-a-pot-kit\)/);
    expect(e13).toMatch(/Row 14: Variant Inventory Qty must be a whole number, but is "ten"/);
    expect(p.items.filter((i) => i.action !== "failed").every((i) => i.compared)).toBe(true);
  });

  it("C4/M4: when the bad rows are fixed, each variant's change and its warnings are listed", async () => {
    const [sheet] = await file("edge_cases_products.csv");
    // Keep rows 2, 3, 4 and 6 (the 90% drop, £79.99, 89,99 and zero).
    const rows = [sheet.rows[0], sheet.rows[1], sheet.rows[2], sheet.rows[4]];
    const p = await preview([{ ...sheet, rows }], wovenWood());
    const item = p.items[0];
    expect(item.action).toBe("update");
    expect(item.changes).toContain("Variant Price (SKU WP057N): 79.99 → 7.99");
    expect(item.changes).toContain("Variant Price (SKU WP058-L): 99.99 → 0");
    // "£79.99" equals the store's 79.99 and "89,99" equals 89.99: no change for those two.
    expect(item.changes.filter((c) => c.startsWith("Variant Price"))).toHaveLength(2);
    expect(item.warnings?.join("\n")).toMatch(/Row 2 \(SKU WP057N\): the price drops 90% \(79\.99 → 7\.99\)/);
    expect(item.warnings?.join("\n")).toMatch(/Row 5 \(SKU WP058-L\): the price would be 0/);
    // The blank Body HTML, Tags… columns of this file would empty those fields: flagged, not hidden.
    expect(item.clears).toEqual(expect.arrayContaining(["Body HTML", "Tags"]));
    expect(item.changes.join("\n")).toMatch(/Tags: garden, outdoor → \(cleared: all 2 tags removed\)/);
  });

  it("H7/C6: a tag wipe and a delete say exactly what would be lost", async () => {
    const p = await preview(await file("edge_cases_products.csv"), wovenWood());
    expect(p.row(17).changes.join("\n")).toMatch(/Tags: a, b, c, d, e, f, g, h, safety → \(cleared: all 9 tags removed\)/);
    expect(p.row(17).clears).toContain("Tags");
    expect(p.row(18)).toMatchObject({ action: "delete", deletes: 1 });
    expect(p.row(18).changes[0]).toMatch(/Deletes the product "Sedum Planter" with its 1 variant and 0 images\. This cannot be undone\./);
    const risk = p.stats[0].risk!;
    expect(risk.deletes).toBe(1);
    expect(risk.clearing).toBeGreaterThanOrEqual(1);
  });

  it("M9/L9: flags the misspelt column and the over-long title; row 15 still matches its handle", async () => {
    const p = await preview(await file("edge_cases_products.csv"), wovenWood());
    expect(p.stats[0].warnings).toEqual(['Column "Varient Price" is not a Products column and is ignored. Did you mean "Variant Price"?']);
    expect(p.row(15).message).toMatch(/Status must be one of Active, Draft, Archived, Unlisted/);
    expect(p.row(16).message).toMatch(/Title is \d{3} characters long; Shopify allows 255/);
  });
});

describe("audit: file reading (C5, M8, M18)", () => {
  it("C5: reads a Windows-1252 file as such, with £ and é intact, a decimal comma, and a note", async () => {
    const sheets = await file("edge_semicolon_win1252.csv");
    expect(sheets[0].rows[0]["Variant Price"]).toBe("£79,99");
    expect(sheets[0].rows[1].Title).toBe("Oak Half Barrel Wildlife Pond In A Pot Kit – Café Edition");
    const p = await preview(sheets, wovenWood());
    expect(p.stats[0].warnings?.[0]).toMatch(/not saved as UTF-8, so it was read as Windows-1252/);
    // £79,99 is the store's price already; 159,99 too. Only the title changes, readable.
    expect(p.row(2)).toMatchObject({ action: "none" });
    expect(p.row(3).changes).toEqual(["Title: Oak Half Barrel Wildlife Pond In A Pot Kit → Oak Half Barrel Wildlife Pond In A Pot Kit – Café Edition"]);
    expect(JSON.stringify(p.items)).not.toContain("�");
  });

  it("C5: refuses a row whose text is already damaged", async () => {
    const p = await preview([{ name: "Products", headers: ["Handle", "Title"], rows: [{ Handle: "willow-bunch-weave-hurdle-fence-panel", Title: "Caf� panel" }] }], wovenWood());
    expect(p.items[0]).toMatchObject({ action: "failed" });
    expect(p.items[0].message).toMatch(/"Title" has characters that could not be read/);
  });

  it("M8: reads the multi-sheet Excel file; the formula with no saved result fails only its own row", async () => {
    const sheets = await file("edge_multisheet.xlsx");
    expect(sheets.map((s) => s.name)).toEqual(["Products", "Notes", "Smart Collections"]);
    const p = await preview(sheets, wovenWood());
    const products = p.stats.find((s) => s.sheet === "Products")!;
    expect(products.entity).toBe("products");
    expect(p.items.find((i) => i.action === "failed")!.message).toMatch(/"Variant Price" holds a formula with no saved result \(=ROUND\(79\.99\*1\.1,2\)\)/);
    // A text barcode keeps its leading zeros.
    expect(sheets[0].rows.some((r) => r["Variant Barcode"] === "0012345678905")).toBe(true);
    expect(p.stats.find((s) => s.sheet === "Notes")).toMatchObject({ entity: null });
  });

  it("M18/M12: reads UTF-8 with BOM, UTF-16 and tab-separated files, and recognises Handle-only sheets by their handles", async () => {
    const store = fakeStore([
      product("zz-bulkport-test-08-encoding", "Old 08", [variant("ZZBPT-08", "1.00")]),
      product("zz-bulkport-test-03-sku-owner", "Old 03", [variant("ZZBPT-03", "1.00")]),
      product("zz-bulkport-test-10-inventory", "Old 10", [variant("ZZBPT-10-A", "1.00"), variant("ZZBPT-10-B", "1.00")].map((v, i) => ({ ...v, options: { Pack: String(i) }, stock: { Warehouse: 0 } }))),
      product("zz-bulkport-test-04-tags", "F04", [variant("ZZBPT-04", "1.00")]),
      product("zz-bulkport-test-05-delete", "F05", [variant("ZZBPT-05", "1.00")]),
      product("zz-bulkport-test-01-price", "F01", [variant("ZZBPT-01", "101.12")]),
      product("zz-bulkport-test-11-many-variants", "F11", [variant("ZZBPT-11-001", "111.00", { "ZZ Number": "ZZ-001" })]),
    ]);
    const sheets = (await file("zz_bulkport_round_B.zip")).filter((s) => /^rB[456]/.test(s.name));
    expect(sheets.map((s) => s.headers)).toEqual([["Handle", "Command", "Title"], ["Handle", "Command", "Title"], ["Handle", "Command", "Title"]]);
    const p = await preview(sheets, store);
    expect(p.stats.map((s) => s.entity)).toEqual(["products", "products", "products"]);
    expect(p.items.map((i) => i.changes[0])).toEqual([
      "Title: Old 08 → ZZ BULKPORT TEST 08 – Café Crème Ünïcödé £ € (BOM) – DO NOT USE",
      "Title: Old 03 → ZZ BULKPORT TEST 03 – Crème UTF-16 £ – DO NOT USE",
      "Title: Old 10 → ZZ BULKPORT TEST 10 – Inventory (tab file) – DO NOT USE",
    ]);
    expect(p.log).toMatch(/recognised as Products from its handles/);
  });
});

// --- Real imports (section 4) ----------------------------------------------------

/** The audit's throwaway test products. */
function zzStore(locations = ["Warehouse"]) {
  const many = Array.from({ length: 120 }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    return variant(`ZZBPT-11-${n}`, "111.00", { "ZZ Number": `ZZ-${n}` });
  });
  const colours = ["R", "B"].flatMap((c) => ["S", "M"].flatMap((s) => ["M", "G"].map((f) => variant(`ZZBPT-02-${c}${s}${f}`, "102.00", { Colour: c, Size: s, Finish: f }))));
  return fakeStore(
    [
      product("zz-bulkport-test-01-price", "ZZ 01", [variant("ZZBPT-01", "101.11")], { status: "DRAFT", published: false }),
      product("zz-bulkport-test-02-variants", "ZZ 02", colours, { status: "DRAFT" }),
      product("zz-bulkport-test-03-sku-owner", "ZZ 03", [variant("ZZBPT-03", "103.00")], { status: "DRAFT" }),
      product("zz-bulkport-test-04-tags", "ZZ 04", [variant("ZZBPT-04", "104.00")], { tags: ["zz-bulkport-test", "do-not-list", "t3", "t4", "t5", "t6", "t7", "t8", "t9"] }),
      product("zz-bulkport-test-05-delete", "ZZ 05", [variant("ZZBPT-05", "105.00")]),
      product("zz-bulkport-test-06-metafields", "ZZ 06", [variant("ZZBPT-06", "106.00")]),
      product("zz-bulkport-test-07-images", "ZZ 07", [variant("ZZBPT-07", "107.00")]),
      product("zz-bulkport-test-09-formula", "ZZ 09", [variant("ZZBPT-09", "109.00")]),
      product("zz-bulkport-test-10-inventory", "ZZ 10", [
        variant("ZZBPT-10-A", "110.00", { Pack: "A" }, { stock: Object.fromEntries(locations.map((l) => [l, 0])) }),
        variant("ZZBPT-10-B", "110.00", { Pack: "B" }, { stock: Object.fromEntries(locations.map((l) => [l, 0])) }),
      ]),
      product("zz-bulkport-test-11-many-variants", "ZZ 11", many),
    ],
    locations,
  );
}

async function real(sheets: Sheet[], store: ReturnType<typeof fakeStore>, options: Record<string, unknown> = {}, extra: { expected?: any; ctx?: Record<string, unknown> } = {}) {
  const logs: string[] = [];
  const written: Array<{ name: string; rows: any[] }> = [];
  const stats = await runImport({
    ctx: { gql: store.gql, options: { defaultCommand: "UPDATE", ...options } as any, log: (m: string) => logs.push(m), cache: new Map(), ...extra.ctx } as any,
    sheets: structuredClone(sheets),
    entities: ENTITIES,
    log: (m) => logs.push(m),
    expected: extra.expected,
    out: { addSheet: async (name: string, _h: string[], rows: any) => void written.push({ name, rows: [...rows] }), close: async () => "" },
  });
  const comment = (sheet: string, i = 0) => written.find((w) => w.name === sheet)!.rows[i]["Import Comment"] as string;
  const result = (sheet: string, i = 0) => written.find((w) => w.name === sheet)!.rows[i]["Import Result"] as string;
  return { stats, logs, log: logs.join("\n"), written, comment, result };
}

const expectedOf = (stats: ImportSummary[]) => Object.fromEntries(stats.filter((s) => s.seen).map((s) => [s.sheet, s.seen!]));
const sheetsOf = async (zip: string, pattern: RegExp) => (await file(zip)).filter((s) => pattern.test(s.name));

describe("audit: real imports, round A", () => {
  it("applies a valid price change and reports it with a count", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_A.zip", /^r2_/);
    const r = await real(sheets, store);
    expect(store.byHandle("zz-bulkport-test-01-price")!.variants[0].price).toBe("101.12");
    expect(r.comment(sheets[0].name)).toBe("Updated (1 change)");
    // Importing the same file again changes nothing, and says so.
    store.calls.length = 0;
    const again = await real(sheets, store);
    expect(store.mutations()).toEqual([]);
    expect(again.comment(sheets[0].name)).toBe("No change: already as in the file");
  });

  it("H9: reports all the bad values on a product at once, and warns about the odd ones", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_A.zip", /^r3_/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    expect(p.items[0].errors).toEqual([
      "Row 2: Variant Price cannot be negative (-10)",
      'Row 5: Variant Price "1.8E+2" is in scientific notation (a spreadsheet changed it). Format the column as a number and export again',
      'Row 7: Variant Inventory Qty must be a whole number, but is "ten"',
    ]);
    const r = await real(sheets, store);
    expect(store.mutations()).toEqual([]);
    expect(r.result(sheets[0].name)).toBe("Failed");
    // With the three bad rows removed, the rest goes through with its warnings shown first.
    const good = [{ ...sheets[0], rows: sheets[0].rows.filter((_, i) => ![0, 3, 5].includes(i)) }];
    const p2 = await preview(good, store, { defaultCommand: "UPDATE" });
    expect(p2.items[0].action).toBe("update");
    expect(p2.items[0].changes).toContain("Variant Price (SKU ZZBPT-02-RMM): 102 → 89.99");
    const w = p2.items[0].warnings!.join("\n");
    expect(w).toMatch(/SKU ZZBPT-02-RSG\): the price would be 0/);
    expect(w).toMatch(/SKU ZZBPT-02-BSM\): the price 102\.999 has more than 2 decimal places/);
    expect(w).toMatch(/SKU ZZBPT-02-BMM\): the compare-at price \(102\.07\) is not above the price \(102\.07\)/);
    expect(w).toMatch(/SKU ZZBPT-02-BMG\): the compare-at price \(50\) is not above the price \(102\.08\)/);
  });

  it("H8/M13: a SKU of another product, and the same SKU twice, fail in the preview with a plain reason", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_A.zip", /^r4_/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    expect(p.row(2).message).toBe('Row 2: SKU "ZZBPT-03" belongs to another product (zz-bulkport-test-03-sku-owner), not to this one (its SKU is "ZZBPT-07"). Check the Handle.');
    expect(p.row(3).message).toBe("Row 4: Rows 3 and 4 both change the same variant (SKU ZZBPT-11-001). Keep one of them.");
    expect(p.stats[0]).toMatchObject({ ok: 0, failed: 2 });
    const r = await real(sheets, store);
    expect(store.mutations()).toEqual([]);
    // Preview and import agree.
    expect(r.stats[0]).toMatchObject({ ok: 0, failed: 2 });
  });

  it("M12: sheets with only Handle and Command are recognised from their handles", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_A.zip", /^r5_(delete|tag_wipe)/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    expect(p.stats.map((s) => s.entity)).toEqual(["products", "products"]);
    expect(p.items.map((i) => i.action).sort()).toEqual(["delete", "update"]);
    expect(p.items.find((i) => i.action === "update")!.changes[0]).toMatch(/Tags: .* → \(cleared: all 9 tags removed\)/);
  });

  it("H13: a create with status draft is created as a draft, unpublished", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_A.zip", /^r5_create/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    expect(p.items[0].changes).toEqual(expect.arrayContaining(["Status: Draft", "Online Store: not published", "Price: 112.12, SKU ZZBPT-12"]));
    await real(sheets, store);
    expect(store.byHandle("zz-bulkport-test-12-created")).toMatchObject({ status: "DRAFT", published: false });
  });

  it("H9: every invalid metafield value is reported, not just the first", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_A.zip", /^r6_metafields_invalid/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    const errors = p.items[0].errors!;
    expect(errors).toHaveLength(11);
    expect(errors.join("\n")).toMatch(/t_int: expected a whole number but got "abc"/);
    expect(errors.join("\n")).toMatch(/t_dec: expected a number but got "1,5"/);
    expect(errors.join("\n")).toMatch(/t_bool: expected TRUE or FALSE but got "maybe"/);
    expect(errors.join("\n")).toMatch(/t_date: expected a date like 2026-11-18 but got "31\/12\/2026"/);
    expect(errors.join("\n")).toMatch(/t_prodref: expected a Shopify ID/);
    expect(errors.join("\n")).toMatch(/t_colour: expected a colour like #1D4ED8 but got "green"/);
  });

  it("the valid metafields import, and importing them again is no change", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_A.zip", /^r6_metafields_valid/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    expect(p.items[0]).toMatchObject({ action: "update" });
    expect(p.items[0].changes.length).toBeGreaterThanOrEqual(14);
    await real(sheets, store);
    expect(Object.keys(store.byHandle("zz-bulkport-test-06-metafields")!.metafields).length).toBeGreaterThanOrEqual(14);
    const again = await preview(sheets, store, { defaultCommand: "UPDATE" });
    expect(again.items[0]).toMatchObject({ action: "none", changes: [] });
  });

  it("C8: renaming an option value by SKU renames that variant; it does not add a second one", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_A.zip", /^r8_/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    expect(p.items[0]).toMatchObject({ action: "update" });
    expect(p.items[0].changes).toEqual(["Option ZZ Number (SKU ZZBPT-11-120): ZZ-120 → ZZ-120-RENAMED"]);
    expect(p.items[0].creates).toBeUndefined();
    await real(sheets, store);
    const f11 = store.byHandle("zz-bulkport-test-11-many-variants")!;
    expect(f11.variants).toHaveLength(120);
    expect(f11.variants.filter((v) => v.sku === "ZZBPT-11-120")).toHaveLength(1);
    expect(f11.variants.find((v) => v.sku === "ZZBPT-11-120")!.options["ZZ Number"]).toBe("ZZ-120-RENAMED");
    expect(store.mutations()).toEqual(["ImportVariantsUpdate"]);
  });
});

describe("audit: real imports, rounds B and C", () => {
  it("C7: a price changed in the store after the preview is not overwritten", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_B.zip", /^rB1_/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    expect(p.items[0].changes).toEqual(["Variant Price (SKU ZZBPT-01): 101.11 → 101.13"]);
    // Someone edits the price in the admin.
    store.byHandle("zz-bulkport-test-01-price")!.variants[0].price = "101.50";
    const r = await real(sheets, store, {}, { expected: expectedOf(p.stats) });
    expect(store.byHandle("zz-bulkport-test-01-price")!.variants[0].price).toBe("101.50");
    expect(store.mutations()).toEqual([]);
    expect(r.result(sheets[0].name)).toBe("Failed");
    expect(r.comment(sheets[0].name)).toBe(
      "Changed in the store since the preview, so nothing was imported for this item: Variant Price (SKU ZZBPT-01) was 101.11 at the preview and is now 101.5. Preview the file again.",
    );
    // Untouched since the preview: goes through.
    store.byHandle("zz-bulkport-test-01-price")!.variants[0].price = "101.11";
    await real(sheets, store, {}, { expected: expectedOf(p.stats) });
    expect(store.byHandle("zz-bulkport-test-01-price")!.variants[0].price).toBe("101.13");
  });

  it("C7: a product deleted (or created) since the preview is caught too", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_A.zip", /^r5_create/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    store.products.push(product("zz-bulkport-test-12-created", "Made by hand meanwhile", [variant("X", "1.00")]));
    const r = await real(sheets, store, {}, { expected: expectedOf(p.stats) });
    expect(r.comment(sheets[0].name)).toMatch(/Changed in the store since the preview.*the product now exists/);
    expect(store.mutations()).toEqual([]);
  });

  it("C9: with several locations, a stock total is refused with the column to use instead, never reported OK", async () => {
    const store = zzStore(["Warehouse", "ZZ Bulkport Test – do not fulfil"]);
    const adjust = await sheetsOf("zz_bulkport_round_B.zip", /^rB3_/);
    const set = await sheetsOf("zz_bulkport_round_C.zip", /^rC2_/);
    const p = await preview([...adjust, ...set], store, { defaultCommand: "UPDATE" });
    expect(p.items.map((i) => i.action)).toEqual(["failed", "failed"]);
    expect(p.items[0].message).toMatch(/Variant Inventory Adjust \(-3\) can't be imported: this store has 2 locations\. Use a column per location, e\.g\. "Inventory Available Adjust: Warehouse"/);
    expect(p.items[1].message).toMatch(/Variant Inventory Qty \(2\) can't be imported: this store has 2 locations.*"Inventory Available: Warehouse"/);
    const r = await real([...adjust, ...set], store);
    expect(r.stats.map((s) => s.failed)).toEqual([1, 1]);
    expect(store.mutations()).toEqual([]);
  });

  it("C9: with a named location the preview shows the quantity and place, and the write is read back", async () => {
    const store = zzStore(["Warehouse", "ZZ Bulkport Test – do not fulfil"]);
    const sheet: Sheet = {
      name: "Products",
      headers: ["Handle", "Variant SKU", "Inventory Available: Warehouse", "Inventory Available Adjust: ZZ Bulkport Test – do not fulfil"],
      rows: [
        { Handle: "zz-bulkport-test-10-inventory", "Variant SKU": "ZZBPT-10-A", "Inventory Available: Warehouse": "2", "Inventory Available Adjust: ZZ Bulkport Test – do not fulfil": "" },
        { Handle: "zz-bulkport-test-10-inventory", "Variant SKU": "ZZBPT-10-B", "Inventory Available: Warehouse": "0", "Inventory Available Adjust: ZZ Bulkport Test – do not fulfil": "5" },
      ],
    };
    const p = await preview([sheet], store, { defaultCommand: "UPDATE" });
    expect(p.items[0].changes).toEqual([
      "Available stock at Warehouse (SKU ZZBPT-10-A): 0 → 2",
      "Available stock at ZZ Bulkport Test – do not fulfil (SKU ZZBPT-10-B): 0 → 5 (+5)",
    ]);
    await real([sheet], store);
    const [a, b] = store.byHandle("zz-bulkport-test-10-inventory")!.variants;
    expect(a.stock.Warehouse).toBe(2);
    expect(b.stock["ZZ Bulkport Test – do not fulfil"]).toBe(5);
    expect(store.calls.filter((c) => c.op === "ImportStockNow").length).toBeGreaterThanOrEqual(2); // before, and the read-back
  });

  it("C9: stock for an item Shopify isn't tracking switches tracking on, and a write that doesn't take is an error", async () => {
    const store = zzStore();
    const v = store.byHandle("zz-bulkport-test-10-inventory")!.variants[0];
    v.tracked = false;
    const sheets = await sheetsOf("zz_bulkport_round_C.zip", /^rC2_/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    expect(p.items[0].changes).toEqual(["Available stock at Warehouse (SKU ZZBPT-10-A): 0 → 2", "Stock tracking (SKU ZZBPT-10-A): off → on (needed to hold stock)"]);
    await real(sheets, store);
    expect(v).toMatchObject({ tracked: true, stock: { Warehouse: 2 } });
    // Shopify accepts the write but the stock doesn't change (here: tracking is switched off again underneath).
    v.stock.Warehouse = 0;
    const original = store.handlers.ImportInventorySet;
    store.handlers.ImportInventorySet = () => ({ inventorySetQuantities: { userErrors: [] } });
    const r = await real(sheets, store);
    store.handlers.ImportInventorySet = original;
    expect(r.result(sheets[0].name)).toBe("Failed");
    expect(r.comment(sheets[0].name)).toMatch(/Stock was written but did not take: SKU ZZBPT-10-A at Warehouse is 0, expected 2/);
  });

  it("H11/M17: broken and non-image links fail before anything is attached; a repeated image is added once", async () => {
    const store = zzStore();
    const sheets = await sheetsOf("zz_bulkport_round_C.zip", /^rC1_/);
    const checkImageUrl = async (url: string) => (url.includes("does-not-exist") ? `can't be loaded: the link answers "not found" (HTTP 404)` : url === "https://example.com/" ? "is not an image: the link returns text/html" : null);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" }, { checkImageUrl });
    expect(p.items[0].errors).toEqual([
      `Row 4: Image zz-bulkport-test-does-not-exist.jpg can't be loaded: the link answers "not found" (HTTP 404)`,
      "Row 5: Image https://example.com/ is not an image: the link returns text/html",
    ]);
    const r = await real(sheets, store, {}, { ctx: { checkImageUrl } });
    expect(r.result(sheets[0].name)).toBe("Failed");
    expect(store.byHandle("zz-bulkport-test-07-images")!.images).toEqual([]);
    // Without the two bad rows: one image added, the duplicate noted.
    const good = [{ ...sheets[0], rows: sheets[0].rows.slice(0, 2) }];
    const p2 = await preview(good, store, { defaultCommand: "UPDATE" }, { checkImageUrl });
    expect(p2.items[0].changes).toEqual(["Image: (none) → adds range-100-120cm-silver-trough-planter-2-3d534482.jpg"]);
    expect(p2.items[0].warnings![0]).toMatch(/Row 3: the image range-100-120cm-silver-trough-planter-2-3d534482\.jpg is in the file twice; it is added once/);
    await real(good, store, {}, { ctx: { checkImageUrl } });
    expect(store.byHandle("zz-bulkport-test-07-images")!.images).toHaveLength(1);
  });

  it("deletes one variant by Variant ID, shown as a deletion in the preview", async () => {
    const store = zzStore();
    const f11 = store.byHandle("zz-bulkport-test-11-many-variants")!;
    const sheet: Sheet = { name: "x", headers: ["Handle", "Command", "Variant ID", "Variant Command"], rows: [{ Handle: f11.handle, Command: "UPDATE", "Variant ID": f11.variants[4].id.split("/").pop()!, "Variant Command": "DELETE" }] };
    const p = await preview([sheet], store);
    expect(p.items[0]).toMatchObject({ action: "update", deletes: 1, changes: ["Variant (SKU ZZBPT-11-005): exists → (deleted)"] });
    expect(p.stats[0].risk!.deletes).toBe(1);
    await real([sheet], store);
    expect(f11.variants).toHaveLength(119);
  });
});

describe("audit: round R1, export then re-import unchanged", () => {
  it("C1: the app's own export, re-imported, is no change for every product and writes nothing", async () => {
    const { productToRows } = await import("../app/lib/entities/products");
    const store = zzStore();
    store.byHandle("zz-bulkport-test-04-tags")!.metafields["custom.care"] = { type: "single_line_text_field", value: "Wash cold" };
    const groups = new Set(["variants", "images", "metafields", "seo"]);
    const rows = store.products.flatMap((p) => {
      const node = store.handlers.ImportProductById({ id: p.id }).product;
      const variants = store.handlers.ImportProductVariants({ id: p.id }).product.variants.nodes.map((v: any) => ({ ...v, inventoryItem: { ...v.inventoryItem, inventoryLevels: undefined } }));
      return productToRows(
        {
          ...node,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
          isGiftCard: false,
          totalInventory: 0,
          metafields: Object.entries(p.metafields).map(([k, m]) => ({ namespace: k.split(".")[0], key: k.split(".")[1], ...m })),
          media: node.media.nodes,
          variants,
        },
        groups,
      );
    });
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const sheet: Sheet = { name: "Products", headers, rows: rows.map((r) => Object.fromEntries(headers.map((h) => [h, r[h] ?? ""]))) };
    expect(sheet.rows.length).toBeGreaterThan(130);
    const p = await preview([sheet], store);
    expect(p.items.filter((i) => i.action !== "none").map((i) => [i.item, i.action, i.message, i.changes])).toEqual([]);
    expect(p.stats[0].risk).toMatchObject({ unchanged: store.products.length, updates: 0, creates: 0 });
    const r = await real([sheet], store, { defaultCommand: "MERGE" });
    expect(store.mutations()).toEqual([]);
    expect(r.stats[0]).toMatchObject({ ok: store.products.length, failed: 0 });
  });
});

describe("audit: redirects (H8, H10, M19)", () => {
  function redirectStore(existing: Array<{ path: string; target: string }> = [], productHandles: string[] = ["zz-bulkport-test-01-price"]) {
    const redirects = existing.map((r, i) => ({ id: `gid://shopify/UrlRedirect/${i + 1}`, ...r }));
    const mutations: string[] = [];
    const gql = (async (q: string, v: any = {}) => {
      const [, kind, op] = /(query|mutation)\s+(\w+)/.exec(q)!;
      if (kind === "mutation") mutations.push(op);
      const page = (nodes: any[]) => ({ nodes, pageInfo: { hasNextPage: false } });
      if (op === "ImportRedirectByPath") return { urlRedirects: page(redirects.filter((r) => v.query.toLowerCase().includes(r.path.toLowerCase()))) };
      if (op === "ImportRedirectTargetProduct") return { products: page(productHandles.filter((h) => v.q === `handle:"${h}"`).map((h) => ({ id: h }))) };
      if (op === "ImportRedirectCreate" || /Create/.test(op)) {
        redirects.push({ id: `gid://shopify/UrlRedirect/${redirects.length + 1}`, ...v.urlRedirect });
        return { urlRedirectCreate: { urlRedirect: redirects.at(-1), userErrors: [] } };
      }
      if (/Delete/.test(op)) {
        redirects.splice(redirects.findIndex((r) => r.id === v.id), 1);
        return { urlRedirectDelete: { deletedUrlRedirectId: v.id, userErrors: [] } };
      }
      throw new Error(`Unexpected operation ${op}`);
    }) as any;
    return { gql, redirects, mutations: () => mutations } as any;
  }

  it("catches a redirect loop in the preview and imports neither half", async () => {
    const store = redirectStore();
    const sheets = await sheetsOf("zz_bulkport_round_A.zip", /^r13_/);
    const p = await preview(sheets, store, { defaultCommand: "UPDATE" });
    expect(p.items.map((i) => i.action)).toEqual(["failed", "failed", "create"]);
    expect(p.row(2).message).toBe("Redirect loop: /zz-bulkport-test-redirect-a → /zz-bulkport-test-redirect-b → /zz-bulkport-test-redirect-a (rows 2 and 3). Neither row is imported.");
    expect(p.row(4)).toMatchObject({ changes: ["New redirect: /zz-bulkport-test-redirect-c → /products/zz-bulkport-test-01-price"] });
    expect(p.row(4).warnings).toBeUndefined();
    const r = await real(sheets, store);
    // The same three results as the preview, and no redirect to nowhere left behind.
    expect(r.stats[0]).toMatchObject({ ok: 1, failed: 2 });
    expect(store.redirects.map((x: any) => x.path)).toEqual(["/zz-bulkport-test-redirect-c"]);
  });

  it("warns about a target that doesn't exist, and refuses a target that is itself redirected", async () => {
    const store = redirectStore([
      { path: "/zz-bulkport-test-redirect-a", target: "/old" },
      { path: "/moved", target: "/final" },
    ]);
    const sheets = await sheetsOf("zz_bulkport_round_B.zip", /^rB7_/);
    const extra: Sheet = { name: "Redirects", headers: ["Path", "Target"], rows: [{ Path: "/x", Target: "/moved" }] };
    const p = await preview([...sheets, extra], store, { defaultCommand: "MERGE" });
    const byItem = Object.fromEntries(p.items.map((i) => [i.item, i]));
    expect(byItem["Path: /zz-bulkport-test-redirect-a"]).toMatchObject({ action: "delete", deletes: 1, changes: ["Deletes the redirect /zz-bulkport-test-redirect-a → /old"] });
    expect(byItem["Path: /zz-bulkport-test-redirect-d"]).toMatchObject({ action: "create" });
    expect(byItem["Path: /zz-bulkport-test-redirect-d"].warnings).toEqual([`The target /products/zz-bulkport-test-does-not-exist doesn't exist in the store, so the redirect would lead to a "not found" page`]);
    expect(byItem["Path: /x"].message).toBe("The target /moved is itself redirected in the store (to /final), and Shopify doesn't allow a redirect to a redirect. Use /final as the target.");
    expect(store.mutations()).toEqual([]);
  });
});

describe("audit: large files (M15)", () => {
  it("keeps a 40,000-row sheet small in memory and refuses a file that cannot fit, instead of crashing the server", async () => {
    const { parseCsv } = await import("../app/lib/core/sheets");
    const { assertFitsInMemory } = await import("../app/lib/jobs/runner.server");
    const cols = Array.from({ length: 100 }, (_, i) => `Column ${i}`);
    const text = [cols.join(","), ...Array.from({ length: 40_000 }, (_, r) => cols.map((_, c) => (c < 2 ? `handle-${r >> 3}` : c < 20 && r % 8 === 0 ? `value ${c}` : c % 7 ? "" : "MERGE")).join(","))].join("\n");
    const before = process.memoryUsage().heapUsed;
    const { rows } = parseCsv(text);
    const used = (process.memoryUsage().heapUsed - before) / 1e6;
    expect(rows).toHaveLength(40_000);
    expect(Object.keys(rows[5])).toEqual(cols);
    expect(rows[5]["Column 0"]).toBe("handle-0");
    expect(rows[5]["Column 3"]).toBe("");
    // 4 million cells: a hash table per row took ~300 MB; a shared layout stays far under.
    expect(used).toBeLessThan(170);
    // Rows still take new columns (ID, Import Result…).
    rows[5]["Import Result"] = "OK";
    expect(rows[5]["Import Result"]).toBe("OK");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-big-"));
    const f = path.join(dir, "big.csv");
    fs.writeFileSync(f, text);
    await expect(assertFitsInMemory(f, "big.csv", { heap_size_limit: 1500e6, used_heap_size: 200e6 } as any)).resolves.toBeUndefined();
    await expect(assertFitsInMemory(f, "big.zip", { heap_size_limit: 300e6, used_heap_size: 200e6 } as any)).rejects.toThrow(/too large to import in one go.*Split it into smaller files/);
  });

  it("reads odd header names safely", async () => {
    const { parseCsv } = await import("../app/lib/core/sheets");
    const { headers, rows } = parseCsv('ID,"a ""quoted"" name",__proto__,"x`${1}`","back\\\\slash"\n1,2,3,4,5\n');
    expect(headers).toEqual(["ID", 'a "quoted" name', "__proto__", "x`${1}`", "back\\\\slash"]);
    expect(rows[0].ID).toBe("1");
    expect(rows[0]['a "quoted" name']).toBe("2");
    expect(rows[0]["x`${1}`"]).toBe("4");
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
  });
});

describe("audit: data check (M10, M11)", () => {
  it("M10: an export filtered by a data-check problem holds every product with it, however many", async () => {
    const { getEntity } = await import("../app/lib/entities");
    const { parseFilters } = await import("../app/lib/jobs/jobs.server");
    const products = getEntity("products")!;
    const node = (i: number, alt: string) => ({
      id: `gid://shopify/Product/${i}`, handle: `p-${i}`, title: `Product ${i}`, descriptionHtml: "<p>x</p>", status: "ACTIVE", tags: [],
      media: [{ id: `m${i}`, mediaContentType: "IMAGE", alt, image: { url: `https://cdn.shopify.com/p-${i}.jpg` } }],
      variants: [{ id: `gid://shopify/ProductVariant/${i}`, sku: `S${i}`, price: "5.00", position: 1, selectedOptions: [], inventoryItem: { id: `gid://shopify/InventoryItem/${i}` } }],
    });
    // 600 products without alt text (more than the old cap of 250), 5 with.
    const store = [...Array.from({ length: 600 }, (_, i) => node(i + 1, "")), ...Array.from({ length: 5 }, (_, i) => node(1000 + i, "A planter"))];
    let query = "";
    const out: Array<Record<string, string>> = [];
    const filters = parseFilters(products, [{ field: "status", op: "is", value: "active" }, { field: "tag", op: "is_not", value: "internal" }, { field: "problem", op: "is", value: "no_alt" }]);
    expect(filters.at(-1)).toMatchObject({ field: "problem", local: true });
    await products.export!(
      {
        gql: (async () => ({})) as any,
        bulk: async function* (q: string) {
          query = q;
          yield* structuredClone(store);
        },
        // Only ID and title wanted in the file: the images needed for the rule are fetched anyway.
        options: { groups: [], columns: ["ID", "Title"], filters },
        log: () => {},
        cache: new Map(),
        progress: () => {},
      },
      async (rows) => void out.push(...rows),
    );
    expect(new Set(out.map((r) => r.ID)).size).toBe(600);
    expect(out.some((r) => Number(r.ID) >= 1000)).toBe(false);
    // The Shopify search carries the ordinary filters, not the problem one.
    expect(query).toMatch(/status:\\?"?active/);
    expect(query).toMatch(/-tag:/);
    expect(query).not.toMatch(/problem/);
    expect(query).toMatch(/media/);
    // The file has the groups asked for, not the ones fetched for the rule.
    expect(out[0]["Image Src"]).toBeUndefined();
  });

  it("M11: the check leaves out products with the chosen tags", async () => {
    const { runCheck } = await import("../app/lib/check/run");
    let query = "";
    const logs: string[] = [];
    await runCheck(
      { gql: (async () => ({})) as any, bulk: async function* (q: string) { query = q; }, log: (m) => logs.push(m), progress: () => {}, isCancelled: async () => false },
      fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-check-")),
      ["internal", "damaged stock"],
    );
    expect(query).toMatch(/-tag:\\?"?internal/);
    expect(query).toMatch(/-tag:\\?"damaged stock/);
    expect(logs[0]).toBe("Checking active products, leaving out those tagged internal, damaged stock");
  });
});

describe("audit: backups (H6)", () => {
  it("restores only the chosen items of a backup, by handle, ID, order name or email", async () => {
    const { keepOnlyItems } = await import("../app/lib/jobs/runner.server");
    const sheets: Array<{ name: string; headers: string[]; rows: Array<Record<string, string>> }> = [
      { name: "Products", headers: ["ID", "Handle", "Title"], rows: [{ ID: "1", Handle: "bin", Title: "Bin" }, { ID: "1", Handle: "bin", Title: "" }, { ID: "2", Handle: "panel", Title: "Panel" }] },
      { name: "Orders", headers: ["ID", "Name", "Email"], rows: [{ ID: "9", Name: "#1001", Email: "a@example.com" }, { ID: "10", Name: "#1002", Email: "b@example.com" }] },
      { name: "Pages", headers: ["ID", "Handle"], rows: [{ ID: "5", Handle: "about" }] },
    ];
    const r = keepOnlyItems(sheets, ["BIN", "1002", "b@example.com", "no-such-thing"]);
    expect(sheets[0].rows.map((x) => x.Handle)).toEqual(["bin", "bin"]);
    expect(sheets[1].rows.map((x) => x.Name)).toEqual(["#1002"]);
    expect(sheets[2].rows).toEqual([]);
    expect(r).toEqual({ kept: 3, missing: ["no-such-thing"] });
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("audit: backup copy destination (H6)", async () => {
  process.env.DATABASE_URL ??= "file:dev.sqlite";
  process.env.SHOPIFY_API_SECRET ??= "test-secret";
  process.env.BACKUP_SHOPS = "*";
  const { default: prisma } = await import("../app/db.server");
  const backups = await import("../app/lib/jobs/backups.server");
  const shop = `backup-dest-${Date.now()}.myshopify.com`;
  const base = { enabled: true, runAt: "02:30", timezone: "Europe/London", types: ["products"], keepDays: 30 };

  it("stores the destination sealed, shows it without the password, and keeps it unless changed", async () => {
    await backups.saveBackupSettings(shop, { ...base, uploadUrl: "sftp://files.example.com/backups", uploadUser: "shop", uploadPassword: "s3cret/pw" });
    let s = (await backups.getBackupSchedule(shop))!;
    expect(s.uploadUrl).not.toContain("s3cret");
    expect(backups.backupDestination(s)).toBe("sftp://shop:****@files.example.com/backups/");
    // Saved again with the link as shown: the sign-in is kept.
    await backups.saveBackupSettings(shop, { ...base, uploadUrl: "sftp://shop:****@files.example.com/backups/" });
    s = (await backups.getBackupSchedule(shop))!;
    expect(backups.backupDestination(s)).toBe("sftp://shop:****@files.example.com/backups/");
    await expect(backups.saveBackupSettings(shop, { ...base, uploadUrl: "https://example.com/x" })).rejects.toThrow(/must start with s3/);
    await backups.saveBackupSettings(shop, { ...base, uploadUrl: "" });
    expect((await backups.getBackupSchedule(shop))!.uploadUrl).toBeNull();
    // Restoring chosen items carries them on the preview job.
    const { backupDir } = await import("../app/lib/jobs/storage.server");
    const backup = await prisma.job.create({ data: { shop, type: "export", kind: "backup", status: "finished", config: JSON.stringify({ entities: [{ entity: "products", options: {} }] }) } });
    const stored = path.join(backupDir(shop, backup.id), "Backup.zip");
    fs.writeFileSync(stored, "zip");
    await prisma.job.update({ where: { id: backup.id }, data: { resultFile: stored } });
    const job = await backups.restorePreview(shop, backup.id, ["bin", "panel"]);
    expect(JSON.parse(job.config)).toEqual({ options: { dryRun: true, defaultCommand: "MERGE" }, onlyItems: ["bin", "panel"] });
    expect(job.name).toMatch(/^Restore 2 items from backup/);
    await prisma.job.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.shopSetting.deleteMany({ where: { shop } });
  });
});

describe("audit: alerts outside the app (H5)", () => {
  it("words an alert for unattended jobs that went wrong, and stays quiet otherwise", async () => {
    const { alertText } = await import("../app/lib/jobs/alerts.server");
    const job = { shop: "wovenwooduk.myshopify.com", type: "import", kind: "job", name: "Carrier numbers", scheduled: true };
    expect(alertText(job, { status: "failed", problems: 0, summary: "", error: "Download failed: HTTP 404" })).toBe(
      'Bulkport, wovenwooduk: Scheduled import "Carrier numbers" failed. Download failed: HTTP 404 Open the app\'s home screen for details.',
    );
    expect(alertText(job, { status: "finished", problems: 3, summary: "3 items failed" })).toMatch(/finished with problems\. 3 items failed/);
    expect(alertText(job, { status: "finished", problems: 0, summary: "" })).toBeNull();
    // Someone is watching a job they started by hand.
    expect(alertText({ ...job, scheduled: false }, { status: "failed", problems: 0, summary: "", error: "x" })).toBeNull();
    expect(alertText({ ...job, kind: "backup", type: "export", scheduled: false }, { status: "failed", problems: 0, summary: "", error: "Disk full" })).toMatch(/Store backup failed\. Disk full/);
  });
});

describe("redesign: skipping rows at the preview", () => {
  it("leaves out the items set to Skip, and names each product in the preview", async () => {
    const store = wovenWood();
    const sheets = await file("dryrun_products_test.csv");
    const p = await preview(sheets, store);
    expect(p.row(2)).toMatchObject({ key: "Handle=66-litre-wooden-potato-planter-barrel", title: "66 Litre Wooden Potato Planter Barrel" });
    const logs: string[] = [];
    const stats = await runImport({
      ctx: { gql: store.gql, options: { defaultCommand: "MERGE" }, log: () => {}, cache: new Map() },
      sheets: structuredClone(sheets),
      entities: ENTITIES,
      log: (m) => logs.push(m),
      exclude: { [sheets[0].name]: [p.row(2).key!, p.row(4).key!] },
    });
    // The price change and the create were skipped: nothing written, nothing created.
    expect(store.mutations()).toEqual([]);
    expect(store.byHandle("66-litre-wooden-potato-planter-barrel")!.variants[0].price).toBe("44.99");
    expect(store.byHandle("bulkport-test-does-not-exist")).toBeUndefined();
    expect(stats[0]).toMatchObject({ ok: 1, failed: 1, skipped: 2 });
  });

  it("warns about a script tag in a description", async () => {
    const store = wovenWood();
    const p = await preview([{ name: "Products", headers: ["Handle", "Body HTML"], rows: [{ Handle: "willow-bunch-weave-hurdle-fence-panel", "Body HTML": "<script>alert(1)</script><p>Panel</p>" }] }], store);
    expect(p.items[0].warnings?.[0]).toMatch(/description contains a <script> tag/);
  });
});

describe("redesign: undo", () => {
  async function importWithUndo(sheets: Sheet[], store: ReturnType<typeof fakeStore>, extra: Record<string, unknown> = {}) {
    const stats = await runImport({ ctx: { gql: store.gql, options: { defaultCommand: "MERGE" }, log: () => {}, cache: new Map() }, sheets: structuredClone(sheets), entities: ENTITIES, log: () => {}, ...extra });
    return stats;
  }

  it("records what an import changed, and importing that record puts everything back", async () => {
    const store = zzStore();
    const f01 = store.byHandle("zz-bulkport-test-01-price")!;
    const f04 = store.byHandle("zz-bulkport-test-04-tags")!;
    const f10 = store.byHandle("zz-bulkport-test-10-inventory")!;
    f04.metafields["custom.care"] = { type: "single_line_text_field", value: "Wash cold" };
    const before = JSON.stringify([f01, f04, f10]);
    const sheet: Sheet = {
      name: "Products",
      headers: ["Handle", "Title", "Tags", "Variant SKU", "Variant Price", "Variant Compare At Price", "Inventory Available: Warehouse", "Metafield: custom.care [single_line_text_field]"],
      rows: [
        { Handle: f01.handle, Title: "Renamed 01", Tags: "new-tag", "Variant SKU": "ZZBPT-01", "Variant Price": "99.00", "Variant Compare At Price": "120", "Inventory Available: Warehouse": "", "Metafield: custom.care [single_line_text_field]": "" },
        { Handle: f04.handle, Title: "", Tags: "", "Variant SKU": "ZZBPT-04", "Variant Price": "", "Variant Compare At Price": "", "Inventory Available: Warehouse": "", "Metafield: custom.care [single_line_text_field]": "" },
        { Handle: f10.handle, Title: "", Tags: "garden, outdoor", "Variant SKU": "ZZBPT-10-A", "Variant Price": "", "Variant Compare At Price": "", "Inventory Available: Warehouse": "7", "Metafield: custom.care [single_line_text_field]": "" },
        { Handle: "zz-brand-new", Title: "Brand new", Tags: "", "Variant SKU": "NEW-1", "Variant Price": "5", "Variant Compare At Price": "", "Inventory Available: Warehouse": "", "Metafield: custom.care [single_line_text_field]": "" },
      ],
    };
    const stats = await importWithUndo([sheet], store);
    expect(stats[0]).toMatchObject({ ok: 4, failed: 0 });
    expect(f01).toMatchObject({ title: "Renamed 01", tags: ["new-tag"] });
    expect(f01.variants[0]).toMatchObject({ price: "99.00", compareAtPrice: "120.00" });
    expect(f04.tags).toEqual([]);
    expect(f04.metafields["custom.care"]).toBeUndefined();
    expect(f10.variants[0].stock.Warehouse).toBe(7);
    expect(store.byHandle("zz-brand-new")).toBeTruthy();

    const undo = stats[0].undo!;
    expect(undo.find((r) => r.Title)).toMatchObject({ Command: "UPDATE", Title: "ZZ 01", Tags: "garden, outdoor", "Tags Command": "REPLACE" });
    expect(undo.find((r) => r["Variant Price"])).toMatchObject({ "Variant Price": "101.11", "Variant Compare At Price": "" });
    expect(undo.filter((r) => r.Command === "DELETE")).toHaveLength(1);

    // The undo is an ordinary sheet: preview it, then apply it.
    const headers = [...new Set(undo.flatMap((r) => Object.keys(r)))];
    const undoSheet: Sheet = { name: "Products", headers, rows: undo.map((r) => ({ ...r })) };
    const p = await preview([undoSheet], store, { defaultCommand: "UPDATE" });
    expect(p.items.filter((i) => i.action === "failed")).toEqual([]);
    expect(p.items.some((i) => i.changes.includes("Variant Price (SKU ZZBPT-01): 99 → 101.11"))).toBe(true);
    await importWithUndo([undoSheet], store);
    expect(store.byHandle("zz-brand-new")).toBeUndefined();
    expect(JSON.stringify([f01, f04, f10])).toBe(before);
  });

  it("stops a sheet when too many rows fail unexpectedly, and says the rest were not imported", async () => {
    const store = zzStore();
    const rows = Array.from({ length: 60 }, (_, i) => ({ Handle: i < 3 ? "zz-bulkport-test-01-price" : `no-such-product-${i}`, Title: `T${i}` }));
    rows[1].Handle = "zz-bulkport-test-03-sku-owner";
    rows[2].Handle = "zz-bulkport-test-04-tags";
    const logs: string[] = [];
    const stats = await runImport({ ctx: { gql: store.gql, options: { defaultCommand: "UPDATE", concurrency: 1 }, log: () => {}, cache: new Map() }, sheets: [{ name: "Products", headers: ["Handle", "Title"], rows }], entities: ENTITIES, log: (m) => logs.push(m), stopAtFailedPercent: 5 });
    expect(stats[0].stopped).toBe(true);
    expect(stats[0].ok).toBe(3);
    expect(stats[0].failed).toBeLessThan(25);
    expect(stats[0].skipped).toBeGreaterThan(30);
    expect(logs.join("\n")).toMatch(/stopped, because \d+ of the first \d+ items failed/);
    // Failures the preview announced don't count.
    const calm = await runImport({ ctx: { gql: store.gql, options: { defaultCommand: "UPDATE", concurrency: 1 }, log: () => {}, cache: new Map() }, sheets: [{ name: "Products", headers: ["Handle", "Title"], rows: structuredClone(rows) }], entities: ENTITIES, log: () => {}, stopAtFailedPercent: 5, expectedFailed: { Products: 57 } });
    expect(calm[0].stopped).toBeUndefined();
    expect(calm[0].failed).toBe(57);
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("redesign: held imports, key scopes", async () => {
  process.env.DATABASE_URL ??= "file:dev.sqlite";
  process.env.SHOPIFY_API_SECRET ??= "test-secret";
  const { default: prisma } = await import("../app/db.server");
  const worker = await import("../app/lib/jobs/held.server");
  const keys = await import("../app/lib/api/keys.server");
  const service = await import("../app/lib/api/service.server");
  const shop = `held-${Date.now()}.myshopify.com`;
  const risk = (r: Record<string, number>) => [{ sheet: "Products", entity: "products", items: 5, ok: 5, failed: 0, skipped: 0, risk: { creates: 0, updates: 0, deletes: 0, unchanged: 0, clearing: 0, warned: 0, ...r } }];

  it("a scheduled import set to hold runs as a preview; a clean one is applied, an unusual one waits", async () => {
    const config = JSON.stringify({ options: { defaultCommand: "UPDATE", hold: true } });
    expect(JSON.parse(worker.heldConfig("import", config))).toEqual({ options: { defaultCommand: "UPDATE", hold: true, dryRun: true }, autoApply: true });
    expect(worker.heldConfig("export", config)).toBe(config);
    expect(worker.heldConfig("import", JSON.stringify({ options: {} }))).toBe(JSON.stringify({ options: {} }));
    const make = (stats: unknown = []) => prisma.job.create({ data: { shop, type: "import", status: "finished", config: worker.heldConfig("import", config), inputFile: "x/in.csv", stats: JSON.stringify(stats) } });
    const clean = await make(risk({ updates: 5 }));
    expect(await worker.settleHeldPreview(shop, clean.id, risk({ updates: 5 }))).toBeNull();
    // Applied: a real import of the same file was queued.
    const queued = await prisma.job.findMany({ where: { shop, status: "queued" } });
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0].config)).toMatchObject({ previewOf: clean.id, options: { defaultCommand: "UPDATE", hold: true } });
    expect(JSON.parse(queued[0].config).options.dryRun).toBeUndefined();
    const odd = await make();
    expect(await worker.settleHeldPreview(shop, odd.id, risk({ updates: 3, creates: 1, warned: 2 }))).toBe("Held for approval: 1 new item, 2 with warnings. Open the preview, choose what to include and apply it.");
    expect(await prisma.job.count({ where: { shop, status: "queued" } })).toBe(1);
    // Nothing to change: nothing queued, nothing held.
    expect(await worker.settleHeldPreview(shop, (await make()).id, risk({ unchanged: 5 }))).toBeNull();
    expect(await prisma.job.count({ where: { shop, status: "queued" } })).toBe(1);
  });

  it("keys can be read-only and can expire", async () => {
    const ro = await keys.createKey(shop, "Report tool", "read", 30);
    expect(ro.row).toMatchObject({ readOnly: true, canImport: false });
    expect(Math.round((ro.row.expiresAt!.getTime() - Date.now()) / 86400_000)).toBe(30);
    const auth = await keys.checkKey(ro.key);
    await expect(service.startImport(auth, { csv: "ID\n1\n", fileName: "Products.csv" })).rejects.toThrow(/read-only/);
    expect((await service.startExport(auth, { sheets: [{ sheet: "Products", limit: 1 }] })).type).toBe("export");
    await expect(keys.checkKey(ro.key, Date.now() + 31 * 86400_000)).rejects.toThrow(/expired/);
    expect((await keys.createKey(shop, "Old style", true)).row).toMatchObject({ canImport: true, readOnly: false, expiresAt: null });
    await prisma.job.deleteMany({ where: { shop } });
    await prisma.apiKey.deleteMany({ where: { shop } });
  });
});

describe("redesign: restoring chosen fields", () => {
  it("drops the columns of the kinds not chosen, keeping what identifies each row", async () => {
    const { keepOnlyFields, RESTORE_FIELDS } = await import("../app/lib/jobs/runner.server");
    expect(RESTORE_FIELDS.filter((f) => !f.byDefault).map((f) => f.key)).toEqual(["stock"]);
    const sheet = {
      headers: ["ID", "Handle", "Command", "Title", "Tags", "Variant ID", "Variant SKU", "Variant Price", "Variant Inventory Qty", "Inventory Available: Warehouse", "Image Src", "Metafield: custom.care [single_line_text_field]"],
      rows: [{ ID: "1", Handle: "bin", Command: "MERGE", Title: "Bin", Tags: "a", "Variant ID": "11", "Variant SKU": "A", "Variant Price": "5", "Variant Inventory Qty": "3", "Inventory Available: Warehouse": "3", "Image Src": "x.jpg", "Metafield: custom.care [single_line_text_field]": "Wash" }],
    };
    const dropped = keepOnlyFields([sheet], ["prices"]);
    expect(sheet.headers).toEqual(["ID", "Handle", "Command", "Variant ID", "Variant Price"]);
    expect(Object.keys(sheet.rows[0])).toEqual(["ID", "Handle", "Command", "Variant ID", "Variant Price"]);
    expect(dropped).toContain("Inventory Available: Warehouse");
    // Without a Variant ID, the SKU stays: it is how the row finds its variant.
    const bySku = { headers: ["Handle", "Variant SKU", "Variant Price", "Title"], rows: [{ Handle: "bin", "Variant SKU": "A", "Variant Price": "5", Title: "Bin" }] };
    keepOnlyFields([bySku], ["prices"]);
    expect(bySku.headers).toEqual(["Handle", "Variant SKU", "Variant Price"]);
  });
});

describe("redesign: undo for other data types", () => {
  it("copies the affected items before a sheet is imported, and offers the copy as the undo", async () => {
    const customers = ENTITIES.find((e) => e.key === "customers")!;
    const asked: string[][] = [];
    const logs: string[] = [];
    const fake = { ...customers, import: { keyColumns: ["ID"], apply: async (_c: any, rows: any[], command: any) => ({ status: rows[0].ID === "3" ? ("Failed" as const) : ("OK" as const), command }) } };
    const stats = await runImport({
      ctx: { gql: (async () => ({})) as any, options: { defaultCommand: "UPDATE" }, log: () => {}, cache: new Map() },
      sheets: [{ name: "Customers", headers: ["ID", "Tags"], rows: [{ ID: "1", Tags: "vip" }, { ID: "2", Tags: "vip" }, { ID: "3", Tags: "vip" }, { ID: "", Tags: "new person" }] }],
      entities: [fake as any],
      log: (m) => logs.push(m),
      snapshot: async (_e, ids) => {
        asked.push(ids);
        return [{ ID: "1", Command: "UPDATE", Tags: "old-a" }, { ID: "2", Command: "UPDATE", Tags: "" }];
      },
    });
    expect(asked).toEqual([["1", "2", "3"]]);
    expect(stats[0].undo).toEqual([{ ID: "1", Command: "UPDATE", Tags: "old-a" }, { ID: "2", Command: "UPDATE", Tags: "" }]);
    expect(logs.join("\n")).toMatch(/recorded 2 of 3 items as they are now, for undo/);
    // Never for a preview.
    const dry = await runImport({ ctx: { gql: (async () => ({})) as any, options: { dryRun: true }, log: () => {}, cache: new Map() }, sheets: [{ name: "Customers", headers: ["ID"], rows: [{ ID: "1" }] }], entities: [fake as any], log: () => {}, snapshot: async () => { throw new Error("not for previews"); } });
    expect(dry[0].undo).toBeUndefined();
    // A copy that can't be taken doesn't stop the import; it says so.
    const logs2: string[] = [];
    const noCopy = await runImport({ ctx: { gql: (async () => ({})) as any, options: {}, log: () => {}, cache: new Map() }, sheets: [{ name: "Customers", headers: ["ID"], rows: [{ ID: "1" }] }], entities: [fake as any], log: (m) => logs2.push(m), snapshot: async () => { throw new Error("search unavailable"); } });
    expect(noCopy[0]).toMatchObject({ ok: 1 });
    expect(logs2.join("\n")).toMatch(/could not record the items for undo \(search unavailable\)/);
  });
});
