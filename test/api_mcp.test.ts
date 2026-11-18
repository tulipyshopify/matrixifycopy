import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-api-"));
process.env.API_RATE_LIMIT = "1000";

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("API and MCP server", async () => {
  const { default: prisma } = await import("../app/db.server");
  const keys = await import("../app/lib/api/keys.server");
  const api = await import("../app/routes/api.v1.$");
  const { handleMcp, TOOLS } = await import("../app/lib/api/mcp.server");
  const { jobDir } = await import("../app/lib/jobs/storage.server");
  const shop = `api-${Date.now()}.myshopify.com`;
  const other = `api-other-${Date.now()}.myshopify.com`;
  afterAll(async () => {
    for (const s of [shop, other]) {
      await prisma.job.deleteMany({ where: { shop: s } });
      await prisma.schedule.deleteMany({ where: { shop: s } });
      await prisma.apiKey.deleteMany({ where: { shop: s } });
    }
  });

  const preview = await keys.createKey(shop, "Claude", false);
  const full = await keys.createKey(shop, "CLI on my laptop", true);
  const foreign = await keys.createKey(other, "Other store", true);

  const call = async (method: string, p: string, key: string | null, body?: unknown, form?: FormData) => {
    const headers: Record<string, string> = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body) headers["Content-Type"] = "application/json";
    const request = new Request(`https://app.test/api/v1/${p}`, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
    const args = { request, params: { "*": p.split("?")[0] }, context: {} } as any;
    const res: Response = await (method === "GET" ? api.loader(args) : api.action(args));
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text(), res };
  };

  it("stores only a hash and shows the key once", async () => {
    expect(preview.key).toMatch(/^bp_[\w-]{43}$/);
    const rows = await prisma.apiKey.findMany({ where: { shop } });
    expect(JSON.stringify(rows)).not.toContain(preview.key);
    expect(rows.find((r) => r.id === preview.row.id)).toMatchObject({ prefix: preview.key.slice(0, 9), canImport: false, name: "Claude" });
    await expect(keys.createKey(shop, "  ", false)).rejects.toThrow(/name/);
  });

  it("refuses requests without a valid key", async () => {
    expect((await call("GET", "jobs", null)).status).toBe(401);
    expect((await call("GET", "jobs", "bp_" + "x".repeat(43))).status).toBe(401);
    expect((await call("POST", "exports", null, { sheets: [{ sheet: "Products" }] })).status).toBe(401);
    const gone = await keys.createKey(shop, "Old", true);
    await keys.revokeKey(shop, gone.row.id);
    expect((await call("GET", "jobs", gone.key)).status).toBe(401);
    // Revoking is per store: another store can't revoke this one's key.
    await keys.revokeKey(other, preview.row.id);
    expect((await call("GET", "jobs", preview.key)).status).toBe(200);
  });

  it("describes sheets, columns and filters", async () => {
    const list = await call("GET", "sheets", preview.key);
    expect(list.body.sheets.find((s: any) => s.sheet === "Products")).toMatchObject({ can_export: true, can_import: true });
    const one = await call("GET", "sheets/products", preview.key);
    expect(one.body.columns).toContain("Title");
    expect(one.body.filters.map((f: any) => f.field)).toContain("vendor");
    expect((await call("GET", "sheets/nonsense", preview.key)).status).toBe(400);
  });

  it("starts an export with columns and filters checked", async () => {
    const r = await call("POST", "exports", preview.key, {
      sheets: [{ sheet: "Products", columns: ["ID", "Title", "Not a column"], filters: [{ field: "vendor", op: "is", value: "Woven Wood" }], limit: 5 }],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: "export", status: "queued", preview: false, result_url: null });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(job).toMatchObject({ shop, format: "csv", name: "Via Claude" });
    expect(JSON.parse(job.config).entities[0]).toMatchObject({ entity: "products", options: { columns: ["ID", "Title"], limit: 5, filters: [{ field: "vendor", op: "is", value: "Woven Wood" }] } });
    expect((await call("POST", "exports", preview.key, { sheets: [{ sheet: "Products", filters: [{ field: "nope", op: "is", value: "x" }] }] })).status).toBe(400);
    expect((await call("POST", "exports", preview.key, {})).status).toBe(400);
  });

  it("makes every import a preview unless the key allows imports and asks for it", async () => {
    const csv = "ID,Tags\n1,Winter sale\n";
    const a = await call("POST", "imports", preview.key, { csv, file_name: "Products" });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ type: "import", preview: true, status: "queued" });
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: a.body.id } });
    expect(JSON.parse(stored.config).options).toEqual({ dryRun: true });
    expect(stored.inputName).toBe("Products.csv");
    expect(fs.readFileSync(stored.inputFile!, "utf8")).toBe(csv);

    // A preview-only key can't run for real, by either route.
    const denied = await call("POST", "imports", preview.key, { csv, file_name: "Products.csv", apply: true });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/only preview/);
    await prisma.job.update({ where: { id: a.body.id }, data: { status: "finished" } });
    expect((await call("POST", `jobs/${a.body.id}/apply`, preview.key)).status).toBe(403);

    // A full key previews by default too…
    const form = new FormData();
    form.set("file", new File([csv], "Products.csv"));
    form.set("command", "update");
    const b = await call("POST", "imports", full.key, undefined, form);
    expect(b.body.preview).toBe(true);
    expect(JSON.parse((await prisma.job.findUniqueOrThrow({ where: { id: b.body.id } })).config).options).toEqual({ dryRun: true, defaultCommand: "UPDATE" });
    // …and can apply a finished preview, or ask for a real run outright.
    const applied = await call("POST", `jobs/${a.body.id}/apply`, full.key);
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({ type: "import", preview: false });
    const real = await call("POST", "imports", full.key, { csv, file_name: "Products.csv", apply: true });
    expect(real.body.preview).toBe(false);
    expect((await call("POST", `jobs/${b.body.id}/apply`, full.key)).status).toBe(409); // not finished yet

    expect((await call("POST", "imports", full.key, { csv: "x", file_name: "a.pdf.csv", command: "EXPLODE" })).status).toBe(400);
    expect((await call("POST", "imports", full.key, { url: "file:///etc/passwd" })).status).toBe(400);
    const link = await call("POST", "imports", full.key, { url: "sftp://u:p@files.example.com/Products.csv" });
    expect(link.body).toMatchObject({ preview: true });
    expect(JSON.stringify(link.body)).not.toContain("u:p@");
  });

  it("keeps stores apart and serves the result file", async () => {
    const mine = await prisma.job.create({ data: { shop, type: "export", status: "finished", config: "{}", format: "csv", stats: '[{"entity":"products","items":2,"rows":2}]' } });
    const file = path.join(jobDir(shop, mine.id), "Export.csv");
    fs.writeFileSync(file, "ID,Title\n1,Bin\n2,Panel\n");
    await prisma.job.update({ where: { id: mine.id }, data: { resultFile: file } });
    const got = await call("GET", `jobs/${mine.id}`, preview.key);
    expect(got.body).toMatchObject({ status: "finished", outcome: "Finished", sheets: [{ entity: "products", items: 2 }] });
    expect(got.body.result_url).toMatch(/\/download\//);
    const dl = await call("GET", `jobs/${mine.id}/result`, preview.key);
    expect(dl.body).toBe("ID,Title\n1,Bin\n2,Panel\n");
    expect(dl.res.headers.get("content-disposition")).toContain("Export.csv");
    for (const p of [`jobs/${mine.id}`, `jobs/${mine.id}/result`, `jobs/${mine.id}/preview`]) {
      expect((await call("GET", p, foreign.key)).status, p).toBe(404);
    }
    expect((await call("POST", `jobs/${mine.id}/cancel`, foreign.key)).status).toBe(404);
    expect((await call("GET", "jobs", foreign.key)).body.jobs).toEqual([]);
    expect((await call("GET", "jobs?limit=2", preview.key)).body.jobs).toHaveLength(2);
    // Checks and backups are not jobs of the API.
    const check = await prisma.job.create({ data: { shop, type: "export", kind: "check", status: "finished", config: "{}" } });
    expect((await call("GET", `jobs/${check.id}`, preview.key)).status).toBe(404);

    // MCP read_result returns rows as data.
    const rows = await mcp(preview.key, "tools/call", { name: "read_result", arguments: { job_id: mine.id, rows: 1 } });
    expect(JSON.parse(rows.result.content[0].text).sheets[0]).toMatchObject({ columns: ["ID", "Title"], total_rows: 2, rows: [{ ID: "1", Title: "Bin" }] });
  });

  let n = 0;
  async function mcp(key: string | null, method: string, params?: unknown, viaPath = false) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (key && !viaPath) headers.Authorization = `Bearer ${key}`;
    const res = await handleMcp(new Request("https://app.test/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }), viaPath ? (key ?? "") : undefined);
    const body = res.status === 202 ? null : await res.json();
    return { status: res.status, ...(body ?? {}) } as any;
  }

  it("speaks MCP: initialize, list tools, notifications", async () => {
    const init = await mcp(preview.key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bulkport" } });
    expect(init.result.instructions).toMatch(/never changes the store/i);
    expect((await mcp(preview.key, "initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-11-25");
    const list = await mcp(preview.key, "tools/list", undefined, true);
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["list_sheets", "start_export", "preview_import", "get_job", "list_jobs", "get_preview", "read_result", "cancel_job"]);
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe("object");
    const note = await handleMcp(new Request("https://app.test/mcp", { method: "POST", headers: { Authorization: `Bearer ${preview.key}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
    expect(note.status).toBe(202);
    expect((await handleMcp(new Request("https://app.test/mcp", { method: "GET" }))).status).toBe(405);
    expect((await mcp(null, "tools/list")).status).toBe(401);
    expect((await mcp("bp_wrong", "tools/list", undefined, true)).status).toBe(401);
    expect((await mcp(preview.key, "nope")).error.code).toBe(-32601);
  });

  it("has no MCP tool that changes the store, even with a key that allows imports", async () => {
    expect(TOOLS.map((t) => t.name).filter((x) => /apply|import/.test(x))).toEqual(["preview_import"]);
    const r = await mcp(full.key, "tools/call", { name: "preview_import", arguments: { csv: "ID,Tags\n1,x\n", file_name: "Products.csv", apply: true } });
    const job = JSON.parse(r.result.content[0].text);
    expect(job.preview).toBe(true);
    expect(JSON.parse((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).config).options.dryRun).toBe(true);
    const exp = await mcp(full.key, "tools/call", { name: "start_export", arguments: { sheets: [{ sheet: "Orders", dateRange: { field: "created_at", preset: "last_n", amount: 2, unit: "days" } }], format: "xlsx" } });
    expect(JSON.parse(exp.result.content[0].text)).toMatchObject({ type: "export", status: "queued" });
    const bad = await mcp(full.key, "tools/call", { name: "start_export", arguments: { sheets: [{ sheet: "Unicorns" }] } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/Unknown sheet/);
    const got = await mcp(full.key, "tools/call", { name: "get_job", arguments: { job_id: job.id, wait_seconds: 0 } });
    expect(JSON.parse(got.result.content[0].text).id).toBe(job.id);
    expect((await mcp(full.key, "tools/call", { name: "launch" })).error.code).toBe(-32602);
  });

  it("limits how fast one key can call", async () => {
    const k = await keys.createKey(shop, "Busy", false);
    const t = Date.now() + 10 * 60_000;
    for (let i = 0; i < 1000; i++) await keys.checkKey(k.key, t);
    await expect(keys.checkKey(k.key, t)).rejects.toMatchObject({ status: 429 });
    await expect(keys.checkKey(k.key, t + 61_000)).resolves.toMatchObject({ shop });
  });
});
