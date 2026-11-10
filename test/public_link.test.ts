import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-public-"));
process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_APP_URL = "https://bulk.example.com/";

const { default: prisma } = await import("../app/db.server");
const jobs = await import("../app/lib/jobs/jobs.server");
const { loader } = await import("../app/routes/files.$token");
const { jobDir } = await import("../app/lib/jobs/storage.server");

const shop = `public-link-test-${Date.now()}.myshopify.com`;
const get = (token: string) => loader({ params: { token }, request: new Request("https://x/files/" + token), context: {} } as any) as Promise<Response>;

async function finishedJob(scheduleId: string, name: string, content: string, finishedAt: Date) {
  const job = await prisma.job.create({ data: { shop, type: "export", config: "{}", scheduleId, status: "finished", finishedAt } });
  const file = path.join(jobDir(shop, job.id), name);
  fs.writeFileSync(file, content);
  await prisma.job.update({ where: { id: job.id }, data: { resultFile: file } });
}

afterAll(async () => {
  await prisma.job.deleteMany({ where: { shop } });
  await prisma.schedule.deleteMany({ where: { shop } });
});

// Needs the local database (npm run setup); skipped on a fresh checkout without one.
describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("permanent export link", () => {
  it("serves the newest finished file at a fixed address, and can be reset", async () => {
    const schedule = await jobs.createSchedule(shop, {
      name: "Daily products",
      type: "export",
      config: { entities: [{ entity: "products", options: {} }] },
      format: "csv",
      intervalMinutes: 1440,
    });
    expect(schedule.publicToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const url = jobs.publicFileUrl(schedule)!;
    expect(url).toBe(`https://bulk.example.com/files/${schedule.publicToken}`);
    const token = schedule.publicToken!;

    // Before the first run there is nothing to serve.
    expect((await get(token)).status).toBe(404);

    await finishedJob(schedule.id, "Export_20261109_030000.csv", "Handle\nold\n", new Date("2026-11-09T03:00:00Z"));
    let res = await get(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Handle\nold\n");
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    // Stable file name without a timestamp.
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Daily_products.csv"');

    // A newer run replaces what the same link serves; ".csv" suffix is accepted.
    await finishedJob(schedule.id, "Export_20261110_030000.csv", "Handle\nnew\n", new Date("2026-11-10T03:00:00Z"));
    res = await get(`${token}.csv`);
    expect(await res.text()).toBe("Handle\nnew\n");

    // Failed or running jobs never replace the file.
    await prisma.job.create({ data: { shop, type: "export", config: "{}", scheduleId: schedule.id, status: "failed", finishedAt: new Date() } });
    expect(await (await get(token)).text()).toBe("Handle\nnew\n");

    // Resetting the link revokes the old address.
    await jobs.resetPublicToken(shop, schedule.id);
    expect((await get(token)).status).toBe(404);
    const fresh = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    expect(fresh!.publicToken).not.toBe(token);
    expect((await get(fresh!.publicToken!)).status).toBe(200);
  });

  it("rejects unknown and malformed tokens; import schedules get no link", async () => {
    expect((await get("short")).status).toBe(404);
    expect((await get("../../etc/passwd")).status).toBe(404);
    expect((await get("A".repeat(32))).status).toBe(404);
    const imp = await jobs.createSchedule(shop, { name: "imp", type: "import", config: { options: {} }, sourceUrl: "https://example.com/a.csv", intervalMinutes: 60 });
    expect(imp.publicToken).toBeNull();
    expect(jobs.publicFileUrl(imp)).toBeNull();
  });
});
