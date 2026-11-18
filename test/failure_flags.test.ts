import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { countProblems, jobHealth } from "../app/lib/jobs/health";

describe("job health", () => {
  const imp = (stats: any[], status = "finished", dryRun = false) => jobHealth({ type: "import", status, stats: JSON.stringify(stats), dryRun });

  it("says Finished only when nothing went wrong", () => {
    expect(imp([{ sheet: "Products", entity: "products", items: 10, ok: 9, failed: 0, skipped: 1 }])).toMatchObject({ level: "ok", label: "Finished", problems: 0 });
    expect(jobHealth({ type: "export", status: "finished", stats: "[]" })).toMatchObject({ level: "ok", label: "Finished" });
  });

  it("flags failed rows and sheets that weren't imported", () => {
    const h = imp([
      { sheet: "Products", entity: "products", items: 10, ok: 7, failed: 3, skipped: 0 },
      { sheet: "CarrierNumbers", entity: null, items: 0, ok: 0, failed: 0, skipped: 88 },
    ]);
    expect(h).toMatchObject({ level: "critical", label: "Finished with errors", problems: 91 });
    expect(h.summary).toBe("3 items failed; 1 sheet not imported (CarrierNumbers)");
    expect(countProblems([{ entity: null, sheet: "x", items: 4 }])).toEqual({ failed: 0, unimported: 4, sheets: ["x"] });
  });

  it("previews say 'would fail'; failures and cancels have their own labels", () => {
    expect(imp([{ sheet: "Orders", entity: "orders", failed: 1 }], "finished", true)).toMatchObject({ level: "warning", label: "Preview: problems", summary: "1 item would fail" });
    expect(imp([], "finished", true)).toMatchObject({ level: "ok", label: "Preview ready" });
    expect(jobHealth({ type: "import", status: "failed", error: "Download failed: HTTP 404" })).toMatchObject({ level: "critical", label: "Failed", summary: "Download failed: HTTP 404" });
    expect(jobHealth({ type: "export", status: "cancelled" })).toMatchObject({ level: "warning", label: "Cancelled" });
    expect(jobHealth({ type: "import", status: "running" })).toMatchObject({ level: "running" });
    expect(imp("oops" as any)).toMatchObject({ level: "ok" });
  });
});

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("attention and schedule health", async () => {
  const { default: prisma } = await import("../app/db.server");
  const jobs = await import("../app/lib/jobs/jobs.server");
  const shop = `alerts-test-${Date.now()}.myshopify.com`;
  afterAll(async () => {
    await prisma.job.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.shopSetting.deleteMany({ where: { shop } });
  });
  const failedStats = JSON.stringify([{ sheet: "Products", entity: "products", items: 2, ok: 1, failed: 1, skipped: 0 }]);

  it("lists failed jobs until they are opened", async () => {
    const ok = await prisma.job.create({ data: { shop, type: "import", status: "finished", config: "{}", stats: "[]" } });
    const partly = await prisma.job.create({ data: { shop, type: "import", status: "finished", config: "{}", stats: failedStats, problems: 1 } });
    const failed = await prisma.job.create({ data: { shop, type: "export", status: "failed", config: "{}", error: "boom" } });
    const old = await prisma.job.create({ data: { shop, type: "export", status: "failed", config: "{}", createdAt: new Date(Date.now() - 30 * 86400_000) } });
    const ids = async () => (await jobs.needsAttention(shop)).map((j) => j.id).sort();
    expect(await ids()).toEqual([partly.id, failed.id].sort());
    await jobs.markReviewed(shop, failed.id);
    expect(await ids()).toEqual([partly.id]);
    await jobs.markReviewed("someone-else.myshopify.com");
    expect(await ids()).toEqual([partly.id]);
    await jobs.markReviewed(shop);
    expect(await ids()).toEqual([]);
    expect([ok.id, old.id]).toHaveLength(2);
  });

  it("shows each schedule's last run, failing streak and whether it is overdue", async () => {
    const now = new Date();
    const s = await prisma.schedule.create({ data: { shop, name: "S", type: "export", config: "{}", intervalMinutes: 60, nextRunAt: new Date(now.getTime() - 2 * 3600_000) } });
    const at = (m: number) => new Date(now.getTime() - m * 60_000);
    await prisma.job.create({ data: { shop, type: "export", status: "finished", config: "{}", scheduleId: s.id, createdAt: at(300), finishedAt: at(299) } });
    await prisma.job.create({ data: { shop, type: "export", status: "failed", config: "{}", scheduleId: s.id, createdAt: at(200), error: "x" } });
    const last = await prisma.job.create({ data: { shop, type: "import", status: "finished", config: "{}", scheduleId: s.id, problems: 4, createdAt: at(100), finishedAt: at(99) } });
    const h = (await jobs.scheduleHealth(shop, [s], now))[s.id];
    expect(h).toMatchObject({ failingStreak: 2, overdue: true, last: { id: last.id, problems: 4, status: "finished" } });
    const fresh = await prisma.schedule.create({ data: { shop, name: "T", type: "export", config: "{}", intervalMinutes: 60, nextRunAt: new Date(now.getTime() + 60_000), enabled: true } });
    expect((await jobs.scheduleHealth(shop, [fresh], now))[fresh.id]).toEqual({ last: null, failingStreak: 0, overdue: false });
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("history filters", async () => {
  const { default: prisma } = await import("../app/db.server");
  const jobs = await import("../app/lib/jobs/jobs.server");
  const shop = `history-filter-${Date.now()}.myshopify.com`;
  afterAll(() => prisma.job.deleteMany({ where: { shop } }));

  it("lists exports, imports, scheduled jobs or problems only", async () => {
    await prisma.job.createMany({
      data: [
        { shop, type: "export", status: "finished", config: "{}" },
        { shop, type: "export", status: "failed", config: "{}", scheduleId: "s1" },
        { shop, type: "import", status: "finished", config: "{}", problems: 2 },
        { shop, type: "import", status: "finished", config: "{}" },
        { shop, type: "import", status: "running", config: "{}" },
      ],
    });
    const n = async (f: any) => [await jobs.countJobs(shop, f), (await jobs.listJobs(shop, 50, f)).length];
    expect(await n("all")).toEqual([5, 5]);
    expect(await n("export")).toEqual([2, 2]);
    expect(await n("import")).toEqual([3, 3]);
    expect(await n("scheduled")).toEqual([1, 1]);
    expect(await n("problems")).toEqual([2, 2]);
    expect((await jobs.listJobs(shop, 2)).length).toBe(2);
  });
});
