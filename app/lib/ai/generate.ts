import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import type { BulkRunner, ExportOptions, Gql, Logger } from "../core/types";
import { getEntity } from "../entities";
import { adjustedPrice, changeColumns, computedCells, isComputed, isPerVariant, type ChangeSpec } from "./changes";

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
): Promise<{ file: string; name: string; items: number; notes?: string[] }> {
  const entity = getEntity(spec.entity);
  if (!entity?.export || !entity.import) throw new Error(`${spec.entity} can't be changed in bulk`);
  const cells = changeColumns(spec.changes);
  if (spec.prompt) deps.log(`Asked: "${spec.prompt}"`);
  deps.log(`Finding the ${entity.sheet.toLowerCase()} to change`);
  const name = `${entity.sheet}.csv`;
  const file = path.join(dir, `input-${name.replace(/\s+/g, "_")}`);
  const ids = new Set<string>();
  const fromValues = spec.changes.filter((c) => isComputed(c) || isPerVariant(c));
  if (fromValues.length) {
    // Changes worked out from what each item holds now (a price rise, find and replace): the
    // items are read with the columns involved, and only rows that really change are written.
    if (entity.key !== "products") throw new Error(`This kind of change is for products, not ${entity.sheet.toLowerCase()}`);
    const perVariant = spec.changes.some(isPerVariant);
    const textColumns = spec.changes.filter((c) => c.action === "replace_text").map((c) => c.column!);
    const groups = [...(perVariant ? ["variants"] : []), ...(textColumns.some((c) => /^SEO /.test(c)) ? ["seo"] : [])];
    const options: ExportOptions = { ...spec.options, columns: undefined, groups, timezone: deps.timezone };
    const variantColumns = [
      ...(spec.changes.some((c) => c.action === "adjust_price" || c.action === "end_sale") ? ["Variant Price", "Variant Compare At Price"] : []),
      ...spec.changes.filter((c) => c.action === "set_column" && /^Variant /.test(c.column ?? "")).map((c) => c.column!),
    ];
    const fields = [...new Set(["ID", "Command", ...(perVariant ? ["Variant ID"] : []), ...Object.keys(cells), ...textColumns, ...variantColumns])];
    const out: string[][] = [];
    let unchanged = 0;
    let unpriced = 0;
    // A product's rows follow each other. Its whole-product values belong on the first row written for it,
    // and every cell written holds either the new value or the current one: a blank cell would clear.
    let current = "";
    let top: Record<string, string> | null = null;
    await entity.export({ gql: deps.gql, bulk: deps.bulk, options, log: deps.log, cache: new Map(), progress: () => {} }, async (rows) => {
      for (const r of rows) {
        if (!r.ID) continue;
        const computed = computedCells(r, fromValues);
        if (r.ID !== current) {
          current = r.ID;
          ids.add(r.ID);
          if (ids.size > MAX_GENERATED_ITEMS) throw new Error(`More than ${MAX_GENERATED_ITEMS.toLocaleString("en")} ${entity.sheet.toLowerCase()} match; narrow the request`);
          top = { ...cells, ...Object.fromEntries(textColumns.map((c) => [c, computed[c] ?? r[c] ?? ""])) };
        }
        if (r["Variant ID"] && spec.changes.some((c) => c.action === "adjust_price" && adjustedPrice(r["Variant Price"] ?? "", c) === null)) unpriced++;
        const productChange = top !== null && (Object.keys(cells).length > 0 || textColumns.some((c) => c in computed));
        const variantChange = variantColumns.some((c) => c in computed);
        if (!productChange && !variantChange) {
          unchanged++;
          continue;
        }
        const row: Record<string, string> = { ID: r.ID, Command: "UPDATE", ...(top ?? {}) };
        if (perVariant && r["Variant ID"]) {
          row["Variant ID"] = r["Variant ID"];
          for (const c of variantColumns) row[c] = computed[c] ?? r[c] ?? "";
        }
        top = null;
        out.push(fields.map((h) => row[h] ?? ""));
      }
    });
    deps.log(`${ids.size.toLocaleString("en")} ${entity.sheet.toLowerCase()} match; ${out.length.toLocaleString("en")} row${out.length === 1 ? "" : "s"} would change${unchanged ? `, ${unchanged.toLocaleString("en")} need no change` : ""}`);
const notes: string[] = [];
    if (unchanged) notes.push(`${unchanged.toLocaleString("en")} row${unchanged === 1 ? "" : "s"} of the products you chose need${unchanged === 1 ? "s" : ""} no change and ${unchanged === 1 ? "is" : "are"} not listed here.`);
    if (unpriced) {
      const note = `${unpriced.toLocaleString("en")} variant${unpriced === 1 ? " has" : "s have"} no price to work from, or the change would take the price to zero or below, and ${unpriced === 1 ? "is" : "are"} left as ${unpriced === 1 ? "it is" : "they are"}`;
      deps.log(note);
      notes.push(`${note[0].toUpperCase()}${note.slice(1)}.`);
    }
    if (!out.length) {
      // The real reason, not a general one: a price that can't take the change is not "already as wanted".
      const n = ids.size.toLocaleString("en");
      const what = entity.sheet.toLowerCase();
      if (!ids.size) throw new Error(`No ${what} match what you chose.`);
      if (unpriced && unpriced >= unchanged) throw new Error(`${n} ${what} match, but this change can't be made to any of them: it would take the price to zero or below, or there is no price to work from. Choose a smaller amount, or a percentage.`);
      if (spec.changes.some((c) => c.action === "replace_text")) throw new Error(`${n} ${what} match, but none of them contains the text to find, so there is nothing to change.`);
      throw new Error(`${n} ${what} match, but all of them already have these values, so there is nothing to change.`);
    }
    await fs.promises.writeFile(file, "\ufeff" + Papa.unparse({ fields, data: out }, { newline: "\r\n" }));
    return { file, name, items: ids.size, notes };
  }
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
  await fs.promises.writeFile(file, "﻿" + Papa.unparse({ fields: headers, data: rows }, { newline: "\r\n" }));
  return { file, name, items: ids.size };
}
