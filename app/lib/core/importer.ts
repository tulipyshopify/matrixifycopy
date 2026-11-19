import type { Command, Entity, ImportContext, ItemResult, Logger, Row } from "./types";
import { ImportError, ImportErrors } from "./types";
import { cell, gidToId, mapLimit, parseCommand } from "./util";
import type { Sheet, WorkbookOut } from "./sheets";
import { NO_VALUE_MARK } from "./sheets";
import { detectEntity, detectEntityByHandles, detectEntityByIds, detectEntityByMetafields, unknownColumns } from "./registry";
import type { BatchIo } from "./batch";
import { planBatch, runBatch } from "./batch";

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
  /**
   * What would change. From data types that compare with the store: one line
   * per field, "old → new". From the others: the values the first step sends.
   */
  changes: string[];
  /** True when `changes` is a full old → new comparison, not just the first step. */
  compared?: boolean;
  /** Every problem with the item (when it would fail). */
  errors?: string[];
  /** Allowed, but worth a second look. */
  warnings?: string[];
  clears?: string[];
  deletes?: number;
  creates?: number;
}

/** What needs a person's sign-off before a preview is imported for real, counted over every item. */
export interface ImportRisk {
  creates: number;
  updates: number;
  deletes: number;
  unchanged: number;
  /** Items that would empty at least one field. */
  clearing: number;
  /** Items with at least one warning. */
  warned: number;
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
  /** Dry runs only: totals over every item, for the confirmations before a real import. */
  risk?: ImportRisk;
  /** About the sheet as a whole: columns that aren't recognised, the encoding assumed… */
  warnings?: string[];
  /** Dry runs only: what each item looked like in the store, by item key (see ItemResult.seen). */
  seen?: Record<string, Record<string, string>>;
}

export interface RunImportArgs {
  ctx: ImportContext;
  sheets: Sheet[];
  entities: Entity[];
  out?: WorkbookOut;
  log: Logger;
  progress?: (done: number, total: number) => void;
  isCancelled?: () => boolean | Promise<boolean>;
  /** Batch mode plumbing (tests replace the upload and download). */
  batchIo?: BatchIo;
  /**
   * From the preview this import follows: sheet name -> item key -> the store
   * values the preview saw. An item whose values differ now is not imported.
   */
  expected?: Record<string, Record<string, Record<string, string>>>;
}

