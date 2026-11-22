import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ImportRisk, PartialPreview, PreviewItem } from "../core/importer";
import prisma from "../../db.server";
import type { Command, DateRange, Entity, ExportOptions, FilterCondition, ImportOptions } from "../core/types";
import { COMMANDS, DATE_PRESETS, DATE_UNITS, MAX_LIST_VALUES, listValues, opsFor } from "../core/types";
import { ENTITIES, getEntity } from "../entities";
import { METAFIELD_FILTER } from "../core/util";
import { INVENTORY_COLUMN } from "../core/exporter";
import type { ExportConfig, ImportConfig } from "./runner.server";
import { EDITS_FILE, PARTIAL_FILE, PREVIEW_FILE, undoFileOf } from "./runner.server";
import { jobDir, openSecret, saveUpload, sealSecret, signedDownloadUrl } from "./storage.server";
import { SOURCE_PROTOCOLS, UPLOAD_PROTOCOLS, redactUrl } from "./sources.server";
import { isValidTimeZone, nextRun } from "./schedule-time";

/** Entity metadata safe to send to the browser. */
export function entityCatalog() {
  return ENTITIES.map((e) => ({
    key: e.key,
    sheet: e.sheet,
    description: e.description,
    groups: e.groups ?? [],
    supportsQuery: !!e.supportsQuery,
    canExport: !!e.export,
    canImport: !!e.import,
    columns: e.columns,
    keyColumns: e.import?.keyColumns ?? [],
    filters: e.filters ?? [],
  }));
}

export type EntityInfo = ReturnType<typeof entityCatalog>[number];

const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

/** Current version of saved export settings (see ExportOptions.v). */
/** Stock quantities Shopify keeps per location. */
export const INVENTORY_KIND_NAMES = ["available", "on_hand", "committed", "reserved", "damaged", "safety_stock", "quality_control", "incoming"];

export const OPTIONS_VERSION = 2;

