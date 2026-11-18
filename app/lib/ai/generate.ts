import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import type { BulkRunner, ExportOptions, Gql, Logger } from "../core/types";
import { getEntity } from "../entities";
import { changeColumns, type ChangeSpec } from "./changes";

/** Most items one generated change may touch. */
export const MAX_GENERATED_ITEMS = 20_000;

export interface GenerateSpec {
  entity: string;
  options: ExportOptions;
  changes: ChangeSpec[];
  /** What was asked, for the log. */
  prompt?: string;
}

/**
 * Builds the import file for a change: finds every item the filters match
 * (an export of their IDs) and writes one row per item with the new values.
 * The file then goes through the normal import, preview first.
 */
export async function generateChangeFile(
  spec: GenerateSpec,
  deps: { gql: Gql; bulk: BulkRunner; log: Logger; timezone?: string; isCancelled?: () => Promise<boolean> },
  dir: string,
): Promise<{ file: string; name: string; items: number }> {
  const entity = getEntity(spec.entity);
  if (!entity?.export || !entity.import) throw new Error(`${spec.entity} can't be changed in bulk`);
  const cells = changeColumns(spec.changes);
  if (spec.prompt) deps.log(`Asked: "${spec.prompt}"`);
  deps.log(`Finding the ${entity.sheet.toLowerCase()} to change`);
  const ids = new Set<string>();
  // Only the item rows are needed: no variants, line items or other extra data.
  const options: ExportOptions = { ...spec.options, columns: ["ID"], groups: [], timezone: deps.timezone };
  await entity.export(
    { gql: deps.gql, bulk: deps.bulk, options, log: deps.log, cache: new Map(), progress: () => {} },
    async (rows) => {
      for (const r of rows) if (r.ID) ids.add(r.ID);
      if (ids.size > MAX_GENERATED_ITEMS) throw new Error(`More than ${MAX_GENERATED_ITEMS.toLocaleString("en")} ${entity.sheet.toLowerCase()} match; narrow the request`);
    },
  );
  deps.log(`${ids.size.toLocaleString("en")} ${entity.sheet.toLowerCase()} match`);
  const headers = ["ID", "Command", ...Object.keys(cells)];
  const rows = [...ids].map((id) => [id, "UPDATE", ...Object.values(cells)]);
  const name = `${entity.sheet}.csv`;
  const file = path.join(dir, `input-${name.replace(/\s+/g, "_")}`);
  await fs.promises.writeFile(file, "﻿" + Papa.unparse({ fields: headers, data: rows }, { newline: "\r\n" }));
  return { file, name, items: ids.size };
}
