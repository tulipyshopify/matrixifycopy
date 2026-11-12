import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runExport } from "../app/lib/core/exporter";
import { createXlsxOut } from "../app/lib/core/sheets";
import type { Entity } from "../app/lib/core/types";
import { jobTiming } from "../app/components/jobs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-progress-"));
const { executeJob } = await import("../app/lib/jobs/runner.server");

const product = (i: number) => ({ id: `gid://shopify/Product/${i}`, handle: `p${i}`, title: `P${i}`, tags: [], options: [], variants: [] });

describe("export progress and time estimate", () => {
  it("reports a percentage across Shopify's preparation and the file writing", async () => {
    const seen: Array<[number, number]> = [];
    const bulkEvents = { onRoots: (_n: number) => {} };
    await executeJob(
      { id: "p1", shop: "t.myshopify.com", type: "export", config: JSON.stringify({ entities: [{ entity: "products", options: { groups: ["variants"] } }] }), format: "csv", name: "", inputFile: null, inputName: null },
      {
        gql: (async () => ({})) as any,
        bulk: async function* () {
          // Shopify prepares 100 root items, then the rows are written.
          for (const n of [25, 50, 100]) bulkEvents.onRoots(n);
          for (let i = 1; i <= 100; i++) yield product(i);
        },
        log: () => {},
        progress: (done, total) => seen.push([done, total]),
        isCancelled: async () => false,
        bulkEvents,
        count: async () => 100,
      },
    );
    expect(seen[0]).toEqual([20, 100]); // 25 prepared = 20% (preparation is 80% of the job)
    expect(seen[2]).toEqual([80, 100]);
    expect(seen.at(-2)).toEqual([99, 100]); // never shows 100% before the file is closed
    expect(seen.at(-1)).toEqual([100, 100]);
    // Progress never goes backwards.
    expect(seen.every(([d], i) => i === 0 || d >= seen[i - 1][0])).toBe(true);
  });

  it("falls back to a plain item counter when the total is unknown", async () => {
    const seen: Array<[number, number]> = [];
    await executeJob(
      { id: "p2", shop: "t.myshopify.com", type: "export", config: JSON.stringify({ entities: [{ entity: "products", options: {} }] }), format: "csv", name: "", inputFile: null, inputName: null },
      { gql: (async () => ({})) as any, bulk: async function* () { yield product(1); yield product(2); }, log: () => {}, progress: (d, t) => seen.push([d, t]), isCancelled: async () => false, count: async () => null },
    );
    expect(seen.slice(0, 2)).toEqual([[1, 0], [2, 0]]);
  });

  it("stops while rows are being written when the job is cancelled", async () => {
    let emitted = 0;
    const entity: Entity = {
      key: "products", sheet: "Products", description: "", columns: ["ID"],
      async export(_ctx, emit) {
        for (let i = 0; i < 1000; i++) { await emit([{ ID: String(i) }]); emitted++; }
      },
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-cancel-"));
    await expect(
      runExport({ gql: (async () => ({})) as any, bulk: async function* () {}, requests: [{ entity, options: {} }], out: createXlsxOut(path.join(dir, "x.xlsx")), tmpDir: dir, log: () => {}, isCancelled: async () => emitted >= 250 }),
    ).rejects.toThrow("Cancelled");
    expect(emitted).toBeLessThan(400);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toEqual([]); // temp rows cleaned up
  });

  it("formats elapsed time and the estimate", () => {
    const now = Date.now();
    expect(jobTiming({ status: "running", progress: 25, total: 100, startedAt: new Date(now - 120_000), finishedAt: null })).toBe("Running for 2 min 0 sec · about 6 min 0 sec left");
    expect(jobTiming({ status: "running", progress: 1, total: 100, startedAt: new Date(now - 120_000), finishedAt: null })).toBe("Running for 2 min 0 sec");
    expect(jobTiming({ status: "finished", progress: 5, total: 5, startedAt: new Date(now - 65_000), finishedAt: new Date(now) })).toBe("Took 1 min 5 sec");
    expect(jobTiming({ status: "queued", progress: 0, total: 0, startedAt: null, finishedAt: null })).toBe("");
  });
});
