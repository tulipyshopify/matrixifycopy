import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import type { ExportContext, Row } from "../app/lib/core/types";
import { payoutToRows, payoutsEntity } from "../app/lib/entities/payouts";

type Handler = (vars: any) => any;

function mockGql(handlers: Record<string, Handler>) {
  const calls: Array<{ op: string; vars: any; query: string }> = [];
  const gql = async (query: string, vars: any = {}) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    calls.push({ op, vars, query });
    const h = handlers[op];
    if (!h) throw new Error(`Unexpected operation ${op}`);
    return h(vars);
  };
  return { gql: gql as any, calls, ops: () => calls.map((c) => c.op) };
}

const money = (amount: string) => ({ amount, currencyCode: "USD" });
const summary = Object.fromEntries(
  [
    "chargesGross", "chargesFee", "refundsFeeGross", "refundsFee", "adjustmentsGross", "adjustmentsFee",
    "reservedFundsGross", "reservedFundsFee", "retriedPayoutsGross", "retriedPayoutsFee", "advanceGross", "advanceFees",
  ].map((k, i) => [k, { amount: `${i}.00` }]),
);

const payout = (id: number, issuedAt: string) => ({
  id: `gid://shopify/ShopifyPaymentsPayout/${id}`,
  status: "PAID",
  issuedAt,
  transactionType: "DEPOSIT",
  externalTraceId: null,
  net: money(`${id}00.00`),
  summary,
});

const txn = (id: number, payoutId: number | null, date: string) => ({
  id: `gid://shopify/ShopifyPaymentsBalanceTransaction/${id}`,
  type: "CHARGE",
  test: false,
  transactionDate: date,
  sourceType: "CHARGE",
  sourceId: 9000 + id,
  adjustmentReason: null,
  amount: money("50.00"),
  fee: { amount: "1.75" },
  net: { amount: "48.25" },
  associatedOrder: { id: "gid://shopify/Order/1001", name: "#1001" },
  associatedPayout: { id: payoutId ? `gid://shopify/ShopifyPaymentsPayout/${payoutId}` : null },
});

function exportCtx(gql: any, options: ExportContext["options"] = {}) {
  const logs: string[] = [];
  const bulkQueries: string[] = [];
  const ctx: ExportContext = {
    gql,
    bulk: (q) => {
      bulkQueries.push(q);
      return (async function* () {})();
    },
    options,
    log: (m) => logs.push(m),
    cache: new Map(),
    progress: () => {},
  };
  return { ctx, logs, bulkQueries };
}

