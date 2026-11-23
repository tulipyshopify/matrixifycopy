import fs from "node:fs";
import path from "node:path";
import prisma from "../../db.server";
import { readWorkbook } from "../core/sheets";
import type { ExportOptions } from "../core/types";
import { ENTITIES } from "../entities";
import { isDryRunConfig, jobHealth } from "../jobs/health";
import {
  applyDryRun,
  applyNeeds,
  cancelJob,
  createExportJob,
  createImportJob,
  createUrlImportJob,
  discardJob,
  sameUploadBefore,
  entityCatalog,
  parseExportConfig,
  parseImportOptions,
  previewKind,
  readPreview,
} from "../jobs/jobs.server";
import { SOURCE_PROTOCOLS } from "../jobs/sources.server";
import { resolveStored, signedDownloadUrl } from "../jobs/storage.server";
import type { KeyAuth } from "./keys.server";
import { ApiError } from "./keys.server";

/**
 * What the API, the MCP server, the CLI and the Sheets add-on can do. One
 * place, so every way in follows the same rules: an import is a preview unless
 * the key allows imports AND the caller asks for it explicitly.
 */

/** A shop (the app itself asking) or a key, which may be limited to some data types. */
type Who = string | KeyAuth;
const shopOf = (who: Who) => (typeof who === "string" ? who : who.shop);
const limitOf = (who: Who): string[] | null => (typeof who === "string" ? null : who.entities?.length ? who.entities : null);
const sheetNames = (keys: string[]) => keys.map((k) => ENTITIES.find((e) => e.key === k)?.sheet ?? k).join(", ");

/** The data types a job holds: an export's sheets, or what an import's sheets were read as. */
function jobEntities(job: { type: string; config: string; stats: string }): string[] {
  try {
    if (job.type === "export") return ((JSON.parse(job.config)?.entities ?? []) as Array<{ entity?: string }>).map((e) => String(e.entity ?? "")).filter(Boolean);
    return ((JSON.parse(job.stats || "[]") ?? []) as Array<{ entity?: string | null }>).map((s) => s?.entity ?? "").filter(Boolean) as string[];
  } catch {
    return [];
  }
}

/** A key limited to some data types reads only jobs that hold nothing else. */
function allowedJob(who: Who, job: { type: string; config: string; stats: string }): boolean {
  const limit = limitOf(who);
  return !limit || jobEntities(job).every((k) => limit.includes(k));
}

export const MAX_API_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 200);

/** Sheets (data types) with their columns, optional column groups and filters. */
export function sheetList(sheet?: string) {
  const all = entityCatalog();
  if (!sheet) {
    return all.map((e) => ({ sheet: e.sheet, description: e.description, can_export: e.canExport, can_import: e.canImport, columns: e.columns.length }));
  }
  const e = findSheet(sheet);
  const info = all.find((x) => x.key === e.key)!;
  return {
    sheet: info.sheet,
    description: info.description,
    can_export: info.canExport,
    can_import: info.canImport,
    key_columns: info.keyColumns,
    columns: info.columns,
    groups: info.groups.map((g: any) => ({ key: g.key, label: g.label })),
    filters: info.filters.map((f: any) => ({ field: f.key, label: f.label, type: f.type, values: f.options?.map((o: any) => o.value) })),
  };
}

function findSheet(name: string) {
  const want = String(name ?? "").trim().toLowerCase();
  const e = ENTITIES.find((x) => x.key.toLowerCase() === want || x.sheet.toLowerCase() === want);
  if (!e) throw new ApiError(400, `Unknown sheet "${name}". Sheets: ${ENTITIES.map((x) => x.sheet).join(", ")}`);
  return e;
}

export interface ExportRequest {
  sheets: Array<{ sheet: string } & Pick<ExportOptions, "columns" | "groups" | "filters" | "dateRange" | "limit" | "metafields" | "variantMetafields" | "locations" | "inventoryKinds">>;
  format?: string;
  name?: string;
}

