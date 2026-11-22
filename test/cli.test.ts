import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-cli-"));

/**
 * Runs the real command-line file against the real API routes over HTTP. A
 * stand-in for the worker "finishes" jobs so the CLI's waiting can be tested.
 */
describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("command line", async () => {
  const { default: prisma } = await import("../app/db.server");
  const keys = await import("../app/lib/api/keys.server");
  const api = await import("../app/routes/api.v1.$");
  const { jobDir } = await import("../app/lib/jobs/storage.server");
  const shop = `cli-${Date.now()}.myshopify.com`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-cli-home-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-cli-work-"));
  const previewKey = (await keys.createKey(shop, "Preview", false)).key;
  const fullKey = (await keys.createKey(shop, "Full", true)).key;
  let base = "";
  let failNext = false;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, "http://x");
    const request = new Request(`http://x${req.url}`, {
      method: req.method,
      headers: req.headers as any,
      body: req.method === "GET" ? undefined : Buffer.concat(chunks),
    });
    const args = { request, params: { "*": url.pathname.replace(/^\/api\/v1\//, "") }, context: {} } as any;
    const out: Response = await (req.method === "GET" ? api.loader(args) : api.action(args));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  // The stand-in worker.
  const worker = setInterval(async () => {
    for (const job of await prisma.job.findMany({ where: { shop, status: "queued" } })) {
      const dir = jobDir(shop, job.id);
      if (failNext) {
        failNext = false;
        await prisma.job.update({ where: { id: job.id }, data: { status: "failed", error: "Shopify said no", finishedAt: new Date() } });
      } else if (job.type === "export") {
        const file = path.join(dir, "Export_Products.csv");
        fs.writeFileSync(file, "ID,Title\n1,Bin\n");
        await prisma.job.update({ where: { id: job.id }, data: { status: "finished", resultFile: file, stats: '[{"entity":"products","items":1,"rows":1}]', finishedAt: new Date() } });
      } else {
        const dry = JSON.parse(job.config).options.dryRun;
        if (dry) fs.writeFileSync(path.join(dir, "preview.json"), JSON.stringify([{ sheet: "Products", entity: "products", items: [{ row: 2, item: "ID: 1", command: "MERGE", action: "update", message: "", changes: ["tags = Winter sale"] }] }]));
        await prisma.job.update({ where: { id: job.id }, data: { status: "finished", stats: '[{"sheet":"Products","entity":"products","items":2,"ok":1,"failed":1,"skipped":0}]', problems: 1, finishedAt: new Date() } });
      }
    }
  }, 200);

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    clearInterval(worker);
    server.close();
    await prisma.job.deleteMany({ where: { shop } });
    await prisma.apiKey.deleteMany({ where: { shop } });
  });

  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      execFile(process.execPath, [path.resolve("public/cli/bulkport.mjs"), ...args], { cwd: work, env: { PATH: process.env.PATH!, HOME: home, USERPROFILE: home, ...env } }, (e, out, err) =>
        resolve({ code: e ? ((e as any).code ?? 1) : 0, out, err }),
      );
    });

  it("explains itself and refuses to run before login", async () => {
    expect((await run(["help"])).out).toMatch(/bulkport export <sheet>/);
    const r = await run(["jobs"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Not set up yet/);
  });

  it("logs in (checking the key) and keeps the settings private", async () => {
    const bad = await run(["login", base, "bp_" + "x".repeat(43)]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/invalid access key/);
    expect((await run(["login", base, previewKey])).out).toMatch(/Signed in/);
    const file = path.join(home, ".bulkport.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ url: base, key: previewKey });
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("lists sheets and one sheet's columns", async () => {
    expect((await run(["sheets"])).out).toMatch(/Products\s+export, import/);
    const one = await run(["sheets", "orders"]);
    expect(one.out).toMatch(/Columns:/);
    expect(one.out).toMatch(/Filters: .*financial_status/);
  });

  it("exports, waits and saves the file", async () => {
    const r = await run(["export", "Products", "--columns", "ID, Title", "--filter", "vendor is Woven Wood", "--last", "7d", "--limit", "5", "-o", "out.csv"]);
    expect(r.err).toBe("");
    expect(r.out).toMatch(/Export \w+: Finished\n  products: 1 items, 1 rows\nSaved out\.csv/);
    expect(fs.readFileSync(path.join(work, "out.csv"), "utf8")).toBe("ID,Title\n1,Bin\n");
    const job = await prisma.job.findFirstOrThrow({ where: { shop, type: "export" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(job.config).entities[0].options).toMatchObject({
      columns: ["ID", "Title"],
      limit: 5,
      filters: [{ field: "vendor", op: "is", value: "Woven Wood" }],
      dateRange: { field: "created_at", preset: "last_n", amount: 7, unit: "days" },
    });
    expect((await run(["export", "Products", "--filter", "nonsense"])).err).toMatch(/Can't read filter/);
    expect((await run(["export", "Unicorns"])).err).toMatch(/Unknown sheet/);
  });

  it("exits 1 when a job fails", async () => {
    failNext = true;
    const r = await run(["export", "Products"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Failed\n  Shopify said no/);
  });

  it("imports as a preview by default, shows the changes, and exits 2 on problems", async () => {
    fs.writeFileSync(path.join(work, "Products.csv"), "ID,Tags\n1,Winter sale\n2,x\n");
    const r = await run(["import", "Products.csv", "--command", "UPDATE"]);
    expect(r.out).toMatch(/Import preview \w+: Preview: problems/);
    expect(r.out).toMatch(/Products: 2 items, 1 ok, 1 failed, 0 skipped/);
    expect(r.out).toMatch(/row 2 {2}update {2}ID: 1\n {6}tags = Winter sale/);
    expect(r.out).toMatch(/Nothing was changed\. To run it for real: bulkport apply \w+/);
    expect(r.code).toBe(2);
    const job = await prisma.job.findFirstOrThrow({ where: { shop, type: "import" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(job.config).options).toEqual({ dryRun: true, defaultCommand: "UPDATE", blanks: "leave" });
    expect(job.inputName).toBe("Products.csv");

    // The preview-only key can't go further.
    const denied = await run(["apply", job.id]);
    expect(denied.code).toBe(1);
    expect(denied.err).toMatch(/only preview/);
    expect((await run(["import", "Products.csv", "--apply"])).err).toMatch(/only preview/);

    // A key that allows imports can, from the environment (as a scheduled script would).
    const env = { BULKPORT_URL: base, BULKPORT_KEY: fullKey };
    const applied = await run(["apply", job.id, "--json"], env);
    expect(JSON.parse(applied.out)).toMatchObject({ type: "import", preview: false, status: "finished" });
    const real = await run(["import", "Products.csv", "--apply"], env);
    expect(real.out).toMatch(/^Import \w+: Finished with errors/);
    expect(real.out).not.toMatch(/Nothing was changed/);
    expect((await run(["import", "missing.csv"], env)).err).toMatch(/No such file/);
  });

  it("lists jobs and downloads a result again", async () => {
    const jobs = await run(["jobs"]);
    expect(jobs.out.split("\n").length).toBeGreaterThan(3);
    const id = (await prisma.job.findFirstOrThrow({ where: { shop, type: "export", status: "finished" } })).id;
    expect((await run(["download", id])).out).toMatch(/Saved Export_Products\.csv/);
    expect((await run(["status", id])).out).toMatch(/Finished/);
    expect((await run(["frobnicate"])).err).toMatch(/Unknown command/);
  });
});
