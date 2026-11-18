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
process.env.SHOPIFY_API_KEY ??= "key123";

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("attention and alerts", async () => {
  const { default: prisma } = await import("../app/db.server");
  const jobs = await import("../app/lib/jobs/jobs.server");
  const alerts = await import("../app/lib/jobs/alerts.server");
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

  it("emails once about a failed scheduled job, and only when asked to", async () => {
    const sent: any[] = [];
    const mail = async (m: any) => void sent.push(m);
    const schedule = await prisma.schedule.create({ data: { shop, name: "Nightly carriers", type: "import", config: "{}", intervalMinutes: 1440, nextRunAt: new Date() } });
    const job = await prisma.job.create({ data: { shop, type: "import", status: "finished", config: "{}", stats: failedStats, problems: 1, scheduleId: schedule.id } });
    // No address saved: nothing sent.
    expect(await alerts.alertIfNeeded(job.id, mail)).toBe(false);
    await expect(alerts.saveSettings(shop, { alertEmail: "ops@example.com, not-an-email" })).rejects.toThrow(/not an email/);
    await alerts.saveSettings(shop, { alertEmail: "ops@example.com; mat@example.com", alertScope: "scheduled" });
    expect(await alerts.alertIfNeeded(job.id, mail)).toBe(true);
    expect(sent[0].to).toBe("ops@example.com, mat@example.com");
    expect(sent[0].subject).toBe(`Bulkport: Import "Nightly carriers" had problems (${shop.replace(".myshopify.com", "")})`);
    expect(sent[0].text).toMatch(/1 item failed/);
    expect(sent[0].text).toContain(`/apps/key123/app/jobs/${job.id}`);
    // Once only.
    expect(await alerts.alertIfNeeded(job.id, mail)).toBe(false);
    // A job someone started by hand: only with "every job".
    const manual = await prisma.job.create({ data: { shop, type: "export", status: "failed", config: "{}", error: "Throttled" } });
    expect(await alerts.alertIfNeeded(manual.id, mail)).toBe(false);
    await alerts.saveSettings(shop, { alertEmail: "ops@example.com", alertScope: "all" });
    expect(await alerts.alertIfNeeded(manual.id, mail)).toBe(true);
    expect(sent[1].subject).toMatch(/Export failed/);
    // Fine or cancelled jobs never alert.
    const fine = await prisma.job.create({ data: { shop, type: "import", status: "finished", config: "{}", stats: "[]" } });
    const cancelled = await prisma.job.create({ data: { shop, type: "export", status: "cancelled", config: "{}" } });
    expect(await alerts.alertIfNeeded(fine.id, mail)).toBe(false);
    expect(await alerts.alertIfNeeded(cancelled.id, mail)).toBe(false);
    // A mail server error doesn't mark it as sent.
    const again = await prisma.job.create({ data: { shop, type: "export", status: "failed", config: "{}" } });
    expect(await alerts.alertIfNeeded(again.id, async () => { throw new Error("SMTP down"); })).toBe(false);
    expect((await prisma.job.findUnique({ where: { id: again.id } }))!.alertedAt).toBeNull();
    expect(sent).toHaveLength(2);
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
