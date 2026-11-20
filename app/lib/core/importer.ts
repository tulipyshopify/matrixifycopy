import type { Command, Entity, ImportContext, ItemResult, Logger, Row } from "./types";
import { ImportError, ImportErrors } from "./types";
import { cell, gidToId, mapLimit, parseCommand } from "./util";
import type { Sheet, WorkbookOut } from "./sheets";
import { EXCEL_ERROR, NO_VALUE_MARK } from "./sheets";
import { applyColumnAliases, columnHint, detectEntity, detectEntityByHandles, detectEntityByIds, detectEntityByMetafields, unknownColumns } from "./registry";
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
  /** The item's key within its sheet: how a later import is told to leave it out. */
  key?: string;
  /** A name to show beside the key (the product's title), when known. */
  title?: string;
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
  /** One or more of its cells were corrected on the preview's page. */
  edited?: boolean;
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

/** Data types undone by re-importing a copy taken just before the import (products record theirs field by field). */
const SNAPSHOT_TYPES = new Set(["customers", "companies", "smart_collections", "custom_collections", "orders", "draft_orders", "pages", "blog_posts", "redirects"]);
/** Most items copied for undo before one sheet is imported. */
const MAX_SNAPSHOT_ITEMS = 2000;

/** Most undo rows kept for one sheet (a very large import can still be undone from a backup). */
const MAX_UNDO_ROWS = 200_000;

/** Most changed items remembered per sheet for the change history. */
const MAX_APPLIED = 50_000;

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
  /** Real imports, as stored on the job: how many undo rows were recorded. */
  undoRows?: number;
  /** Dry runs only: totals over every item, for the confirmations before a real import. */
  risk?: ImportRisk;
  /** About the sheet as a whole: columns that aren't recognised, the encoding assumed… */
  warnings?: string[];
  /** Real imports: rows that put back what the sheet changed, as a sheet of `entity` (see ItemResult.undo). */
  undo?: Row[];
  /** Real imports: the items that were changed (for the change history; not stored with the job). */
  applied?: Array<{ key: string; id?: string; title?: string; message?: string }>;
  /** Real imports: what can't be undone that way. */
  undoNotes?: string[];
  /** Real imports: stopped early because too many items were failing. */
  stopped?: boolean;
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
  /** Items left out at the preview, by sheet name: they are skipped, untouched. */
  exclude?: Record<string, string[]>;
  /**
   * Stop a sheet when more than this share (0–100) of its items have failed,
   * once at least 20 were tried: a file that is going wrong is not pushed
   * through to the end. 0 or undefined = never stop.
   */
  stopAtFailedPercent?: number;
  /**
   * Reads items of a data type as they are now, by ID, in export layout.
   * Called before a sheet is imported, for data types that don't record their
   * own undo: the rows it returns are what "Undo" imports to put them back.
   */
  snapshot?: (entity: Entity, ids: string[]) => Promise<Row[]>;
  /** Failures a preview already announced, by sheet name: they don't count towards stopping. */
  expectedFailed?: Record<string, number>;
  /**
   * Cells corrected in the preview, by sheet name, then row position, then
   * column: they replace the file's values before anything is checked.
   */
  edits?: SheetEdits;
  /**
   * Dry runs: called with what has been checked so far (the first items of
   * each sheet, and running totals), so a first look can be shown while a
   * large file is still being checked.
   */
  onPartial?: (sheets: PartialPreview[]) => void;
}

export type SheetEdits = Record<string, Record<string, Record<string, string>>>;

/** A preview in the making: the first items checked, and how far it is. */
export interface PartialPreview {
  sheet: string;
  entity: string | null;
  /** Items in the sheet, and how many are checked so far. */
  total: number;
  checked: number;
  failed: number;
  items: PreviewItem[];
  warnings?: string[];
}

/** Items of each sheet shown in the first look. */
export const FIRST_LOOK_ITEMS = 50;

/** Columns that hold codes, where a number in scientific notation is always damage. */
const CODE_COLUMN = /(Barcode|SKU|(^|\s)ID|Phone|Zip|HS Code)$/i;

const shortName = (h: string) => (h.length > 60 ? `${h.slice(0, 57)}…` : h);

