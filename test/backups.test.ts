import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-backups-"));
process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";

const backups = await import("../app/lib/jobs/backups.server");

describe("backup settings", () => {
  it("backs up every column and data group, without discount code pools", () => {
    const cfg = backups.backupConfig(["products", "discounts", "payouts", "nope"]);
    expect(cfg.entities.map((e) => e.entity)).toEqual(["products", "discounts"]);
    expect(cfg.entities[0].options.groups).toContain("inventory");
    expect(cfg.entities[0].options.columns).toBeUndefined();
    expect(cfg.entities[1].options.groups).not.toContain("codes");
    expect(() => backups.backupConfig([])).toThrow(/at least one/);
    expect(backups.DEFAULT_BACKUP_TYPES).not.toContain("payouts");
  });

  it("is limited to the stores in BACKUP_SHOPS (all stores by default)", () => {
    const before = process.env.BACKUP_SHOPS;
    delete process.env.BACKUP_SHOPS;
    expect(backups.backupsAllowed("a.myshopify.com")).toBe(true);
    process.env.BACKUP_SHOPS = "b.myshopify.com, c.myshopify.com";
    expect(backups.backupsAllowed("a.myshopify.com")).toBe(false);
    expect(backups.backupsAllowed("c.myshopify.com")).toBe(true);
    if (before === undefined) delete process.env.BACKUP_SHOPS;
    else process.env.BACKUP_SHOPS = before;
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("backups on the server", async () => {
  const { default: prisma } = await import("../app/db.server");
  const jobs = await import("../app/lib/jobs/jobs.server");
  const { backupDir, jobDir, cleanupOldFiles } = await import("../app/lib/jobs/storage.server");
  const shop = `backup-test-${Date.now()}.myshopify.com`;
  afterAll(async () => {
    await prisma.job.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.shopSetting.deleteMany({ where: { shop } });
  });

  it("saves a daily backup schedule that stays off the Schedules page", async () => {
    const s = await backups.saveBackupSettings(shop, { enabled: true, runAt: "2:30", timezone: "Europe/London", types: ["products", "orders"], keepDays: 14 });
    expect(s).toMatchObject({ kind: "backup", runAt: "02:30", intervalMinutes: 1440, enabled: true, format: "csv" });
    const again = await backups.saveBackupSettings(shop, { enabled: false, runAt: "03:00", timezone: "Europe/London", types: ["products"], keepDays: 7 });
    expect(again.id).toBe(s.id);
    expect(JSON.parse(again.config).entities.map((e: any) => e.entity)).toEqual(["products"]);
    expect((await prisma.shopSetting.findUnique({ where: { shop } }))!.backupKeepDays).toBe(7);
    expect(await jobs.listSchedules(shop)).toEqual([]);
    await expect(backups.saveBackupSettings(shop, { enabled: true, runAt: "25:00", timezone: "Europe/London", types: ["products"], keepDays: 7 })).rejects.toThrow(/HH:MM/);
  });

  it("runs one backup at a time, and keeps backups out of the job history", async () => {
    const b = await backups.backupNow(shop);
    expect(b).toMatchObject({ kind: "backup", type: "export", status: "queued", format: "csv" });
    await expect(backups.backupNow(shop)).rejects.toThrow(/already running/);
    expect(await jobs.countJobs(shop)).toBe(0);
    expect((await backups.listBackups(shop)).map((x) => x.id)).toEqual([b.id]);
    await prisma.job.update({ where: { id: b.id }, data: { status: "failed", error: "x" } });
  });

  it("deletes backups past the keep period but always keeps the newest", async () => {
    const day = 86400_000;
    const mk = async (daysAgo: number, status = "finished") => {
      const j = await prisma.job.create({ data: { shop, type: "export", kind: "backup", status, config: "{}", createdAt: new Date(Date.now() - daysAgo * day) } });
      const file = path.join(backupDir(shop, j.id), "Store_backup.zip");
      fs.writeFileSync(file, "zip");
      return prisma.job.update({ where: { id: j.id }, data: { resultFile: file } });
    };
    await prisma.job.deleteMany({ where: { shop, kind: "backup" } });
    const old1 = await mk(40);
    const old2 = await mk(20);
    const recent = await mk(2);
    await backups.pruneBackups(); // keep period 7 days (saved above)
    expect((await backups.listBackups(shop)).map((x) => x.id)).toEqual([recent.id]);
    expect(fs.existsSync(path.dirname(old1.resultFile!))).toBe(false);
    expect(fs.existsSync(recent.resultFile!)).toBe(true);
    // Only old backups left: the newest of them stays.
    await prisma.job.deleteMany({ where: { id: recent.id } });
    const lone = await mk(60);
    await backups.pruneBackups();
    expect((await backups.listBackups(shop)).map((x) => x.id)).toEqual([lone.id]);
    expect(old2.id).toBeTruthy();
  });

  it("the general clean-up of old job folders leaves backups alone", async () => {
    const b = (await backups.listBackups(shop))[0];
    const jd = jobDir(shop, "oldjob");
    const past = new Date(Date.now() - 400 * 86400_000);
    fs.utimesSync(jd, past, past);
    fs.utimesSync(path.join(path.dirname(jd), "_backups"), past, past);
    await cleanupOldFiles();
    expect(fs.existsSync(jd)).toBe(false);
    expect(fs.existsSync(path.join(process.env.STORAGE_DIR!, b.resultFile ? path.relative(process.env.STORAGE_DIR!, b.resultFile) : ""))).toBe(true);
  });

  it("restoring starts a preview of the backup file", async () => {
    const b = (await backups.listBackups(shop))[0];
    const job = await backups.restorePreview(shop, b.id);
    expect(JSON.parse(job.config)).toEqual({ options: { dryRun: true, defaultCommand: "MERGE" } });
    expect(job).toMatchObject({ type: "import", kind: "job", inputFile: b.resultFile, status: "queued" });
    expect(job.inputName).toMatch(/^Backup \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.zip$/);
    // A single-type backup is one CSV, named after its type so it is recognised.
    const single = await prisma.job.create({ data: { shop, type: "export", kind: "backup", status: "finished", config: JSON.stringify({ entities: [{ entity: "smart_collections", options: {} }] }) } });
    const file = path.join(backupDir(shop, single.id), "Store_backup.csv");
    fs.writeFileSync(file, "ID\n1\n");
    await prisma.job.update({ where: { id: single.id }, data: { resultFile: file } });
    expect((await backups.restorePreview(shop, single.id)).inputName).toBe("Smart Collections.csv");
    // Not a backup, or another store's: refused.
    const plain = await prisma.job.create({ data: { shop, type: "export", status: "finished", config: "{}", resultFile: file } });
    await expect(backups.restorePreview(shop, plain.id)).rejects.toThrow(/can't be restored/);
    await expect(backups.restorePreview("other.myshopify.com", b.id)).rejects.toBeTruthy();
  });
});

describe("writing a backup", () => {
  it("goes to the store's backup folder, not a job folder", async () => {
    const { executeJob } = await import("../app/lib/jobs/runner.server");
    const r = await executeJob(
      { id: "bk1", shop: "file-test.myshopify.com", type: "export", kind: "backup", format: "csv", name: "Store backup", inputFile: null, inputName: null, config: JSON.stringify({ entities: [{ entity: "redirects", options: {} }] }) },
      {
        gql: (async () => ({})) as any,
        bulk: async function* () {
          yield { id: "gid://shopify/UrlRedirect/1", path: "/old", target: "/new" };
        },
        log: () => {},
        progress: () => {},
        isCancelled: async () => false,
      },
    );
    expect(r.resultFile).toContain(`${path.sep}_backups${path.sep}bk1${path.sep}`);
    expect(fs.readFileSync(r.resultFile, "utf8")).toContain("/old");
  });
});