export async function startExport(auth: KeyAuth, input: ExportRequest) {
  if (!Array.isArray(input?.sheets) || !input.sheets.length) throw new ApiError(400, 'Say what to export: {"sheets":[{"sheet":"Products"}]}');
  if (input.sheets.length > 20) throw new ApiError(400, "At most 20 sheets per export");
  let config;
  try {
    config = parseExportConfig({
      entities: input.sheets.map(({ sheet, ...options }) => {
        const e = findSheet(sheet);
        // A column the sheet doesn't have is refused by name, the same as an unknown filter.
        if (options.columns?.length) {
          const known = new Set(e.columns.map((c) => c.toLowerCase()));
          const unknown = options.columns.filter((c) => !known.has(String(c).toLowerCase()) && !/^((Variant )?Metafield: \S|Inventory [A-Za-z ]+: \S)/.test(String(c)));
          if (unknown.length) {
            throw new ApiError(400, `${e.sheet} has no column${unknown.length === 1 ? "" : "s"} ${unknown.slice(0, 8).map((c) => `"${c}"`).join(", ")}. Call list_sheets with this sheet's name for its columns.`);
          }
          // Column names are matched whatever their capitals.
          const proper = new Map(e.columns.map((c) => [c.toLowerCase(), c]));
          options.columns = options.columns.map((c) => proper.get(String(c).toLowerCase()) ?? c);
        }
        // Columns were named and no groups: fetch only the data those columns need,
        // so the file holds what was asked for and not every metafield and stock column too.
        if (options.columns?.length && !options.groups) {
          const cols = options.columns;
          options.groups = (e.groups ?? [])
            .filter((g) => {
              const prefix = (g as { columnPrefix?: string }).columnPrefix;
              if (prefix) return cols.some((c) => c.startsWith(prefix));
              if (g.key === "metafields") return cols.some((c) => /^Metafield: /.test(c));
              if (g.key === "variant_metafields") return cols.some((c) => /^Variant Metafield: /.test(c));
              if (g.key === "inventory") return cols.some((c) => /^Inventory .+: /.test(c));
              const word = g.label.split(/[\s&]/)[0].replace(/s$/, "");
              return cols.some((c) => c.startsWith(word));
            })
            .map((g) => g.key);
        }
        return { entity: e.key, options };
      }),
    });
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, e.message);
  }
  const limit = limitOf(auth);
  const refused = limit ? config.entities.map((e) => e.entity).filter((k) => !limit.includes(k)) : [];
  if (refused.length) throw new ApiError(403, `This access key is limited to ${sheetNames(limit!)}: it may not export ${sheetNames(refused)}.`);
  const job = await createExportJob(auth.shop, config, input.format === "xlsx" ? "xlsx" : "csv", input.name || `Via ${auth.name}`);
  return jobView(auth, job.id);
}

export interface ImportRequest {
  file?: File;
  /** Instead of a file: the CSV itself, with the name to recognise it by. */
  csv?: string;
  fileName?: string;
  /** Instead of a file: a link the app downloads. */
  url?: string;
  /** Command for rows without one (UPDATE, MERGE, NEW, REPLACE, DELETE, IGNORE). Default UPDATE: only existing items change. */
  command?: string;
  /** Run for real. Needs a key that allows imports; otherwise it's a preview. */
  apply?: boolean;
  /** "clear": a blank cell empties its field. Default "leave": blanks are ignored, and [clear] in a cell empties that field. */
  blankCells?: string;
  /** Batch mode for sheets of only ID + Metafield columns. */
  batch?: boolean;
  /** Items sent at once, 1-8. */
  concurrency?: number;
}

export function assertCanImport(auth: KeyAuth) {
  if (!auth.canImport) {
    throw new ApiError(403, 'This access key can only preview imports. Open the preview in the app and press "Review and apply", or use a key that allows imports.');
  }
}

