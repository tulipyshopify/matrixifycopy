import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runImport } from "../app/lib/core/importer";
import type { PartialPreview } from "../app/lib/core/importer";
import { ENTITIES } from "../app/lib/entities";
import { fakeStore, product, variant } from "./helpers/fake_store";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-fix-"));

const makeStore = () =>
  fakeStore([
    product("potato-barrel", "Potato Barrel", [variant("PB001", "44.99")]),
    product("dracaena", "Dracaena Planter", [variant("LEAF-7435", "16.99")]),
    product("hurdle", "Willow Hurdle", [variant("WS010", "39.99")]),
  ]);

describe("first look while a preview runs", () => {
  it("reports the first rows checked and running totals, then the finished sheet", async () => {
    const store = fakeStore(Array.from({ length: 80 }, (_, i) => product(`p-${i}`, `Product ${i}`, [variant(`SKU-${i}`, "10.00")])));
    const rows = Array.from({ length: 80 }, (_, i) => ({ Handle: i === 3 ? "p-typo" : `p-${i}`, Title: `Product ${i}${i % 2 ? "" : " new"}` }));
    const seen: PartialPreview[][] = [];
    await runImport({
      ctx: { gql: store.gql, options: { dryRun: true, defaultCommand: "UPDATE", concurrency: 4 } as any, log: () => {}, cache: new Map() } as any,
      sheets: [{ name: "Products", headers: ["Handle", "Title", "Titel"], rows }],
      entities: ENTITIES,
      log: () => {},
      onPartial: (p) => seen.push(JSON.parse(JSON.stringify(p))),
    });
    // After the first 10 items, at 50, and when the sheet is done.
    expect(seen.map((p) => p[0].checked)).toEqual([10, 50, 80]);
    expect(seen[0][0]).toMatchObject({ sheet: "Products", entity: "products", total: 80 });
    expect(seen[0][0].items).toHaveLength(10);
    // The sheet's warnings (a mistyped column) are there from the first look on.
    expect(seen[0][0].warnings!.join()).toMatch(/Column "Titel" is not a Products column/);
    expect(seen[1][0].items).toHaveLength(50);
    expect(seen[1][0].items.map((i) => i.row)).toEqual([...seen[1][0].items.map((i) => i.row)].sort((a, b) => a - b));
    expect(seen[2][0]).toMatchObject({ checked: 80, failed: 1 });
    expect(seen[2][0].items).toHaveLength(50);
    expect(seen[2][0].items.find((i) => i.row === 5)).toMatchObject({ action: "failed" });
  });

  it("row numbers of a part of a sheet are those of the file", async () => {
    const [s] = await runImport({
      ctx: { gql: makeStore().gql, options: { dryRun: true, defaultCommand: "UPDATE" } as any, log: () => {}, cache: new Map() } as any,
      sheets: [{ name: "Products", headers: ["Handle", "Title"], rows: [{ Handle: "nope", Title: "x".repeat(300) }], rowNumbers: [41] }],
      entities: ENTITIES,
      log: () => {},
    });
    expect(s.preview![0]).toMatchObject({ row: 41, action: "failed" });
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("correcting a row on the preview's page", async () => {
  const { default: prisma } = await import("../app/db.server");
  const { executeJob, readEdits, PREVIEW_FILE, PARTIAL_FILE } = await import("../app/lib/jobs/runner.server");
  const { applyDryRun, applyNeeds, readPreview } = await import("../app/lib/jobs/jobs.server");
  const { editableRows, editedRowCount, fixPreviewRows } = await import("../app/lib/jobs/fix.server");
  const { jobDir } = await import("../app/lib/jobs/storage.server");
  const shop = `fix-${Date.now()}.myshopify.com`;
  afterAll(async () => {
    await prisma.job.deleteMany({ where: { shop } });
  });

  const run = async (id: string, store: ReturnType<typeof fakeStore>) => {
    const job = await prisma.job.findUniqueOrThrow({ where: { id } });
    const logs: string[] = [];
    const { stats } = await executeJob(job as any, { gql: store.gql, bulk: (async function* () {}) as any, log: (m) => logs.push(m), progress: () => {}, isCancelled: async () => false });
    await prisma.job.update({ where: { id }, data: { status: "finished", stats: JSON.stringify(stats) } });
    return { stats, log: logs.join("\n") };
  };

  const start = async (csv: string) => {
    const dir = fs.mkdtempSync(path.join(process.env.STORAGE_DIR!, "in-"));
    const file = path.join(dir, "Products.csv");
    fs.writeFileSync(file, csv);
    const job = await prisma.job.create({ data: { shop, type: "import", config: JSON.stringify({ options: { dryRun: true, defaultCommand: "UPDATE" } }), format: "csv", name: "t", inputFile: file, inputName: "Products.csv" } });
    return job.id;
  };

  it("a mistyped handle is corrected, only that row is checked again, and the import uses the correction", async () => {
    const store = makeStore();
    const id = await start("Handle,Title,Variant SKU,Variant Price\npotato-barel,Potato Barrel XL,PB001,49.99\ndracaena,Dracaena Planter,LEAF-7435,16.99\nhurdle,Willow Hurdle Panel,WS010,39.99\n");
    await run(id, store);
    // The first look is cleared once the preview is complete.
    expect(fs.existsSync(path.join(jobDir(shop, id), PARTIAL_FILE))).toBe(false);
    let job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(applyNeeds(job.stats)).toMatchObject({ failing: 1, updates: 1, unchanged: 1 });

    const rows = await editableRows(shop, id, "Products", 2);
    expect(rows).toMatchObject({ sheet: "Products", row: 2, headers: ["Handle", "Title", "Variant SKU", "Variant Price"] });
    expect(rows.keyColumns).toContain("Handle");
    expect(rows.rows).toEqual([{ index: 0, number: 2, cells: { Handle: "potato-barel", Title: "Potato Barrel XL", "Variant SKU": "PB001", "Variant Price": "49.99" }, edited: [] }]);

    // A value that would make it the same item as another row is refused.
    await expect(fixPreviewRows(shop, id, "Products", 2, [{ index: 0, column: "Handle", value: "hurdle" }], store.gql as any)).rejects.toThrow(/same Handle as row 4/);
    await expect(fixPreviewRows(shop, id, "Products", 2, [{ index: 1, column: "Title", value: "x" }], store.gql as any)).rejects.toThrow(/belongs to another item/);
    await expect(fixPreviewRows(shop, id, "Products", 2, [{ index: 0, column: "Nope", value: "x" }], store.gql as any)).rejects.toThrow(/not a column/);
    expect(await editedRowCount(shop, id)).toBe(0);

    const fixed = await fixPreviewRows(shop, id, "Products", 2, [{ index: 0, column: "Handle", value: "potato-barrel" }], store.gql as any);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ row: 2, action: "update", edited: true, key: "Handle=potato-barrel" });
    expect(fixed[0].changes.join("\n")).toMatch(/Title: Potato Barrel → Potato Barrel XL/);
    expect(fixed[0].changes.join("\n")).toMatch(/44\.99 → 49\.99/);

    job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(applyNeeds(job.stats)).toMatchObject({ failing: 0, updates: 2, unchanged: 1, changes: 2 });
    expect(job.problems).toBe(0);
    expect(job.log).toMatch(/Row 2 of "Products" was corrected on this page and checked again: would update/);
    const preview = await readPreview(shop, id);
    expect(preview[0].items.map((i) => [i.row, i.action])).toEqual([[2, "update"], [3, "none"], [4, "update"]]);
    expect(await readEdits(jobDir(shop, id))).toEqual({ Products: { "0": { Handle: "potato-barrel" } } });
    expect(await editedRowCount(shop, id)).toBe(1);
    // The row now shows the corrected value, and which cell was corrected.
    expect((await editableRows(shop, id, "Products", 2)).rows[0]).toMatchObject({ cells: { Handle: "potato-barrel" }, edited: ["Handle"] });
    // The uploaded file itself is untouched.
    expect(fs.readFileSync(job.inputFile!, "utf8")).toContain("potato-barel,");
    // What the preview saw of the corrected item is recorded for the import's check.
    const stored = JSON.parse(fs.readFileSync(path.join(jobDir(shop, id), PREVIEW_FILE), "utf8"));
    expect(Object.keys(stored[0].seen)).toContain("Handle=potato-barrel");
    expect(Object.keys(stored[0].seen)).not.toContain("Handle=potato-barel");

    // Applying the preview imports the corrected row.
    const real = await applyDryRun(shop, id, "trusted");
    const { stats, log } = await run(real.id, store);
    expect(log).toMatch(/1 row was corrected in the preview; the corrected values are used/);
    expect(stats[0]).toMatchObject({ ok: 3, failed: 0 });
    const p = store.products.find((x) => x.handle === "potato-barrel")!;
    expect(p.title).toBe("Potato Barrel XL");
    expect(p.variants[0].price).toBe("49.99");
  });

  it("a correction that doesn't solve it leaves the row failing; the file's values can be put back", async () => {
    const store = makeStore();
    const id = await start("Handle,Title,Variant SKU,Variant Price\npotato-barrel,Potato Barrel,PB001,abc\ndracaena,New name,LEAF-7435,16.99\n");
    await run(id, store);
    const still = await fixPreviewRows(shop, id, "Products", 2, [{ index: 0, column: "Variant Price", value: "minus five" }], store.gql as any);
    expect(still[0]).toMatchObject({ action: "failed", edited: true });
    expect(still[0].message).toMatch(/expected a price but got "minus five"/);
    expect(applyNeeds((await prisma.job.findUniqueOrThrow({ where: { id } })).stats)).toMatchObject({ failing: 1, updates: 1 });

    const ok = await fixPreviewRows(shop, id, "Products", 2, [{ index: 0, column: "Variant Price", value: "44.99" }], store.gql as any);
    expect(ok[0]).toMatchObject({ action: "none", edited: true });
    expect(applyNeeds((await prisma.job.findUniqueOrThrow({ where: { id } })).stats)).toMatchObject({ failing: 0, updates: 1, unchanged: 1 });

    // An item that was fine can be edited too, and put back.
    const edited = await fixPreviewRows(shop, id, "Products", 3, [{ index: 1, column: "Title", value: "Dracaena Planter" }], store.gql as any);
    expect(edited[0]).toMatchObject({ action: "none" });
    const back = await fixPreviewRows(shop, id, "Products", 3, [], store.gql as any, { reset: true });
    expect(back[0]).toMatchObject({ action: "update" });
    expect(back[0].edited).toBeUndefined();
    expect(await readEdits(jobDir(shop, id))).toEqual({ Products: { "0": { "Variant Price": "44.99" } } });
    await fixPreviewRows(shop, id, "Products", 2, [], store.gql as any, { reset: true });
    expect(await readEdits(jobDir(shop, id))).toEqual({});
    expect(applyNeeds((await prisma.job.findUniqueOrThrow({ where: { id } })).stats)).toMatchObject({ failing: 1, updates: 1, unchanged: 0 });
  });

  it("only a finished preview can be corrected", async () => {
    const job = await prisma.job.create({ data: { shop, type: "import", config: JSON.stringify({ options: { defaultCommand: "UPDATE" } }), format: "csv", name: "real", status: "finished", inputFile: "/x", inputName: "Products.csv" } });
    await expect(editableRows(shop, job.id, "Products", 2)).rejects.toThrow(/finished preview only/);
    await expect(editableRows("other.myshopify.com", job.id, "Products", 2)).rejects.toThrow(/can't be found/);
  });
});
