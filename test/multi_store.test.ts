import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-multi-"));
process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";
process.env.SHOPIFY_APP_URL = "https://bulk.example.com";

const { default: prisma } = await import("../app/db.server");
const jobs = await import("../app/lib/jobs/jobs.server");
const { jobDir } = await import("../app/lib/jobs/storage.server");
const { loader: filesLoader } = await import("../app/routes/files.$token");

const stamp = Date.now();
const A = `store-a-${stamp}.myshopify.com`;
const B = `store-b-${stamp}.myshopify.com`;
const config = jobs.parseExportConfig({ entities: [{ entity: "products", options: {} }] });
const status = async (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof Response ? e.status : 500));

afterAll(async () => {
  for (const shop of [A, B]) await jobs.purgeShop(shop);
});

// Needs the local database (npm run setup); skipped on a fresh checkout without one.
describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("several stores on one server", () => {
  it("each store sees and controls only its own jobs", async () => {
    const a = await jobs.createExportJob(A, config, "xlsx", "A export");
    const b = await jobs.createExportJob(B, config, "csv", "B export");
    expect((await jobs.listJobs(A)).map((j) => j.id)).toEqual([a.id]);
    expect((await jobs.listJobs(B)).map((j) => j.id)).toEqual([b.id]);

    // Store B can't open, cancel or re-run store A's job, even knowing its ID.
    expect(await status(jobs.getJob(B, a.id))).toBe(404);
    expect(await status(jobs.cancelJob(B, a.id))).toBe(404);
    expect(await status(jobs.rerunJob(B, a.id))).toBe(404);
    expect((await prisma.job.findUnique({ where: { id: a.id } }))!.status).toBe("queued");

    // "Latest export" comes from the store's own history.
    expect(await jobs.latestExportPreset(B, a.id)).toBeNull();
    expect((await jobs.latestExportPreset(A))?.format).toBe("xlsx");

    // Files are stored in separate folders per store.
    expect(path.dirname(jobDir(A, a.id))).not.toBe(path.dirname(jobDir(B, b.id)));
  });

  it("presets and schedules are separate per store", async () => {
    const data = { format: "xlsx", entities: [{ entity: "products", options: {} }] };
    const pa = await jobs.savePreset(A, "Weekly", data);
    await jobs.savePreset(B, "Weekly", { ...data, format: "csv" }); // same name, different store
    expect((await jobs.listPresets(A)).map((p) => p.data.format)).toEqual(["xlsx"]);
    expect((await jobs.listPresets(B)).map((p) => p.data.format)).toEqual(["csv"]);
    await jobs.deletePreset(B, pa.id);
    expect(await jobs.listPresets(A)).toHaveLength(1);

    const sa = await jobs.createSchedule(A, { name: "A daily", type: "export", config, intervalMinutes: 1440, publicLink: true });
    expect((await jobs.listSchedules(B)).map((s) => s.id)).toEqual([]);
    expect(await status(jobs.updateSchedule(B, sa.id, { enabled: false }))).toBe(404);
    await jobs.deleteSchedule(B, sa.id);
    await jobs.disablePublicLink(B, sa.id);
    await jobs.resetPublicToken(B, sa.id);
    const still = (await jobs.listSchedules(A))[0];
    expect(still).toMatchObject({ id: sa.id, enabled: true, publicToken: sa.publicToken });
  });

  it("a store's permanent link only ever serves that store's file", async () => {
    const [sa] = await jobs.listSchedules(A);
    const sb = await jobs.createSchedule(B, { name: "B daily", type: "export", config, intervalMinutes: 1440, publicLink: true });
    for (const [shop, s, text] of [[A, sa, "store A data"], [B, sb, "store B data"]] as const) {
      const job = await prisma.job.create({ data: { shop, type: "export", config: "{}", scheduleId: s.id, status: "finished", finishedAt: new Date() } });
      const file = path.join(jobDir(shop, job.id), "Export.csv");
      fs.writeFileSync(file, text);
      await prisma.job.update({ where: { id: job.id }, data: { resultFile: file } });
    }
    const get = (token: string) => filesLoader({ params: { token }, request: new Request("https://x/files/" + token), context: {} } as any) as Promise<Response>;
    expect(await (await get(sa.publicToken!)).text()).toBe("store A data");
    expect(await (await get(sb.publicToken!)).text()).toBe("store B data");
  });

  it("removing one store's data (uninstall / redact) leaves the other untouched", async () => {
    await jobs.purgeShop(B);
    expect(await jobs.listJobs(B)).toEqual([]);
    expect(await jobs.listPresets(B)).toEqual([]);
    expect((await jobs.listJobs(A)).length).toBeGreaterThan(0);
    expect(await jobs.listPresets(A)).toHaveLength(1);
    expect(await jobs.listSchedules(A)).toHaveLength(1);
  });
});
