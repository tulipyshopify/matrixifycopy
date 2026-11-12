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
}

export interface RunExportArgs {
  gql: Gql;
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
const INVENTORY_PREFIX = "Inventory Available: ";

/** Applies the location and metafield choices to dynamic column headers. */
function keepDynamic(options: ExportOptions, h: string): boolean {
  if (options.locations && h.startsWith(INVENTORY_PREFIX)) {
    return options.locations.some((l) => l.toLowerCase() === h.slice(INVENTORY_PREFIX.length).trim().toLowerCase());
  }
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
  const present = new Set(headers);
  const known = new Set(entity.columns);
  return [...options.columns.filter((c) => present.has(c)), ...headers.filter((h) => !known.has(h))];
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
        for (const r of rows) await spool.push(r);
      });
      await spool.finish();
      await out.addSheet(entity.sheet, selectColumns(entity, options, spool.headers(entity.columns)), spool.rows());
      summaries.push({ entity: entity.key, rows: spool.count, items });
      log(`${entity.sheet}: exported ${items} items in ${spool.count} rows`);
    } finally {
      await spool.dispose();
    }
  }
  return summaries;
}
