import { describe, expect, it } from "vitest";
import { BATCH_MIN_ITEMS, planBatch, runBatch, runBulkMutation } from "../app/lib/core/batch";
import { groupRows, runImport } from "../app/lib/core/importer";
import { ENTITIES, getEntity } from "../app/lib/entities";

const orders = getEntity("orders")!;
const COURIER = "Metafield: custom.courier [single_line_text_field]";
const COST = "Metafield: custom.couriercost [number_decimal]";
const rowsOf = (n: number, extra: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => ({ ID: String(1000 + i), [COURIER]: `DX ${i}`, [COST]: i % 10 === 3 ? "" : "4.50", ...extra }));
const itemsOf = (rows: Array<Record<string, string>>) => groupRows(rows, orders.import!.keyColumns);

/** A stand-in for Shopify's bulk operations: records what was sent and answers per line. */
function fakeShopify(answer: (vars: any, line: number, mutation: string) => any = () => undefined, opts: { status?: string; busy?: number } = {}) {
  const ops: Array<{ mutation: string; lines: any[] }> = [];
  const calls: string[] = [];
  let uploaded = "";
  let busy = opts.busy ?? 0;
  const gql = (async (q: string, v: any) => {
    const name = /(?:query|mutation)\s+(\w+)/.exec(q)![1];
    calls.push(name);
    if (name === "BatchStage") {
      expect(v.input[0]).toMatchObject({ resource: "BULK_MUTATION_VARIABLES", mimeType: "text/jsonl", httpMethod: "POST" });
      return { stagedUploadsCreate: { stagedTargets: [{ url: "https://upload.test/", parameters: [{ name: "key", value: `tmp/vars-${ops.length}` }, { name: "policy", value: "p" }] }], userErrors: [] } };
    }
    if (name === "BatchRun") {
      if (busy-- > 0) return { bulkOperationRunMutation: { bulkOperation: null, userErrors: [{ code: "OPERATION_IN_PROGRESS", message: "A bulk mutation operation for this app and shop is already in progress" }] } };
      expect(v.path).toBe(`tmp/vars-${ops.length}`);
      ops.push({ mutation: v.mutation, lines: uploaded.trim().split("\n").map((l) => JSON.parse(l)) });
      return { bulkOperationRunMutation: { bulkOperation: { id: `gid://shopify/BulkOperation/${ops.length}`, status: "CREATED" }, userErrors: [] } };
    }
    if (name === "BatchPoll") return { bulkOperation: { id: v.id, status: opts.status ?? "COMPLETED", errorCode: null, objectCount: "3", url: opts.status ? null : `result:${v.id}`, partialDataUrl: opts.status ? `result:${v.id}` : null } };
    if (name === "BatchCancel") return { bulkOperationCancel: { userErrors: [] } };
    throw new Error(`Unexpected call ${name}`);
  }) as any;
  const io = {
    pollIntervalMs: 1,
    upload: async (_u: string, params: any[], jsonl: string) => {
      expect(params.map((p) => p.name)).toContain("key");
      uploaded = jsonl;
    },
    fetchLines: async function* () {
      const op = ops.at(-1)!;
      const field = /metafieldsDelete/.test(op.mutation) ? "metafieldsDelete" : "metafieldsSet";
      for (let n = 0; n < op.lines.length; n++) {
        const a = answer(op.lines[n], n, field);
        if (a === null) continue; // Shopify reported nothing for this line
        yield JSON.stringify({ data: { [field]: a ?? { userErrors: [] } }, __lineNumber: n });
      }
    },
  };
  return { gql, io, ops, calls };
}

