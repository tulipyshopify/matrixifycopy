import type { Command, Entity, ImportContext, ItemResult, Logger, Row } from "./types";
import { ImportError } from "./types";
import { cell, gidToId, mapLimit, parseCommand } from "./util";
import type { Sheet, WorkbookOut } from "./sheets";
import { detectEntity } from "./registry";

export const RESULT_COLUMN = "Import Result";
export const COMMENT_COLUMN = "Import Comment";

export interface ImportItem {
  key: string;
  rows: Row[];
  rowIndexes: number[];
}

/**
 * Groups rows into items. A row joins the item identified by the first
 * non-empty key column; rows with all keys blank continue the previous item.
 * Items keep the order in which they first appear.
 */
export function groupRows(rows: Row[], keyColumns: string[]): ImportItem[] {
  const items: ImportItem[] = [];
  const byKey = new Map<string, ImportItem>();
  let current: ImportItem | null = null;
  rows.forEach((row, i) => {
    let key = "";
    for (const col of keyColumns) {
      const v = cell(row, col);
      if (v) {
        key = `${col}=${v.toLowerCase()}`;
        break;
      }
    }
    if (!key) {
      if (current) {
        current.rows.push(row);
        current.rowIndexes.push(i);
        return;
      }
      key = `#row${i}`;
    }
    let item = byKey.get(key);
    if (!item) {
      item = { key, rows: [], rowIndexes: [] };
      byKey.set(key, item);
      items.push(item);
    }
    item.rows.push(row);
    item.rowIndexes.push(i);
    current = item;
  });
  return items;
}

export interface ImportSummary {
  sheet: string;
  entity: string | null;
  items: number;
  ok: number;
  failed: number;
  skipped: number;
  byCommand: Record<string, number>;
}

export interface RunImportArgs {
  ctx: ImportContext;
  sheets: Sheet[];
  entities: Entity[];
  out?: WorkbookOut;
  log: Logger;
  progress?: (done: number, total: number) => void;
  isCancelled?: () => boolean | Promise<boolean>;
}

export async function runImport(args: RunImportArgs): Promise<ImportSummary[]> {
  const { ctx, sheets, entities, out, log } = args;
  const defaultCommand: Command = ctx.options.defaultCommand ?? "MERGE";

  // Process sheets in registry order so dependencies (products before collections) exist.
  const plan = sheets.map((sheet) => ({ sheet, entity: detectEntity(sheet, entities) }));
  plan.sort((a, b) => entities.indexOf(a.entity!) - entities.indexOf(b.entity!));

  const grouped = plan.map((p) => ({
    ...p,
    items: p.entity?.import ? groupRows(p.sheet.rows, p.entity.import.keyColumns) : [],
  }));
  const total = grouped.reduce((n, g) => n + g.items.length, 0);
  let done = 0;
  const summaries: ImportSummary[] = [];

  for (const { sheet, entity, items } of grouped) {
    const summary: ImportSummary = {
      sheet: sheet.name,
      entity: entity?.key ?? null,
      items: items.length,
      ok: 0,
      failed: 0,
      skipped: 0,
      byCommand: {},
    };
    summaries.push(summary);
    if (!entity) {
      log(`Sheet "${sheet.name}": not recognised, skipped. Name sheets/files like the export (e.g. "Products").`);
      continue;
    }
    if (!entity.import) {
      log(`Sheet "${sheet.name}": ${entity.sheet} are export-only, skipped.`);
      continue;
    }
    log(`Sheet "${sheet.name}": importing ${items.length} ${entity.sheet.toLowerCase()} (${sheet.rows.length} rows)`);

    const results: Array<{ item: ImportItem; result: ItemResult }> = [];
    let cancelled = false;
    await mapLimit(items, Math.max(1, ctx.options.concurrency ?? 4), async (item) => {
      let result: ItemResult;
      let command: Command = defaultCommand;
      if (cancelled || (args.isCancelled && (await args.isCancelled()))) {
        cancelled = true;
        result = { status: "Skipped", command, message: "Job cancelled" };
      } else {
        try {
          command = parseCommand(cell(item.rows[0], "Command"), defaultCommand);
          if (command === "IGNORE") {
            result = { status: "Skipped", command, message: "Command IGNORE" };
          } else if (ctx.options.dryRun) {
            result = { status: "Skipped", command, message: `Dry run: would ${command}` };
          } else {
            result = await entity.import!.apply(ctx, item.rows, command);
          }
        } catch (e: any) {
          result = {
            status: "Failed",
            command,
            message: e instanceof ImportError ? e.message : `Error: ${e?.message ?? e}`,
          };
        }
      }
      results.push({ item, result });
      if (result.status === "OK") summary.ok++;
      else if (result.status === "Failed") summary.failed++;
      else summary.skipped++;
      summary.byCommand[result.command] = (summary.byCommand[result.command] ?? 0) + 1;
      done++;
      args.progress?.(done, total);
    });

    log(`Sheet "${sheet.name}": ${summary.ok} OK, ${summary.failed} failed, ${summary.skipped} skipped`);

    if (out) {
      // Write the original rows back with result columns.
      const resultRows = sheet.rows.map((r) => ({ ...r }));
      for (const { item, result } of results) {
        item.rowIndexes.forEach((ri, j) => {
          const row = resultRows[ri];
          if (j === 0 && result.id) row.ID = gidToId(result.id);
          Object.assign(row, result.rowPatches?.[j] ?? {});
          row[RESULT_COLUMN] = result.status;
          row[COMMENT_COLUMN] = j === 0 ? (result.message ?? "") : "";
        });
      }
      const headers = [...sheet.headers];
      if (!headers.includes("ID")) headers.unshift("ID");
      for (const r of resultRows) for (const k of Object.keys(r)) if (!headers.includes(k)) headers.push(k);
      // Result columns last.
      const ordered = [...headers.filter((h) => h !== RESULT_COLUMN && h !== COMMENT_COLUMN), RESULT_COLUMN, COMMENT_COLUMN];
      await out.addSheet(sheet.name, ordered, resultRows);
    }
  }
  return summaries;
}
