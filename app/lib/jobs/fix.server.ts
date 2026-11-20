import fs from "node:fs";
import path from "node:path";
import prisma from "../../db.server";
import type { ImportRisk, PreviewItem, SheetEdits } from "../core/importer";
import { COMMENT_COLUMN, RESULT_COLUMN, groupRows, runImport } from "../core/importer";
import { applyColumnAliases } from "../core/registry";
import type { Sheet } from "../core/sheets";
import type { Gql, Row } from "../core/types";
import { getEntity } from "../entities";
import { jobHealth } from "./health";
import type { ImportConfig } from "./runner.server";
import { EDITS_FILE, PREVIEW_FILE, readEdits, readImportSheets } from "./runner.server";
import { jobDir } from "./storage.server";
import { listLayouts } from "./layouts.server";

/**
 * Correcting a row on the preview's page. The file itself is never changed:
 * corrected cells are kept beside the preview, the row is checked against the
 * store again on its own, and the import that follows uses the corrected
 * values.
 */

/** Most rows of one item shown for editing (a product with very many variants is edited in the file). */
const MAX_EDIT_ROWS = 100;
const MAX_CELL = 60_000;

interface StoredSheet {
  sheet: string;
  entity: string | null;
  items: Array<PreviewItem & { edited?: boolean }>;
  seen?: Record<string, Record<string, string>>;
  risk?: ImportRisk;
  warnings?: string[];
}

export interface EditableRows {
  sheet: string;
  row: number;
  /** Every column of the sheet, in file order. */
  headers: string[];
  /** The columns that identify the item. */
  keyColumns: string[];
  rows: Array<{ index: number; number: number; cells: Record<string, string>; edited: string[] }>;
}

async function load(shop: string, id: string, sheetName: string, rowNumber: number) {
  const job = await prisma.job.findFirst({ where: { id, shop } });
  if (!job) throw new Error("That preview can't be found");
  let config: ImportConfig;
  try {
    config = JSON.parse(job.config);
  } catch {
    throw new Error("This job's settings can't be read");
  }
  if (job.type !== "import" || !config.options?.dryRun || job.status !== "finished") throw new Error("Rows can be corrected on a finished preview only");
  if (!job.inputFile) throw new Error("The previewed file is no longer kept. Import it again.");
  const dir = jobDir(shop, id);
  let stored: StoredSheet[];
  try {
    stored = JSON.parse(await fs.promises.readFile(path.join(dir, PREVIEW_FILE), "utf8"));
  } catch {
    throw new Error("The preview's record is no longer kept. Preview the file again.");
  }
  const sheetPreview = stored.find((s) => s.sheet === sheetName);
  const entity = sheetPreview?.entity ? getEntity(sheetPreview.entity) : null;
  if (!sheetPreview || !entity?.import) throw new Error("That sheet is not part of this preview");
  const sheets = await readImportSheets({ inputFile: job.inputFile, inputName: job.inputName }, config, () => {}, await listLayouts(shop));
  const sheet = sheets.find((s) => (s.label ?? s.name) === sheetName);
  if (!sheet) throw new Error("That sheet is no longer in the file");
  applyColumnAliases(entity, sheet);
  const edits = await readEdits(dir);
  const applyEdits = (list: SheetEdits) => {
    for (const [index, cells] of Object.entries(list[sheetName] ?? {})) {
      const row = sheet.rows[Number(index)];
      if (row) for (const [col, v] of Object.entries(cells)) if (sheet.headers.includes(col)) row[col] = v;
    }
  };
  // The file's own values, before any correction (to put them back).
  const original = new Map<number, Row>();
  for (const index of Object.keys(edits[sheetName] ?? {})) if (sheet.rows[Number(index)]) original.set(Number(index), { ...sheet.rows[Number(index)] });
  applyEdits(edits);
  const item = groupRows(sheet.rows, entity.import.keyColumns).find((g) => g.rowIndexes[0] + 2 === rowNumber);
  if (!item) throw new Error("That row can't be found in the file any more. Preview the file again.");
  return { job, config, dir, stored, sheetPreview, entity, sheet, edits, item, original };
}

