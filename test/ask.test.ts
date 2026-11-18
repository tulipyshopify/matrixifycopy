import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCsv, readWorkbook } from "../app/lib/core/sheets";
import { detectEntity } from "../app/lib/core/registry";
import { ENTITIES } from "../app/lib/entities";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";

const ai = await import("../app/lib/ai/assistant.server");
const { generateChangeFile } = await import("../app/lib/ai/generate");

const plan = (p: Partial<ai.AssistantPlan>): ai.AssistantPlan => ({
  kind: "export",
  explanation: "x",
  entity: "products",
  filters: [],
  date_range: null,
  columns: null,
  changes: [],
  ...p,
});

describe("checking a plan", () => {
  it("accepts an export with filters, a date range and chosen columns", () => {
    const c = ai.checkPlan(
      plan({
        entity: "orders",
        filters: [{ field: "financial_status", op: "is", value: "paid", value2: null }],
        date_range: { field: "fulfillment_created_at", preset: "last_n", amount: 21, unit: "days", from: null, to: null },
        columns: ["ID", "Name", "Metafield: custom.courier", "Bogus column"],
      }),
    );
    expect(c.kind).toBe("export");
    const o = c.config.entities[0].options;
    expect(o.filters).toEqual([{ field: "financial_status", op: "is", value: "paid" }]);
    expect(o.dateRange).toMatchObject({ field: "fulfillment_created_at", preset: "last_n", amount: 21, unit: "days" });
    expect(o.columns).toEqual(["ID", "Name"]);
  });

  it("refuses anything outside the form, with a reason", () => {
    expect(() => ai.checkPlan(plan({ kind: "unclear", explanation: "Which store data do you mean?" }))).toThrow("Which store data do you mean?");
    expect(() => ai.checkPlan(plan({ entity: "spaceships" }))).toThrow(/isn't a data type/);
    expect(() => ai.checkPlan(plan({ filters: [{ field: "colour", op: "is", value: "red", value2: null }] }))).toThrow(/unknown filter/);
    expect(() => ai.checkPlan(plan({ filters: [{ field: "vendor", op: "gt", value: "a", value2: null }] }))).toThrow();
    expect(() => ai.checkPlan(plan({ kind: "change", entity: "payouts" }))).toThrow(/only be exported|isn't a data type/);
    expect(() => ai.checkPlan(plan({ kind: "change", changes: [] }))).toThrow(/didn't say what to change/);
    const set = (column: string) => ai.checkPlan(plan({ kind: "change", changes: [{ action: "set_column", column, value: "x", metafield: null, metafield_type: null }] }));
    expect(() => set("ID")).toThrow(/can be changed/);
    expect(() => set("Made up")).toThrow(/can be changed/);
    expect(set("Vendor").changes).toEqual([{ action: "set_column", column: "Vendor", value: "x" }]);
    expect(() => ai.checkPlan(plan({ kind: "change", changes: [{ action: "set_metafield", column: null, value: "1", metafield: "bad key", metafield_type: "boolean" }] }))).toThrow(/isn't a metafield/);
  });

  it("turns changes into import columns", () => {
    expect(ai.changeColumns([{ action: "add_tags", value: "Winter sale" }, { action: "set_metafield", metafield: "custom.pre_order", metafieldType: "boolean", value: "true" }])).toEqual({
      Tags: "Winter sale",
      "Tags Command": "MERGE",
      "Metafield: custom.pre_order [boolean]": "true",
    });
    expect(ai.changeColumns([{ action: "remove_tags", value: "old" }])).toEqual({ Tags: "old", "Tags Command": "DELETE" });
    expect(() => ai.changeColumns([{ action: "add_tags", value: "a" }, { action: "remove_tags", value: "b" }])).toThrow(/separate/);
  });
});

describe("asking Claude", () => {
  it("sends the request with the catalogue cached, structured output and fallbacks", async () => {
    let sent: any;
    const fake = { beta: { messages: { parse: async (p: any) => ((sent = p), { stop_reason: "end_turn", parsed_output: plan({ explanation: "All products" }) }) } } } as any;
    const p = await ai.askForPlan("export all products", { now: new Date("2026-11-18T10:00:00Z"), timezone: "Europe/London" }, fake);
    expect(p.explanation).toBe("All products");
    expect(sent).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], output_config: { effort: "low" } });
    expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(sent.system[0].text).toContain("## orders");
    expect(sent.system[0].text).toContain("fulfillment_created_at");
    // Today's date goes in the message, not the cached system prompt.
    expect(sent.system[0].text).not.toContain("2026-11-18");
    expect(sent.messages[0].content).toContain("Today is 2026-11-18 (store time zone Europe/London)");
  });

  it("explains a refusal or an unreadable answer", async () => {
    const reply = (r: any) => ({ beta: { messages: { parse: async () => r } } }) as any;
    await expect(ai.askForPlan("x", { now: new Date(), timezone: "UTC" }, reply({ stop_reason: "refusal", parsed_output: null }))).rejects.toThrow(/can't be turned into a plan/);
    await expect(ai.askForPlan("x", { now: new Date(), timezone: "UTC" }, reply({ stop_reason: "end_turn", parsed_output: null }))).rejects.toThrow(/Couldn't understand/);
    await expect(ai.askForPlan("   ", { now: new Date(), timezone: "UTC" }, reply({}))).rejects.toThrow(/Type what you want/);
  });
});

describe("building the change file", () => {
  it("lists every matching item once, with the new values, as a Products sheet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-gen-"));
    let query = "";
    const made = await generateChangeFile(
      { entity: "products", options: { filters: [{ field: "product_type", op: "is", value: "Planters" }] }, changes: [{ action: "add_tags", value: "Winter sale" }], prompt: "tag planters" },
      {
        gql: (async () => ({})) as any,
        bulk: async function* (q: string) {
          query = q;
          yield { id: "gid://shopify/Product/1", handle: "a", title: "A" };
          yield { id: "gid://shopify/Product/2", handle: "b", title: "B" };
        },
        log: () => {},
      },
      dir,
    );
    expect(query).toContain('product_type:\\"Planters\\"');
    expect(query).not.toMatch(/variants|media/);
    expect(made).toMatchObject({ name: "Products.csv", items: 2 });
    const [sheet] = await readWorkbook(made.file, made.name);
    expect(sheet.headers).toEqual(["ID", "Command", "Tags", "Tags Command"]);
    expect(sheet.rows).toEqual([
      { ID: "1", Command: "UPDATE", Tags: "Winter sale", "Tags Command": "MERGE" },
      { ID: "2", Command: "UPDATE", Tags: "Winter sale", "Tags Command": "MERGE" },
    ]);
    expect(detectEntity(sheet, ENTITIES)?.key).toBe("products");
    expect(parseCsv(fs.readFileSync(made.file, "utf8")).rows).toHaveLength(2);
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("requests", async () => {
  const { default: prisma } = await import("../app/db.server");
  const shop = `ask-test-${Date.now()}.myshopify.com`;
  afterAll(async () => {
    await prisma.askLog.deleteMany({ where: { shop } });
    await prisma.job.deleteMany({ where: { shop } });
  });
  const gql = (async () => ({ shop: { ianaTimezone: "Europe/London" } })) as any;
  const reply = (p: ai.AssistantPlan) => ({ beta: { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: p }) } } }) as any;

  it("records each request; a change starts as a preview", async () => {
    process.env.ANTHROPIC_API_KEY ??= "test-key";
    const change = plan({ kind: "change", explanation: "Tag planters", filters: [{ field: "product_type", op: "is", value: "Planters", value2: null }], changes: [{ action: "add_tags", column: null, value: "Winter sale", metafield: null, metafield_type: null }] });
    const r = await ai.ask(shop, "tag all planters Winter sale", gql, reply(change));
    expect(r.plan?.kind).toBe("change");
    const job = await ai.startChangePreview(shop, r.id);
    const cfg = JSON.parse(job.config);
    expect(cfg.options).toEqual({ dryRun: true, defaultCommand: "UPDATE" });
    expect(cfg.generate).toMatchObject({ entity: "products", changes: [{ action: "add_tags", value: "Winter sale" }], prompt: "tag all planters Winter sale" });
    expect(job.inputFile).toBeNull();
    // Exports are opened in the export form.
    const e = await ai.ask(shop, "export products", gql, reply(plan({ columns: ["ID", "Title"] })));
    expect(await ai.askedExport(shop, e.id)).toMatchObject({ entities: [{ entity: "products", options: { columns: ["ID", "Title"] } }] });
    expect(await ai.askedExport("other.myshopify.com", e.id)).toBeNull();
    await expect(ai.startChangePreview(shop, e.id)).rejects.toThrow(/can't be found/);
    // Problems are recorded too, with the message shown to the merchant.
    const bad = await ai.ask(shop, "delete everything", gql, reply(plan({ kind: "unclear", explanation: "Deleting isn't possible here." })));
    expect(bad).toMatchObject({ plan: null, error: "Deleting isn't possible here." });
    expect(await prisma.askLog.count({ where: { shop } })).toBe(3);
  });

  it("allows a few requests a minute", async () => {
    for (let i = 0; i < 3; i++) await ai.ask(shop, "export products", gql, reply(plan({})));
    await expect(ai.ask(shop, "export products", gql, reply(plan({})))).rejects.toThrow(/Too many requests/);
  });
});

describe("a change, end to end", () => {
  it("builds the file when the job runs, then previews it without writing", async () => {
    const { executeJob } = await import("../app/lib/jobs/runner.server");
    const product = { id: "gid://shopify/Product/1", handle: "bin", title: "Bin", tags: ["Compost Bin"], hasOnlyDefaultVariant: true, options: [], media: { nodes: [] } };
    const mutations: string[] = [];
    const gql = (async (q: string) => {
      const op = /(query|mutation)\s+(\w+)/.exec(q);
      if (op?.[1] === "mutation") mutations.push(op[2]);
      if (/ImportProductById/.test(q)) return { product };
      if (/ImportProductVariants/.test(q)) return { product: { variants: { nodes: [], pageInfo: { hasNextPage: false } } } };
      return {};
    }) as any;
    let saved: string[] = [];
    const job = {
      id: "gen1",
      shop: "gen-test.myshopify.com",
      type: "import",
      format: "csv",
      name: "Change: tag",
      inputFile: null,
      inputName: null,
      config: JSON.stringify({ options: { dryRun: true, defaultCommand: "UPDATE" }, generate: { entity: "products", options: {}, changes: [{ action: "add_tags", value: "Winter sale" }] } }),
    };
    const r = await executeJob(job, {
      gql,
      bulk: async function* () {
        yield { id: "gid://shopify/Product/1", handle: "bin", title: "Bin" };
      },
      log: () => {},
      progress: () => {},
      isCancelled: async () => false,
      onInput: async (file, name) => void (saved = [file, name]),
    });
    expect(saved[1]).toBe("Products.csv");
    expect(job.inputFile).toBe(saved[0]);
    expect(r.stats[0]).toMatchObject({ entity: "products", items: 1, ok: 1, failed: 0 });
    expect(mutations).toEqual([]);
    const text = fs.readFileSync(r.resultFile, "utf8");
    expect(text).toMatch(/Dry run: would update/);
  });
});
