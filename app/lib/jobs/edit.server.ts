import Papa from "papaparse";
import prisma from "../../db.server";
import { readWorkbook } from "../core/sheets";
import type { FilterCondition } from "../core/types";
import { getEntity } from "../entities";
import { createImportJob, parseExportConfig, parseFilters } from "./jobs.server";
import { PICK_FIELDS } from "./tasks.server";

/**
 * Editing in a table inside the app: the chosen products are read into a
 * grid, cells are changed there, and the changed rows go through the normal
 * import preview. No file is downloaded or uploaded by the person.
 */

export const EDIT_COLUMNS: Array<{ column: string; label: string; level: "product" | "variant"; on?: boolean; hint?: string }> = [
  { column: "Title", label: "Title", level: "product", on: true },
  { column: "Vendor", label: "Vendor", level: "product" },
  { column: "Type", label: "Product type", level: "product" },
  { column: "Tags", label: "Tags", level: "product", hint: "Separated by commas" },
  { column: "Status", label: "Status", level: "product", hint: "Active, Draft or Archived" },
  { column: "SEO Title", label: "SEO title", level: "product" },
  { column: "SEO Description", label: "SEO description", level: "product" },
  { column: "Variant SKU", label: "SKU", level: "variant", on: true },
  { column: "Variant Price", label: "Price", level: "variant", on: true },
  { column: "Variant Compare At Price", label: "Compare-at price", level: "variant" },
  { column: "Variant Cost", label: "Cost", level: "variant" },
  { column: "Variant Barcode", label: "Barcode", level: "variant" },
];
/** Most products read into the table at once. */
export const MAX_EDIT_PRODUCTS = 1000;
const MAX_EDIT_ROWS = 6000;

const clean = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);

/** Starts reading the chosen products for the table. */
export async function startEdit(shop: string, input: { pick?: Array<{ field: string; value: string }>; all?: boolean; columns?: string[] }) {
  const products = getEntity("products")!;
  const picked = (input.pick ?? []).filter((p) => clean(p.value) !== "");
  if (!picked.length && !input.all) throw new Error('Choose which products to edit, or tick "Every product in the store".');
  const filters: FilterCondition[] = parseFilters(
    products,
    picked.map((p) => {
      const spec = PICK_FIELDS.find((f) => f.key === p.field);
      if (!spec) throw new Error("Unknown way to choose products");
      return { field: spec.key, op: spec.op, value: clean(p.value) };
    }),
  );
  const columns = EDIT_COLUMNS.filter((c) => (input.columns ?? []).includes(c.column));
  if (!columns.length) throw new Error("Choose at least one column to edit.");
  const variant = columns.some((c) => c.level === "variant");
  const config = parseExportConfig({
    entities: [
      {
        entity: "products",
        options: {
          filters,
          groups: [...(variant ? ["variants"] : []), ...(columns.some((c) => /^SEO /.test(c.column)) ? ["seo"] : [])],
          columns: ["ID", "Handle", "Title", ...columns.map((c) => c.column), ...(variant ? ["Variant ID", "Option1 Value", "Option2 Value", "Option3 Value"] : [])].filter((c, i, a) => a.indexOf(c) === i),
          limit: MAX_EDIT_PRODUCTS,
        },
      },
    ],
  });
  const which = picked.length ? picked.map((p) => `${PICK_FIELDS.find((f) => f.key === p.field)!.label.toLowerCase()} ${clean(p.value)}`).join(", ") : "every product";
  return prisma.job.create({
    data: { shop, type: "export", format: "csv", name: `Edit in a table: ${which}`.slice(0, 100), config: JSON.stringify({ ...config, edit: { columns: columns.map((c) => c.column) } }) },
  });
}

export interface EditRow {
  /** Position of the row in the file that was read. */
  i: number;
  id: string;
  /** The product's first row: whole-product columns are edited here. */
  top: boolean;
  label: string;
  sub: string;
  cells: Record<string, string>;
}

async function readRows(shop: string, id: string) {
  const job = await prisma.job.findFirst({ where: { id, shop, type: "export" } });
  let edit: { columns: string[] } | null = null;
  try {
    edit = JSON.parse(job?.config ?? "{}").edit ?? null;
  } catch {
    edit = null;
  }
  if (!job || !edit) throw new Error("That table can't be found. Start again from Edit in a table.");
  if (job.status !== "finished" || !job.resultFile) return { job, edit, rows: null as null | Array<Record<string, string>> };
  const sheets = await readWorkbook(job.resultFile, "Products.csv");
  return { job, edit, rows: sheets[0]?.rows ?? [] };
}

