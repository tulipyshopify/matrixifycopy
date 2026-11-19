import path from "node:path";
import type { Entity, ExportContext, ExportOptions, Gql, BulkRunner, Logger } from "./types";
import { RowSpool, type WorkbookOut } from "./sheets";

export interface ExportRequest {
  entity: Entity;
  options: ExportOptions;
}

export interface ExportSummary {
  entity: string;
  rows: number;
  items: number;
  /** Columns in the file beyond the data type's fixed ones: metafields, stock per location… */
  dataColumns?: string[];
}

export interface RunExportArgs {
  gql: Gql;
  rest?: (path: string) => Promise<any>;
  bulk: BulkRunner;
  requests: ExportRequest[];
  out: WorkbookOut;
  tmpDir: string;
  log: Logger;
  progress?: (entity: string, items: number) => void;
  /** Called before each entity's export starts. */
  onStart?: (entity: string) => void;
  isCancelled?: () => boolean | Promise<boolean>;
}

/**
 * Applies the column choice (key columns such as ID are optional too, though a
 * file without them can't be imported back); dynamic columns (metafields, inventory per
 * location) are controlled by column groups instead.
 */
/** "Inventory Available: Shop", "Inventory On Hand: Shop"… → the location name. */
export const INVENTORY_COLUMN = /^Inventory (?:Available|On Hand|Committed|Reserved|Damaged|Safety Stock|Quality Control|Incoming): (.+)$/;

/** Applies the location and metafield choices to dynamic column headers. */
function keepDynamic(options: ExportOptions, h: string): boolean {
  const inv = options.locations ? INVENTORY_COLUMN.exec(h) : null;
  if (inv) return options.locations!.some((l) => l.toLowerCase() === inv[1].trim().toLowerCase());
  for (const [prefix, list] of [
    ["Variant Metafield: ", options.variantMetafields],
    ["Metafield: ", options.metafields],
  ] as const) {
    if (list && h.startsWith(prefix)) {
      const key = h.slice(prefix.length).replace(/\s*\[.*$/, "").trim().toLowerCase();
      return list.some((m) => m.toLowerCase() === key);
    }
  }
  return true;
}

export function selectColumns(entity: Entity, options: ExportOptions, headers: string[]): string[] {
  headers = headers.filter((h) => keepDynamic(options, h));
  if (!options.columns) return headers;
  // Chosen columns come out in the order given (the export form lets people
  // arrange them), followed by the dynamic columns.
  // When stock columns are listed, only the listed ones are written (the form
  // lists them all unless some were taken out).
  if (options.columns.some((c) => INVENTORY_COLUMN.test(c))) {
    const listed = new Set(options.columns.map((c) => c.toLowerCase()));
    headers = headers.filter((h) => !INVENTORY_COLUMN.test(h) || listed.has(h.toLowerCase()));
  }
  const present = new Set(headers);
  const known = new Set(entity.columns);
  const out: string[] = [];
  const placed = new Set<string>();
  for (const c of options.columns) {
    if (present.has(c)) {
      out.push(c);
      placed.add(c);
    } else if (/^(Variant )?Metafield: /.test(c)) {
      // A named metafield placed among the columns; its header also carries the type.
      const want = c.toLowerCase();
      for (const h of headers) {
        if (!placed.has(h) && !known.has(h) && h.replace(/\s*\[.*$/, "").trim().toLowerCase() === want) {
          out.push(h);
          placed.add(h);
        }
      }
    }
  }
  return [...out, ...headers.filter((h) => !known.has(h) && !placed.has(h))];
}

export async function runExport(args: RunExportArgs): Promise<ExportSummary[]> {
  const { gql, bulk, requests, out, tmpDir, log } = args;
  const summaries: ExportSummary[] = [];
  const cache = new Map<string, unknown>();

  for (const { entity, options } of requests) {
    if (!entity.export) {
      log(`${entity.sheet}: export not supported, skipped`);
      continue;
    }
    log(`${entity.sheet}: export started`);
    const spool = new RowSpool(path.join(tmpDir, `${entity.key}-${Date.now()}.jsonl`));
    let items = 0;
    const ctx: ExportContext = {
      gql,
      bulk,
      rest: args.rest,
      options,
      log: (m) => log(`${entity.sheet}: ${m}`),
      cache,
      progress: (n) => {
        items = n;
        args.progress?.(entity.key, n);
      },
    };
    args.onStart?.(entity.key);
    let batches = 0;
    try {
      await entity.export(ctx, async (rows) => {
        // Stop promptly when the job is cancelled while rows are being written.
        if (++batches % 100 === 0 && args.isCancelled && (await args.isCancelled())) throw new Error("Cancelled");
        for (const r of rows) {
          // The Command column is left for the person to fill in: a pre-filled MERGE would
          // override the import's safer default and create a new item from a mistyped handle.
          if (r.Command === "MERGE") r.Command = "";
          await spool.push(r);
        }
      });
      await spool.finish();
      const columns = selectColumns(entity, options, spool.headers(entity.columns));
      await out.addSheet(entity.sheet, columns, spool.rows());
      // Columns that come from the store's own data (metafields, stock per location), as written to the file.
      const fixed = new Set(entity.columns);
      const dynamic = columns.filter((c) => !fixed.has(c));
      summaries.push({ entity: entity.key, rows: spool.count, items, ...(dynamic.length ? { dataColumns: dynamic.slice(0, 500) } : {}) });
      log(`${entity.sheet}: exported ${items} items in ${spool.count} rows`);
    } finally {
      await spool.dispose();
    }
  }
  return summaries;
}