/** A row that must not be imported as it stands, whatever the data type. */
function unreadableCell(rows: Row[]): string | null {
  for (const row of rows) {
    for (const [col, v] of Object.entries(row)) {
      if (!v) continue;
      if (v.startsWith(NO_VALUE_MARK)) {
        return `"${col}" holds a formula with no saved result (${v.slice(NO_VALUE_MARK.length, NO_VALUE_MARK.length + 40)}). Open the file in Excel and save it, or paste the values in, then import again.`;
      }
      if (v.includes("\uFFFD")) {
        return `"${col}" has characters that could not be read (shown as \uFFFD). The file's text encoding is damaged; save it as "CSV UTF-8" and import again.`;
      }
    }
  }
  return null;
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
    // Only a Handle to go on (say Handle + Command): which data type has those handles?
    if (!entity) {
      entity = await detectEntityByHandles(ctx.gql, sheet, entities);
      if (entity) log(`Sheet "${sheet.name}": recognised as ${entity.sheet} from its handles`);
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
    const sheetWarnings: string[] = [...(sheet.notes ?? [])];
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
          ? `not recognised, nothing imported. Its columns (${sheet.headers.slice(0, 12).join(", ")}${sheet.headers.length > 12 ? ", …" : ""}) don't point to one data type and its IDs and handles weren't found in the store. Add the data type to the file or sheet name (e.g. "Products"), or use the column names from an export.`
          : "the sheet is empty, nothing imported.",
      );
      continue;
    }
    if (!entity.import) {
      await skip(`${entity.sheet} are export-only, nothing imported.`);
      continue;
    }
    log(`Sheet "${sheet.name}": importing ${items.length} ${entity.sheet.toLowerCase()} (${sheet.rows.length} rows)`);

    // Columns the data type doesn't have are ignored: say so, with the likely intended name.
    for (const u of unknownColumns(entity, sheet.headers)) {
      sheetWarnings.push(`Column "${u.header}" is not a ${entity.sheet} column and is ignored.${u.suggestion ? ` Did you mean "${u.suggestion}"?` : ""}`);
    }
    for (const w of sheetWarnings) log(`Sheet "${sheet.name}": ${w}`);
    if (sheetWarnings.length) summary.warnings = sheetWarnings;

    // Checks that need the whole sheet (a loop between rows, the same key twice).
    let blocked = new Map<number, string[]>();
    if (entity.import.prepare) {
      try {
        blocked = await entity.import.prepare(ctx.options.dryRun ? { ...ctx, gql: dryRunGql(ctx.gql) } : ctx, items, defaultCommand);
      } catch (e: any) {
        log(`Sheet "${sheet.name}": the whole-sheet check could not run (${e?.message ?? e}); rows are checked one by one.`);
      }
    }
    const expected = args.expected?.[sheet.name];

    const results: Array<{ item: ImportItem; result: ItemResult }> = [];
    const previews = new Map<ImportItem, Pick<PreviewItem, "action" | "changes">>();
    const seen: Record<string, Record<string, string>> = {};
    const risk: ImportRisk = { creates: 0, updates: 0, deletes: 0, unchanged: 0, clearing: 0, warned: 0 };
    let cancelled = false;
    // Batch mode (opt-in, never for dry runs): the sheet goes to Shopify as one
    // bulk operation when it qualifies; otherwise it runs the normal way below.
    let batched = false;
    if (ctx.options.batch && !ctx.options.dryRun) {
      const batch = planBatch(entity, sheet.headers, items, defaultCommand);
      if ("reason" in batch) {
        log(`Sheet "${sheet.name}": not using batch mode (${batch.reason}).`);
      } else {
        const base = done;
        const batchResults = await runBatch(ctx.gql, batch, {
          ...args.batchIo,
          log,
          isCancelled: args.isCancelled,
          onProgress: (n) => args.progress?.(base + Math.min(n, items.length), total),
        });
        batchResults.forEach((result, i) => {
          results.push({ item: items[i], result });
          if (result.status === "OK") summary.ok++;
          else if (result.status === "Failed") summary.failed++;
          else summary.skipped++;
          summary.byCommand[result.command] = (summary.byCommand[result.command] ?? 0) + 1;
        });
        done += items.length;
        args.progress?.(done, total);
        batched = true;
      }
    }
    await mapLimit(batched ? [] : items, Math.max(1, ctx.options.concurrency ?? 4), async (item, index) => {
      let result: ItemResult;
      let command: Command = defaultCommand;
      if (cancelled || (args.isCancelled && (await args.isCancelled()))) {
        cancelled = true;
        result = { status: "Skipped", command, message: "Job cancelled" };
      } else {
        try {
          command = parseCommand(cell(item.rows[0], "Command"), defaultCommand);
          const unreadable = unreadableCell(item.rows);
          if (command === "IGNORE") {
            result = { status: "Skipped", command, message: "Command IGNORE" };
          } else if (unreadable) {
            result = { status: "Failed", command, message: unreadable };
          } else if (blocked.has(index)) {
            const errors = blocked.get(index)!;
            result = { status: "Failed", command, message: errors.join("; "), errors };
          } else if (ctx.options.dryRun) {
            try {
              const r = await entity.import!.apply({ ...ctx, gql: dryRunGql(ctx.gql) }, item.rows, command, { rowNumbers: item.rowIndexes.map((i) => i + 2) });
              if (r.seen) seen[item.key] = r.seen;
              if (r.preview) {
                // The data type compared the file with the store itself.
                const verb = r.preview.action === "none" ? "no change" : `would ${r.preview.action}`;
                result = { ...r, id: undefined, rowPatches: undefined, message: r.status === "OK" ? `Dry run: ${verb}${r.message ? ` (${r.message})` : ""}` : `Dry run: ${r.message ?? "would fail"}` };
              } else {
                // Finished without writing anything: nothing to change (or a problem it reported).
                result = { ...r, id: undefined, rowPatches: undefined, message: `Dry run: ${r.message ?? "no changes needed"}` };
                previews.set(item, { action: r.status === "OK" ? "none" : r.status === "Failed" ? "failed" : "skipped", changes: [] });
              }
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
            result = await entity.import!.apply(ctx, item.rows, command, { expectedSeen: expected?.[item.key], rowNumbers: item.rowIndexes.map((i) => i + 2) });
          }
        } catch (e: any) {
          result = {
            status: "Failed",
            command,
            message: e instanceof ImportError ? e.message : `Error: ${e?.message ?? e}`,
            errors: e instanceof ImportErrors ? e.errors : undefined,
          };
        }
      }
      // Keep what the preview needs; drop the rest so a large file doesn't pile up in memory.
      if (!ctx.options.dryRun) {
        result.preview = undefined;
        result.seen = undefined;
      }
      results.push({ item, result });
      if (result.status === "OK") summary.ok++;
      else if (result.status === "Failed") summary.failed++;
      else summary.skipped++;
      summary.byCommand[result.command] = (summary.byCommand[result.command] ?? 0) + 1;
      if (ctx.options.dryRun && result.status === "OK") {
        const p = result.preview ?? previews.get(item);
        const action = p?.action ?? "none";
        if (action === "create") risk.creates++;
        else if (action === "delete" || action === "replace") risk.deletes++;
        else if (action === "none") risk.unchanged++;
        else risk.updates++;
        if (result.preview?.clears?.length) risk.clearing++;
        if (result.preview?.warnings?.length) risk.warned++;
        if (result.preview?.deletes && action !== "delete" && action !== "replace") risk.deletes++;
      }
      done++;
      args.progress?.(done, total);
    });

    log(`Sheet "${sheet.name}": ${summary.ok} OK, ${summary.failed} failed, ${summary.skipped} skipped`);
    if (ctx.options.dryRun) {
      const firstValue = (row: Row, col: string) => cell(row, col);
      summary.risk = risk;
      summary.seen = seen;
      // Problems and risky items first in line for the limited preview, then file order.
      const weight = (r: ItemResult) => (r.status === "Failed" ? 0 : r.preview?.deletes || r.preview?.action === "delete" || r.preview?.warnings?.length || r.preview?.clears?.length ? 1 : 2);
      summary.preview = [...results]
        .sort((a, b) => a.item.rowIndexes[0] - b.item.rowIndexes[0])
        .sort((a, b) => (results.length > MAX_PREVIEW_ITEMS ? weight(a.result) - weight(b.result) : 0))
        .slice(0, MAX_PREVIEW_ITEMS)
        .sort((a, b) => a.item.rowIndexes[0] - b.item.rowIndexes[0])
        .map(({ item, result }) => {
          const keyCol = item.key.startsWith("#row") ? null : (entity.import!.keyColumns.find((c) => firstValue(item.rows[0], c)) ?? null);
          const p = previews.get(item);
          const rich = result.preview;
          return {
            row: item.rowIndexes[0] + 2,
            item: keyCol ? `${keyCol}: ${firstValue(item.rows[0], keyCol)}` : `Row ${item.rowIndexes[0] + 2}`,
            command: result.command,
            action: result.status === "Failed" ? "failed" : result.status === "Skipped" ? "skipped" : (rich?.action ?? p?.action ?? "none"),
            message: (result.message ?? "").replace(/^Dry run: /, ""),
            changes: rich?.changes ?? p?.changes ?? [],
            ...(rich ? { compared: true } : {}),
            ...(result.errors?.length ? { errors: result.errors } : {}),
            ...(rich?.warnings?.length ? { warnings: rich.warnings } : {}),
            ...(rich?.clears?.length ? { clears: rich.clears } : {}),
            ...(rich?.deletes ? { deletes: rich.deletes } : {}),
            ...(rich?.creates ? { creates: rich.creates } : {}),
          } satisfies PreviewItem;
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
      // Write the rows back with result columns (in place: a copy of a large sheet would double its memory).
      const resultRows = sheet.rows;
      for (const { item, result } of results) {
        const warnings = result.preview?.warnings ?? [];
        item.rowIndexes.forEach((ri, j) => {
          const row = resultRows[ri];
          if (j === 0 && result.id) row.ID = gidToId(result.id);
          Object.assign(row, result.rowPatches?.[j] ?? {});
          row[RESULT_COLUMN] = result.status;
          row[COMMENT_COLUMN] = j === 0 ? [result.message ?? "", ...warnings.map((w) => `Warning: ${w}`)].filter(Boolean).join(" | ") : "";
        });
      }
      const headers = [...sheet.headers];
      if (!headers.includes("ID")) headers.unshift("ID");
      const known = new Set(headers);
      for (const { result } of results) {
        for (const patch of result.rowPatches ?? []) for (const k of Object.keys(patch ?? {})) if (!known.has(k)) (known.add(k), headers.push(k));
      }
      // Result columns last.
      const ordered = [...headers.filter((h) => h !== RESULT_COLUMN && h !== COMMENT_COLUMN), RESULT_COLUMN, COMMENT_COLUMN];
      await out.addSheet(sheet.name, ordered, resultRows);
    }
  }
  return summaries;
}