/** A row that must not be imported as it stands, whatever the data type. */
function unreadableCell(rows: Row[]): string | null {
  for (const row of rows) {
    for (const [col, v] of Object.entries(row)) {
      if (!v) continue;
      if (v.startsWith(NO_VALUE_MARK)) {
        return `"${col}" holds a formula with no saved result (${v.slice(NO_VALUE_MARK.length, NO_VALUE_MARK.length + 40)}). Open the file in Excel and save it, or paste the values in, then import again.`;
      }
      const first = v.charCodeAt(0);
      if (first === 35 && v.length < 14 && EXCEL_ERROR.test(v)) {
        return `"${col}" holds an Excel error (${v}) instead of a value: a formula in the file is broken. Fix the formula or type the value in, then import again.`;
      }
      // What Excel shows for a long number it has shortened: the real digits are gone.
      if (first >= 48 && first <= 57 && v.length < 16 && /^\d(?:[.,]\d+)?E\+?\d+$/i.test(v) && CODE_COLUMN.test(col)) {
        return `"${col}" holds ${v}, which is how Excel writes a long number it has shortened: the real digits are lost. In Excel, format that column as Text (or as Number with no decimals) and put the full value back, then import again.`;
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
    // A saved column layout says what the sheet is; otherwise it is recognised from its name and columns.
    let entity = (sheet.entity ? (entities.find((e) => e.key === sheet.entity) ?? null) : null) ?? detectEntity(sheet, entities);
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

  const grouped = plan.map((p) => {
    // Column names from Shopify's own exports are read as the columns they mean.
    const renamed = p.entity?.import ? applyColumnAliases(p.entity, p.sheet) : [];
    const edits = args.edits?.[p.sheet.label ?? p.sheet.name];
    if (edits) {
      for (const [index, cells] of Object.entries(edits)) {
        const row = p.sheet.rows[Number(index)];
        if (row) for (const [col, v] of Object.entries(cells)) if (p.sheet.headers.includes(col)) row[col] = v;
      }
    }
    return { ...p, renamed, items: p.entity?.import ? groupRows(p.sheet.rows, p.entity.import.keyColumns) : [] };
  });
  const total = grouped.reduce((n, g) => n + g.items.length, 0);
  if (ctx.options.dryRun) log("Dry run: the file is checked against the store, but nothing is changed.");
  let done = 0;
  const summaries: ImportSummary[] = [];
  const partials: PartialPreview[] = [];

  for (const { sheet: read, entity, items, renamed } of grouped) {
    // Sheets of several workbooks in one ZIP carry their file's name, so each can be told apart.
    const sheet = read.label ? { ...read, name: read.label } : read;
    // +2: spreadsheet rows start at 1 and the header is row 1 (unless the sheet says which rows these are).
    const rowNo = (i: number) => sheet.rowNumbers?.[i] ?? i + 2;
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
      summary.warnings = [...sheetWarnings, `Not imported: ${reason}`];
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
    if (renamed.length) sheetWarnings.push(`Column names from Shopify's own export were recognised: ${renamed.join("; ")}.`);
    const setAside = new Set(sheet.ignoredColumns ?? []);
    const unknown = unknownColumns(entity, sheet.headers).filter((u) => !setAside.has(u.header));
    // Near-misses and known Shopify columns are worth a line each; a long tail of unrelated columns is one line.
    const specific = unknown.filter((u) => u.suggestion || columnHint(entity, u.header));
    const plain = unknown.filter((u) => !specific.includes(u));
    for (const u of specific.slice(0, 15)) {
      const hint = columnHint(entity, u.header);
      sheetWarnings.push(`Column "${shortName(u.header)}" is not a ${entity.sheet} column and is ignored.${hint ? ` ${hint}` : ` Did you mean "${u.suggestion}"?`}`);
    }
    const rest = [...specific.slice(15), ...plain];
    if (rest.length && rest.length <= 5) {
      for (const u of rest) sheetWarnings.push(`Column "${shortName(u.header)}" is not a ${entity.sheet} column and is ignored.`);
    } else if (rest.length) {
      sheetWarnings.push(`${rest.length.toLocaleString("en-GB")} columns are not ${entity.sheet} columns and are ignored: ${rest.slice(0, 6).map((u) => `"${shortName(u.header)}"`).join(", ")} … "${shortName(rest[rest.length - 1].header)}".`);
    }
    for (const w of sheetWarnings) log(`Sheet "${sheet.name}": ${w}`);
    // Importers add to these as they go (each message once).
    ctx.warn = (message: string) => {
      if (sheetWarnings.includes(message)) return;
      sheetWarnings.push(message);
      log(`Sheet "${sheet.name}": ${message}`);
    };

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
    const excluded = args.exclude?.[sheet.name] ? new Set(args.exclude[sheet.name]) : null;

    const results: Array<{ item: ImportItem; result: ItemResult }> = [];
    const previews = new Map<ImportItem, Pick<PreviewItem, "action" | "changes">>();
    const seen: Record<string, Record<string, string>> = {};
    const risk: ImportRisk = { creates: 0, updates: 0, deletes: 0, unchanged: 0, clearing: 0, warned: 0 };
    let cancelled = false;
    let stopped = false;
    const undo: Row[] = [];
    const applied: NonNullable<ImportSummary["applied"]> = [];
    const undoNotes: string[] = [];
    // Before anything is written: a copy of the items as they are, to undo with
    // (data types that record their own undo row by row don't need it).
    let before: Row[] = [];
    if (args.snapshot && !ctx.options.dryRun && SNAPSHOT_TYPES.has(entity.key)) {
      const ids = [...new Set(items.map((it) => gidToId(cell(it.rows[0], "ID") ?? "")).filter((v) => /^\d+$/.test(v)))];
      if (ids.length > MAX_SNAPSHOT_ITEMS) {
        log(`Sheet "${sheet.name}": too many items (${ids.length}) to record for undo. Take a backup first if you may need to put them back.`);
      } else if (ids.length) {
        try {
          before = await args.snapshot(entity, ids);
          const found = new Set(before.map((r) => r.ID).filter(Boolean));
          log(`Sheet "${sheet.name}": recorded ${found.size} of ${ids.length} items as they are now, for undo.`);
        } catch (e: any) {
          log(`Sheet "${sheet.name}": could not record the items for undo (${e?.message ?? e}). The import goes ahead; take a backup if you may need to put them back.`);
        }
      }
    }
    const toPreview = ({ item, result }: { item: ImportItem; result: ItemResult }): PreviewItem => {
      const keyCol = item.key.startsWith("#row") ? null : (entity.import!.keyColumns.find((c) => cell(item.rows[0], c)) ?? null);
      const p = previews.get(item);
      const rich = result.preview;
      return {
        row: rowNo(item.rowIndexes[0]),
        key: item.key,
        ...(result.title ? { title: result.title } : {}),
        item: keyCol ? `${keyCol}: ${cell(item.rows[0], keyCol)}` : `Row ${rowNo(item.rowIndexes[0])}`,
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
      };
    };
    // A first look while the sheet is still being checked: after the first few items, then every few seconds.
    let lastPartial = 0;
    const partial: PartialPreview = { sheet: sheet.name, entity: entity.key, total: items.length, checked: 0, failed: 0, items: [] };
    if (ctx.options.dryRun && args.onPartial) partials.push(partial);
    const emitPartial = (force = false) => {
      if (!ctx.options.dryRun || !args.onPartial) return;
      const n = results.length;
      const now = Date.now();
      if (!force && !(n === 10 || n === FIRST_LOOK_ITEMS || (n > FIRST_LOOK_ITEMS && now - lastPartial > 5000))) return;
      lastPartial = now;
      partial.checked = n;
      partial.failed = summary.failed;
      partial.warnings = sheetWarnings.length ? [...sheetWarnings] : undefined;
      // The first items of the file among those checked so far (they finish slightly out of order).
      if (partial.items.length < FIRST_LOOK_ITEMS || force) {
        partial.items = [...results].sort((a, b) => a.item.rowIndexes[0] - b.item.rowIndexes[0]).slice(0, FIRST_LOOK_ITEMS).map(toPreview);
      }
      try {
        args.onPartial(partials);
      } catch {
        // a first look that can't be shown never stops the preview
      }
    };
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
        result = { status: "Skipped", command, message: stopped ? "Not imported: the import stopped because too many items were failing" : "Job cancelled" };
      } else {
        try {
          command = parseCommand(cell(item.rows[0], "Command"), defaultCommand);
          const unreadable = unreadableCell(item.rows);
          if (command === "IGNORE") {
            result = { status: "Skipped", command, message: "Command IGNORE" };
          } else if (excluded?.has(item.key)) {
            result = { status: "Skipped", command, message: "Left out at the preview" };
          } else if (unreadable) {
            result = { status: "Failed", command, message: unreadable };
          } else if (blocked.has(index)) {
            const errors = blocked.get(index)!;
            result = { status: "Failed", command, message: errors.join("; "), errors };
          } else if (ctx.options.dryRun) {
            try {
              const r = await entity.import!.apply({ ...ctx, gql: dryRunGql(ctx.gql) }, item.rows, command, { rowNumbers: item.rowIndexes.map(rowNo) });
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
              // A new item's visibility is worth saying outright, whatever the first step happens to send.
              if (verb === "create" && entity.columns.includes("Published")) {
                const p = cell(item.rows[0], "Published");
                changes.push(p === undefined || p === "" ? "Published: not set in the file (Shopify's default applies)" : `Published: ${/^(true|yes|y|1)$/i.test(p) ? "yes" : "no"}`);
              }
              previews.set(item, {
                action: command === "REPLACE" ? "replace" : (verb as PreviewItem["action"]),
                changes: changes.length ? [`First step: ${operationText(e.operation)}`, ...changes] : [`First step: ${operationText(e.operation)}`],
              });
            }
          } else {
            result = await entity.import!.apply(ctx, item.rows, command, { expectedSeen: expected?.[item.key], rowNumbers: item.rowIndexes.map(rowNo) });
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
        if (result.undo?.length && undo.length < MAX_UNDO_ROWS) undo.push(...result.undo);
        if (result.undoNote && undoNotes.length < 50) undoNotes.push(result.undoNote);
        result.undo = undefined;
        // What was really changed, for the change history ("Unchanged" items are not history).
        if (result.status === "OK" && applied.length < MAX_APPLIED && !/^(unchanged|no change|nothing to change)/i.test(result.message ?? "")) {
          applied.push({ key: item.key, ...(result.id ? { id: gidToId(result.id) } : {}), ...(result.title ? { title: result.title } : {}), ...(result.message ? { message: result.message.slice(0, 200) } : {}) });
        }
        // A file that is going wrong is stopped, not pushed through.
        const tried = summary.ok + summary.failed + (result.status === "Failed" ? 1 : result.status === "OK" ? 1 : 0);
        const failedNow = Math.max(0, summary.failed + (result.status === "Failed" ? 1 : 0) - (args.expectedFailed?.[sheet.name] ?? 0));
        if (!cancelled && args.stopAtFailedPercent && tried >= 20 && (failedNow / tried) * 100 > args.stopAtFailedPercent) {
          cancelled = true;
          stopped = true;
          summary.stopped = true;
          log(`Sheet "${sheet.name}": stopped, because ${failedNow} of the first ${tried} items failed (more than ${args.stopAtFailedPercent}%). The rest were not imported. What was imported can be undone from this job's page.`);
        }
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
      emitPartial();
    });

    log(`Sheet "${sheet.name}": ${summary.ok} OK, ${summary.failed} failed, ${summary.skipped} skipped`);
    if (sheetWarnings.length) summary.warnings = sheetWarnings;
    if (!undo.length && before.length && summary.ok > 0) undo.push(...before);
    if (undo.length) summary.undo = undo;
    if (applied.length) summary.applied = applied;
    if (undoNotes.length) summary.undoNotes = undoNotes;
    if (ctx.options.dryRun) {
      summary.risk = risk;
      summary.seen = seen;
      // Problems and risky items first in line for the limited preview, then file order.
      const weight = (r: ItemResult) => (r.status === "Failed" ? 0 : r.preview?.deletes || r.preview?.action === "delete" || r.preview?.warnings?.length || r.preview?.clears?.length ? 1 : 2);
      summary.preview = [...results]
        .sort((a, b) => a.item.rowIndexes[0] - b.item.rowIndexes[0])
        .sort((a, b) => (results.length > MAX_PREVIEW_ITEMS ? weight(a.result) - weight(b.result) : 0))
        .slice(0, MAX_PREVIEW_ITEMS)
        .sort((a, b) => a.item.rowIndexes[0] - b.item.rowIndexes[0])
        .map(toPreview);
      emitPartial(true);
    }
    // Say why rows failed right in the log (the results file has every row).
    const failures = results.filter((r) => r.result.status === "Failed").sort((a, b) => a.item.rowIndexes[0] - b.item.rowIndexes[0]);
    for (const { item, result } of failures.slice(0, MAX_LOGGED_FAILURES)) {
      // +2: spreadsheet rows start at 1 and the header is row 1.
      log(`  Row ${rowNo(item.rowIndexes[0])} (${item.key.replace(/^#row\d+$/, "no key").replace("=", ": ")}): ${result.message ?? "Failed"}`);
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
