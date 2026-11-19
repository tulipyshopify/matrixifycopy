import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ALL_RULES, RULES, createChecker, validGtin } from "../app/lib/check/rules";
import { getEntity } from "../app/lib/entities";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-check-"));

const jobs = await import("../app/lib/jobs/jobs.server");
const check = await import("../app/lib/check/check.server");

const good = (id: string, sku = `SKU-${id}`): Array<Record<string, string>> => [
  {
    "Metafield: shopify.color-pattern [list.metaobject_reference]": "gid://shopify/Metaobject/9",
    ID: id, "Top Row": "TRUE", Title: "Easy Fill Wooden Compost Bin", "Body HTML": `<p>${"A sturdy slatted bin for garden waste. ".repeat(5)}</p>`, Vendor: "Woven Wood", Type: "Compost Bins",
    "Category: Name": "Compost Bins", "SEO Title": "Compost bin", "SEO Description": "Wooden compost bin",
    "Variant ID": `${id}1`, "Variant SKU": sku, "Variant Barcode": "4006381333931", "Variant Price": "49.00", "Variant Requires Shipping": "TRUE", "Variant Weight": "12",
    "Variant Inventory Tracker": "shopify", "Variant Inventory Policy": "deny", "Variant Inventory Qty": "8", Published: "TRUE",
    "Image Src": "https://cdn/x.jpg", "Image Alt Text": "Compost bin in a garden",
  },
  { ID: id, "Image Src": "https://cdn/y.jpg", "Image Alt Text": "Compost bin, side view" },
];

describe("product data rules", () => {
  it("a complete product has no problems", () => {
    const c = createChecker();
    expect(c.add(good("1"))).toEqual([]);
    expect(c.report()).toMatchObject({ products: 1, ready: 1, score: 100 });
  });

  it("finds each kind of gap", () => {
    const problems = (patch: Record<string, string>, extraRows: any[] = []) => {
      const c = createChecker();
      return c.add([{ ...good("1")[0], ...patch }, good("1")[1], ...extraRows]);
    };
    expect(problems({ "Body HTML": "<p>Nice bin</p>" })).toEqual(["No description, or a very short one"]);
    const noImages = createChecker().add([{ ...good("1")[0], "Image Src": "", "Image Alt Text": "" }]);
    expect(noImages).toEqual(["No image"]);
    expect(problems({ "Category: Name": "" })).toEqual(["No product category"]);
    expect(problems({ "Variant Price": "0.00" })).toEqual(["A variant with no price"]);
    expect(problems({}, [{ ID: "1", "Variant ID": "12", "Variant SKU": "", "Variant Barcode": "036000291452", "Variant Price": "5" }])).toEqual(["A variant without a SKU"]);
    expect(problems({ "Variant Barcode": "" })).toEqual(["A variant without a barcode (GTIN)"]);
    expect(problems({ "Image Alt Text": "" })).toEqual(["Images without alt text"]);
    expect(problems({ Title: "Bin" })).toEqual(["Title too short or too long"]);
    expect(problems({ Vendor: "", Type: "" })).toEqual(["No vendor (brand)", "No product type"]);
    expect(problems({ "SEO Description": "" })).toEqual(["Search title or description missing"]);
    expect(problems({ "Variant Weight": "0" })).toEqual(["A shipped variant with no weight"]);
    expect(problems({ "Variant Weight": "0", "Variant Requires Shipping": "FALSE" })).toEqual([]);
    // The rules added for Shopify's agentic channels.
    expect(problems({ "Body HTML": `<p>${"Sturdy bin. ".repeat(8)}</p>` })).toEqual(["Description under 150 characters"]);
    expect(problems({ "Variant Barcode": "4006381333932" })).toEqual(["A barcode that isn't a valid GTIN"]);
    expect(problems({ "Variant Barcode": "ABC-123" })).toEqual(["A barcode that isn't a valid GTIN"]);
    expect(createChecker().add([good("1")[0]])).toEqual(["Only one image"]);
    expect(problems({ "Variant Inventory Qty": "0" })).toEqual(["Active but out of stock"]);
    expect(problems({ "Variant Inventory Qty": "0", "Variant Inventory Policy": "continue" })).toEqual([]);
    expect(problems({ "Variant Inventory Qty": "0", "Variant Inventory Tracker": "" })).toEqual([]);
    expect(problems({ Published: "FALSE" })).toEqual(["Active but not on the Online Store"]);
    expect(problems({ "Variant Compare At Price": "49.00" })).toEqual(["Compare-at price not above the price"]);
    expect(problems({ "Variant Compare At Price": "59.00" })).toEqual([]);
  });

  it("checks GTIN check digits", () => {
    for (const ok of ["4006381333931", "036000291452", "96385074", "10614141000415"]) expect(validGtin(ok), ok).toBe(true);
    for (const bad of ["4006381333930", "12345", "ABC", ""]) expect(validGtin(bad), bad).toBe(false);
  });

  it("flags missing category attributes only when the store's attributes can be read", () => {
    const bare = (id: string) => good(id).map((r) => ({ ...r, "Metafield: shopify.color-pattern [list.metaobject_reference]": "" }));
    const c = createChecker();
    c.add(good("1"));
    expect(c.add(bare("2"))).toEqual(["Category set, but no attributes (colour, material, size…)"]);
    expect(c.report().rules.find((r) => r.key === "no_attributes")!.count).toBe(1);
    // No product shows any attribute: it can't be told apart from "not readable", so nothing is flagged.
    const blind = createChecker();
    blind.add(bare("1"));
    blind.add(bare("2"));
    expect(blind.report().rules.find((r) => r.key === "no_attributes")!.count).toBe(0);
  });

  it("flags both products that share a SKU, and scores critical gaps three times as heavy", () => {
    const c = createChecker();
    c.add(good("1", "DUP"));
    c.add(good("2", "dup"));
    c.add(good("3"));
    c.add([{ ...good("4")[0], Vendor: "" }, good("4")[1]]);
    const r = c.report();
    expect(r.rules.find((x) => x.key === "duplicate_sku")).toMatchObject({ count: 2, ids: ["1", "2"] });
    expect(r).toMatchObject({ products: 4, ready: 2 });
    // 4 products; possible loss = (6 critical x3 + 14 recommended x1) x 4 = 128; lost = 2x3 + 1 = 7.
    expect(ALL_RULES.filter((x) => x.severity === "critical")).toHaveLength(6);
    expect(ALL_RULES).toHaveLength(20);
    expect(r.score).toBe(95);
  });

  it("only asks for columns that exist, so 'Export to fix' is always valid", () => {
    const columns = new Set(getEntity("products")!.columns);
    for (const r of ALL_RULES) for (const c of r.fixColumns) expect(columns.has(c), `${r.key}: ${c}`).toBe(true);
    expect(new Set(ALL_RULES.map((r) => r.key)).size).toBe(RULES.length + 1);
  });
});

