import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCsv } from "../app/lib/core/sheets";
import { AI_FIXABLE, generateAiFixFile } from "../app/lib/check/aifix";
import { ALL_RULES, createChecker } from "../app/lib/check/rules";
import { getEntity } from "../app/lib/entities";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-aifix-"));

const products = [
  { id: "gid://shopify/Product/1", handle: "bin", title: "Easy Fill Wooden Compost Bin", vendor: "Woven Wood", productType: "Compost Bins", tags: ["garden"], descriptionHtml: "", seo: { title: null, description: null },
    variants: [{ id: "gid://shopify/ProductVariant/11", sku: "A", price: "49.00", selectedOptions: [{ name: "Size", value: "Large" }] }] },
  { id: "gid://shopify/Product/2", handle: "panel", title: "Willow Hurdle Fence Panel", vendor: "Woven Wood", productType: "Fencing", tags: [], descriptionHtml: "<p>Existing text.</p>", seo: { title: "Willow hurdle panel", description: null },
    variants: [{ id: "gid://shopify/ProductVariant/21", sku: "B", price: "30.00", selectedOptions: [{ name: "Title", value: "Default Title" }] }] },
];

function setup(reply: (asked: any[]) => any) {
  const sent: any[] = [];
  let query = "";
  const deps = {
    gql: (async () => ({})) as any,
    bulk: async function* (q: string) {
      query = q;
      yield* structuredClone(products);
    },
    log: () => {},
    anthropic: {
      beta: {
        messages: {
          parse: async (p: any) => {
            sent.push(p);
            const asked = JSON.parse(p.messages[0].content.slice(p.messages[0].content.indexOf("[")));
            return reply(asked);
          },
        },
      },
    } as any,
  };
  return { deps, sent, query: () => query };
}
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-aifix-"));

