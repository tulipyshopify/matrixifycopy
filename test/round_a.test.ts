import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computedCells } from "../app/lib/ai/changes";
import { runExport } from "../app/lib/core/exporter";
import { runImport } from "../app/lib/core/importer";
import { oddMatches } from "../app/lib/core/layouts";
import { detectEntity } from "../app/lib/core/registry";
import { createCsvOut } from "../app/lib/core/sheets";
import { ENTITIES, getEntity } from "../app/lib/entities";
import { aroundChange } from "../app/lib/entities/product_compare";
import { jobHealth } from "../app/lib/jobs/health";
import { fakeStore, product, variant } from "./helpers/fake_store";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-ra-"));

/** Replays the "new features and deeper tests" report of 20 Nov 2026 (A1…A15). */
const sheet = (headers: string[], ...rows: string[][]) => [{ name: "Products", headers, rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) }];
const run = async (sheets: any[], gql: any, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const stats = await runImport({ ctx: { gql, options: { defaultCommand: "UPDATE", ...options } as any, log: () => {}, cache: new Map() } as any, sheets, entities: ENTITIES, log: () => {}, ...extra });
  return { stats, items: stats.flatMap((s) => s.preview ?? []) };
};

describe("round A: stock", () => {
  const store = () => fakeStore([product("bin", "Bin", [variant("B1", "10.00", {}, { stock: { Warehouse: 5 } })])]);

  it("A1: every stock write carries the key Shopify requires, a new one per request", async () => {
    const s = store();
    const sent: Array<{ query: string; vars: any }> = [];
    const gql = (async (q: string, v: any) => {
      if (/mutation ImportInventory/.test(q)) sent.push({ query: q, vars: v });
      return s.gql(q, v);
    }) as any;
    const { stats } = await run(sheet(["Handle", "Variant SKU", "Inventory Available: Warehouse"], ["bin", "B1", "9"]), gql);
    expect(stats[0]).toMatchObject({ ok: 1, failed: 0 });
    expect(s.products[0].variants[0].stock.Warehouse).toBe(9);
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) {
      expect(m.query).toMatch(/\$key: String!/);
      expect(m.query).toMatch(/@idempotent\(key: \$key\)/);
      expect(m.vars.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
    await run(sheet(["Handle", "Variant SKU", "Inventory Available Adjust: Warehouse"], ["bin", "B1", "-2"]), gql);
    expect(new Set(sent.map((m) => m.vars.key)).size).toBe(sent.length);
    // The three stock mutations in the app all declare it.
    const source = fs.readFileSync("app/lib/entities/products.ts", "utf8");
    for (const name of ["inventorySetQuantities", "inventoryAdjustQuantities", "inventoryActivate"]) expect(source).toMatch(new RegExp(`${name}\\([^)]*\\) @idempotent\\(key: \\$key\\)`));
  });

  it("A2: a row that stops half-way says what was saved and what was not", async () => {
    const s = store();
    const gql = (async (q: string, v: any) => {
      if (/mutation ImportInventorySet/.test(q)) throw new Error("The @idempotent directive is required for this mutation but was not provided.");
      return s.gql(q, v);
    }) as any;
    const rows = sheet(["Handle", "Variant SKU", "Variant Price", "Inventory Available: Warehouse", "Import Comment"], ["bin", "B1", "12.00", "9"]);
    const { stats } = await run(rows, gql, {}, { out: createCsvOut(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ra-")), "r")) });
    expect(stats[0]).toMatchObject({ ok: 0, failed: 1 });
    expect(s.products[0].variants[0].price).toBe("12.00");
    expect(s.products[0].variants[0].stock.Warehouse).toBe(5);
    expect(rows[0].rows[0]["Import Comment"]).toMatch(/^Partly applied\. Saved: variant details \(prices, SKUs, options\)\. Then it stopped, and the rest of this row was NOT saved: Error: The @idempotent directive/);
    // What was saved can still be undone.
    expect(stats[0].undo?.length).toBeGreaterThan(0);
  });

  it("A12: stock below zero is flagged", async () => {
    const { items } = await run(sheet(["Handle", "Variant SKU", "Inventory Available: Warehouse"], ["bin", "B1", "-3"]), store().gql, { dryRun: true });
    expect(items[0].warnings!.join()).toMatch(/would be -3: below zero/);
  });
});

describe("round A: risky changes are flagged", () => {
  const store = () => fakeStore([product("panel", "Willow Panel", [variant("W1", "20.00"), variant("W2", "30.00", { Size: "L" })], { images: ["https://cdn.shopify.com/a.jpg", "https://cdn.shopify.com/b.jpg"], descriptionHtml: `<p>${"Hand woven from English willow. ".repeat(6)}See our <a href="https://www.wovenwood.co.uk/pages/care">care guide</a> for looking after it. Take care when lifting.</p>` })]);

  it("A3: archiving, drafting and unpublishing start on Skip", async () => {
    for (const [col, value, text] of [["Status", "Archived", /the product is archived: it comes off sale/], ["Status", "draft", /set back to draft/], ["Published", "FALSE", /taken off the online store/]] as const) {
      const { items, stats } = await run(sheet(["Handle", col], ["panel", value]), store().gql, { dryRun: true });
      expect(items[0].warnings!.join()).toMatch(text);
      expect(stats[0].risk).toMatchObject({ warned: 1 });
    }
    // Putting a draft on sale is not a warning.
    const draft = fakeStore([product("x", "X", [variant("X1", "1.00")], { status: "DRAFT" })]);
    expect((await run(sheet(["Handle", "Status"], ["x", "Active"]), draft.gql, { dryRun: true })).items[0].warnings ?? []).toEqual([]);
  });

  it("A4: find and replace changes the words, not the links; the preview shows the changed part", async () => {
    const s = store();
    const body = s.products[0].descriptionHtml;
    const next = computedCells({ "Body HTML": body }, [{ action: "replace_text", column: "Body HTML", find: "care", value: "maintenance" }])["Body HTML"];
    expect(next).toContain('href="https://www.wovenwood.co.uk/pages/care"');
    expect(next).toContain(">maintenance guide</a>");
    expect(next).toContain("Take maintenance when lifting");
    // In a title, which has no tags, everything is text.
    expect(computedCells({ Title: "Care <kit>" }, [{ action: "replace_text", column: "Title", find: "care", value: "Repair" }])).toEqual({ Title: "Repair <kit>" });
    const { items } = await run(sheet(["Handle", "Body HTML"], ["panel", next]), s.gql, { dryRun: true });
    expect(items[0].changes[0]).toMatch(/^Body HTML: ….*care guide.* → ….*maintenance guide/);
    expect(aroundChange("short", "shorter")).toEqual(["short", "shorter"]);
  });

  it("A7: taking images off a product is flagged", async () => {
    const { items } = await run(sheet(["Handle", "Image Src", "Image Command"], ["panel", "https://example.com/new.jpg", "REPLACE"]), store().gql, { dryRun: true });
    expect(items[0].changes.join("\n")).toMatch(/Image: 2 now → adds new\.jpg/);
    expect(items[0].warnings!.join()).toMatch(/2 images are removed from the product \(all it has\)/);
  });

  it("A5/A11: price cuts from 40% are flagged; a cost column matched to the selling price is caught", async () => {
    const { items } = await run(sheet(["Handle", "Variant SKU", "Variant Price"], ["panel", "W1", "11.00"]), store().gql, { dryRun: true });
    expect(items[0].warnings!.join()).toMatch(/the price drops 45% \(20 → 11\)/);
    const small = await run(sheet(["Handle", "Variant SKU", "Variant Price"], ["panel", "W1", "15.00"]), store().gql, { dryRun: true });
    expect(small.items[0].warnings ?? []).toEqual([]);
    expect(oddMatches({ "Cost Price": "Variant Price", RRP: "Variant Cost", "Product Code": "Variant SKU" })).toEqual([
      expect.stringMatching(/"Cost Price" looks like what you pay the supplier, and is matched to Variant Price/),
      expect.stringMatching(/"RRP" looks like a selling price, and is matched to Variant Cost/),
    ]);
    expect(oddMatches({ "Cost Price": "Variant Cost", RRP: "Variant Price", "Trade Price": "", "Retail price": "Variant Price" })).toEqual([]);
  });

  it("A11: 'keep selling when out of stock' is flagged, in a shop's words", async () => {
    const { items } = await run(sheet(["Handle", "Variant SKU", "Variant Inventory Policy"], ["panel", "W1", "continue"]), store().gql, { dryRun: true });
    expect(items[0].changes.join()).toMatch(/When out of stock \(SKU W1\): stop selling → keep selling/);
    expect(items[0].warnings!.join()).toMatch(/keeps selling when it is out of stock/);
  });
});

describe("round A: detection, exports, undo", () => {
  it("A13: a supplier's price list is not taken for a Menus file", () => {
    expect(detectEntity({ name: "Sheet1", headers: ["Product Code", "Item Description", "Cost Price", "RRP"] }, ENTITIES)).toBeNull();
    // Real files are still recognised from their columns.
    expect(detectEntity({ name: "Sheet1", headers: ["Handle", "Title", "Variant SKU", "Variant Price"] }, ENTITIES)?.key).toBe("products");
    expect(detectEntity({ name: "Sheet1", headers: ["ID", "Handle", "Title", "Item: Title", "Item: Type", "Item: URL"] }, ENTITIES)?.key).toBe("menus");
    expect(detectEntity({ name: "Menus", headers: ["Whatever"] }, ENTITIES)?.key).toBe("menus");
  });

  it("A9: a sheet the app may not read is left out with the reason; the others are exported", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-exp-"));
    const out = createCsvOut(path.join(dir, "Export"));
    const ok: any = { key: "redirects", sheet: "Redirects", columns: ["ID", "Path"], export: async (_c: any, emit: any) => emit([{ ID: "1", Path: "/a" }]) };
    const denied: any = { key: "payouts", sheet: "Payouts", columns: ["ID"], export: async () => { throw new Error("Access denied for shopifyPaymentsAccount field. Required access: `read_shopify_payments` access scope."); } };
    const logs: string[] = [];
    const stats = await runExport({ gql: (async () => ({})) as any, bulk: (async function* () {}) as any, requests: [{ entity: denied, options: { columns: ["ID"] } as any }, { entity: ok, options: { columns: ["ID", "Path"] } as any }], out, tmpDir: dir, log: (m: string) => logs.push(m) } as any);
    expect(stats).toEqual([{ entity: "payouts", rows: 0, items: 0, error: "this app doesn't have Shopify's permission to read payouts (read_shopify_payments)" }, { entity: "redirects", rows: 1, items: 0 }]);
    expect(fs.readFileSync(await out.close(), "utf8")).toContain("1,/a");
    expect(logs.join("\n")).toMatch(/Payouts: NOT exported: .*The other sheets are not affected/);
    expect(jobHealth({ type: "export", status: "finished", stats: stats as any })).toMatchObject({ level: "warning", label: "Finished, sheets missing", problems: 1 });
    // The only sheet failing is still a failed export.
    await expect(runExport({ gql: (async () => ({})) as any, bulk: (async function* () {}) as any, requests: [{ entity: denied, options: { columns: ["ID"] } as any }], out: createCsvOut(path.join(dir, "E2")), tmpDir: dir, log: () => {} } as any)).rejects.toThrow(/Access denied/);
  });

  it("A6: customers named by email are recorded before the import, so it can be undone", async () => {
    const ann = { id: "gid://shopify/Customer/7", firstName: "Ann", lastName: "Lee", displayName: "Ann Lee", note: "", locale: "en", taxExempt: false, taxExemptions: [], tags: ["vip"], defaultEmailAddress: { emailAddress: "ann@example.com", marketingState: "NOT_SUBSCRIBED", marketingOptInLevel: null }, defaultPhoneNumber: null, defaultAddress: null, addressesV2: { nodes: [] } };
    const gql = (async (q: string) => {
      if (/ImportCustomerByIdentifier/.test(q)) return { customerByIdentifier: ann };
      if (/mutation ImportCustomerUpdate/.test(q)) return { customerUpdate: { customer: { id: ann.id }, userErrors: [] } };
      if (/mutation/.test(q)) return Object.fromEntries([[/(\w+)\(/.exec(q.slice(q.indexOf("{")))![1], { userErrors: [] }]]);
      return {};
    }) as any;
    const asked: any[] = [];
    const snapshot = async (entity: any, ids: string[], named?: any) => {
      asked.push({ entity: entity.key, ids, named });
      return [{ ID: "7", Email: "ann@example.com", "First Name": "Ann", Tags: "vip", Command: "UPDATE" }];
    };
    const { stats } = await run([{ name: "Customers", headers: ["Email", "First Name", "Tags"], rows: [{ Email: "Ann@Example.com", "First Name": "Anne", Tags: "" }] }], gql, {}, { snapshot });
    expect(asked).toEqual([{ entity: "customers", ids: [], named: { column: "Email", field: "email", values: ["Ann@Example.com"] } }]);
    expect(stats[0]).toMatchObject({ ok: 1 });
    expect(stats[0].undo).toEqual([{ ID: "7", Email: "ann@example.com", "First Name": "Ann", Tags: "vip", Command: "UPDATE" }]);
    expect(getEntity("customers")!.import!.keyColumns).toContain("Email");
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("round A: shared previews and matchings", async () => {
  const { maskChange, maskPersonal } = await import("../app/lib/jobs/share.server");
  const { saveLayout } = await import("../app/lib/jobs/layouts.server");
  const { default: prisma } = await import("../app/db.server");

  it("A14: a shared preview of customers hides who they are", () => {
    expect(maskPersonal("Email: ann.lee@example.com")).toBe("Email: a•••@e•••.com");
    expect(maskPersonal("Phone +44 7911 123456 changed")).toBe("Phone +44•••56 changed");
    expect(maskChange("First Name: Ann → Anne")).toBe("First Name: (hidden) → (hidden)");
    expect(maskChange("Address (1 High St, Leeds) City: Leeds → York")).toBe("Address (1 High St, Leeds) City: (hidden) → (hidden)");
    expect(maskChange("Note: Likes oak → (cleared)")).toBe("Note: (hidden) → (cleared)");
    // What the reviewer needs to judge stays readable.
    expect(maskChange("Email marketing: unsubscribed → subscribed")).toBe("Email marketing: unsubscribed → subscribed");
    expect(maskChange("Tax Exempt: no → yes")).toBe("Tax Exempt: no → yes");
    expect(maskChange("Tags: vip, trade → (cleared: all 2 tags removed)")).toBe("Tags: vip, trade → (cleared: all 2 tags removed)");
  });

  it("A5: a matching that reads cost prices as selling prices is not saved without a deliberate yes", async () => {
    const shop = `ra-${Date.now()}.myshopify.com`;
    const map = { "Product Code": "Variant SKU", "Cost Price": "Variant Price" };
    await expect(saveLayout(shop, { name: "Acme", entity: "products", map })).rejects.toThrow(/"Cost Price" looks like what you pay the supplier.*tick the box to say it is right/);
    await expect(saveLayout(shop, { name: "Acme", entity: "products", map, confirmedOdd: true })).resolves.toMatchObject({ name: "Acme" });
    await prisma.shopSetting.deleteMany({ where: { shop } });
  });
});
