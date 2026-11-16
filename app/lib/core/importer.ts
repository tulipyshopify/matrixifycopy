import type { Command, Entity, ImportContext, ItemResult, Logger, Row } from "./types";
import { ImportError } from "./types";
import { cell, gidToId, mapLimit, parseCommand } from "./util";
import type { Sheet, WorkbookOut } from "./sheets";
import { detectEntity, detectEntityByIds, detectEntityByMetafields } from "./registry";

export const RESULT_COLUMN = "Import Result";
export const COMMENT_COLUMN = "Import Comment";

/** Thrown by the dry-run API wrapper when an item reaches its first write. */
class DryRunStop extends Error {
  constructor(
    public operation: string,
    public variables: Record<string, unknown> = {},
  ) {
    super(`Dry run stopped at ${operation}`);
  }
}

/**
 * API wrapper for dry runs: lookups run for real, so an item is matched and
 * validated exactly as in a real import, but the first mutation stops it.
 */
function dryRunGql(gql: ImportContext["gql"]): ImportContext["gql"] {
  return (async (query: string, variables?: Record<string, unknown>) => {
    const m = /^\s*(?:#graphql\s*)?(query|mutation)\s+(\w+)/.exec(query);
    if (m?.[1] === "mutation") throw new DryRunStop(m[2], variables ?? {});
    return gql(query, variables);
  }) as ImportContext["gql"];
}

function dryRunVerb(command: Command, operation: string): string {
  if (command === "DELETE" || command === "REPLACE") return command.toLowerCase();
  if (/Delete/.test(operation)) return "delete";
  if (command === "UPDATE") return "update";
  if (command === "NEW") return "create";
  // MERGE: creating the item itself (productSet, customerCreate…) is a create;
  // setting metafields, stock or tags on an existing one is an update.
  if (/Metafields|Inventory|Tags/.test(operation)) return "update";
  return /Create$|Upsert$|^Import\w*Set$/.test(operation) ? "create" : "update";
}

/** One item of a dry-run preview: what the import would do with it. */
export interface PreviewItem {
  /** Spreadsheet row number of the item's first row (header is row 1). */
  row: number;
  /** What identifies it: "ID: 123", "Handle: blue-shirt"… */
  item: string;
  command: string;
  action: "create" | "update" | "delete" | "replace" | "none" | "failed" | "skipped";
  message: string;
  /** The values the first change would send, e.g. "custom.courier = P: DX Freight". */
  changes: string[];
}

/** Items kept per sheet for the preview (the result file has every row). */
export const MAX_PREVIEW_ITEMS = 1000;

const ID_KEYS = /^(id|ownerId|productId|orderId|customerId|companyId|collectionId|draftOrderId|inventoryItemId|locationId)$/;

/** Short value text for the preview. */
function shown(v: unknown): string {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

/**
 * The values a mutation would send, as readable lines. Shopify IDs and empty
 * values are left out; metafields read "namespace.key = value".
 */
export function describeChanges(variables: Record<string, unknown>, limit = 12): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (out.length >= limit || v === null || v === undefined || v === "") return;
    const key = path.split(".").pop() ?? "";
    if (ID_KEYS.test(key) || (typeof v === "string" && v.startsWith("gid://"))) return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      if (v.every((x) => typeof x !== "object" || x === null)) return void out.push(`${path}: ${shown(v.join(", "))}`);
      for (const x of v) {
        if (x && typeof x === "object" && "namespace" in x && "key" in x) {
          const mf = x as Record<string, unknown>;
          out.push(`${mf.namespace}.${mf.key} = ${shown(mf.value ?? "(cleared)")}`);
        } else walk(x, path);
        if (out.length >= limit) return;
      }
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path && !/^(input|product|order|customer|variables)$/.test(path) ? `${path}.${k}` : k);
      return;
    }
    out.push(`${path}: ${shown(v)}`);
  };
  walk(variables, "");
  return out;
}

