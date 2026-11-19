import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import type { BulkRunner, ExportOptions, Gql, ImportOptions, Logger } from "../core/types";
import { runExport, type ExportSummary } from "../core/exporter";
import { runImport, type ImportSummary } from "../core/importer";
import { createWorkbookOut, readWorkbook, type OutputFormat } from "../core/sheets";
import { ENTITIES, getEntity } from "../entities";
import { backupDir, jobDir, tmpDir } from "./storage.server";
import { generateChangeFile, type GenerateSpec } from "../ai/generate";
import { runCheck } from "../check/run";
import { generateAiFixFile, type AiFixSpec } from "../check/aifix";

/** Dry-run preview of an import, in the job's folder. */
export const PREVIEW_FILE = "preview.json";

export interface ExportConfig {
  entities: Array<{ entity: string; options: ExportOptions }>;
}

export interface ImportConfig {
  options: ImportOptions;
  /** A change asked for in plain English: the input file is built when the job runs. */
  generate?: GenerateSpec;
  /** AI-drafted fixes from the data check: likewise built when the job runs. */
  aiFix?: AiFixSpec;
  /**
   * The preview job this import was started from ("Import for real"). Items
   * that changed in the store since that preview are not imported.
   */
  previewOf?: string;
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
  kind?: string;
}

export interface RunnerDeps {
  gql: Gql;
  bulk: BulkRunner;
  /** GET on the store's REST Admin API (relative path). */
  rest?: (path: string) => Promise<any>;
  log: Logger;
  progress: (done: number, total: number) => void;
  isCancelled: () => Promise<boolean>;
  /** The shop's IANA time zone. */
  timezone?: () => Promise<string>;
  /** Claude API client; only tests pass one. */
  anthropic?: any;
  /** Called when a job builds its own input file, so it can be saved on the job. */
  onInput?: (file: string, name: string) => Promise<void>;
  /** Expected number of items for an entity's export, or null when unknown. */
  count?: (entity: string, options: ExportOptions) => Promise<number | null>;
  /** The worker's bulk runner reports prepared root items through this hook. */
  bulkEvents?: { onRoots: (n: number) => void };
  /** Data check: tags whose products are left out. */
  checkExclusions?: () => Promise<string[]>;
  /** Checks an image link loads and is an image (see ImportContext.checkImageUrl). */
  checkImageUrl?: (url: string) => Promise<string | null>;
}

/** Share of an export's time spent while Shopify prepares the data (the rest is writing the file). */
const PREPARE_WEIGHT = 0.8;

/**
 * Rough memory a file needs once read into rows, as a multiple of its size on
 * disk (compressed formats unpack to several times that first).
 */
const MEMORY_FACTOR: Record<string, number> = { ".csv": 12, ".txt": 12, ".tsv": 12, ".xlsx": 45, ".xlsm": 45, ".zip": 45 };

/**
 * Refuses a file that would not fit in the server's memory, with a reason,
 * instead of letting it take the whole server down mid-import (which would
 * also interrupt every other job that is running).
 */