/** Validates the export form payload into an ExportConfig. */
export function parseExportConfig(raw: unknown): ExportConfig {
  const input = raw as { entities?: Array<{ entity: string; options?: ExportOptions }> };
  if (!input?.entities?.length) throw new Error("Choose at least one sheet to export");
  return {
    entities: input.entities.map(({ entity, options = {} }) => {
      const e = getEntity(entity);
      if (!e?.export) throw new Error(`Cannot export "${entity}"`);
      const o: ExportOptions = { v: OPTIONS_VERSION };
      if (options.query?.trim()) {
        if (!e.supportsQuery) throw new Error(`${e.sheet} does not support filters`);
        o.query = options.query.trim().slice(0, 2000);
      }
      for (const k of ["createdAfter", "createdBefore", "updatedAfter", "updatedBefore"] as const) {
        const v = options[k]?.trim();
        if (v) {
          if (!DATE.test(v)) throw new Error(`Invalid date "${v}"`);
          o[k] = v;
        }
      }
      if (options.groups) {
        const valid = new Set((e.groups ?? []).map((g) => g.key));
        o.groups = options.groups.filter((g) => valid.has(g));
      }
      if (options.filters?.length) o.filters = parseFilters(e, options.filters);
      if (options.dateRange) o.dateRange = parseDateRange(e, options.dateRange);
      for (const k of ["locations", "metafields", "variantMetafields"] as const) {
        const list = options[k];
        if (!Array.isArray(list)) continue;
        const clean = [...new Set(list.map((v) => String(v).trim().slice(0, 200)).filter(Boolean))].slice(0, 250);
        if (k !== "locations") {
          for (const m of clean) if (!/^[^.\s]+\.[^\s]+$/.test(m)) throw new Error(`${e.sheet}: metafield "${m}" must look like namespace.key`);
        }
        if (clean.length) o[k] = clean;
        else if (k === "locations") throw new Error(`${e.sheet}: choose at least one inventory location, or untick Inventory by location`);
      }
      if (Array.isArray(options.inventoryKinds) && (e.groups ?? []).some((g) => g.key === "inventory")) {
        const kinds = INVENTORY_KIND_NAMES.filter((k) => options.inventoryKinds!.includes(k));
        if (kinds.length) o.inventoryKinds = kinds;
      }
      if (options.columns) {
        const valid = new Set(e.columns);
        // "Metafield: namespace.key" places a named metafield among the columns.
        const named = new Set([
          ...(o.metafields ?? []).map((m) => `Metafield: ${m}`),
          ...(o.variantMetafields ?? []).map((m) => `Variant Metafield: ${m}`),
        ]);
        // Stock columns ("Inventory Available: Main") can be placed too.
        const stock = (e.groups ?? []).some((g) => g.key === "inventory");
        o.columns = options.columns
          .map((c) => String(c).slice(0, 300))
          .filter((c) => valid.has(c) || named.has(c) || (stock && INVENTORY_COLUMN.test(c)))
          .slice(0, 2000);
        if (!o.columns.some((c) => valid.has(c))) throw new Error(`${e.sheet}: choose at least one column`);
      }
      if (options.limit) o.limit = Math.max(1, Math.floor(Number(options.limit)));
      return { entity: e.key, options: o };
    }),
  };
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Validates a date range against the entity's date filter fields. */
export function parseDateRange(e: Entity, r: DateRange): DateRange | undefined {
  const field = (e.filters ?? []).find((f) => f.key === r.field && f.type === "date");
  if (!field) throw new Error(`${e.sheet}: can't filter by date "${r.field}"`);
  if (!DATE_PRESETS.some((p) => p.value === r.preset) && (r.preset as string) !== "last_n_days") throw new Error(`${e.sheet}: unknown date range`);
  // Taken from the field's definition, never from the request.
  const searchBy = field.searchBy ? { searchBy: field.searchBy } : {};
  // "Last N days" from older set-ups is the same as "last N" with days.
  const preset = (r.preset as string) === "last_n_days" ? "last_n" : r.preset;
  if (preset === "last_n") {
    const unit = r.preset === "last_n" ? (r.unit ?? "days") : "days";
    if (!DATE_UNITS.includes(unit)) throw new Error(`${field.label}: choose minutes, hours, days or months`);
    const amount = Math.floor(Number(r.preset === "last_n" ? r.amount : r.days));
    if (!(amount >= 1 && amount <= 100000)) throw new Error(`${field.label}: enter how many ${unit}, from 1 to 100000`);
    return { field: r.field, preset: "last_n", amount, unit, ...searchBy };
  }
  if (r.preset !== "custom") return { field: r.field, preset: r.preset, ...searchBy };
  const from = r.from?.trim() || undefined;
  const to = r.to?.trim() || undefined;
  for (const d of [from, to]) if (d && !DATE.test(d)) throw new Error(`${field.label}: "${d}" is not a date`);
  if (!from && !to) return undefined;
  if (from && to && from > to) throw new Error(`${field.label}: the start date is after the end date`);
  return { field: r.field, preset: "custom", from, to, ...searchBy };
}

/** Validates filter rows against the entity's filter fields. */
export function parseFilters(e: Entity, raw: FilterCondition[]): FilterCondition[] {
  const fields = new Map((e.filters ?? []).map((f) => [f.key, f]));
  return raw.slice(0, 30).map((f) => {
    const field = fields.get(f.field);
    if (!field) throw new Error(`${e.sheet}: unknown filter "${f.field}"`);
    if (!opsFor(field).includes(f.op)) throw new Error(`${field.label}: unsupported condition`);
    const value = String(f.value ?? "").trim().slice(0, 500);
    const value2 = f.op === "between" ? String(f.value2 ?? "").trim().slice(0, 500) : undefined;
    const check = (v: string) => {
      if (!v) throw new Error(`${field.label}: enter a value`);
      if (field.type === "number" && !NUMBER.test(v)) throw new Error(`${field.label}: "${v}" is not a number`);
      if (field.type === "date" && !DATE.test(v)) throw new Error(`${field.label}: "${v}" is not a date`);
      if (field.type === "boolean" && v !== "true" && v !== "false") throw new Error(`${field.label}: choose yes or no`);
      if (field.type === "id" && !/^(\d+|gid:\/\/shopify\/\w+\/\d+)$/.test(v)) throw new Error(`${field.label}: "${v}" is not an ID`);
    };
    if ((f.op === "any_of" && field.type !== "enum") || f.op === "starts_with_any") {
      // A list: one value per line or separated by commas.
      const values = listValues(String(f.value ?? "").slice(0, 50_000)).map((v) => (field.type === "id" ? v.replace(/^gid:\/\/shopify\/\w+\//, "") : v));
      if (!values.length) throw new Error(`${field.label}: enter at least one value`);
      if (values.length > MAX_LIST_VALUES) throw new Error(`${field.label}: at most ${MAX_LIST_VALUES} values in one filter (${values.length} given)`);
      for (const v of values) if (field.type === "id" && !/^\d+$/.test(v)) throw new Error(`${field.label}: "${v}" is not an ID`);
      return {
        field: field.key,
        op: f.op,
        value: values.join(","),
        ...(field.local ? { local: true } : {}),
      };
    }
    if (field.type === "enum") {
      const allowed = new Set(field.options?.map((o) => o.value));
      const values = value.split(",").map((v) => v.trim()).filter(Boolean);
      if (!values.length) throw new Error(`${field.label}: choose a value`);
      for (const v of values) if (!allowed.has(v)) throw new Error(`${field.label}: "${v}" is not allowed`);
    } else {
      check(value);
    }
    if (value2 !== undefined) check(value2);
    if (field.key === "metafield" && !METAFIELD_FILTER.test(value)) throw new Error(`${field.label}: write it as namespace.key=value`);
    const id = field.type === "id" ? value.replace(/^gid:\/\/shopify\/\w+\//, "") : value;
    return {
      field: field.key,
      op: f.op,
      value: id,
      ...(value2 !== undefined ? { value2 } : {}),
      // Taken from the field's definition, never from the request.
      ...(field.local ? { local: true } : {}),
      ...(field.local && field.searchBy ? { searchBy: field.searchBy } : {}),
    };
  });
}

export function parseImportOptions(raw: unknown): ImportOptions {
  const input = (raw ?? {}) as ImportOptions;
  const o: ImportOptions = {};
  if (input.defaultCommand) {
    if (!COMMANDS.includes(input.defaultCommand as Command)) throw new Error("Invalid default command");
    o.defaultCommand = input.defaultCommand;
  }
  if (input.dryRun) o.dryRun = true;
  if (input.batch) o.batch = true;
  if (input.hold) o.hold = true;
  if (input.concurrency) o.concurrency = Math.min(8, Math.max(1, Math.floor(Number(input.concurrency))));
  // Blank cells leave fields alone unless the person chose otherwise ([clear] in a cell always empties it).
  o.blanks = input.blanks === "clear" ? "clear" : "leave";
  return o;
}

export async function createExportJob(shop: string, config: ExportConfig, format: string, name = "") {
  return prisma.job.create({
    data: { shop, type: "export", config: JSON.stringify(config), format: format === "csv" ? "csv" : "xlsx", name: name.slice(0, 100) },
  });
}

export async function createImportJob(shop: string, file: File, options: ImportOptions) {
  const job = await prisma.job.create({
    data: { shop, type: "import", config: JSON.stringify({ options } satisfies ImportConfig), status: "uploading", inputName: file.name },
  });
  try {
    const path = await saveUpload(shop, job.id, file);
    return prisma.job.update({ where: { id: job.id }, data: { inputFile: path, status: "queued" } });
  } catch (e) {
    await prisma.job.update({ where: { id: job.id }, data: { status: "failed", error: "Upload failed" } });
    throw e;
  }
}

const fileHash = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });

/**
 * A job made from the very same file with the same settings in the last few
 * minutes (a double click, an upload sent twice): the earlier job, if it is
 * still waiting, running, or a finished preview. Null otherwise.
 */
export async function sameUploadBefore(shop: string, job: { id: string; config: string; inputFile: string | null; inputName: string | null }, withinMs = 10 * 60_000) {
  if (!job.inputFile) return null;
  const size = (await fs.promises.stat(job.inputFile)).size;
  const earlier = await prisma.job.findMany({
    where: { shop, type: "import", kind: "job", id: { not: job.id }, inputName: job.inputName, config: job.config, createdAt: { gte: new Date(Date.now() - withinMs) }, status: { in: ["queued", "running", "finished"] } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  let hash = "";
  for (const e of earlier) {
    try {
      if (!e.inputFile || (await fs.promises.stat(e.inputFile)).size !== size) continue;
      hash ||= await fileHash(job.inputFile);
      if ((await fileHash(e.inputFile)) === hash) return e;
    } catch {
      // that job's file is gone: not the same upload any more
    }
  }
  return null;
}

/** Takes back a job that was only just made (its row and its files). */
export async function discardJob(shop: string, id: string) {
  await prisma.job.deleteMany({ where: { id, shop } });
  await fs.promises.rm(jobDir(shop, id), { recursive: true, force: true }).catch(() => {});
}

/** Creates an import job that downloads its file from a URL when it runs. */
export async function createUrlImportJob(shop: string, url: string, options: ImportOptions) {
  // A one-off schedule (disabled) carries the URL so the worker can fetch it.
  const schedule = await prisma.schedule.create({
    data: {
      shop,
      name: `Import from URL`,
      type: "import",
      config: JSON.stringify({ options }),
      sourceUrl: sealSecret(url),
      intervalMinutes: 0,
      nextRunAt: new Date("9999-01-01T00:00:00Z"),
      enabled: false,
    },
  });
  return prisma.job.create({
    data: { shop, type: "import", config: JSON.stringify({ options }), scheduleId: schedule.id, name: "Import from URL" },
  });
}

export type JobFilter = "all" | "export" | "import" | "problems" | "scheduled";

/** Where-clause for the job history filters. */
function jobFilter(filter: JobFilter) {
  switch (filter) {
    case "export":
      return { type: "export" };
    case "import":
      return { type: "import" };
    case "problems":
      return { OR: [{ status: "failed" }, { status: "finished", problems: { gt: 0 } }] };
    case "scheduled":
      return { scheduleId: { not: null } };
    default:
      return {};
  }
}

/** Jobs matching a history filter, newest first. */
export function countJobs(shop: string, filter: JobFilter = "all") {
  return prisma.job.count({ where: { shop, kind: "job", ...jobFilter(filter) } });
}

export function listJobs(shop: string, take = 50, filter: JobFilter = "all") {
  return prisma.job.findMany({
    where: { shop, kind: "job", ...jobFilter(filter) },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      type: true,
      status: true,
      name: true,
      format: true,
      inputName: true,
      progress: true,
      total: true,
      createdAt: true,
      finishedAt: true,
      resultFile: true,
      error: true,
      config: true,
      stats: true,
      startedAt: true,
      scheduleId: true,
      problems: true,
      reviewedAt: true,
    },
  });
}

/** Numbers for the home dashboard: the last 7 days at a glance. */
export async function homeStats(shop: string, now = new Date()) {
  const since = new Date(now.getTime() - 7 * 86400_000);
  const week = await prisma.job.findMany({
    where: { shop, kind: "job", createdAt: { gte: since } },
    select: { type: true, status: true, stats: true, problems: true, config: true },
  });
  let exported = 0;
  let changed = 0;
  for (const j of week) {
    if (j.status !== "finished") continue;
    let stats: any[] = [];
    try {
      stats = JSON.parse(j.stats);
    } catch {
      // unreadable stats count as nothing
    }
    if (j.type === "export") exported += stats.reduce((n, s) => n + (Number(s?.items) || 0), 0);
    // Previews change nothing.
    else if (!j.config.includes('"dryRun":true')) changed += stats.reduce((n, s) => n + (Number(s?.ok) || 0), 0);
  }
  const [backupSchedule, everRan, nextSchedule, lastBackup] = await Promise.all([
    prisma.schedule.findFirst({ where: { shop, kind: "backup" }, select: { enabled: true, nextRunAt: true } }),
    prisma.job.count({ where: { shop } }),
    prisma.schedule.findFirst({ where: { shop, kind: "job", enabled: true, intervalMinutes: { gt: 0 } }, orderBy: { nextRunAt: "asc" }, select: { name: true, nextRunAt: true } }),
    prisma.job.findFirst({ where: { shop, kind: "backup", status: "finished" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  return {
    exports: week.filter((j) => j.type === "export").length,
    // A preview changes nothing, so it is not counted as an import.
    imports: week.filter((j) => j.type === "import" && !j.config.includes('"dryRun":true')).length,
    previews: week.filter((j) => j.type === "import" && j.config.includes('"dryRun":true')).length,
    exported,
    changed,
    problems: week.filter((j) => j.status === "failed" || (j.status === "finished" && j.problems > 0)).length,
    firstRun: everRan === 0,
    nextSchedule,
    lastBackupAt: lastBackup?.createdAt ?? null,
    backupOn: !!backupSchedule?.enabled,
    nextBackupAt: backupSchedule?.enabled ? backupSchedule.nextRunAt : null,
  };
}

/** Days a failed job keeps asking for attention on the home screen. */
const ATTENTION_DAYS = 14;

/** Jobs that failed or finished with problems and nobody has opened since. */
export function needsAttention(shop: string) {
  return prisma.job.findMany({
    where: {
      shop,
      kind: { not: "check" },
      reviewedAt: null,
      // A preview that finds problems is the preview doing its job. Only one that
      // a schedule is holding for approval asks for attention.
      NOT: { AND: [{ config: { contains: '"dryRun":true' } }, { NOT: { config: { contains: '"autoApply":true' } } }] },
      createdAt: { gte: new Date(Date.now() - ATTENTION_DAYS * 86400_000) },
      OR: [{ status: "failed" }, { status: "finished", problems: { gt: 0 } }],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, type: true, status: true, name: true, inputName: true, config: true, stats: true, error: true, createdAt: true, scheduleId: true },
  });
}

/** Marks a job (or every job of the store) as seen, so it stops asking for attention. */
export async function markReviewed(shop: string, id?: string) {
  await prisma.job.updateMany({ where: { shop, reviewedAt: null, ...(id ? { id } : {}) }, data: { reviewedAt: new Date() } });
}

export interface ScheduleHealth {
  /** Status of the most recent run, null if it never ran. */
  last: { id: string; status: string; problems: number; finishedAt: Date | null; error: string | null } | null;
  /** Runs in a row (newest first) that failed or had problems. */
  failingStreak: number;
  /** Enabled, and its run time is more than 30 minutes past. */
  overdue: boolean;
}

/** Last run, failing streak and overdue flag for each of a store's schedules. */
export async function scheduleHealth(shop: string, schedules: Array<{ id: string; enabled: boolean; nextRunAt: Date }>, now = new Date()) {
  const runs = await prisma.job.findMany({
    where: { shop, scheduleId: { in: schedules.map((s) => s.id) }, createdAt: { gte: new Date(now.getTime() - 60 * 86400_000) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, scheduleId: true, status: true, problems: true, finishedAt: true, error: true },
  });
  const out: Record<string, ScheduleHealth> = {};
  for (const s of schedules) {
    const mine = runs.filter((r) => r.scheduleId === s.id && r.status !== "queued" && r.status !== "running");
    let failingStreak = 0;
    for (const r of mine) {
      if (r.status === "failed" || (r.status === "finished" && r.problems > 0)) failingStreak++;
      else break;
    }
    const last = mine[0] ?? null;
    out[s.id] = {
      last: last ? { id: last.id, status: last.status, problems: last.problems, finishedAt: last.finishedAt, error: last.error } : null,
      failingStreak,
      overdue: s.enabled && s.nextRunAt.getTime() < now.getTime() - 30 * 60_000,
    };
  }
  return out;
}

/** Days an export stays in the history (and its file on the server). */
export const EXPORT_HISTORY_DAYS = Number(process.env.EXPORT_HISTORY_DAYS ?? 90);

export const HISTORY_CHOICES = [7, 30, 90, 365];

/** A store's own history length (Settings), else the server's default. */
export async function historyDays(shop: string): Promise<number> {
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { historyDays: true } });
  return s?.historyDays ?? EXPORT_HISTORY_DAYS;
}

/**
 * Removes exports older than the history period, with their files. The newest
 * finished run of each schedule is kept, so its permanent link keeps working
 * even when the schedule runs less often than the period.
 */
export async function clearOldExports(days?: number, now = new Date()): Promise<number> {
  // Each store keeps its own number of days (Settings); `days` forces one for all.
  const perShop = new Map((days === undefined ? await prisma.shopSetting.findMany({ select: { shop: true, historyDays: true } }) : []).map((s) => [s.shop, s.historyDays]));
  const daysFor = (shop: string) => days ?? perShop.get(shop) ?? EXPORT_HISTORY_DAYS;
  const shortest = Math.min(days ?? EXPORT_HISTORY_DAYS, ...perShop.values());
  if (!(shortest > 0)) return 0;
  const candidates = await prisma.job.findMany({
    where: { type: "export", kind: "job", status: { in: ["finished", "failed", "cancelled"] }, createdAt: { lt: new Date(now.getTime() - shortest * 86400_000) } },
    select: { id: true, shop: true, scheduleId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 2000,
  });
  const old = candidates.filter((j) => daysFor(j.shop) > 0 && j.createdAt.getTime() < now.getTime() - daysFor(j.shop) * 86400_000);
  const keep = new Set<string>();
  for (const scheduleId of new Set(old.map((j) => j.scheduleId).filter((x): x is string => !!x))) {
    const newest = await prisma.job.findFirst({
      where: { scheduleId, status: "finished", resultFile: { not: null } },
      orderBy: { finishedAt: "desc" },
      select: { id: true },
    });
    if (newest) keep.add(newest.id);
  }
  let removed = 0;
  for (const j of old) {
    if (keep.has(j.id)) continue;
    await fs.promises.rm(jobDir(j.shop, j.id), { recursive: true, force: true }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: j.id } });
    removed++;
  }
  return removed;
}

export async function getJob(shop: string, id: string) {
  const job = await prisma.job.findFirst({ where: { id, shop } });
  if (!job) throw new Response("Not found", { status: 404 });
  return job;
}

export async function cancelJob(shop: string, id: string) {
  const job = await getJob(shop, id);
  if (job.status === "queued") {
    await prisma.job.update({ where: { id }, data: { status: "cancelled", finishedAt: new Date() } });
  } else if (job.status === "running") {
    await prisma.job.update({ where: { id }, data: { cancelRequested: true } });
  }
}

/**
 * Queues a finished job again. An export simply runs again. An import always
 * comes back as a preview: the store may have changed since, so nothing is
 * written again without a fresh look and the confirmations.
 */
export async function rerunJob(shop: string, id: string) {
  const job = await getJob(shop, id);
  let config = job.config;
  if (job.type === "import") {
    try {
      const parsed = JSON.parse(job.config) as ImportConfig;
      // What belonged to the earlier run (its preview, its skipped rows) doesn't carry over.
      const { previewOf: _p, exclude: _x, expectedFailed: _f, stopAtFailedPercent: _s, ...rest } = parsed;
      config = JSON.stringify({ ...rest, options: { ...parsed.options, dryRun: true } });
    } catch {
      throw new Error("This job's settings can't be read");
    }
  }
  const again = await prisma.job.create({
    data: {
      shop,
      type: job.type,
      config,
      format: job.format,
      name: job.name,
      inputFile: job.inputFile,
      inputName: job.inputName,
      scheduleId: job.scheduleId,
      kind: job.kind,
    },
  });
  // Rows corrected on the earlier preview's page stay corrected when the same file is previewed again.
  if (job.type === "import" && job.inputFile) {
    await fs.promises.copyFile(path.join(jobDir(shop, job.id), EDITS_FILE), path.join(jobDir(shop, again.id), EDITS_FILE)).catch(() => {});
  }
  return again;
}

/** What a person must agree to before a preview is imported for real. */
export interface ApplyNeeds {
  /** Items that would change something (created, updated, deleted, replaced). */
  changes: number;
  creates: number;
  updates: number;
  deletes: number;
  unchanged: number;
  /** Items that would empty at least one field. */
  clearing: number;
  /** Items with a warning. */
  warned: number;
  /** Items that would fail and are skipped by the import. */
  failing: number;
  /** Sheets that are not imported at all, with why. */
  skippedSheets: Array<{ sheet: string; rows: number; reason: string }>;
}

/** Works out what needs confirming from a finished preview's stats (which cover every item). */
export function applyNeeds(stats: unknown): ApplyNeeds {
  const needs: ApplyNeeds = { changes: 0, creates: 0, updates: 0, deletes: 0, unchanged: 0, clearing: 0, warned: 0, failing: 0, skippedSheets: [] };
  let list: any[] = [];
  try {
    list = typeof stats === "string" ? JSON.parse(stats) : ((stats as any[]) ?? []);
  } catch {
    list = [];
  }
  for (const s of list) {
    needs.failing += Number(s?.failed) || 0;
    if (s?.entity === null) {
      const rows = Number(s.skipped) || 0;
      if (rows) needs.skippedSheets.push({ sheet: String(s.sheet), rows, reason: String((s.warnings ?? []).find((w: string) => w.startsWith("Not imported: ")) ?? "").replace(/^Not imported: /, "") });
      continue;
    }
    const r = s?.risk;
    if (r) {
      needs.creates += r.creates || 0;
      needs.updates += r.updates || 0;
      needs.deletes += r.deletes || 0;
      needs.unchanged += r.unchanged || 0;
      needs.clearing += r.clearing || 0;
      needs.warned += r.warned || 0;
    } else {
      // A preview made before risks were recorded: every OK item counts as a change.
      needs.updates += Number(s?.ok) || 0;
    }
  }
  needs.changes = needs.creates + needs.updates + needs.deletes;
  return needs;
}

function expectedFailed(stats: string): Record<string, number> {
  try {
    return Object.fromEntries((JSON.parse(stats) as Array<{ sheet: string; failed?: number }>).filter((s) => s.failed).map((s) => [s.sheet, s.failed!]));
  } catch {
    return {};
  }
}

export async function undoOnStop(shop: string): Promise<boolean> {
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { undoOnStop: true } });
  return !!s?.undoOnStop;
}

/** The store's "stop when more than this share of rows fail" setting (0 = never). */
export async function failStopPercent(shop: string): Promise<number> {
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { failStopPercent: true } });
  return s?.failStopPercent ?? 5;
}

/**
 * Starts the undo of a finished import: a preview of the file that import
 * recorded, which puts back the values it changed. Like any preview, nothing
 * changes until it is applied.
 */
export async function startUndo(shop: string, id: string, opts: { apply?: boolean } = {}) {
  const job = await getJob(shop, id);
  if (job.type !== "import" || isDryRunJob(job.config)) throw new Error("Only an import can be undone");
  const file = undoFileOf(jobDir(shop, id));
  if (!file) throw new Error("This import has nothing recorded to undo (it changed nothing, or its record has been cleared).");
  return prisma.job.create({
    data: {
      shop,
      type: "import",
      // `apply`: straight away, without a preview (used when an import is stopped and set to undo itself).
      config: JSON.stringify({ options: { ...(opts.apply ? {} : { dryRun: true }), defaultCommand: "UPDATE" }, undoOf: id } satisfies ImportConfig),
      name: `Undo of ${job.name || job.inputName || "import"}`.slice(0, 100),
      inputFile: file,
      // A single CSV is named after its data type inside the zip writer ("Undo_Customers.csv"…): the type is in the name.
      inputName: path.basename(file),
    },
  });
}

const isDryRunJob = (config: string) => {
  try {
    return !!JSON.parse(config)?.options?.dryRun;
  } catch {
    return false;
  }
};

/** How an item of a preview is treated when deciding what needs a person's say-so. */
export type PreviewKind = "delete" | "create" | "look" | "update" | "none" | "failed";

/**
 * Deletions, new items and anything with a warning or an emptied field are
 * "risky": each needs its own Include or Skip before an import, and starts
 * out as Skip.
 */
export function previewKind(i: Pick<PreviewItem, "action" | "deletes" | "warnings" | "clears">): PreviewKind {
  if (i.action === "failed" || i.action === "skipped") return "failed";
  if (i.action === "none") return "none";
  if (i.action === "delete" || i.action === "replace" || i.deletes) return "delete";
  if (i.action === "create") return "create";
  if (i.warnings?.length || i.clears?.length) return "look";
  return "update";
}
export const isRisky = (k: PreviewKind) => k === "delete" || k === "create" || k === "look";

/** The decisions made on the preview page (or by an API caller). */
export interface ApplyConfirm {
  /** Items to leave out, by sheet name then item key. */
  exclude?: Record<string, string[]>;
  /** Risky items the person chose to include, by sheet name then item key. */
  include?: Record<string, string[]>;
  /** For deletions that are included: the word DELETE, typed. */
  deletes?: string;
  /** A yes to the risky items of a very large file that the preview has no room to list one by one. */
  rest?: boolean;
}

/**
 * Runs a dry-run import for real: same file, same options, without the dry run.
 * Uses the file the preview was made from, even when it came from a link.
 * Every risky item listed in the preview (a deletion, a new item, a warning,
 * an emptied field) must have been given an Include or a Skip; included
 * deletions need the typed word DELETE. The check is made here as well as on
 * the page, so no route can skip it.
 */
export async function applyDryRun(shop: string, id: string, confirm: ApplyConfirm | "trusted" = {}, leaveOut?: Record<string, string[]>) {
  const job = await getJob(shop, id);
  let config: ImportConfig;
  try {
    config = JSON.parse(job.config);
  } catch {
    throw new Error("This job's settings can't be read");
  }
  if (job.type !== "import" || !config.options?.dryRun) throw new Error("Only a dry run can be applied");
  if (job.status !== "finished") throw new Error("Wait for the dry run to finish");
  if (!job.inputFile) throw new Error("The previewed file is no longer available. Import it again.");
  const needs = applyNeeds(job.stats);
  if (!needs.changes) throw new Error("There is nothing to import: the preview found no changes to make.");
  let exclude: Record<string, string[]> | undefined = leaveOut && Object.keys(leaveOut).length ? leaveOut : undefined;
  if (confirm !== "trusted") {
    const sheets = await readPreview(shop, id);
    const out = new Map<string, Set<string>>(Object.entries(confirm.exclude ?? {}).map(([k, v]) => [k, new Set(v)]));
    const inc = new Map<string, Set<string>>(Object.entries(confirm.include ?? {}).map(([k, v]) => [k, new Set(v)]));
    let changes = needs.changes;
    let deletes = needs.deletes;
    let undecided = 0;
    // `flags` counts as the totals do: one for an item's warnings, one for its emptied fields, whatever else it is.
    const listed = { delete: 0, create: 0, look: 0, flags: 0 };
    for (const s of sheets) {
      for (const i of s.items) {
        const kind = previewKind(i);
        if (kind === "failed" || kind === "none") continue;
        const skipped = !!i.key && out.get(s.sheet)?.has(i.key);
        listed.flags += (i.warnings?.length ? 1 : 0) + (i.clears?.length ? 1 : 0);
        if (isRisky(kind)) {
          listed[kind as "delete"]++;
          if (!skipped && !(i.key && inc.get(s.sheet)?.has(i.key))) undecided++;
        }
        if (skipped) {
          changes--;
          if (kind === "delete") deletes--;
        }
      }
    }
    if (undecided) throw new Error(`Before importing: choose Include or Skip for ${undecided} item${undecided === 1 ? "" : "s"} that need a decision (new items, deletions, warnings or emptied fields).`);
    // Risky items of a very large file beyond what the preview lists.
    const unlisted = Math.max(0, needs.deletes - listed.delete) + Math.max(0, needs.creates - listed.create) + Math.max(0, needs.clearing + needs.warned - listed.flags);
    if (unlisted && !confirm.rest) throw new Error(`Before importing: ${unlisted} more item${unlisted === 1 ? "" : "s"} would create, delete or empty something and are not listed one by one. Confirm them, or split the file.`);
    if (deletes > 0 && (confirm.deletes ?? "").trim().toUpperCase() !== "DELETE") throw new Error(`Before importing: type DELETE to confirm ${deletes} deletion${deletes === 1 ? "" : "s"}.`);
    if (changes <= 0) throw new Error("Every change is set to Skip, so there is nothing to import. Include at least one.");
    exclude = Object.fromEntries([...out].map(([k, v]) => [k, [...v]]).filter(([, v]) => (v as string[]).length));
  }
  const { dryRun: _d, ...options } = config.options;
  return prisma.job.create({
    data: {
      shop,
      type: "import",
      // previewOf: the import compares each item with what this preview saw.
      config: JSON.stringify({
        ...config,
        options,
        previewOf: job.id,
        ...(exclude && Object.keys(exclude).length ? { exclude } : {}),
        // Rows the preview said would fail are expected; more than a few beyond them stops the import.
        expectedFailed: expectedFailed(job.stats),
        stopAtFailedPercent: await failStopPercent(shop),
      }),
      format: job.format,
      name: job.name,
      inputFile: job.inputFile,
      inputName: job.inputName,
    },
  });
}

/** A dry run's preview, if it has one. */
export interface PreviewSheet {
  sheet: string;
  entity: string | null;
  items: PreviewItem[];
  risk?: ImportRisk;
  warnings?: string[];
}

export async function readPreview(shop: string, id: string): Promise<PreviewSheet[]> {
  try {
    const sheets = JSON.parse(await fs.promises.readFile(path.join(jobDir(shop, id), PREVIEW_FILE), "utf8")) as Array<PreviewSheet & { seen?: unknown }>;
    // `seen` is for the import that follows, not for the page. A very long list of changes on one
    // item is cut for the page (the results file has everything), so the page stays quick to open.
    const MAX_LINES = 60;
    return sheets.map(({ seen: _seen, ...s }) => ({
      ...s,
      ...(s.items ? { items: s.items.map((i) => (i.changes.length > MAX_LINES ? { ...i, changes: [...i.changes.slice(0, MAX_LINES), `…and ${(i.changes.length - MAX_LINES).toLocaleString("en-GB")} more changes on this item`] } : i)) } : {}),
    }));
  } catch {
    return [];
  }
}

/** A running preview's first look: the first items checked and running totals (empty until there is one). */
export async function readPartialPreview(shop: string, id: string): Promise<PartialPreview[]> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(jobDir(shop, id), PARTIAL_FILE), "utf8")) as PartialPreview[];
  } catch {
    return [];
  }
}

