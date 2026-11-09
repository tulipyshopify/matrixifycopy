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
}

/**
 * Applies the column choice. Key columns (ID, Handle…) are always kept so the
 * file can be imported back; dynamic columns (metafields, inventory per
 * location) are controlled by column groups instead.
 */
export function selectColumns(entity: Entity, options: ExportOptions, headers: string[]): string[] {
  if (!options.columns) return headers;
  const keep = new Set([...options.columns, "ID", ...(entity.import?.keyColumns ?? [])]);
  const known = new Set(entity.columns);
  return headers.filter((h) => keep.has(h) || !known.has(h));
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
    try {
      await entity.export(ctx, async (rows) => {
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