export async function startImport(auth: KeyAuth, input: ImportRequest) {
  if (auth.readOnly) throw new ApiError(403, "This access key is read-only: it can export and read results, but not prepare imports.");
  if (input.apply) assertCanImport(auth);
  let options;
  try {
    options = parseImportOptions({ defaultCommand: input.command ? String(input.command).toUpperCase() : "UPDATE", dryRun: !input.apply, onlyEntities: limitOf(auth) ?? undefined, batch: !!input.batch, concurrency: input.concurrency ? Number(input.concurrency) : undefined, blanks: input.blankCells === "clear" ? "clear" : "leave" });
  } catch (e: any) {
    throw new ApiError(400, e.message);
  }
  if (input.url) {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new ApiError(400, "The link is not a valid URL");
    }
    if (!SOURCE_PROTOCOLS.includes(url.protocol)) throw new ApiError(400, "The link must start with https://, ftp://, sftp:// or webdavs://");
    const job = await createUrlImportJob(auth.shop, url.toString(), options);
    return jobView(auth, job.id);
  }
  let file = input.file;
  if (!file && typeof input.csv === "string" && input.csv.trim()) {
    const name = String(input.fileName || "import.csv");
    file = new File([input.csv], /\.csv$/i.test(name) ? name : `${name}.csv`, { type: "text/csv" });
  }
  if (!file || !file.size) throw new ApiError(400, "Send a file, the CSV text, or a link to import");
  if (!/\.(xlsx|xlsm|csv|tsv|txt|zip|xls|xlsb|ods|numbers)$/i.test(file.name)) throw new ApiError(400, "The file must be .xlsx, .ods, .csv, .tsv, .txt or .zip");
  if (file.size > MAX_API_UPLOAD_MB * 1024 * 1024) throw new ApiError(413, `The file is larger than ${MAX_API_UPLOAD_MB} MB`);
  const job = await createImportJob(auth.shop, file, options);
  // The same preview sent twice in a row (a retry, an assistant asking again) is one job, not two.
  if (options.dryRun) {
    const same = await sameUploadBefore(auth.shop, job).catch(() => null);
    if (same) {
      await discardJob(auth.shop, job.id);
      return { ...(await jobView(auth, same.id)), note: "This is the same file with the same settings as a preview started a moment ago: that job is returned, and no second one was started." };
    }
  }
  return jobView(auth, job.id);
}

/**
 * Runs a finished preview for real. Deletions need their own explicit yes, and
 * so do rows the preview flagged (a warning or an emptied field):
 * in the app those start on Skip, and a script gets no quieter way round.
 * `warnings: "skip"` applies the rest and leaves the flagged rows out.
 */
export async function applyPreview(auth: KeyAuth, id: string, confirmDeletes = false, warnings: "confirm" | "skip" | null = null) {
  assertCanImport(auth);
  const preview = await findJob(auth, id);
  const needs = applyNeeds(preview.stats);
  if (needs.deletes && !confirmDeletes) {
    throw new ApiError(409, `This preview would permanently delete ${needs.deletes} item${needs.deletes === 1 ? "" : "s"}. To go ahead, confirm the deletions (API: "confirm_deletes": true; command line: --confirm-deletes).`);
  }
  // Flagged rows, as listed by the preview (a very large file may hold more than it lists).
  const sheets = await readPreview(auth.shop, id);
  const flagged: Record<string, string[]> = {};
  let listed = 0;
  const examples: string[] = [];
  for (const s of sheets) {
    for (const i of s.items) {
      if (previewKind(i) === "failed" || !(i.warnings?.length || i.clears?.length)) continue;
      listed++;
      if (i.key) (flagged[s.sheet] ??= []).push(i.key);
      if (examples.length < 3) examples.push(`row ${i.row}: ${(i.warnings?.[0] ?? `empties ${(i.clears ?? []).join(", ")}`).slice(0, 160)}`);
    }
  }
  const total = Math.max(listed, needs.warned, needs.clearing);
  if (total && !warnings) {
    throw new ApiError(
      409,
      `This preview flags ${total} row${total === 1 ? "" : "s"} that need a decision (${examples.join("; ")}${total > examples.length ? "; …" : ""}). Look at them with the preview, then either apply everything (API: "confirm_warnings": true; command line: --confirm-warnings) or apply the rest and leave those rows out (API: "skip_warnings": true; command line: --skip-warnings).`,
    );
  }
  try {
    if (total && warnings === "skip") {
      if (total > listed) throw new Error(`This file is too large for the preview to list every flagged row (${listed} of ${total} listed), so they can't be left out one by one. Split the file, or confirm the warnings.`);
      const job = await applyDryRun(auth.shop, id, "trusted", flagged);
      return jobView(auth, job.id);
    }
    const job = await applyDryRun(auth.shop, id, "trusted");
    return jobView(auth, job.id);
  } catch (e: any) {
    throw new ApiError(409, e.message);
  }
}