/** The table's contents once the products have been read (rows null while that is still running). */
export async function loadEdit(shop: string, id: string) {
  const { job, edit, rows } = await readRows(shop, id);
  const columns = EDIT_COLUMNS.filter((c) => edit.columns.includes(c.column));
  if (!rows) return { status: job.status, error: job.error, name: job.name, progress: job.progress, columns, rows: null, truncated: false, products: 0 };
  const out: EditRow[] = [];
  let current = "";
  let title = "";
  let products = 0;
  for (let i = 0; i < rows.length && out.length < MAX_EDIT_ROWS; i++) {
    const r = rows[i];
    const top = r.ID !== current;
    if (top) {
      current = r.ID;
      title = r.Title ?? "";
      products++;
    }
    const options = [r["Option1 Value"], r["Option2 Value"], r["Option3 Value"]].filter((v) => v && v !== "Default Title").join(" / ");
    out.push({ i, id: r.ID, top, label: top ? title || r.Handle : "", sub: top ? [r.Handle, options].filter(Boolean).join(" · ") : options || "Variant", cells: Object.fromEntries(columns.map((c) => [c.column, r[c.column] ?? ""])) });
  }
  return { status: job.status, error: job.error, name: job.name, progress: job.progress, columns, rows: out, truncated: rows.length > out.length || products >= MAX_EDIT_PRODUCTS, products };
}

export interface CellChange {
  i: number;
  column: string;
  value: string;
}

/** Builds the import file from the cells changed in the table. Exported for tests. */
export function editFile(rows: Array<Record<string, string>>, columns: string[], changes: CellChange[]): { csv: string; rows: number; cells: number } {
  const level = new Map(EDIT_COLUMNS.map((c) => [c.column, c.level]));
  const changed = new Map<number, Record<string, string>>();
  let cells = 0;
  for (const c of changes) {
    const row = rows[c.i];
    if (!row || !columns.includes(c.column)) throw new Error("A changed cell is not part of this table. Reload the page and try again.");
    const value = String(c.value ?? "").slice(0, 5000);
    if ((row[c.column] ?? "") === value) continue;
    (changed.get(c.i) ?? changed.set(c.i, {}).get(c.i)!)[c.column] = value;
    cells++;
  }
  if (!cells) throw new Error("Nothing was changed.");
  // Only the columns that changed somewhere are written. Every cell written holds the new value or the
  // current one, and each product's first row is written too: its whole-product cells must never be blank.
  const used = columns.filter((col) => [...changed.values()].some((r) => col in r));
  const productCols = used.filter((c) => level.get(c) === "product");
  const variantCols = used.filter((c) => level.get(c) === "variant");
  const hasVariantId = rows.some((r) => r["Variant ID"]);
  const tops = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.ID && !tops.has(r.ID)) tops.set(r.ID, i);
  });
  const touched = new Set([...changed.keys()].map((i) => rows[i].ID));
  const fields = ["ID", "Command", ...(variantCols.length && hasVariantId ? ["Variant ID"] : []), ...productCols, ...variantCols];
  const data: string[][] = [];
  rows.forEach((r, i) => {
    if (!touched.has(r.ID)) return;
    const top = tops.get(r.ID) === i;
    if (!top && !changed.has(i)) return;
    // A product whose only changes are on its variants needs no first row unless whole-product columns are in the file.
    if (top && !changed.has(i) && !productCols.length) return;
    const now = changed.get(i) ?? {};
    const line: Record<string, string> = { ID: r.ID, Command: "UPDATE", "Variant ID": r["Variant ID"] ?? "" };
    if (top) for (const c of productCols) line[c] = now[c] ?? r[c] ?? "";
    for (const c of variantCols) line[c] = now[c] ?? r[c] ?? "";
    data.push(fields.map((f) => line[f] ?? ""));
  });
  return { csv: "﻿" + Papa.unparse({ fields, data }, { newline: "\r\n" }), rows: data.length, cells };
}

/** Turns the cells changed in the table into an import preview. */
export async function saveEdit(shop: string, id: string, changes: CellChange[]) {
  const { edit, rows } = await readRows(shop, id);
  if (!rows) throw new Error("The products are still being read.");
  const made = editFile(rows, edit.columns, changes.slice(0, 100_000));
  const job = await createImportJob(shop, new File([made.csv], "Products.csv", { type: "text/csv" }), { dryRun: true, defaultCommand: "UPDATE" });
  return prisma.job.update({ where: { id: job.id }, data: { name: `Edited in a table: ${made.cells.toLocaleString("en")} cell${made.cells === 1 ? "" : "s"}` } });
}