/** "ImportOrderUpdate" -> "order update", "MetafieldsSet" -> "metafields set". */
function operationText(op: string): string {
  return op.replace(/^Import/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** How many failed rows are written to the job log per sheet. */
const MAX_LOGGED_FAILURES = 20;

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
  /** Dry runs only: what would happen to each item (first MAX_PREVIEW_ITEMS). */
  preview?: PreviewItem[];
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
  const plan: Array<{ sheet: Sheet; entity: Entity | null }> = [];
  for (const sheet of sheets) {
    let entity = detectEntity(sheet, entities);
    // Columns that fit several data types (e.g. only ID and Tags): the IDs tell which one.
    if (!entity) {
      entity = await detectEntityByIds(ctx.gql, sheet, entities);
      if (entity) log(`Sheet "${sheet.name}": recognised as ${entity.sheet} from its IDs`);
    }
    // Still open: which data type has the sheet's metafields defined in the store?
    if (!entity) {
      entity = await detectEntityByMetafields(ctx.gql, sheet, entities);
      if (entity) log(`Sheet "${sheet.name}": recognised as ${entity.sheet} from its metafields`);
    }
    plan.push({ sheet, entity });
  }
  plan.sort((a, b) => entities.indexOf(a.entity!) - entities.indexOf(b.entity!));

  const grouped = plan.map((p) => ({
    ...p,
    items: p.entity?.import ? groupRows(p.sheet.rows, p.entity.import.keyColumns) : [],
  }));
  const total = grouped.reduce((n, g) => n + g.items.length, 0);
  if (ctx.options.dryRun) log("Dry run: the file is checked against the store, but nothing is changed.");
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
    // A skipped sheet still goes into the result file, with the reason on every row.
    const skip = async (reason: string) => {
      log(`Sheet "${sheet.name}": ${reason}`);
      summary.skipped = sheet.rows.length;
      const headers = [...sheet.headers.filter((h) => h !== RESULT_COLUMN && h !== COMMENT_COLUMN), RESULT_COLUMN, COMMENT_COLUMN];
      await out?.addSheet(sheet.name, headers, sheet.rows.map((r) => ({ ...r, [RESULT_COLUMN]: "Skipped", [COMMENT_COLUMN]: reason })));
    };
    if (!entity) {
      await skip(
        sheet.rows.length
          ? `not recognised, nothing imported. Its columns (${sheet.headers.slice(0, 12).join(", ")}${sheet.headers.length > 12 ? ", …" : ""}) don't point to one data type and its IDs weren't found in the store. Add the data type to the file or sheet name (e.g. "Products"), or use the column names from an export.`
          : "the sheet is empty, nothing imported.",
      );
      continue;
    }
    if (!entity.import) {
      await skip(`${entity.sheet} are export-only, nothing imported.`);
      continue;
    }
    log(`Sheet "${sheet.name}": importing ${items.length} ${entity.sheet.toLowerCase()} (${sheet.rows.length} rows)`);

    const results: Array<{ item: ImportItem; result: ItemResult }> = [];
    const previews = new Map<ImportItem, Pick<PreviewItem, "action" | "changes">>();
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
            try {
              const r = await entity.import!.apply({ ...ctx, gql: dryRunGql(ctx.gql) }, item.rows, command);
              // Finished without writing anything: nothing to change (or a problem it reported).
              result = { ...r, id: undefined, rowPatches: undefined, message: `Dry run: ${r.message ?? "no changes needed"}` };
              previews.set(item, { action: r.status === "OK" ? "none" : r.status === "Failed" ? "failed" : "skipped", changes: [] });
            } catch (e) {
              if (!(e instanceof DryRunStop)) throw e;
              const verb = dryRunVerb(command, e.operation);
              result = { status: "OK", command, message: `Dry run: would ${verb}` };
              const changes = describeChanges(e.variables);
              previews.set(item, {
                action: command === "REPLACE" ? "replace" : (verb as PreviewItem["action"]),
                changes: changes.length ? [`First step: ${operationText(e.operation)}`, ...changes] : [`First step: ${operationText(e.operation)}`],
              });
            }
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
    if (ctx.options.dryRun) {
      const firstValue = (row: Row, col: string) => cell(row, col);
      summary.preview = [...results]
        .sort((a, b) => a.item.rowIndexes[0] - b.item.rowIndexes[0])
        .slice(0, MAX_PREVIEW_ITEMS)
        .map(({ item, result }) => {
          const keyCol = item.key.startsWith("#row") ? null : (entity.import!.keyColumns.find((c) => firstValue(item.rows[0], c)) ?? null);
          const p = previews.get(item);
          return {
            row: item.rowIndexes[0] + 2,
            item: keyCol ? `${keyCol}: ${firstValue(item.rows[0], keyCol)}` : `Row ${item.rowIndexes[0] + 2}`,
            command: result.command,
            action: p?.action ?? (result.status === "Failed" ? "failed" : "skipped"),
            message: (result.message ?? "").replace(/^Dry run: /, ""),
            changes: p?.changes ?? [],
          };
        });
    }
    // Say why rows failed right in the log (the results file has every row).
    const failures = results.filter((r) => r.result.status === "Failed").sort((a, b) => a.item.rowIndexes[0] - b.item.rowIndexes[0]);
    for (const { item, result } of failures.slice(0, MAX_LOGGED_FAILURES)) {
      // +2: spreadsheet rows start at 1 and the header is row 1.
      log(`  Row ${item.rowIndexes[0] + 2} (${item.key.replace(/^#row\d+$/, "no key").replace("=", ": ")}): ${result.message ?? "Failed"}`);
    }
    if (failures.length > MAX_LOGGED_FAILURES) {
      log(`  …and ${failures.length - MAX_LOGGED_FAILURES} more failed rows. The results file lists every one.`);
    }

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