describe("payouts export", () => {
  it("maps a payout and its transactions to rows", () => {
    const rows = payoutToRows(payout(1, "2026-10-01T00:00:00Z"), [txn(1, 1, "2026-09-29T00:00:00Z"), txn(2, 1, "2026-09-30T00:00:00Z")]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ID: "1",
      Status: "paid",
      "Issued At": "2026-10-01T00:00:00Z",
      "Transaction Type": "deposit",
      Net: "100.00",
      Currency: "USD",
      "Charges Gross": "0.00",
      "Charges Fee": "1.00",
      "Refunds Gross": "2.00",
      "Advance Fees": "11.00",
      "Transaction: ID": "1",
      "Transaction: Type": "charge",
      "Transaction: Amount": "50.00",
      "Transaction: Fee": "1.75",
      "Transaction: Net": "48.25",
      "Transaction: Order ID": "1001",
      "Transaction: Order Name": "#1001",
      "Transaction: Source ID": "9001",
      "Transaction: Test": "FALSE",
    });
    expect(rows[1]).toMatchObject({ ID: "1", "Top Row": "FALSE", "Transaction: ID": "2" });
    expect(rows[1].Status).toBeUndefined();
  });

  it("pages payouts and matches balance transactions by payout", async () => {
    const m = mockGql({
      ExportPayouts: (v) =>
        v.after
          ? { shopifyPaymentsAccount: { id: "a", payouts: { nodes: [payout(1, "2026-09-01T00:00:00Z")], pageInfo: { hasNextPage: false, endCursor: null } } } }
          : { shopifyPaymentsAccount: { id: "a", payouts: { nodes: [payout(2, "2026-10-01T00:00:00Z")], pageInfo: { hasNextPage: true, endCursor: "c1" } } } },
      ExportPayoutTransactions: (v) => {
        const pages: Record<string, any> = {
          start: { nodes: [txn(10, null, "2026-10-20T00:00:00Z"), txn(11, 2, "2026-09-30T00:00:00Z")], next: "t1" },
          t1: { nodes: [txn(12, 1, "2026-08-30T00:00:00Z"), txn(13, 2, "2026-09-29T00:00:00Z")], next: "t2" },
          t2: { nodes: [txn(14, 99, "2026-08-01T00:00:00Z")], next: "t3" },
          t3: { nodes: [txn(15, 98, "2026-07-01T00:00:00Z")], next: null },
        };
        const p = pages[v.after ?? "start"];
        return { shopifyPaymentsAccount: { balanceTransactions: { nodes: p.nodes, pageInfo: { hasNextPage: !!p.next, endCursor: p.next } } } };
      },
    });
    const { ctx } = exportCtx(m.gql, { query: "status:paid" });
    const out: Row[][] = [];
    await payoutsEntity.export!(ctx, async (rows) => {
      out.push(rows);
    });
    expect(m.calls[0].vars).toEqual({ after: null, query: "status:paid" });
    // Stops after the first page without matches once every payout was seen.
    expect(m.ops()).toEqual(["ExportPayouts", "ExportPayouts", "ExportPayoutTransactions", "ExportPayoutTransactions", "ExportPayoutTransactions"]);
    expect(out.map((rows) => rows.map((r) => r["Transaction: ID"]))).toEqual([
      ["11", "13"],
      ["12"],
    ]);
  });

  it("applies date filters and limit, and skips transactions when the group is off", async () => {
    const m = mockGql({
      ExportPayouts: () => ({
        shopifyPaymentsAccount: {
          id: "a",
          payouts: {
            nodes: [payout(3, "2026-10-20T00:00:00Z"), payout(2, "2026-10-10T00:00:00Z"), payout(1, "2026-09-01T00:00:00Z")],
            pageInfo: { hasNextPage: true, endCursor: "x" },
          },
        },
      }),
    });
    const { ctx } = exportCtx(m.gql, { groups: [], createdBefore: "2026-10-15", createdAfter: "2026-10-01" });
    const out: Row[][] = [];
    await payoutsEntity.export!(ctx, async (rows) => {
      out.push(rows);
    });
    expect(out.map((r) => r[0].ID)).toEqual(["2"]);
    expect(m.ops()).toEqual(["ExportPayouts"]);
  });

  it("logs and exports nothing without Shopify Payments", async () => {
    const m = mockGql({ ExportPayouts: () => ({ shopifyPaymentsAccount: null }) });
    const { ctx, logs } = exportCtx(m.gql);
    const out: Row[][] = [];
    await payoutsEntity.export!(ctx, async (rows) => {
      out.push(rows);
    });
    expect(out).toEqual([]);
    expect(logs.join("\n")).toMatch(/Shopify Payments is not enabled/);
  });

  it("is export-only", () => {
    expect(payoutsEntity.import).toBeUndefined();
  });

  const SCHEMA_FILE = path.resolve(".cache/schema/admin_2026-10.json.gz");
  it.skipIf(!fs.existsSync(SCHEMA_FILE))("export queries match the Admin API schema", async () => {
    const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString("utf8"));
    const schema = buildClientSchema(json.data ?? json);
    // Same harness as test/schema.test.ts: the bulk runner records queries,
    // here gql also records the paginated queries (payouts do not use bulk).
    const sent: string[] = [];
    const gql = async (q: string, v: any) => {
      sent.push(q);
      if (q.includes("ExportPayouts")) {
        return { shopifyPaymentsAccount: { id: "a", payouts: { nodes: [payout(1, "2026-10-01T00:00:00Z")], pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      void v;
      return { shopifyPaymentsAccount: { balanceTransactions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    };
    const { ctx, bulkQueries } = exportCtx(gql as any, {
      groups: payoutsEntity.groups?.map((g) => g.key),
      query: "title:x",
      updatedAfter: "2026-01-01",
    });
    await payoutsEntity.export!(ctx, async () => {});
    expect(sent.length).toBe(2);
    for (const q of [...bulkQueries, ...sent]) {
      expect(validate(schema, parse(q)).map((e) => e.message), q).toEqual([]);
    }
  });
});