/** The rows of one previewed item, as they will be imported (corrections included). */
export async function editableRows(shop: string, id: string, sheetName: string, rowNumber: number): Promise<EditableRows> {
  const { entity, sheet, edits, item } = await load(shop, id, sheetName, rowNumber);
  const headers = sheet.headers.filter((h) => h !== RESULT_COLUMN && h !== COMMENT_COLUMN);
  return {
    sheet: sheetName,
    row: rowNumber,
    headers,
    keyColumns: entity.import!.keyColumns.filter((c) => headers.includes(c)),
    rows: item.rowIndexes.slice(0, MAX_EDIT_ROWS).map((index) => ({
      index,
      number: index + 2,
      cells: Object.fromEntries(headers.map((h) => [h, sheet.rows[index][h] ?? ""])),
      edited: Object.keys(edits[sheetName]?.[String(index)] ?? {}),
    })),
  };
}

/** What one preview item adds to its sheet's totals. */
function contribution(i: PreviewItem): { ok: number; failed: number; skipped: number; risk: ImportRisk } {
  const risk: ImportRisk = { creates: 0, updates: 0, deletes: 0, unchanged: 0, clearing: 0, warned: 0 };
  if (i.action === "failed") return { ok: 0, failed: 1, skipped: 0, risk };
  if (i.action === "skipped") return { ok: 0, failed: 0, skipped: 1, risk };
  const removesPart = !!i.deletes && i.action !== "delete" && i.action !== "replace";
  if (i.action === "create") risk.creates++;
  else if (i.action === "delete" || i.action === "replace" || removesPart) risk.deletes++;
  else if (i.action === "none") risk.unchanged++;
  else risk.updates++;
  if (i.clears?.length) risk.clearing++;
  if (i.warnings?.length) risk.warned++;
  return { ok: 1, failed: 0, skipped: 0, risk };
}

export interface RowFix {
  /** Position of the row in the sheet (as given by editableRows). */
  index: number;
  column: string;
  value: string;
}

/**
 * Saves corrections to an item's rows (or, with `reset`, puts the file's own
 * values back), checks that item against the store again, and updates the
 * preview and its totals. Returns what the item would now do.
 */
