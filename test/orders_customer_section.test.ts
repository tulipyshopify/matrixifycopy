import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExportContext, Row } from "../app/lib/core/types";
import { orderToRows, ordersEntity } from "../app/lib/entities/orders";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-history-"));
process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";

const { default: prisma } = await import("../app/db.server");
const jobs = await import("../app/lib/jobs/jobs.server");
const { jobDir } = await import("../app/lib/jobs/storage.server");
const { columnSections } = await import("../app/components/ExportForm");

const address = ["First Name", "Last Name", "Name", "Company", "Phone", "Address 1", "Address 2", "Zip", "City", "Province", "Province Code", "Country", "Country Code"];

describe("Orders: Customer section", () => {
  it("holds customer, billing, shipping and browser columns, 53 in all", () => {
    const orders = jobs.entityCatalog().find((e) => e.key === "orders")!;
    const customer = columnSections(orders).find((s) => s.name === "Customer")!;
    expect(customer.columns).toEqual([
      ...["ID", "Email", "Phone", "First Name", "Last Name", "Note", "State", "Tags", "Email Marketing Status", "SMS Marketing Status", "Tax Exempt", "Orders Count", "Total Spent"].map((c) => `Customer: ${c}`),
      ...address.map((c) => `Billing: ${c}`),
      ...address.map((c) => `Shipping: ${c}`),
      ...["IP", "Width", "Height", "User Agent", "Landing Page", "Referrer", "Referrer Domain", "Search Keywords", "Ad URL", "UTM Source", "UTM Medium", "UTM Campaign", "UTM Term", "UTM Content"].map((c) => `Browser: ${c}`),
    ]);
    expect(customer.columns).toHaveLength(53);
    expect(columnSections(orders).map((s) => s.name)).not.toContain("Browser");
    // Other data types keep their own address sections.
    const drafts = jobs.entityCatalog().find((e) => e.key === "draft_orders")!;
    expect(columnSections(drafts).map((s) => s.name)).toContain("Billing address");
  });

  const visit = { landingPage: "https://shop.test/sale?gclid=abc", referrerUrl: "https://www.google.com/search?q=wheelie+bins", utmParameters: null };
  const order = (id: number) => ({ id: `gid://shopify/Order/${id}`, name: `#${id}`, clientIp: "203.0.113.9", customerJourneySummary: { lastVisit: visit } });

  it("writes search keywords, ad URL and the browser details", () => {
    const row = orderToRows({ ...order(1), clientDetails: { browser_width: 1280, browser_height: 720, user_agent: "Mozilla/5.0" } }, new Set(["browser"]))[0];
    expect(row).toMatchObject({
      "Browser: Width": "1280",
      "Browser: Height": "720",
      "Browser: User Agent": "Mozilla/5.0",
      "Browser: Search Keywords": "wheelie bins",
      "Browser: Ad URL": "https://shop.test/sale?gclid=abc",
    });
    const plain = orderToRows({ ...order(1), customerJourneySummary: { lastVisit: { landingPage: "/", referrerUrl: "https://example.com/" } } }, new Set(["browser"]))[0];
    expect(plain).toMatchObject({ "Browser: Search Keywords": "", "Browser: Ad URL": "", "Browser: Width": "" });
  });

  async function run(options: ExportContext["options"], rest: ExportContext["rest"], count = 3) {
    const rows: Row[] = [];
    const queries: string[] = [];
    const logs: string[] = [];
    const ctx: ExportContext = {
      gql: (async () => ({})) as any,
      bulk: async function* (q: string) {
        queries.push(q);
        for (let i = 1; i <= count; i++) yield order(i);
      },
      rest,
      options,
      log: (m) => logs.push(m),
      cache: new Map(),
      progress: () => {},
    };
    await ordersEntity.export!(ctx, async (r) => void rows.push(...r));
    return { rows, queries, logs };
  }

  it("reads width, height and user agent in batches, only when asked for", async () => {
    const paths: string[] = [];
    const rest = async (p: string) => {
      paths.push(p);
      return { orders: [{ id: 2, client_details: { browser_width: 390, browser_height: 844, user_agent: "iPhone" } }] };
    };
    const all = await run({ v: 2, groups: ["browser"] }, rest, 150);
    expect(paths).toHaveLength(2); // 100 + 50
    expect(paths[0]).toMatch(/^orders\.json\?status=any&limit=250&fields=id,client_details&ids=1,2,3,/);
    expect(all.rows).toHaveLength(150);
    expect(all.rows[1]).toMatchObject({ Name: "#2", "Browser: Width": "390", "Browser: User Agent": "iPhone" });
    expect(all.rows[0]["Browser: Width"]).toBe("");

    paths.length = 0;
    const some = await run({ v: 2, groups: ["browser"], columns: ["Name", "Browser: IP"] }, rest);
    expect(paths).toEqual([]);
    expect(some.rows[0]["Browser: IP"]).toBe("203.0.113.9");

    // Browser switched on but none of its columns chosen: not fetched at all.
    const none = await run({ v: 2, groups: ["browser"], columns: ["Name"] }, rest);
    expect(none.queries[0]).not.toMatch(/customerJourneySummary/);
    expect(none.rows[0]["Browser: IP"]).toBeUndefined();
  });

  it("carries on with empty columns when the store refuses", async () => {
    let calls = 0;
    const r = await run({ v: 2, groups: ["browser"] }, async () => {
      calls++;
      throw new Error("REST 403");
    }, 250);
    expect(calls).toBe(1);
    expect(r.rows).toHaveLength(250);
    expect(r.rows[0]).toMatchObject({ "Browser: Width": "", "Browser: IP": "203.0.113.9" });
    expect(r.logs.join("\n")).toMatch(/could not be read \(REST 403\)/);
  });
});