describe("AI-drafted fixes", () => {
  it("only offers rules whose fix is text, with real columns", () => {
    const columns = new Set(getEntity("products")!.columns);
    for (const [key, fix] of Object.entries(AI_FIXABLE)) {
      expect(ALL_RULES.some((r) => r.key === key), key).toBe(true);
      for (const c of fix.columns) expect(columns.has(c), c).toBe(true);
    }
    expect(Object.keys(AI_FIXABLE)).not.toContain("no_alt");
  });

  it("drafts descriptions from the product's own facts into an import file", async () => {
    const s = setup((asked) => ({
      stop_reason: "end_turn",
      parsed_output: { products: asked.map((a) => ({ id: a.id, description_html: `<p>${a.title}, by ${a.vendor}.</p>`, seo_title: null, seo_description: null })).concat([{ id: "999", description_html: "<p>Not asked for</p>", seo_title: null, seo_description: null }]) },
    }));
    const made = await generateAiFixFile({ rule: "no_description", ids: ["1", "2"] }, s.deps, dir());
    expect(s.query()).toMatch(/id:\\"1\\" OR id:\\"2\\"/);
    // What Claude was given: facts only, and told what to write.
    const asked = JSON.parse(s.sent[0].messages[0].content.slice(s.sent[0].messages[0].content.indexOf("[")));
    expect(asked[0]).toMatchObject({ id: "1", title: "Easy Fill Wooden Compost Bin", vendor: "Woven Wood", type: "Compost Bins", options: ["Size: Large"], write: ["description_html"] });
    expect(asked[1].options).toEqual([]);
    expect(s.sent[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low" } });
    expect(s.sent[0].system[0].text).toMatch(/Never invent materials, dimensions/);
    const { headers, rows } = parseCsv(fs.readFileSync(made.file, "utf8"));
    expect(made).toMatchObject({ name: "Products.csv", items: 2 });
    expect(headers).toEqual(["ID", "Command", "Title", "Body HTML"]);
    expect(rows[0]).toEqual({ ID: "1", Command: "UPDATE", Title: "Easy Fill Wooden Compost Bin", "Body HTML": "<p>Easy Fill Wooden Compost Bin, by Woven Wood.</p>" });
    expect(rows.map((r) => r.ID)).toEqual(["1", "2"]);
  });

  it("fills only the missing search fields and never blanks an existing one", async () => {
    const s = setup((asked) => ({
      stop_reason: "end_turn",
      parsed_output: { products: asked.map((a) => ({ id: a.id, description_html: null, seo_title: `${a.title} | Woven Wood`, seo_description: `Buy the ${a.title}.` })) },
    }));
    const made = await generateAiFixFile({ rule: "no_seo", ids: ["1", "2"] }, s.deps, dir());
    const asked = JSON.parse(s.sent[0].messages[0].content.slice(s.sent[0].messages[0].content.indexOf("[")));
    expect(asked[0].write).toEqual(["seo_title", "seo_description"]);
    expect(asked[1].write).toEqual(["seo_description"]);
    const { rows } = parseCsv(fs.readFileSync(made.file, "utf8"));
    expect(rows[0]).toMatchObject({ "SEO Title": "Easy Fill Wooden Compost Bin | Woven Wood", "SEO Description": "Buy the Easy Fill Wooden Compost Bin." });
    // Product 2 already had a search title: it is kept, not replaced by the draft.
    expect(rows[1]).toMatchObject({ "SEO Title": "Willow hurdle panel", "SEO Description": "Buy the Willow Hurdle Fence Panel." });
  });

  it("leaves out products with no draft, and fails clearly when there are none", async () => {
    const some = setup((asked) => ({ stop_reason: "end_turn", parsed_output: { products: [{ id: asked[0].id, description_html: "<p>Draft.</p>", seo_title: null, seo_description: null }] } }));
    const made = await generateAiFixFile({ rule: "no_description", ids: ["1", "2"] }, some.deps, dir());
    expect(parseCsv(fs.readFileSync(made.file, "utf8")).rows.map((r) => r.ID)).toEqual(["1"]);
    const refused = setup(() => ({ stop_reason: "refusal", parsed_output: null }));
    await expect(generateAiFixFile({ rule: "no_description", ids: ["1"] }, refused.deps, dir())).rejects.toThrow(/No drafts could be written/);
    await expect(generateAiFixFile({ rule: "no_image", ids: ["1"] }, some.deps, dir())).rejects.toThrow(/can't be drafted/);
  });

  it("runs as a preview: drafts are checked against the store and nothing is written", async () => {
    const { executeJob } = await import("../app/lib/jobs/runner.server");
    const s = setup((asked) => ({ stop_reason: "end_turn", parsed_output: { products: asked.map((a) => ({ id: a.id, description_html: "<p>A slatted wooden bin for garden waste.</p>", seo_title: null, seo_description: null })) } }));
    const mutations: string[] = [];
    const gql = (async (q: string) => {
      const op = /(query|mutation)\s+(\w+)/.exec(q);
      if (op?.[1] === "mutation") mutations.push(op[2]);
      if (/ImportProductById/.test(q)) return { product: { id: "gid://shopify/Product/1", handle: "bin", title: "Easy Fill Wooden Compost Bin", tags: [], hasOnlyDefaultVariant: true, options: [], media: { nodes: [] } } };
      if (/ImportProductVariants/.test(q)) return { product: { variants: { nodes: [], pageInfo: { hasNextPage: false } } } };
      return {};
    }) as any;
    const job = { id: "ai1", shop: "aifix-test.myshopify.com", type: "import", format: "csv", name: "AI drafts", inputFile: null, inputName: null, config: JSON.stringify({ options: { dryRun: true, defaultCommand: "UPDATE" }, aiFix: { rule: "no_description", ids: ["1"] } }) };
    const r = await executeJob(job, { ...s.deps, gql, bulk: async function* () { yield structuredClone(products[0]); }, progress: () => {}, isCancelled: async () => false });
    expect(mutations).toEqual([]);
    expect(r.stats[0]).toMatchObject({ entity: "products", items: 1, ok: 1 });
    expect(fs.readFileSync(r.resultFile, "utf8")).toMatch(/Dry run: would update/);
    expect(fs.readFileSync(path.join(path.dirname(r.resultFile), "preview.json"), "utf8")).toMatch(/A slatted wooden bin/);
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("weekly check and score drops", async () => {
  const { default: prisma } = await import("../app/db.server");
  const check = await import("../app/lib/check/check.server");
  const jobs = await import("../app/lib/jobs/jobs.server");
  const shop = `weekly-check-${Date.now()}.myshopify.com`;
  afterAll(async () => {
    await prisma.job.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
  });
  const report = (score: number) => JSON.stringify([{ ...createChecker().report(), score, rules: [{ key: "no_description", count: 3, examples: [], ids: ["1", "2", "3"] }] }]);

  it("schedules Mondays at 06:00, off the Schedules page, and can be switched off", async () => {
    const s = await check.setWeeklyCheck(shop, true, "Europe/London");
    expect(s).toMatchObject({ kind: "check", type: "export", intervalMinutes: 10080, runAt: "06:00", weekday: 1, enabled: true });
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "long", hour: "2-digit", minute: "2-digit" }).format(s.nextRunAt)).toBe("Monday 06:00");
    expect(await jobs.listSchedules(shop)).toEqual([]);
    const off = await check.setWeeklyCheck(shop, false, "Europe/London");
    expect(off).toMatchObject({ id: s.id, enabled: false });
  });

  it("flags a lower score on the home screen until the Data check page is opened", async () => {
    const at = (m: number) => new Date(Date.now() - m * 60_000);
    await prisma.job.create({ data: { shop, type: "export", kind: "check", status: "finished", config: "{}", stats: report(82), createdAt: at(20), reviewedAt: at(19) } });
    expect(await check.scoreDrop(shop)).toBeNull();
    const latest = await prisma.job.create({ data: { shop, type: "export", kind: "check", status: "finished", config: "{}", stats: report(74), createdAt: at(5) } });
    expect(await check.scoreDrop(shop)).toEqual({ from: 82, to: 74 });
    // A check job never shows in the job list or the "needs attention" banner.
    expect(await jobs.countJobs(shop)).toBe(0);
    expect(await jobs.needsAttention(shop)).toEqual([]);
    await check.markCheckSeen(shop);
    expect(await check.scoreDrop(shop)).toBeNull();
    // A higher score is never a "drop".
    await prisma.job.create({ data: { shop, type: "export", kind: "check", status: "finished", config: "{}", stats: report(90) } });
    expect(await check.scoreDrop(shop)).toBeNull();
    expect(latest.id).toBeTruthy();
  });

  it("starts AI drafts as a preview of the first products a rule flagged", async () => {
    process.env.ANTHROPIC_API_KEY ??= "test-key";
    const c = (await check.latestChecks(shop)).latest!.job;
    const job = await check.startAiFix(shop, c.id, "no_description");
    const cfg = JSON.parse(job.config);
    expect(cfg).toEqual({ options: { dryRun: true, defaultCommand: "UPDATE" }, aiFix: { rule: "no_description", ids: ["1", "2", "3"] } });
    expect(job).toMatchObject({ type: "import", kind: "job", inputFile: null });
    await expect(check.startAiFix(shop, c.id, "no_image")).rejects.toThrow(/nothing to draft/);
    await expect(check.startAiFix("other.myshopify.com", c.id, "no_description")).rejects.toThrow(/nothing to draft/);
  });
});