export async function fixPreviewRows(shop: string, id: string, sheetName: string, rowNumber: number, fixes: RowFix[], gql: Gql, opts: { reset?: boolean } = {}): Promise<PreviewItem[]> {
  const { job, config, dir, stored, sheetPreview, entity, sheet, edits, item, original } = await load(shop, id, sheetName, rowNumber);
  const own = new Set(item.rowIndexes);
  const sheetEdits = (edits[sheetName] ??= {});
  if (opts.reset) {
    for (const index of item.rowIndexes) {
      if (original.has(index)) sheet.rows[index] = original.get(index)!;
      delete sheetEdits[String(index)];
    }
  } else {
    if (!fixes.length) throw new Error("Nothing was changed");
    for (const f of fixes) {
      if (!own.has(f.index)) throw new Error("That row belongs to another item");
      if (!sheet.headers.includes(f.column) || f.column === RESULT_COLUMN || f.column === COMMENT_COLUMN) throw new Error(`"${f.column}" is not a column of this sheet`);
      const value = String(f.value ?? "");
      if (value.length > MAX_CELL) throw new Error(`The value for "${f.column}" is too long`);
      (sheetEdits[String(f.index)] ??= {})[f.column] = value;
      sheet.rows[f.index][f.column] = value;
    }
  }
  // A changed key must not make these rows part of another item (the import would then treat them together).
  const regrouped = groupRows(sheet.rows, entity.import!.keyColumns).filter((g) => g.rowIndexes.some((i) => own.has(i)));
  for (const g of regrouped) {
    const foreign = g.rowIndexes.find((i) => !own.has(i));
    if (foreign !== undefined) {
      throw new Error(`With this change the row would have the same ${g.key.split("=")[0]} as row ${foreign + 2}, and the import would treat them as one item. Use a different value, or correct this in the file itself.`);
    }
  }
  // Check just these rows, exactly as the preview did.
  const rows = item.rowIndexes.map((i) => sheet.rows[i]);
  const part: Sheet = { name: entity.sheet, headers: sheet.headers, rows, rowNumbers: item.rowIndexes.map((i) => i + 2) };
  const [summary] = await runImport({
    ctx: { gql, options: { ...config.options, dryRun: true }, log: () => {}, cache: new Map() },
    sheets: [part],
    entities: [entity],
    log: () => {},
  });
  if (!summary?.preview?.length) throw new Error("The row could not be checked again. Preview the file again.");
  const edited = item.rowIndexes.some((i) => sheetEdits[String(i)] && Object.keys(sheetEdits[String(i)]).length);
  const fresh = summary.preview.map((p) => ({ ...p, ...(edited ? { edited: true } : {}) }));

  // Replace the item in the preview, and move the totals by the difference.
  const numbers = new Set(item.rowIndexes.map((i) => i + 2));
  const old = sheetPreview.items.filter((p) => numbers.has(p.row));
  if (!old.length) throw new Error("This item is not among those the preview lists, so it can't be corrected here. Correct it in the file.");
  sheetPreview.items = [...sheetPreview.items.filter((p) => !numbers.has(p.row)), ...fresh].sort((a, b) => a.row - b.row);
  if (sheetPreview.seen) {
    for (const p of old) if (p.key) delete sheetPreview.seen[p.key];
    Object.assign(sheetPreview.seen, summary.seen ?? {});
  }
  const stats = JSON.parse(job.stats) as Array<Record<string, any>>;
  const stat = stats.find((s) => s.sheet === sheetName);
  const moved = { ok: 0, failed: 0, skipped: 0 };
  const risk: ImportRisk = { creates: 0, updates: 0, deletes: 0, unchanged: 0, clearing: 0, warned: 0 };
  const add = (p: PreviewItem, sign: 1 | -1) => {
    const c = contribution(p);
    moved.ok += sign * c.ok;
    moved.failed += sign * c.failed;
    moved.skipped += sign * c.skipped;
    for (const k of Object.keys(risk) as Array<keyof ImportRisk>) risk[k] += sign * c.risk[k];
    if (stat?.byCommand) stat.byCommand[p.command] = Math.max(0, (stat.byCommand[p.command] ?? 0) + sign);
  };
  for (const p of old) add(p, -1);
  for (const p of fresh) add(p, 1);
  if (stat) {
    stat.ok = Math.max(0, (stat.ok ?? 0) + moved.ok);
    stat.failed = Math.max(0, (stat.failed ?? 0) + moved.failed);
    stat.skipped = Math.max(0, (stat.skipped ?? 0) + moved.skipped);
    stat.items = Math.max(0, (stat.items ?? 0) + fresh.length - old.length);
    if (stat.risk) for (const k of Object.keys(risk) as Array<keyof ImportRisk>) stat.risk[k] = Math.max(0, (stat.risk[k] ?? 0) + risk[k]);
  }
  if (sheetPreview.risk) for (const k of Object.keys(risk) as Array<keyof ImportRisk>) sheetPreview.risk[k] = Math.max(0, (sheetPreview.risk[k] ?? 0) + risk[k]);

  // Drop rows left without corrections, then save: corrections first, so the import can never miss them.
  for (const index of Object.keys(sheetEdits)) if (!Object.keys(sheetEdits[index]).length) delete sheetEdits[index];
  if (!Object.keys(sheetEdits).length) delete edits[sheetName];
  await fs.promises.writeFile(path.join(dir, EDITS_FILE), JSON.stringify(edits));
  const tmp = path.join(dir, `${PREVIEW_FILE}.tmp`);
  await fs.promises.writeFile(tmp, JSON.stringify(stored));
  await fs.promises.rename(tmp, path.join(dir, PREVIEW_FILE));
  const statsText = JSON.stringify(stats);
  const stamp = new Date().toISOString().slice(11, 19);
  const what = fresh.map((p) => (p.action === "failed" ? `still can't be applied (${p.message})` : p.action === "none" ? "now matches the store" : `would ${p.action}`)).join("; ");
  await prisma.job.update({
    where: { id },
    data: {
      stats: statsText,
      problems: jobHealth({ type: "import", status: "finished", stats: statsText, dryRun: true }).problems,
      log: `${job.log ?? ""}[${stamp}] Row ${rowNumber} of "${sheetName}" ${opts.reset ? "was put back to the file's values" : "was corrected on this page"} and checked again: ${what}\n`,
    },
  });
  return fresh;
}

/** How many rows of a preview carry corrections made on its page. */
export async function editedRowCount(shop: string, id: string): Promise<number> {
  const edits = await readEdits(jobDir(shop, id));
  return Object.values(edits).reduce((n: number, rows) => n + Object.keys(rows).length, 0);
}
