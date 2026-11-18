import path from "node:path";
import type { BulkRunner, Gql, Logger, Row } from "../core/types";
import { createCsvOut } from "../core/sheets";
import { getEntity } from "../entities";
import { createChecker, type CheckReport } from "./rules";

/**
 * Runs the product data check: reads every active product (the same data an
 * export would) and tests it against the rules. Nothing is changed. The
 * result file lists each product with a problem and what the problems are.
 */
export async function runCheck(
  deps: { gql: Gql; bulk: BulkRunner; log: Logger; progress: (done: number, total: number) => void; isCancelled: () => Promise<boolean> },
  dir: string,
): Promise<{ resultFile: string; report: CheckReport }> {
  const products = getEntity("products")!;
  const checker = createChecker();
  const flagged: Row[] = [];
  let n = 0;
  deps.log("Checking active products");
  await products.export!(
    {
      gql: deps.gql,
      bulk: deps.bulk,
      // Only what the rules read: no inventory levels or variant metafields.
      options: { groups: ["variants", "images", "seo", "metafields"], filters: [{ field: "status", op: "is", value: "active" }] },
      log: deps.log,
      cache: new Map(),
      progress: () => {},
    },
    async (rows) => {
      const found = checker.add(rows);
      if (found.length && flagged.length < 50_000) flagged.push({ ID: rows[0].ID, Handle: rows[0].Handle ?? "", Title: rows[0].Title ?? "", Problems: found.join("; ") });
      if (++n % 200 === 0) {
        deps.progress(n, 0);
        if (await deps.isCancelled()) throw new Error("Cancelled");
      }
    },
  );
  const report = checker.report();
  deps.log(`${report.products.toLocaleString("en")} products checked: ${report.ready.toLocaleString("en")} have no critical problem (score ${report.score}/100)`);
  const out = createCsvOut(path.join(dir, "Data_check"));
  await out.addSheet("Data check", ["ID", "Handle", "Title", "Problems"], flagged);
  deps.progress(report.products, report.products);
  return { resultFile: await out.close(), report };
}