export async function cancel(auth: KeyAuth, id: string) {
  const job = await findJob(auth, id);
  // Nothing to stop: say so, rather than answer as if it had been cancelled.
  if (!["queued", "running", "uploading"].includes(job.status)) {
    return { ...view(job), note: `This job had already ${job.status === "finished" ? "finished" : job.status === "failed" ? "failed" : "been cancelled"}; nothing was cancelled.` };
  }
  await cancelJob(auth.shop, id);
  return jobView(auth, id);
}

async function findJob(who: Who, id: string) {
  const job = await prisma.job.findFirst({ where: { id: String(id), shop: shopOf(who), kind: "job" } });
  if (!job) throw new ApiError(404, "No such job");
  if (!allowedJob(who, job)) throw new ApiError(403, `This access key is limited to ${sheetNames(limitOf(who)!)}, and this job holds other data (${sheetNames(jobEntities(job))}).`);
  return job;
}

type JobRow = Awaited<ReturnType<typeof findJob>>;

function view(job: JobRow) {
  const preview = job.type === "import" && isDryRunConfig(job.config);
  const health = jobHealth({ ...job, dryRun: preview });
  let sheets: unknown[] = [];
  try {
    sheets = JSON.parse(job.stats);
  } catch {
    // leave empty
  }
  return {
    id: job.id,
    type: job.type,
    /** queued | running | finished | failed | cancelled */
    status: job.status === "uploading" ? "queued" : job.status,
    /** An import preview: nothing was changed in the store. */
    preview,
    name: job.name || job.inputName || "",
    outcome: health.label,
    problems: health.problems,
    summary: health.summary,
    error: job.error,
    progress: job.progress,
    total: job.total,
    sheets,
    created_at: job.createdAt.toISOString(),
    finished_at: job.finishedAt?.toISOString() ?? null,
    /** For a finished preview: what importing it for real would do, in numbers. */
    would: preview && job.status === "finished" ? applyNeeds(job.stats) : undefined,
    /** Download link for the result file, valid for one hour. */
    result_url: job.resultFile ? signedDownloadUrl(job.id, "result") : null,
  };
}

export type JobView = ReturnType<typeof view>;

export async function jobView(who: Who, id: string) {
  return view(await findJob(who, id));
}

export async function listJobViews(who: Who, limit = 20) {
  const shop = shopOf(who);
  const jobs = await prisma.job.findMany({
    where: { shop, kind: "job" },
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20)),
  });
  return jobs.filter((j) => allowedJob(who, j)).map(view);
}

/** What a preview would change, per sheet (the first items; the result file has every row). */
export async function previewItems(who: Who, id: string, limit = 50) {
  const shop = shopOf(who);
  const job = await findJob(who, id);
  if (!(job.type === "import" && isDryRunConfig(job.config))) throw new ApiError(409, "This job is not an import preview");
  const sheets = await readPreview(shop, id);
  return sheets.map((s) => ({ sheet: s.sheet, recognised_as: s.entity, items: s.items.slice(0, limit) }));
}

/** The result file on disk, for download. */
export async function resultFile(who: Who, id: string) {
  const job = await findJob(who, id);
  if (!job.resultFile) throw new ApiError(job.status === "finished" ? 410 : 409, job.status === "finished" ? "The result file is no longer kept" : "The job has no result yet");
  const file = resolveStored(job.resultFile);
  if (!fs.existsSync(file)) throw new ApiError(410, "The result file is no longer kept");
  return { file, name: path.basename(file) };
}

/** The first rows of a result, as data (for assistants; people download the file). */
export async function resultRows(who: Who, id: string, limit = 20, sheet?: string) {
  const { file, name } = await resultFile(who, id);
  const rows = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 20));
  const sheets = await readWorkbook(file, name);
  return sheets
    .filter((s) => !sheet || s.name.toLowerCase() === sheet.toLowerCase())
    .map((s) => ({ sheet: s.name, columns: s.headers, total_rows: s.rows.length, rows: s.rows.slice(0, rows) }));
}
