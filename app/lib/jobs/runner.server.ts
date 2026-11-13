import path from "node:path";
import type { BulkRunner, ExportOptions, Gql, ImportOptions, Logger } from "../core/types";
import { runExport, type ExportSummary } from "../core/exporter";
import { runImport, type ImportSummary } from "../core/importer";
import { createWorkbookOut, readWorkbook, type OutputFormat } from "../core/sheets";
import { ENTITIES, getEntity } from "../entities";
import { jobDir, tmpDir } from "./storage.server";

export interface ExportConfig {
  entities: Array<{ entity: string; options: ExportOptions }>;
}

export interface ImportConfig {
  options: ImportOptions;
}

export interface JobRecord {
  id: string;
  shop: string;
  type: string;
  config: string;
  format: string;
  name: string;
  inputFile: string | null;
  inputName: string | null;
}

export interface RunnerDeps {
  gql: Gql;
  bulk: BulkRunner;
  log: Logger;
  progress: (done: number, total: number) => void;
  isCancelled: () => Promise<boolean>;
  /** The shop's IANA time zone. */
  timezone?: () => Promise<string>;
  /** Expected number of items for an entity's export, or null when unknown. */
  count?: (entity: string, options: ExportOptions) => Promise<number | null>;
  /** The worker's bulk runner reports prepared root items through this hook. */
  bulkEvents?: { onRoots: (n: number) => void };
}

/** Share of an export's time spent while Shopify prepares the data (the rest is writing the file). */
const PREPARE_WEIGHT = 0.8;

export function timestamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
}

export async function executeJob(
  job: JobRecord,
  deps: RunnerDeps,
): Promise<{ resultFile: string; stats: Array<ExportSummary | ImportSummary> }> {
  const dir = jobDir(job.shop, job.id);
  const format: OutputFormat = job.format === "csv" ? "csv" : "xlsx";

  if (job.type === "export") {
    const config = JSON.parse(job.config) as ExportConfig;
    // Date ranges ("Last month") are worked out in the shop's own time zone.
    const timezone = deps.timezone ? await deps.timezone() : "UTC";
    const requests = config.entities.map(({ entity, options }) => {
      const e = getEntity(entity);
      if (!e) throw new Error(`Unknown entity "${entity}"`);
      return { entity: e, options: { ...options, timezone } };
    });
    const base = job.name ? job.name.replace(/[^\w.-]+/g, "_") : `Export_${timestamp()}`;
    const out = createWorkbookOut(format, path.join(dir, base), deps.log);
    // Expected totals make a percentage and time estimate possible. If any
    // data type can't be counted, progress falls back to a plain item counter.
    const expected: Array<number | null> = [];
    for (const r of requests) {
      expected.push(deps.count ? await deps.count(r.entity.key, r.options).catch(() => null) : null);
    }
    const known = expected.every((n) => n !== null);
    const grandTotal = known ? (expected as number[]).reduce((a, b) => a + b, 0) : 0;
    const counts = new Map<string, number>();
    let index = -1;
    let doneBefore = 0;
    let prepared = 0;
    let written = 0;
    const report = () => {
      if (!known || !grandTotal) {
        return deps.progress([...counts.values()].reduce((a, b) => a + b, 0), 0);
      }
      const t = expected[index] ?? 0;
      const units = doneBefore + PREPARE_WEIGHT * Math.min(prepared, t) + (1 - PREPARE_WEIGHT) * Math.min(written, t);
      // Keep 100% for the real finish.
      deps.progress(Math.min(Math.round(units), grandTotal - 1), grandTotal);
    };
    if (deps.bulkEvents) {
      deps.bulkEvents.onRoots = (n) => {
        prepared = Math.max(prepared, n);
        report();
      };
    }
    const stats = await runExport({
      gql: deps.gql,
      bulk: deps.bulk,
      requests,
      out,
      tmpDir: tmpDir(),
      log: deps.log,
      isCancelled: deps.isCancelled,
      onStart: () => {
        if (index >= 0) doneBefore += expected[index] ?? 0;
        index++;
        prepared = 0;
        written = 0;
      },
      progress: (entity, n) => {
        counts.set(entity, n);
        written = n;
        report();
      },
    });
    const resultFile = await out.close();
    const done = stats.reduce((n, x) => n + x.items, 0);
    deps.progress(done, done);
    return { resultFile, stats };
  }

  if (job.type === "import") {
    if (!job.inputFile) throw new Error("No input file");
    const config = JSON.parse(job.config) as ImportConfig;
    deps.log(`Reading ${job.inputName ?? path.basename(job.inputFile)}`);
    const sheets = await readWorkbook(job.inputFile, job.inputName ?? undefined);
    deps.log(`Found ${sheets.length} sheet(s): ${sheets.map((s) => `${s.name} (${s.rows.length} rows)`).join(", ")}`);
    const inputBase = path.basename(job.inputName ?? "Import", path.extname(job.inputName ?? ""));
    const resultFormat: OutputFormat = /\.(csv|zip)$/i.test(job.inputName ?? "") ? "csv" : format;
    const out = createWorkbookOut(resultFormat, path.join(dir, `${inputBase}_Import_Result_${timestamp()}`), deps.log);
    const cache = new Map<string, unknown>();
    const stats = await runImport({
      ctx: { gql: deps.gql, options: config.options ?? {}, log: deps.log, cache },
      sheets,
      entities: ENTITIES,
      out,
      log: deps.log,
      progress: deps.progress,
      isCancelled: deps.isCancelled,
    });
    const resultFile = await out.close();
    return { resultFile, stats };
  }

  throw new Error(`Unknown job type ${job.type}`);
}