// Needs the local database (npm run setup); skipped on a fresh checkout without one.
describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("export history", () => {
  const shop = `history-test-${Date.now()}.myshopify.com`;
  const now = new Date("2026-11-13T12:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000);
  afterAll(async () => {
    await prisma.job.deleteMany({ where: { shop } });
  });

  async function job(data: Record<string, any>) {
    const j = await prisma.job.create({ data: { shop, type: "export", config: "{}", status: "finished", ...data } });
    const file = path.join(jobDir(shop, j.id), "out.csv");
    fs.writeFileSync(file, "x");
    return prisma.job.update({ where: { id: j.id }, data: { resultFile: file } });
  }

  it("clears exports after 7 days, with their files", async () => {
    const old = await job({ createdAt: daysAgo(8), finishedAt: daysAgo(8) });
    const recent = await job({ createdAt: daysAgo(6), finishedAt: daysAgo(6) });
    const running = await job({ createdAt: daysAgo(9), status: "running" });
    const oldImport = await job({ createdAt: daysAgo(20), type: "import" });
    // A monthly schedule: its only file is older than a week but still serves the permanent link.
    const scheduledOld = await job({ createdAt: daysAgo(40), finishedAt: daysAgo(40), scheduleId: "sched-" + shop });
    const scheduledNewest = await job({ createdAt: daysAgo(10), finishedAt: daysAgo(10), scheduleId: "sched-" + shop });

    await jobs.clearOldExports(7, now);
    const left = (await prisma.job.findMany({ where: { shop }, select: { id: true } })).map((j) => j.id).sort();
    expect(left).toEqual([recent.id, running.id, oldImport.id, scheduledNewest.id].sort());
    expect(fs.existsSync(jobDir(shop, recent.id))).toBe(true);
    expect(fs.existsSync(path.dirname(old.resultFile!))).toBe(false);
    expect(fs.existsSync(path.dirname(scheduledOld.resultFile!))).toBe(false);
    expect(fs.existsSync(scheduledNewest.resultFile!)).toBe(true);
  });
});
