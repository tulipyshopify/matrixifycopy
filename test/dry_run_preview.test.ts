import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeChanges, runImport } from "../app/lib/core/importer";
import { createCsvOut, parseCsv } from "../app/lib/core/sheets";
import type { Entity } from "../app/lib/core/types";
import { ImportError } from "../app/lib/core/types";

const entity: Entity = {
  key: "orders",
  sheet: "Orders",
  description: "",
  columns: ["ID", "Command"],
  import: {
    keyColumns: ["ID"],
    async apply(ctx, rows, command) {
      const id = rows[0].ID;
      await ctx.gql("#graphql\n  query ImportOrderById { x }");
      if (id === "404") throw new ImportError("Order not found");
      if (id === "same") return { status: "OK", command, message: "No changes" };
      await ctx.gql("#graphql\n  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) { x }", {
        metafields: [
          { ownerId: `gid://shopify/Order/${id}`, namespace: "custom", key: "courier", type: "single_line_text_field", value: rows[0].Courier },
          { ownerId: `gid://shopify/Order/${id}`, namespace: "custom", key: "couriercost", type: "number_decimal", value: rows[0].Cost },
        ],
      });
      throw new Error("never reached in a dry run");
    },
  },
};

describe("dry-run preview", () => {
  it("lists what each item would do, with the values it would send", async () => {
    const sheet = { name: "Orders", ...parseCsv("ID,Courier,Cost,Command\n1001,P: DHL Next Day,31.2,UPDATE\n404,P: DX Freight,28,UPDATE\nsame,,,UPDATE\n1002,x,1,IGNORE\n") };
    const mutations: string[] = [];
    const gql = async (q: string) => {
      if (/mutation/.test(q)) mutations.push(q);
      return {};
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-prev-"));
    const [s] = await runImport({
      ctx: { gql: gql as any, options: { dryRun: true }, log: () => {}, cache: new Map() },
      sheets: [sheet],
      entities: [entity],
      out: createCsvOut(path.join(dir, "r")),
      log: () => {},
    });
    expect(mutations).toEqual([]);
    expect(s.preview).toEqual([
      {
        row: 2,
        item: "ID: 1001",
        command: "UPDATE",
        action: "update",
        message: "would update",
        changes: ["First step: metafields set", "custom.courier = P: DHL Next Day", "custom.couriercost = 31.2"],
      },
      { row: 3, item: "ID: 404", command: "UPDATE", action: "failed", message: "Order not found", changes: [] },
      { row: 4, item: "ID: same", command: "UPDATE", action: "none", message: "No changes", changes: [] },
      { row: 5, item: "ID: 1002", command: "IGNORE", action: "skipped", message: "Command IGNORE", changes: [] },
    ]);
  });

  it("is not made for real imports", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-prev-"));
    const [s] = await runImport({
      ctx: { gql: (async () => ({})) as any, options: {}, log: () => {}, cache: new Map() },
      sheets: [{ name: "Orders", ...parseCsv("ID,Command\nsame,UPDATE\n") }],
      entities: [entity],
      out: createCsvOut(path.join(dir, "r")),
      log: () => {},
    });
    expect(s.preview).toBeUndefined();
  });

  it("describes mutation values readably and leaves out IDs", () => {
    expect(describeChanges({ id: "gid://shopify/Product/1", tags: ["YGroup_easy-fill-compost-bin"] })).toEqual(["tags: YGroup_easy-fill-compost-bin"]);
    expect(describeChanges({ input: { id: "gid://shopify/Order/1", note: "Leave at door", shippingAddress: { city: "Leeds", zip: "LS1" } } })).toEqual([
      "note: Leave at door",
      "shippingAddress.city: Leeds",
      "shippingAddress.zip: LS1",
    ]);
    expect(describeChanges({ product: { title: "x".repeat(200) } })[0]).toMatch(/^title: x{117}…$/);
    expect(describeChanges({ a: Array.from({ length: 50 }, (_, i) => ({ v: i })) })).toHaveLength(12);
  });
});

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("Import for real", async () => {
  const { default: prisma } = await import("../app/db.server");
  const jobs = await import("../app/lib/jobs/jobs.server");
  const { jobRow } = await import("../app/components/jobs");
  const shop = `dry-run-test-${Date.now()}.myshopify.com`;

  const stat = (risk: Record<string, number>, extra: Record<string, unknown> = {}) =>
    JSON.stringify([{ sheet: "Products", entity: "products", items: 10, ok: 10, failed: 0, skipped: 0, risk: { creates: 0, updates: 0, deletes: 0, unchanged: 0, clearing: 0, warned: 0, ...risk }, ...extra }]);

  it("starts the same file and settings without the dry run", async () => {
    const config = JSON.stringify({ options: { dryRun: true, defaultCommand: "UPDATE" } });
    const dry = await prisma.job.create({ data: { shop, type: "import", status: "finished", config, inputFile: "x/input.csv", inputName: "Carrier.csv", stats: stat({ updates: 10 }) } });
    expect(jobRow({ ...dry, startedAt: null, finishedAt: null }).kind).toBe("Preview");
    const real = await jobs.applyDryRun(shop, dry.id);
    expect(JSON.parse(real.config)).toEqual({ options: { defaultCommand: "UPDATE" }, previewOf: dry.id });
    expect(real).toMatchObject({ type: "import", status: "queued", inputFile: "x/input.csv", inputName: "Carrier.csv" });
    expect(jobRow({ ...real, startedAt: null, finishedAt: null }).kind).toBe("Import");
    // Only finished dry runs of this store.
    await expect(jobs.applyDryRun(shop, real.id)).rejects.toThrow(/Only a dry run/);
    const running = await prisma.job.create({ data: { shop, type: "import", status: "running", config, inputFile: "x/input.csv" } });
    await expect(jobs.applyDryRun(shop, running.id)).rejects.toThrow(/Wait for the dry run/);
    await expect(jobs.applyDryRun("other.myshopify.com", dry.id)).rejects.toBeTruthy();
    // "Run again" on a real import comes back as a preview, never as another real import.
    const again = await jobs.rerunJob(shop, real.id);
    expect(JSON.parse(again.config)).toEqual({ options: { defaultCommand: "UPDATE", dryRun: true } });
  });

  it("asks for a confirmation of everything risky before importing for real", async () => {
    const config = JSON.stringify({ options: { dryRun: true } });
    const make = (stats: string) => prisma.job.create({ data: { shop, type: "import", status: "finished", config, inputFile: "x/input.csv", stats } });
    // Nothing would change: nothing to import.
    await expect(jobs.applyDryRun(shop, (await make(stat({ unchanged: 10 }))).id)).rejects.toThrow(/nothing to import/);
    // Creates, cleared fields, warnings, failing rows and a sheet left out each need a yes; deletions the typed word.
    const risky = await make(
      JSON.stringify([
        { sheet: "Products", entity: "products", items: 12, ok: 9, failed: 3, skipped: 0, risk: { creates: 2, updates: 5, deletes: 1, unchanged: 1, clearing: 4, warned: 2 } },
        { sheet: "Notes", entity: null, items: 0, ok: 0, failed: 0, skipped: 7, warnings: ["Not imported: not recognised, nothing imported."] },
      ]),
    );
    expect(jobs.applyNeeds(risky.stats)).toEqual({
      changes: 8, creates: 2, updates: 5, deletes: 1, unchanged: 1, clearing: 4, warned: 2, failing: 3,
      skippedSheets: [{ sheet: "Notes", rows: 7, reason: "not recognised, nothing imported." }],
    });
    await expect(jobs.applyDryRun(shop, risky.id)).rejects.toThrow(
      /type DELETE to confirm 1 deletion; confirm creating 2 new items; confirm emptying fields on 4 items; confirm you have read the warnings on 2 items; confirm skipping 3 items that would fail; confirm that 1 sheet is not imported/,
    );
    const all = { creates: true, clearing: true, warnings: true, failing: true, skippedSheets: true };
    await expect(jobs.applyDryRun(shop, risky.id, { ...all, deletes: "yes" })).rejects.toThrow(/type DELETE/);
    await expect(jobs.applyDryRun(shop, risky.id, { ...all, deletes: "DELETE", warnings: false })).rejects.toThrow(/read the warnings/);
    expect((await jobs.applyDryRun(shop, risky.id, { ...all, deletes: " delete " })).status).toBe("queued");
    // A plain update needs no ticks.
    expect((await jobs.applyDryRun(shop, (await make(stat({ updates: 3, unchanged: 7 }))).id)).status).toBe("queued");
    await prisma.job.deleteMany({ where: { shop } });
  });
});