export function downloadLinks(job: { id: string; resultFile: string | null; inputFile: string | null }) {
  return {
    result: job.resultFile ? signedDownloadUrl(job.id, "result") : null,
    input: job.inputFile ? signedDownloadUrl(job.id, "input") : null,
  };
}

// --- Schedules ---------------------------------------------------------------

export interface ScheduleInput {
  name: string;
  type: "export" | "import";
  config: ExportConfig | ImportConfig;
  format?: string;
  sourceUrl?: string;
  uploadUrl?: string;
  /** Exact local time for daily / weekly schedules: "HH:MM", IANA zone, weekday (0 = Sunday, weekly only). */
  runAt?: string;
  timezone?: string;
  weekday?: number | null;
  /** Export schedules: create the permanent link to the latest file. */
  publicLink?: boolean;
  intervalMinutes: number;
  startAt?: string;
}

function checkUrl(u: string | undefined, protocols: string[], what: string): string | null {
  if (!u?.trim()) return null;
  let url: URL;
  try {
    url = new URL(u.trim());
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) {
    const names = [...new Set(protocols.map((x) => (x.startsWith("dav") ? "webdav" + x.slice(3) : x)))].map((x) => `${x}//`);
    throw new Error(`${what} must start with ${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);
  }
  return url.toString();
}

/** Checks a schedule's settings and works out its exact run time, if it has one. */
function scheduleSettings(input: ScheduleInput) {
  const interval = Math.floor(Number(input.intervalMinutes));
  if (!(interval >= 15)) throw new Error("Interval must be at least 15 minutes");
  const sourceUrl = checkUrl(input.sourceUrl, SOURCE_PROTOCOLS, "Source URL");
  const uploadUrl = checkUrl(input.uploadUrl, UPLOAD_PROTOCOLS, "Upload URL");
  // Exact time of day (daily and weekly schedules only).
  let timing: { runAt: string; timezone: string; weekday: number | null } | null = null;
  if (input.runAt?.trim()) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(input.runAt.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error("Enter the time as HH:MM, for example 07:30");
    if (interval < 1440) throw new Error("An exact time needs a daily or weekly schedule");
    if (!input.timezone || !isValidTimeZone(input.timezone)) throw new Error("Unknown time zone");
    const weekday = interval >= 10080 && input.weekday !== null && input.weekday !== undefined ? Number(input.weekday) : null;
    if (weekday !== null && !(weekday >= 0 && weekday <= 6)) throw new Error("Invalid weekday");
    timing = { runAt: `${m[1].padStart(2, "0")}:${m[2]}`, timezone: input.timezone, weekday };
  }
  return { interval, sourceUrl, uploadUrl, timing };
}

export async function createSchedule(shop: string, input: ScheduleInput) {
  const { interval, sourceUrl, uploadUrl, timing } = scheduleSettings(input);
  if (input.type === "import" && !sourceUrl) throw new Error("Scheduled imports need a source URL");
  let start = input.startAt ? new Date(input.startAt) : new Date();
  if (Number.isNaN(start.getTime())) throw new Error("Invalid start time");
  if (timing) start = nextRun({ intervalMinutes: interval, ...timing }, new Date());
  return prisma.schedule.create({
    data: {
      shop,
      name: input.name.slice(0, 100) || (input.type === "export" ? "Scheduled export" : "Scheduled import"),
      type: input.type,
      config: JSON.stringify(input.config),
      format: input.format === "csv" ? "csv" : "xlsx",
      sourceUrl: sealSecret(sourceUrl),
      uploadUrl: sealSecret(uploadUrl),
      intervalMinutes: interval,
      ...(timing ?? {}),
      nextRunAt: start,
      // The permanent link is chosen when the schedule is saved and can be
      // turned on or off later on the Schedules page.
      publicToken: input.type === "export" && input.publicLink ? newPublicToken() : null,
    },
  });
}

/**
 * Changes an existing schedule in place: its permanent link, run history and
 * paused state stay as they are. A URL sent back exactly as it was shown
 * (password hidden) means "keep the saved one".
 */
export async function editSchedule(shop: string, id: string, input: ScheduleInput) {
  const s = await prisma.schedule.findFirst({ where: { id, shop } });
  if (!s) throw new Response("Not found", { status: 404 });
  if (s.type !== input.type) throw new Error(`This schedule is an ${s.type}, not an ${input.type}`);
  const kept = (sealed: string | null, sent: string | undefined) => {
    const current = openSecret(sealed);
    return current && sent?.trim() === redactUrl(current) ? current : sent;
  };
  const { interval, sourceUrl, uploadUrl, timing } = scheduleSettings({
    ...input,
    sourceUrl: kept(s.sourceUrl, input.sourceUrl),
    uploadUrl: kept(s.uploadUrl, input.uploadUrl),
  });
  if (s.type === "import" && !sourceUrl) throw new Error("Scheduled imports need a source URL");
  // The next run only moves when the timing itself was changed.
  const sameTiming =
    s.intervalMinutes === interval &&
    (s.runAt ?? null) === (timing?.runAt ?? null) &&
    (s.weekday ?? null) === (timing?.weekday ?? null) &&
    (!timing || s.timezone === timing.timezone);
  const now = new Date();
  const nextRunAt = sameTiming ? s.nextRunAt : nextRun({ intervalMinutes: interval, ...(timing ?? {}) }, now, timing ? undefined : now);
  return prisma.schedule.update({
    where: { id },
    data: {
      name: input.name.slice(0, 100) || s.name,
      config: JSON.stringify(input.config),
      format: input.format === "csv" ? "csv" : "xlsx",
      sourceUrl: sealSecret(sourceUrl),
      uploadUrl: sealSecret(uploadUrl),
      intervalMinutes: interval,
      runAt: timing?.runAt ?? null,
      timezone: timing?.timezone ?? null,
      weekday: timing?.weekday ?? null,
      nextRunAt,
    },
  });
}

/** A schedule's settings for the edit form. Passwords in URLs are hidden. */
export async function scheduleForEdit(shop: string, id: string, type: "export" | "import") {
  const s = await prisma.schedule.findFirst({ where: { id, shop, type } });
  if (!s) return null;
  const url = (sealed: string | null) => {
    const u = openSecret(sealed);
    return u ? redactUrl(u) : "";
  };
  let config: any = {};
  try {
    config = JSON.parse(s.config);
  } catch {
    // Edit from a blank set-up.
  }
  return {
    id: s.id,
    name: s.name,
    format: s.format,
    intervalMinutes: s.intervalMinutes,
    runAt: s.runAt ?? "",
    timezone: s.timezone ?? "",
    weekday: s.weekday ?? 1,
    sourceUrl: url(s.sourceUrl),
    uploadUrl: url(s.uploadUrl),
    config,
  };
}

function newPublicToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Permanent link for a scheduled export: always serves the newest finished
 * file. Anyone with the link can download, so the token is long and random.
 */
export function publicFileUrl(schedule: { publicToken: string | null; name: string; format: string }): string | null {
  if (!schedule.publicToken) return null;
  const base = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "");
  return `${base}/files/${schedule.publicToken}`;
}

/** Data types whose exports contain personal data. */
const PERSONAL_DATA = new Set(["customers", "orders", "draft_orders", "companies"]);

/** True when a schedule's export includes customer / order data. */
export function hasPersonalData(config: string): boolean {
  try {
    return (JSON.parse(config) as ExportConfig).entities.some((e) => PERSONAL_DATA.has(e.entity));
  } catch {
    return false;
  }
}

/** Turns the permanent link on, or replaces it (revoking the old address). */
export async function resetPublicToken(shop: string, id: string) {
  await prisma.schedule.updateMany({
    where: { id, shop, type: "export" },
    data: { publicToken: newPublicToken(), linkDownloads: 0, lastDownloadAt: null },
  });
}

/** Turns the permanent link off; the old address stops working. */
export async function disablePublicLink(shop: string, id: string) {
  await prisma.schedule.updateMany({ where: { id, shop }, data: { publicToken: null } });
}

/** Records one download through a permanent link. */
export async function recordLinkDownload(scheduleId: string) {
  await prisma.schedule.update({ where: { id: scheduleId }, data: { linkDownloads: { increment: 1 }, lastDownloadAt: new Date() } });
}

/** Newest finished result file of the schedule behind a permanent link. */
export async function latestPublicFile(token: string) {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const schedule = await prisma.schedule.findUnique({ where: { publicToken: token } });
  if (!schedule) return null;
  const job = await prisma.job.findFirst({
    where: { scheduleId: schedule.id, shop: schedule.shop, status: "finished", resultFile: { not: null } },
    orderBy: { finishedAt: "desc" },
  });
  return { schedule, job };
}

export async function listSchedules(shop: string) {
  return prisma.schedule.findMany({ where: { shop, kind: "job", intervalMinutes: { gt: 0 } }, orderBy: { createdAt: "desc" } });
}

export async function updateSchedule(shop: string, id: string, data: { enabled?: boolean; runNow?: boolean }) {
  const s = await prisma.schedule.findFirst({ where: { id, shop } });
  if (!s) throw new Response("Not found", { status: 404 });
  await prisma.schedule.update({
    where: { id },
    data: {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.runNow ? { nextRunAt: new Date(), enabled: true } : {}),
    },
  });
}

export async function deleteSchedule(shop: string, id: string) {
  await prisma.schedule.deleteMany({ where: { id, shop } });
}

/** Removes all data for a shop (app uninstalled / shop redact). */
export async function purgeShop(shop: string) {
  await prisma.job.deleteMany({ where: { shop } });
  await prisma.schedule.deleteMany({ where: { shop } });
  await prisma.preset.deleteMany({ where: { shop } });
  await prisma.shopSetting.deleteMany({ where: { shop } });
  await prisma.apiKey.deleteMany({ where: { shop } });
  await prisma.oAuthGrant.deleteMany({ where: { shop } });
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.dirname(jobDir(shop, "_"));
  await fs.promises.rm(dir, { recursive: true, force: true });
}

// --- Export presets -----------------------------------------------------------

export interface PresetData {
  entities: ExportConfig["entities"];
  format: string;
}

/** Saved export set-ups for a shop, newest first. */
/**
 * A person's presets: their own, plus the ones saved before presets were per
 * person (which everyone keeps seeing). `userId` is "" when the person isn't
 * known, which shows only the shared ones.
 */
export async function listPresets(shop: string, userId = "") {
  const rows = await prisma.preset.findMany({ where: { shop, userId: { in: [...new Set(["", userId])] } }, orderBy: { name: "asc" } });
  return rows.map((r) => ({ id: r.id, name: r.name, data: JSON.parse(r.config) as PresetData }));
}

/** Creates a preset for this person, or overwrites their one with the same name. */
export async function savePreset(shop: string, name: string, raw: unknown, userId = "") {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new Error("Give the preset a name");
  const body = raw as { entities?: unknown; format?: string };
  const config = parseExportConfig(body);
  const data: PresetData = { entities: config.entities, format: body.format === "csv" ? "csv" : "xlsx" };
  const existing = (await prisma.preset.findFirst({ where: { shop, name: clean, userId } })) ?? (await prisma.preset.findFirst({ where: { shop, name: clean, userId: "" } }));
  if (existing) return prisma.preset.update({ where: { id: existing.id }, data: { config: JSON.stringify(data) } });
  if ((await prisma.preset.count({ where: { shop } })) >= 300) throw new Error("Preset limit reached. Delete one first.");
  return prisma.preset.create({ data: { shop, userId, name: clean, config: JSON.stringify(data) } });
}

export async function deletePreset(shop: string, id: string) {
  await prisma.preset.deleteMany({ where: { id, shop } });
}

/** The set-up of the most recent export job, offered as "Latest export". */
export async function latestExportPreset(shop: string, jobId?: string): Promise<PresetData | null> {
  const job = await prisma.job.findFirst({
    where: { shop, type: "export", kind: "job", ...(jobId ? { id: jobId } : {}) },
    orderBy: { createdAt: "desc" },
  });
  if (!job) return null;
  try {
    return { entities: (JSON.parse(job.config) as ExportConfig).entities, format: job.format };
  } catch {
    return null;
  }
}