describe("batch mode: what qualifies", () => {
  it("takes a sheet of IDs and metafields, blank cells becoming deletions", () => {
    const plan = planBatch(orders, ["ID", COURIER, COST], itemsOf(rowsOf(60)), "MERGE");
    if ("reason" in plan) throw new Error(plan.reason);
    expect(plan.set).toHaveLength(60);
    expect(plan.set[0]).toEqual({ item: 0, variables: { metafields: [
      { ownerId: "gid://shopify/Order/1000", namespace: "custom", key: "courier", type: "single_line_text_field", value: "DX 0" },
      { ownerId: "gid://shopify/Order/1000", namespace: "custom", key: "couriercost", type: "number_decimal", value: "4.50" },
    ] } });
    // Rows 3, 13, 23… have a blank cost: cleared, as a normal import would.
    expect(plan.del).toHaveLength(6);
    expect(plan.del[0]).toEqual({ item: 3, variables: { metafields: [{ ownerId: "gid://shopify/Order/1003", namespace: "custom", key: "couriercost" }] } });
    expect(plan.set[3].variables.metafields).toHaveLength(1);
  });

  it("says in plain words why a sheet runs the normal way instead", () => {
    const reason = (headers: string[], rows: Array<Record<string, string>>, entity = orders, cmd: any = "MERGE") => (planBatch(entity, headers, itemsOf(rows), cmd) as any).reason as string;
    expect(reason(["ID", "Tags", COURIER], rowsOf(60, { Tags: "x" }))).toMatch(/only writes metafields, and this sheet also has "Tags"/);
    expect(reason(["ID", COURIER], rowsOf(BATCH_MIN_ITEMS - 1))).toMatch(/fewer than 50 rows/);
    expect(reason(["ID"], rowsOf(60).map((r) => ({ ID: r.ID })))).toMatch(/no Metafield columns/);
    expect(reason(["ID", COURIER], rowsOf(60), getEntity("redirects")!)).toMatch(/can't be imported in batch mode/);
    expect(reason(["ID", "Command", COURIER], rowsOf(60).map((r, i) => ({ ...r, Command: i === 7 ? "DELETE" : "" })))).toMatch(/row 9 uses command DELETE/);
    expect(reason(["ID", COURIER], rowsOf(60), orders, "NEW")).toMatch(/command NEW/);
    const twice = rowsOf(60);
    twice[20] = { ...twice[20], ID: twice[5].ID };
    expect(reason(["ID", COURIER], twice)).toMatch(/row 7: the same ID is on more than one row/);
    const bad = rowsOf(60);
    bad[2].ID = "#1003";
    expect(reason(["ID", COURIER], bad)).toMatch(/row 4: Invalid Order ID/);
    // Rows keyed by something other than ID can't be batched.
    const byName = rowsOf(60).map((r, i) => ({ Name: `#${i}`, [COURIER]: r[COURIER] }));
    expect(reason(["Name", COURIER], byName)).toMatch(/also has "Name"/);
  });

  it("knows a Shopify ID type for every data type it accepts", () => {
    for (const e of ENTITIES) {
      const plan = planBatch(e, ["ID", COURIER], groupRows(rowsOf(60), e.import?.keyColumns ?? ["ID"]), "MERGE");
      if (!("reason" in plan)) expect((plan.set[0].variables.metafields as any[])[0].ownerId).toMatch(/^gid:\/\/shopify\/[A-Z]\w+\/1000$/);
    }
  });
});

describe("batch mode: running", () => {
  it("uploads the lines, runs one bulk operation per step and waits for a free slot", async () => {
    const s = fakeShopify(undefined, { busy: 2 });
    const { results, complete } = await runBulkMutation(s.gql, "mutation call { x }", [{ a: 1 }, { a: 2 }], s.io);
    expect(complete).toBe(true);
    expect([...results.keys()]).toEqual([0, 1]);
    expect(s.ops[0].lines).toEqual([{ a: 1 }, { a: 2 }]);
    expect(s.calls.filter((c) => c === "BatchRun")).toHaveLength(3);
  });

  it("reports each row: ok, Shopify's own error, or no answer", async () => {
    const plan = planBatch(orders, ["ID", COURIER, COST], itemsOf(rowsOf(60)), "UPDATE") as any;
    const s = fakeShopify((vars, n, field) => {
      if (field === "metafieldsSet" && n === 4) return { userErrors: [{ field: ["metafields", "0", "ownerId"], message: "Owner does not exist." }] };
      if (field === "metafieldsSet" && n === 9) return null;
      if (field === "metafieldsDelete" && vars.metafields[0].ownerId.endsWith("/1013")) return { userErrors: [{ message: "Access denied" }] };
      return undefined;
    });
    const out = await runBatch(s.gql, plan, s.io);
    expect(out).toHaveLength(60);
    expect(out[0]).toEqual({ status: "OK", command: "UPDATE", message: "Metafields updated (batch mode)" });
    expect(out[4]).toEqual({ status: "Failed", command: "UPDATE", message: "Metafields: Owner does not exist." });
    expect(out[9].status).toBe("Failed");
    expect(out[9].message).toMatch(/no result for this row/);
    expect(out[13]).toMatchObject({ status: "Failed", message: "Metafields: Access denied" });
    expect(out.filter((r) => r.status === "OK")).toHaveLength(57);
    expect(s.ops.map((o) => /metafields(Set|Delete)/.exec(o.mutation)![0])).toEqual(["metafieldsSet", "metafieldsDelete"]);
  });

  it("marks rows without a result as failed when Shopify stops early", async () => {
    const plan = planBatch(orders, ["ID", COURIER], itemsOf(rowsOf(60).map((r) => ({ ID: r.ID, [COURIER]: r[COURIER] }))), "MERGE") as any;
    const s = fakeShopify((_v, n) => (n < 20 ? undefined : null), { status: "FAILED" });
    const logs: string[] = [];
    const out = await runBatch(s.gql, plan, { ...s.io, log: (m) => logs.push(m) });
    expect(out.filter((r) => r.status === "OK")).toHaveLength(20);
    expect(out.filter((r) => r.status === "Failed")).toHaveLength(40);
    expect(logs.join("\n")).toMatch(/stopped the batch early \(failed\)/);
  });

  it("cancels the bulk operation and doesn't claim the rows were written", async () => {
    const plan = planBatch(orders, ["ID", COURIER, COST], itemsOf(rowsOf(60)), "MERGE") as any;
    const s = fakeShopify();
    const out = await runBatch(s.gql, plan, { ...s.io, isCancelled: () => true });
    expect(s.calls).toContain("BatchCancel");
    expect(s.ops).toHaveLength(1); // the delete step never started
    expect(out.every((r) => r.status === "Skipped" && /may already have written/.test(r.message!))).toBe(true);
  });
});

describe("batch mode inside an import", () => {
  const sheet = (rows: Array<Record<string, string>>) => [{ name: "Orders", headers: Object.keys(rows[0]), rows }];
  const run = (rows: Array<Record<string, string>>, options: any, s = fakeShopify()) => {
    const logs: string[] = [];
    const written: any[] = [];
    const progress: number[] = [];
    return runImport({
      ctx: { gql: s.gql, options, log: () => {}, cache: new Map() },
      sheets: sheet(rows),
      entities: ENTITIES,
      log: (m) => logs.push(m),
      progress: (d) => progress.push(d),
      batchIo: s.io,
      out: { addSheet: async (name: string, headers: string[], r: any[]) => void written.push({ name, headers, rows: r }), finish: async () => "" } as any,
    }).then((stats) => ({ stats, logs, written, progress, s }));
  };

  it("imports a qualifying sheet in one bulk operation and writes the usual results file", async () => {
    const s = fakeShopify((_v, n, field) => (field === "metafieldsSet" && n === 2 ? { userErrors: [{ message: "Value must be a decimal." }] } : undefined));
    const r = await run(rowsOf(60), { batch: true }, s);
    expect(r.stats[0]).toMatchObject({ sheet: "Orders", entity: "orders", items: 60, ok: 59, failed: 1, skipped: 0, byCommand: { MERGE: 60 } });
    expect(r.s.calls.filter((c) => c === "BatchRun")).toHaveLength(2);
    expect(r.s.calls.every((c) => c.startsWith("Batch"))).toBe(true); // no per-row calls at all
    expect(r.logs.join("\n")).toMatch(/Batch mode: setting metafields in one Shopify bulk operation \(60 calls\)/);
    expect(r.logs.join("\n")).toMatch(/Row 4 \(ID: 1002\): Metafields: Value must be a decimal\./);
    expect(r.written[0].rows[2]).toMatchObject({ ID: "1002", "Import Result": "Failed", "Import Comment": "Metafields: Value must be a decimal." });
    expect(r.written[0].rows[0]).toMatchObject({ "Import Result": "OK", "Import Comment": "Metafields updated (batch mode)" });
    expect(r.progress.at(-1)).toBe(60);
  });

  it("is opt-in, never used for a preview, and falls back with the reason", async () => {
    const lookups = () => {
      const calls: string[] = [];
      const gql = (async (q: string) => {
        calls.push(/(?:query|mutation)\s+(\w+)/.exec(q)![1]);
        throw new Error("stop here");
      }) as any;
      return { gql, io: {}, calls, ops: [] } as any;
    };
    const off = await run(rowsOf(60), {}, lookups());
    expect(off.s.calls.some((c: string) => c.startsWith("Batch"))).toBe(false);
    expect(off.logs.join("\n")).not.toMatch(/batch mode/i);
    const dry = await run(rowsOf(60), { batch: true, dryRun: true }, lookups());
    expect(dry.s.calls.some((c: string) => c.startsWith("Batch"))).toBe(false);
    const small = await run(rowsOf(5), { batch: true }, lookups());
    expect(small.s.calls.some((c: string) => c.startsWith("Batch"))).toBe(false);
    expect(small.logs.join("\n")).toMatch(/not using batch mode \(fewer than 50 rows/);
    expect(small.stats[0].failed).toBe(5); // ran the normal way (and hit the stand-in's error)
  });
});