describe("running a check", () => {
  it("reads active products only, changes nothing, and lists the problem products", async () => {
    const { executeJob } = await import("../app/lib/jobs/runner.server");
    let query = "";
    const mutations: string[] = [];
    const r = await executeJob(
      { id: "chk1", shop: "check-test.myshopify.com", type: "export", kind: "check", format: "csv", name: "Data check", inputFile: null, inputName: null, config: "{}" },
      {
        gql: (async (q: string) => (/mutation/.test(q) && mutations.push(q), {})) as any,
        bulk: async function* (q: string) {
          query = q;
          yield { id: "gid://shopify/Product/1", handle: "bin", title: "Easy Fill Wooden Compost Bin", descriptionHtml: "", vendor: "Woven Wood", variants: [{ id: "gid://shopify/ProductVariant/11", sku: "", price: "0.00", selectedOptions: [] }] };
        },
        log: () => {},
        progress: () => {},
        isCancelled: async () => false,
      },
    );
    expect(query).toContain('status:\\"active\\"');
    expect(query).not.toMatch(/inventoryLevels/);
    expect(mutations).toEqual([]);
    const report = r.stats[0] as any;
    expect(report).toMatchObject({ products: 1, ready: 0 });
    expect(report.rules.find((x: any) => x.key === "no_sku").count).toBe(1);
    const text = fs.readFileSync(r.resultFile, "utf8");
    expect(text).toContain("ID,Handle,Title,Problems");
    expect(text).toMatch(/1,bin,Easy Fill Wooden Compost Bin,"?No description/);
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("check reports", async () => {
  const { default: prisma } = await import("../app/db.server");
  const shop = `check-test-${Date.now()}.myshopify.com`;
  afterAll(() => prisma.job.deleteMany({ where: { shop } }));

  it("runs one at a time, stays out of the job history, and builds a fix export", async () => {
    const a = await check.startCheck(shop);
    expect((await check.startCheck(shop)).id).toBe(a.id);
    expect(await jobs.countJobs(shop)).toBe(0);
    const c = createChecker();
    c.add([{ ...good("101")[0], "Variant Barcode": "" }]);
    c.add([{ ...good("102")[0], "Variant Barcode": "" }]);
    await prisma.job.update({ where: { id: a.id }, data: { status: "finished", finishedAt: new Date(), stats: JSON.stringify([c.report()]) } });
    const { latest, active } = await check.latestChecks(shop);
    expect(active).toBeNull();
    expect(latest?.report?.products).toBe(2);
    const fix = (await check.fixExport(shop, a.id, "no_barcode"))!;
    const cfg = jobs.parseExportConfig(fix);
    expect(cfg.entities[0].options).toMatchObject({
      groups: ["variants"],
      columns: ["ID", "Title", "Handle", "Variant ID", "Variant SKU", "Variant Barcode"],
      // The export finds the products itself with the same rule, so none are left out.
      filters: [{ field: "status", op: "is", value: "active" }, { field: "problem", op: "is", value: "no_barcode" }],
    });
    expect(await check.fixExport(shop, a.id, "no_image")).toBeNull();
    expect(await check.fixExport("other.myshopify.com", a.id, "no_barcode")).toBeNull();
  });
});

describe("scores per channel", () => {
  it("weighs each rule by how much the channel cares, and names what holds it back", async () => {
    const { channelScores } = await import("../app/lib/check/rules");
    const report = { products: 1000, rules: [{ key: "no_alt", count: 850, examples: [], ids: [] }, { key: "no_barcode", count: 400, examples: [], ids: [] }, { key: "no_description", count: 10, examples: [], ids: [] }] };
    const [google, social, ai] = channelScores(report as any);
    // Missing GTINs hurt Google most; alt text only matters to the agents; neither matters to social.
    expect(google.worst[0]).toMatchObject({ rule: "no_barcode", count: 400, weight: 3 });
    expect(google.score).toBe(95);
    expect(social.score).toBe(100);
    expect(social.worst.map((w) => w.rule)).toEqual(["no_description"]);
    expect(ai.worst.map((w) => w.rule)).toEqual(["no_alt", "no_barcode", "no_description"]);
    expect(ai.score).toBe(95);
    expect(channelScores({ products: 0, rules: [] } as any).map((c) => c.score)).toEqual([100, 100, 100]);
  });
});
