import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { EXPORT_TEMPLATES, getTemplate } from "../app/lib/jobs/templates";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";
const jobs = await import("../app/lib/jobs/jobs.server");

describe("export templates", () => {
  it("are all valid export set-ups", () => {
    for (const t of EXPORT_TEMPLATES) {
      const cfg = jobs.parseExportConfig({ entities: t.entities });
      expect(cfg.entities.length, t.key).toBe(t.entities.length);
      // Nothing in a template is silently dropped by validation.
      for (const [i, e] of t.entities.entries()) {
        expect(cfg.entities[i].options.columns ?? [], t.key).toEqual(e.options.columns ?? []);
        expect(cfg.entities[i].options.groups ?? [], t.key).toEqual(e.options.groups ?? []);
        expect((cfg.entities[i].options.filters ?? []).length, t.key).toBe((e.options.filters ?? []).length);
      }
    }
    expect(new Set(EXPORT_TEMPLATES.map((t) => t.key)).size).toBe(EXPORT_TEMPLATES.length);
    expect(getTemplate("stock")?.title).toBe("Stock by location");
    expect(getTemplate("nope")).toBeNull();
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("dashboard numbers", async () => {
  const { default: prisma } = await import("../app/db.server");
  const shop = `dash-test-${Date.now()}.myshopify.com`;
  afterAll(async () => {
    await prisma.job.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
  });

  it("starts as a first run, then counts the last 7 days", async () => {
    expect(await jobs.homeStats(shop)).toMatchObject({ firstRun: true, exports: 0, imports: 0, problems: 0, nextSchedule: null, lastBackupAt: null });
    const old = new Date(Date.now() - 10 * 86400_000);
    await prisma.job.createMany({
      data: [
        { shop, type: "export", status: "finished", config: "{}", stats: JSON.stringify([{ items: 100 }, { items: 20 }]) },
        { shop, type: "export", status: "failed", config: "{}" },
        { shop, type: "export", status: "finished", config: "{}", stats: JSON.stringify([{ items: 999 }]), createdAt: old },
        { shop, type: "import", status: "finished", config: "{}", stats: JSON.stringify([{ ok: 7, failed: 2 }]), problems: 2 },
        { shop, type: "import", status: "finished", config: JSON.stringify({ options: { dryRun: true } }), stats: JSON.stringify([{ ok: 50 }]) },
        { shop, type: "export", kind: "backup", status: "finished", config: "{}" },
      ],
    });
    await prisma.schedule.create({ data: { shop, name: "Nightly", type: "export", config: "{}", intervalMinutes: 1440, nextRunAt: new Date(Date.now() + 3600_000) } });
    const s = await jobs.homeStats(shop);
    expect(s).toMatchObject({ firstRun: false, exports: 2, imports: 2, exported: 120, changed: 7, problems: 2 });
    expect(s.nextSchedule?.name).toBe("Nightly");
    expect(s.lastBackupAt).toBeInstanceOf(Date);
  });
});
