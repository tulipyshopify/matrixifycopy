import fs from "node:fs";
import path from "node:path";
import prisma from "../../db.server";
import { readWorkbook } from "../core/sheets";
import type { ExportOptions } from "../core/types";
import { ENTITIES } from "../entities";
import { isDryRunConfig, jobHealth } from "../jobs/health";
import {
  applyDryRun,
  cancelJob,
  createExportJob,
  createImportJob,
  createUrlImportJob,
  entityCatalog,
  parseExportConfig,
  parseImportOptions,
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
      entities: input.sheets.map(({ sheet, ...options }) => ({ entity: findSheet(sheet).key, options })),
    });
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, e.message);
  }
  const job = await createExportJob(auth.shop, config, input.format === "xlsx" ? "xlsx" : "csv", input.name || `Via ${auth.name}`);
  return jobView(auth.shop, job.id);
}

export interface ImportRequest {
  file?: File;
  /** Instead of a file: the CSV itself, with the name to recognise it by. */
  csv?: string;
  fileName?: string;
  /** Instead of a file: a link the app downloads. */
  url?: string;
  /** Command for rows without one (NEW, MERGE, UPDATE, REPLACE, DELETE, IGNORE). */
  command?: string;
  /** Run for real. Needs a key that allows imports; otherwise it's a preview. */
  apply?: boolean;
  /** Batch mode for sheets of only ID + Metafield columns. */
  batch?: boolean;
  /** Items sent at once, 1-8. */
  concurrency?: number;
}

export function assertCanImport(auth: KeyAuth) {
  if (!auth.canImport) {
    throw new ApiError(403, 'This access key can only preview imports. Open the preview in the app and press "Import for real", or use a key that allows imports.');
  }
}

export async function startImport(auth: KeyAuth, input: ImportRequest) {
  if (input.apply) assertCanImport(auth);
  let options;
  try {
    options = parseImportOptions({ defaultCommand: input.command ? String(input.command).toUpperCase() : undefined, dryRun: !input.apply, batch: !!input.batch, concurrency: input.concurrency ? Number(input.concurrency) : undefined });
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
    return jobView(auth.shop, job.id);
  }
  let file = input.file;
  if (!file && typeof input.csv === "string" && input.csv.trim()) {
    const name = String(input.fileName || "import.csv");
    file = new File([input.csv], /\.csv$/i.test(name) ? name : `${name}.csv`, { type: "text/csv" });
  }
  if (!file || !file.size) throw new ApiError(400, "Send a file, the CSV text, or a link to import");
  if (!/\.(xlsx|csv|zip)$/i.test(file.name)) throw new ApiError(400, "The file must be .xlsx, .csv or .zip");
  if (file.size > MAX_API_UPLOAD_MB * 1024 * 1024) throw new ApiError(413, `The file is larger than ${MAX_API_UPLOAD_MB} MB`);
  const job = await createImportJob(auth.shop, file, options);
  return jobView(auth.shop, job.id);
}

/** Runs a finished preview for real. */
export async function applyPreview(auth: KeyAuth, id: string) {
  assertCanImport(auth);
  await findJob(auth.shop, id);
  try {
    const job = await applyDryRun(auth.shop, id);
    return jobView(auth.shop, job.id);
  } catch (e: any) {
    throw new ApiError(409, e.message);
  }
}

export async function cancel(auth: KeyAuth, id: string) {
  await findJob(auth.shop, id);
  await cancelJob(auth.shop, id);
  return jobView(auth.shop, id);
}

async function findJob(shop: string, id: string) {
  const job = await prisma.job.findFirst({ where: { id: String(id), shop, kind: "job" } });
  if (!job) throw new ApiError(404, "No such job");
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
    /** Download link for the result file, valid for one hour. */
    result_url: job.resultFile ? signedDownloadUrl(job.id, "result") : null,
  };
}

export type JobView = ReturnType<typeof view>;

export async function jobView(shop: string, id: string) {
  return view(await findJob(shop, id));
}

export async function listJobViews(shop: string, limit = 20) {
  const jobs = await prisma.job.findMany({
    where: { shop, kind: "job" },
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20)),
  });
  return jobs.map(view);
}

/** What a preview would change, per sheet (the first items; the result file has every row). */
export async function previewItems(shop: string, id: string, limit = 50) {
  const job = await findJob(shop, id);
  if (!(job.type === "import" && isDryRunConfig(job.config))) throw new ApiError(409, "This job is not an import preview");
  const sheets = await readPreview(shop, id);
  return sheets.map((s) => ({ sheet: s.sheet, recognised_as: s.entity, items: s.items.slice(0, limit) }));
}

/** The result file on disk, for download. */
export async function resultFile(shop: string, id: string) {
  const job = await findJob(shop, id);
  if (!job.resultFile) throw new ApiError(job.status === "finished" ? 410 : 409, job.status === "finished" ? "The result file is no longer kept" : "The job has no result yet");
  const file = resolveStored(job.resultFile);
  if (!fs.existsSync(file)) throw new ApiError(410, "The result file is no longer kept");
  return { file, name: path.basename(file) };
}

/** The first rows of a result, as data (for assistants; people download the file). */
export async function resultRows(shop: string, id: string, limit = 20, sheet?: string) {
  const { file, name } = await resultFile(shop, id);
  const rows = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 20));
  const sheets = await readWorkbook(file, name);
  return sheets
    .filter((s) => !sheet || s.name.toLowerCase() === sheet.toLowerCase())
    .map((s) => ({ sheet: s.name, columns: s.headers, total_rows: s.rows.length, rows: s.rows.slice(0, rows) }));
}
