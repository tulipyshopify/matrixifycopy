import type { Entity, ExportContext, Row } from "../core/types";
import { boolCell, gidToId } from "../core/util";

/**
 * Shopify Payments payouts (export only). One payout per item: payout fields
 * on the top row, then one balance transaction per row ("Transaction: ..."
 * columns) when the "transactions" group is selected.
 *
 * Payouts are not available to bulk operations (shopifyPaymentsAccount is not
 * a connection and payouts have no link to their transactions), so this uses
 * paginated queries: payouts first, then one scan of the account's balance
 * transactions sorted by payout date, matched to payouts by
 * associatedPayout.id.
 */

// --- Columns --------------------------------------------------------------------

const PAYOUT_COLUMNS = [
  "ID",
  "Status",
  "Issued At",
  "Transaction Type",
  "Net",
  "Currency",
  "Charges Gross",
  "Charges Fee",
  "Refunds Gross",
  "Refunds Fee",
  "Adjustments Gross",
  "Adjustments Fee",
  "Reserved Funds Gross",
  "Reserved Funds Fee",
  "Retried Payouts Gross",
  "Retried Payouts Fee",
  "Advance Gross",
  "Advance Fees",
  "External Trace ID",
  "Row #",
  "Top Row",
];

const TRANSACTION_COLUMNS = [
  "Transaction: ID",
  "Transaction: Type",
  "Transaction: Date",
  "Transaction: Amount",
  "Transaction: Fee",
  "Transaction: Net",
  "Transaction: Currency",
  "Transaction: Order ID",
  "Transaction: Order Name",
  "Transaction: Source Type",
  "Transaction: Source ID",
  "Transaction: Adjustment Reason",
  "Transaction: Test",
];

/** Summary field -> column. */
const SUMMARY: Array<[string, string]> = [
  ["chargesGross", "Charges Gross"],
  ["chargesFee", "Charges Fee"],
  ["refundsFeeGross", "Refunds Gross"],
  ["refundsFee", "Refunds Fee"],
  ["adjustmentsGross", "Adjustments Gross"],
  ["adjustmentsFee", "Adjustments Fee"],
  ["reservedFundsGross", "Reserved Funds Gross"],
  ["reservedFundsFee", "Reserved Funds Fee"],
  ["retriedPayoutsGross", "Retried Payouts Gross"],
  ["retriedPayoutsFee", "Retried Payouts Fee"],
  ["advanceGross", "Advance Gross"],
  ["advanceFees", "Advance Fees"],
];

// --- Queries ---------------------------------------------------------------------

