import { describe, expect, it } from "vitest";
import { importDiscount } from "../app/lib/entities/discounts";
import type { Row } from "../app/lib/core/types";
import { hasSchema, variableErrors } from "./_variables";

/** Runs an import against an empty store and returns each mutation with its schema problems. */
async function create(rows: Row[]) {
  const sent: Array<{ op: string; vars: any; problems: string[] }> = [];
  const gql = async (q: string, v: any = {}) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(q)![1];
    if (!/^\s*(#graphql\s*)?mutation/.test(q)) {
      // Nothing exists yet: every lookup comes back empty.
      return new Proxy({}, { get: () => (/Code/.test(op) ? null : { nodes: [], edges: [], pageInfo: { hasNextPage: false } }) });
    }
    sent.push({ op, vars: v, problems: variableErrors(q, v) });
    return new Proxy({}, { get: () => ({ userErrors: [], codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" }, automaticDiscountNode: { id: "gid://shopify/DiscountAutomaticNode/1" } }) });
  };
  const result = await importDiscount({ gql: gql as any, options: {}, log: () => {}, cache: new Map() }, rows, "MERGE");
  return { result, sent };
}

describe.skipIf(!hasSchema)("discount imports send inputs Shopify's schema accepts", () => {
  const layouts: Record<string, Row[]> = {
    "code, percentage": [{ Title: "T1", Method: "Code", Type: "Basic", Code: "SAVE10", "Value Type": "percentage", Value: "10", "Starts At": "2026-11-12T00:00:00Z" }],
    "code, minimal columns": [{ Title: "T2", Code: "SAVE5", Value: "5" }],
    "code, fixed amount": [{ Title: "T3", Method: "Code", Type: "Basic", Code: "FIVEOFF", "Value Type": "fixed_amount", Value: "5" }],
    "automatic, percentage": [{ Title: "T4", Method: "Automatic", Type: "Basic", "Value Type": "percentage", Value: "15" }],
    "code, free shipping": [{ Title: "T5", Method: "Code", Type: "FreeShipping", Code: "SHIPFREE" }],
    "code with dates and two codes": [
      { Title: "T6", Code: "D1", Value: "10", "Starts At": "2026-11-12", "Ends At": "2026-12-01" },
      { Title: "", Code: "", "Additional Code": "D2" },
    ],
  };
  for (const [name, rows] of Object.entries(layouts)) {
    it(name, async () => {
      const { result, sent } = await create(rows);
      expect(result).toMatchObject({ status: "OK" });
      expect(sent.length).toBeGreaterThan(0);
      for (const m of sent) expect(m.problems, `${m.op} ${JSON.stringify(m.vars)}`).toEqual([]);
      // New discounts always say who they apply to.
      expect(sent[0].vars.input.context).toEqual({ all: "ALL" });
    });
  }
});
