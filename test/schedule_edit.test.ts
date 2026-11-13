import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-edit-"));
process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_APP_URL = "https://bulk.example.com/";
process.env.SHOPIFY_API_SECRET ??= "test-secret";

const { default: prisma } = await import("../app/db.server");
const jobs = await import("../app/lib/jobs/jobs.server");
const { openSecret } = await import("../app/lib/jobs/storage.server");

const shop = `schedule-edit-test-${Date.now()}.myshopify.com`;
const products = { entities: [{ entity: "products", options: {} }] };
const orders = { entities: [{ entity: "orders", options: { columns: ["Name"] } }] };

afterAll(async () => {
  await prisma.schedule.deleteMany({ where: { shop: { startsWith: "schedule-edit-test-" } } });
});

// Needs the local database (npm run setup); skipped on a fresh checkout without one.
describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("editing a schedule", () => {
  it("changes an export schedule in place and keeps its link, password and next run", async () => {
    const s = await jobs.createSchedule(shop, {
      name: "Daily products",
      type: "export",
      config: products,
      format: "csv",
      intervalMinutes: 1440,
      uploadUrl: "ftp://user:s3cret@ftp.example.com/out/",
      publicLink: true,
    });
    const form = await jobs.scheduleForEdit(shop, s.id, "export");
    expect(form?.uploadUrl).toBe("ftp://user:****@ftp.example.com/out/");
    expect(form?.config).toEqual(products);

    const count = await prisma.schedule.count({ where: { shop } });
    const e = await jobs.editSchedule(shop, s.id, {
      name: "Daily orders",
      type: "export",
      config: orders,
      format: "xlsx",
      intervalMinutes: 1440,
      uploadUrl: form!.uploadUrl, // sent back as shown
    });
    expect(await prisma.schedule.count({ where: { shop } })).toBe(count);
    expect(e.id).toBe(s.id);
    expect(e.name).toBe("Daily orders");
    expect(e.format).toBe("xlsx");
    expect(JSON.parse(e.config)).toEqual(orders);
    expect(e.publicToken).toBe(s.publicToken);
    expect(openSecret(e.uploadUrl)).toBe("ftp://user:s3cret@ftp.example.com/out/");
    expect(e.nextRunAt).toEqual(s.nextRunAt);
  });

  it("moves the next run when the timing changes, and can drop the upload", async () => {
    const s = await jobs.createSchedule(shop, { name: "T", type: "export", config: products, intervalMinutes: 60, uploadUrl: "ftp://a:b@h/x" });
    const e = await jobs.editSchedule(shop, s.id, {
      name: "T",
      type: "export",
      config: products,
      intervalMinutes: 10080,
      runAt: "7:30",
      timezone: "Europe/London",
      weekday: 1,
    });
    expect(e).toMatchObject({ intervalMinutes: 10080, runAt: "07:30", timezone: "Europe/London", weekday: 1, uploadUrl: null });
    expect(e.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "long", hour: "2-digit", minute: "2-digit" }).format(e.nextRunAt)).toBe("Monday 07:30");
    const back = await jobs.editSchedule(shop, s.id, { name: "T", type: "export", config: products, intervalMinutes: 360 });
    expect(back).toMatchObject({ intervalMinutes: 360, runAt: null, timezone: null, weekday: null });
  });

  it("edits an import schedule, keeping or replacing its link", async () => {
    const s = await jobs.createSchedule(shop, {
      name: "Stock",
      type: "import",
      config: { options: { defaultCommand: "MERGE" } },
      sourceUrl: "ftp://u:pw@h.example.com/stock.csv",
      intervalMinutes: 60,
    });
    const shown = (await jobs.scheduleForEdit(shop, s.id, "import"))!.sourceUrl;
    const kept = await jobs.editSchedule(shop, s.id, { name: "Stock", type: "import", config: { options: { defaultCommand: "UPDATE", dryRun: true } }, sourceUrl: shown, intervalMinutes: 60 });
    expect(openSecret(kept.sourceUrl)).toBe("ftp://u:pw@h.example.com/stock.csv");
    expect(JSON.parse(kept.config).options).toEqual({ defaultCommand: "UPDATE", dryRun: true });
    const changed = await jobs.editSchedule(shop, s.id, { name: "", type: "import", config: { options: {} }, sourceUrl: "https://example.com/new.csv", intervalMinutes: 60 });
    expect(openSecret(changed.sourceUrl)).toBe("https://example.com/new.csv");
    expect(changed.name).toBe("Stock");
    await expect(jobs.editSchedule(shop, s.id, { name: "x", type: "import", config: { options: {} }, sourceUrl: "", intervalMinutes: 60 })).rejects.toThrow(/source URL/);
  });

  it("refuses another store's schedule or the wrong kind", async () => {
    const s = await jobs.createSchedule(shop, { name: "Mine", type: "export", config: products, intervalMinutes: 60 });
    const other = "schedule-edit-test-other.myshopify.com";
    expect(await jobs.scheduleForEdit(other, s.id, "export")).toBeNull();
    expect(await jobs.scheduleForEdit(shop, s.id, "import")).toBeNull();
    await expect(jobs.editSchedule(other, s.id, { name: "x", type: "export", config: products, intervalMinutes: 60 })).rejects.toBeInstanceOf(Response);
    await expect(jobs.editSchedule(shop, s.id, { name: "x", type: "import", config: { options: {} }, sourceUrl: "https://e.com/a.csv", intervalMinutes: 60 })).rejects.toThrow(/not an import/);
    expect((await prisma.schedule.findUnique({ where: { id: s.id } }))!.name).toBe("Mine");
  });
});