const PAYOUTS = `#graphql
  query ExportPayouts($after: String, $query: String) {
    shopifyPaymentsAccount {
      id
      payouts(first: 100, after: $after, query: $query, sortKey: ISSUED_AT, reverse: true) {
        nodes {
          id status issuedAt transactionType externalTraceId
          net { amount currencyCode }
          summary {
            chargesGross { amount } chargesFee { amount }
            refundsFeeGross { amount } refundsFee { amount }
            adjustmentsGross { amount } adjustmentsFee { amount }
            reservedFundsGross { amount } reservedFundsFee { amount }
            retriedPayoutsGross { amount } retriedPayoutsFee { amount }
            advanceGross { amount } advanceFees { amount }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const BALANCE_TRANSACTIONS = `#graphql
  query ExportPayoutTransactions($after: String) {
    shopifyPaymentsAccount {
      balanceTransactions(first: 250, after: $after, sortKey: PAYOUT_DATE, reverse: true) {
        nodes {
          id type test transactionDate sourceType sourceId adjustmentReason
          amount { amount currencyCode }
          fee { amount }
          net { amount }
          associatedOrder { id name }
          associatedPayout { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// --- Rows --------------------------------------------------------------------------

export function payoutToRows(p: any, transactions: any[] = []): Row[] {
  const count = Math.max(1, transactions.length);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const row: Row = { ID: gidToId(p.id), "Row #": String(i + 1), "Top Row": boolCell(i === 0) };
    if (i === 0) {
      Object.assign(row, {
        Status: (p.status ?? "").toLowerCase(),
        "Issued At": p.issuedAt ?? "",
        "Transaction Type": (p.transactionType ?? "").toLowerCase(),
        Net: p.net?.amount ?? "",
        Currency: p.net?.currencyCode ?? "",
        "External Trace ID": p.externalTraceId ?? "",
      });
      for (const [field, col] of SUMMARY) row[col] = p.summary?.[field]?.amount ?? "";
    }
    const t = transactions[i];
    if (t) {
      Object.assign(row, {
        "Transaction: ID": gidToId(t.id),
        "Transaction: Type": (t.type ?? "").toLowerCase(),
        "Transaction: Date": t.transactionDate ?? "",
        "Transaction: Amount": t.amount?.amount ?? "",
        "Transaction: Fee": t.fee?.amount ?? "",
        "Transaction: Net": t.net?.amount ?? "",
        "Transaction: Currency": t.amount?.currencyCode ?? "",
        "Transaction: Order ID": gidToId(t.associatedOrder?.id),
        "Transaction: Order Name": t.associatedOrder?.name ?? "",
        "Transaction: Source Type": (t.sourceType ?? "").toLowerCase(),
        "Transaction: Source ID": t.sourceId == null ? "" : String(t.sourceId),
        "Transaction: Adjustment Reason": t.adjustmentReason ?? "",
        "Transaction: Test": boolCell(t.test),
      });
    }
    rows.push(row);
  }
  return rows;
}

// --- Export -------------------------------------------------------------------------

/** Balance transactions may be dated well before the payout that settles them. */
const TRANSACTION_LOOKBACK_MS = 45 * 24 * 3600 * 1000;

async function exportPayouts(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? payoutsEntity.groups!.filter((g) => g.default).map((g) => g.key));
  const { createdAfter, createdBefore, limit } = ctx.options;
  const query = ctx.options.query?.trim() || null;

  // 1. Payouts, newest first. Created At filters apply to the issue date.
  const payouts: any[] = [];
  let after: string | null = null;
  outer: do {
    const data: any = await ctx.gql(PAYOUTS, { after, query });
    const account = data.shopifyPaymentsAccount;
    if (!account) {
      ctx.log("Shopify Payments is not enabled on this store: no payouts to export");
      return;
    }
    for (const p of account.payouts.nodes) {
      const issued = Date.parse(p.issuedAt);
      if (createdBefore && issued > Date.parse(createdBefore)) continue;
      if (createdAfter && issued < Date.parse(createdAfter)) break outer; // sorted newest first
      payouts.push(p);
      if (limit && payouts.length >= limit) break outer;
    }
    after = account.payouts.pageInfo.hasNextPage ? account.payouts.pageInfo.endCursor : null;
  } while (after);
  ctx.log(`${payouts.length} payouts found`);

  // 2. Balance transactions, matched to the payouts above.
  const byPayout = new Map<string, any[]>(payouts.map((p) => [p.id, []]));
  if (groups.has("transactions") && payouts.length) {
    const oldest = Math.min(...payouts.map((p) => Date.parse(p.issuedAt)));
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const data: any = await ctx.gql(BALANCE_TRANSACTIONS, { after: cursor });
      const conn = data.shopifyPaymentsAccount?.balanceTransactions;
      if (!conn) break;
      let matched = 0;
      let allTooOld = conn.nodes.length > 0;
      for (const t of conn.nodes) {
        const list = byPayout.get(t.associatedPayout?.id);
        if (list) {
          list.push(t);
          seen.add(t.associatedPayout.id);
          matched++;
        }
        if (Date.parse(t.transactionDate) >= oldest - TRANSACTION_LOOKBACK_MS) allTooOld = false;
      }
      // Sorted by payout date: once every payout was seen and a page has no
      // matches (or everything is far older than the oldest payout), stop.
      if ((seen.size === byPayout.size && matched === 0) || allTooOld) break;
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
  }

  let n = 0;
  for (const p of payouts) {
    await emit(payoutToRows(p, byPayout.get(p.id)));
    ctx.progress(++n);
  }
}

export const payoutsEntity: Entity = {
  key: "payouts",
  sheet: "Payouts",
  aliases: ["payout", "shopify payments payouts"],
  description: "Shopify Payments payouts with their summary and balance transactions (export only).",
  columns: [...PAYOUT_COLUMNS, ...TRANSACTION_COLUMNS],
  supportsQuery: true,
  groups: [{ key: "transactions", label: "Balance transactions", default: true }],
  export: exportPayouts,
};