export async function assertFitsInMemory(file: string, name: string, heap = v8.getHeapStatistics()) {
  const size = (await fs.promises.stat(file)).size;
  const need = size * (MEMORY_FACTOR[path.extname(name).toLowerCase()] ?? 45);
  const free = heap.heap_size_limit - heap.used_heap_size;
  if (need > free * 0.9) {
    const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`;
    throw new Error(
      `This file is too large to import in one go: it is ${mb(size)} and would need about ${mb(need)} of memory, with ${mb(free)} free on the server right now. Split it into smaller files (for example by product type or by 20,000 rows) and import them one after another.`,
    );
  }
}

export function timestamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
}

export async function executeJob(
  job: JobRecord,
  deps: RunnerDeps,
): Promise<{ resultFile: string; stats: Array<ExportSummary | ImportSummary> }> {
  const dir = job.kind === "backup" ? backupDir(job.shop, job.id) : jobDir(job.shop, job.id);
  const format: OutputFormat = job.format === "csv" ? "csv" : "xlsx";

  if (job.kind === "check") {
    // While Shopify prepares the products, show how many it has so far.
    if (deps.bulkEvents) deps.bulkEvents.onRoots = (n) => deps.progress(n, 0);
    const { resultFile, report } = await runCheck(deps, dir, await (deps.checkExclusions?.() ?? []));
    return { resultFile, stats: [report as any] };
  }

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
      rest: deps.rest,
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
    const config = JSON.parse(job.config) as ImportConfig;
    if (!job.inputFile && config.generate) {
      const timezone = deps.timezone ? await deps.timezone() : "UTC";
      const made = await generateChangeFile(config.generate, { ...deps, timezone }, dir);
      job.inputFile = made.file;
      job.inputName = made.name;
      await deps.onInput?.(made.file, made.name);
    }
    if (!job.inputFile && config.aiFix) {
      const made = await generateAiFixFile(config.aiFix, deps, dir);
      job.inputFile = made.file;
      job.inputName = made.name;
      await deps.onInput?.(made.file, made.name);
    }
    if (!job.inputFile) throw new Error("No input file");
    deps.log(`Reading ${job.inputName ?? path.basename(job.inputFile)}`);
    await assertFitsInMemory(job.inputFile, job.inputName ?? job.inputFile);
    const sheets = await readWorkbook(job.inputFile, job.inputName ?? undefined);
    deps.log(`Found ${sheets.length} sheet(s): ${sheets.map((s) => `${s.name} (${s.rows.length} rows)`).join(", ")}`);
    const inputBase = path.basename(job.inputName ?? "Import", path.extname(job.inputName ?? ""));
    const resultFormat: OutputFormat = /\.(csv|zip)$/i.test(job.inputName ?? "") ? "csv" : format;
    const out = createWorkbookOut(resultFormat, path.join(dir, `${inputBase}_Import_Result_${timestamp()}`), deps.log);
    const cache = new Map<string, unknown>();
    // "Import for real" after a preview: what the preview saw in the store, to compare with now.
    let expected: Record<string, Record<string, Record<string, string>>> | undefined;
    if (config.previewOf && !config.options?.dryRun) {
      try {
        const saved = JSON.parse(await fs.promises.readFile(path.join(jobDir(job.shop, config.previewOf), PREVIEW_FILE), "utf8")) as Array<{ sheet: string; seen?: Record<string, Record<string, string>> }>;
        expected = Object.fromEntries(saved.filter((s) => s.seen).map((s) => [s.sheet, s.seen!]));
        deps.log("Checking each item against the preview: anything changed in the store since then is left alone and reported.");
      } catch {
        deps.log("The preview's record is no longer kept, so this import can't check for changes made since the preview.");
      }
    }
    // The same image link is often on many rows: check each once.
    const checked = new Map<string, Promise<string | null>>();
    const checkImageUrl = deps.checkImageUrl
      ? (url: string) => {
          if (!checked.has(url)) checked.set(url, deps.checkImageUrl!(url));
          return checked.get(url)!;
        }
      : undefined;
    const stats = await runImport({
      ctx: { gql: deps.gql, options: config.options ?? {}, log: deps.log, cache, checkImageUrl },
      sheets,
      entities: ENTITIES,
      out,
      log: deps.log,
      progress: deps.progress,
      isCancelled: deps.isCancelled,
      expected,
    });
    const resultFile = await out.close();
    // The dry-run preview is kept in a file of its own beside the results.
    if (config.options?.dryRun) {
      await fs.promises.writeFile(
        path.join(dir, PREVIEW_FILE),
        JSON.stringify(stats.map((s) => ({ sheet: s.sheet, entity: s.entity, items: s.preview ?? [], seen: s.seen, risk: s.risk, warnings: s.warnings }))),
      );
    }
    return { resultFile, stats: stats.map(({ preview: _p, seen: _s, ...s }) => s) };
  }

  throw new Error(`Unknown job type ${job.type}`);
}
