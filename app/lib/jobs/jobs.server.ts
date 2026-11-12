import crypto from "node:crypto";
import prisma from "../../db.server";
import type { Command, DateRange, Entity, ExportOptions, FilterCondition, ImportOptions } from "../core/types";
import { COMMANDS, DATE_PRESETS, FILTER_OPS } from "../core/types";
import { ENTITIES, getEntity } from "../entities";
import type { ExportConfig, ImportConfig } from "./runner.server";
import { jobDir, saveUpload, sealSecret, signedDownloadUrl } from "./storage.server";

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

/** Validates the export form payload into an ExportConfig. */
export function parseExportConfig(raw: unknown): ExportConfig {
  const input = raw as { entities?: Array<{ entity: string; options?: ExportOptions }> };
  if (!input?.entities?.length) throw new Error("Choose at least one sheet to export");
  return {
    entities: input.entities.map(({ entity, options = {} }) => {
      const e = getEntity(entity);
      if (!e?.export) throw new Error(`Cannot export "${entity}"`);
      const o: ExportOptions = {};
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
      if (options.columns) {
        const valid = new Set(e.columns);
        o.columns = options.columns.filter((c) => valid.has(c));
        if (!o.columns.length) throw new Error(`${e.sheet}: choose at least one column`);
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
  if (!DATE_PRESETS.some((p) => p.value === r.preset)) throw new Error(`${e.sheet}: unknown date range`);
  if (r.preset !== "custom") return { field: r.field, preset: r.preset };
  const from = r.from?.trim() || undefined;
  const to = r.to?.trim() || undefined;
  for (const d of [from, to]) if (d && !DATE.test(d)) throw new Error(`${field.label}: "${d}" is not a date`);
  if (!from && !to) return undefined;
  if (from && to && from > to) throw new Error(`${field.label}: the start date is after the end date`);
  return { field: r.field, preset: "custom", from, to };
}

/** Validates filter rows against the entity's filter fields. */
export function parseFilters(e: Entity, raw: FilterCondition[]): FilterCondition[] {
  const fields = new Map((e.filters ?? []).map((f) => [f.key, f]));
  return raw.slice(0, 30).map((f) => {
    const field = fields.get(f.field);
    if (!field) throw new Error(`${e.sheet}: unknown filter "${f.field}"`);
    if (!FILTER_OPS[field.type].includes(f.op)) throw new Error(`${field.label}: unsupported condition`);
    const value = String(f.value ?? "").trim().slice(0, 500);
    const value2 = f.op === "between" ? String(f.value2 ?? "").trim().slice(0, 500) : undefined;
    const check = (v: string) => {
      if (!v) throw new Error(`${field.label}: enter a value`);
      if (field.type === "number" && !NUMBER.test(v)) throw new Error(`${field.label}: "${v}" is not a number`);
      if (field.type === "date" && !DATE.test(v)) throw new Error(`${field.label}: "${v}" is not a date`);
      if (field.type === "boolean" && v !== "true" && v !== "false") throw new Error(`${field.label}: choose yes or no`);
      if (field.type === "id" && !/^(\d+|gid:\/\/shopify\/\w+\/\d+)$/.test(v)) throw new Error(`${field.label}: "${v}" is not an ID`);
    };
    if (field.type === "enum") {
      const allowed = new Set(field.options?.map((o) => o.value));
      const values = value.split(",").map((v) => v.trim()).filter(Boolean);
      if (!values.length) throw new Error(`${field.label}: choose a value`);
      for (const v of values) if (!allowed.has(v)) throw new Error(`${field.label}: "${v}" is not allowed`);
    } else {
      check(value);
    }
    if (value2 !== undefined) check(value2);
    const id = field.type === "id" ? value.replace(/^gid:\/\/shopify\/\w+\//, "") : value;
    return { field: field.key, op: f.op, value: id, ...(value2 !== undefined ? { value2 } : {}) };
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
  if (input.concurrency) o.concurrency = Math.min(8, Math.max(1, Math.floor(Number(input.concurrency))));
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

export function listJobs(shop: string, take = 50) {
  return prisma.job.findMany({
    where: { shop },
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
    },
  });
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

/** Creates a copy of a finished job and queues it again. */
export async function rerunJob(shop: string, id: string) {
  const job = await getJob(shop, id);
  return prisma.job.create({
    data: {
      shop,
      type: job.type,
      config: job.config,
      format: job.format,
      name: job.name,
      inputFile: job.inputFile,
      inputName: job.inputName,
      scheduleId: job.scheduleId,
    },
  });
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
  if (!protocols.includes(url.protocol)) throw new Error(`${what} must start with ${protocols.join(" or ")}`);
  return url.toString();
}

export async function createSchedule(shop: string, input: ScheduleInput) {
  const interval = Math.floor(Number(input.intervalMinutes));
  if (!(interval >= 15)) throw new Error("Interval must be at least 15 minutes");
  const sourceUrl = checkUrl(input.sourceUrl, ["http:", "https:", "ftp:", "ftps:"], "Source URL");
  const uploadUrl = checkUrl(input.uploadUrl, ["ftp:", "ftps:"], "Upload URL");
  if (input.type === "import" && !sourceUrl) throw new Error("Scheduled imports need a source URL");
  const start = input.startAt ? new Date(input.startAt) : new Date();
  if (Number.isNaN(start.getTime())) throw new Error("Invalid start time");
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
      nextRunAt: start,
      // The permanent link is chosen when the schedule is saved and can be
      // turned on or off later on the Schedules page.
      publicToken: input.type === "export" && input.publicLink ? newPublicToken() : null,
    },
  });
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
  return prisma.schedule.findMany({ where: { shop, intervalMinutes: { gt: 0 } }, orderBy: { createdAt: "desc" } });
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
export async function listPresets(shop: string) {
  const rows = await prisma.preset.findMany({ where: { shop }, orderBy: { name: "asc" } });
  return rows.map((r) => ({ id: r.id, name: r.name, data: JSON.parse(r.config) as PresetData }));
}

/** Creates a preset, or overwrites the one with the same name. */
export async function savePreset(shop: string, name: string, raw: unknown) {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new Error("Give the preset a name");
  const body = raw as { entities?: unknown; format?: string };
  const config = parseExportConfig(body);
  const data: PresetData = { entities: config.entities, format: body.format === "csv" ? "csv" : "xlsx" };
  const existing = await prisma.preset.findFirst({ where: { shop, name: clean } });
  if (existing) return prisma.preset.update({ where: { id: existing.id }, data: { config: JSON.stringify(data) } });
  if ((await prisma.preset.count({ where: { shop } })) >= 100) throw new Error("Preset limit reached (100). Delete one first.");
  return prisma.preset.create({ data: { shop, name: clean, config: JSON.stringify(data) } });
}

export async function deletePreset(shop: string, id: string) {
  await prisma.preset.deleteMany({ where: { id, shop } });
}

/** The set-up of the most recent export job, offered as "Latest export". */
export async function latestExportPreset(shop: string): Promise<PresetData | null> {
  const job = await prisma.job.findFirst({ where: { shop, type: "export" }, orderBy: { createdAt: "desc" } });
  if (!job) return null;
  try {
    return { entities: (JSON.parse(job.config) as ExportConfig).entities, format: job.format };
  } catch {
    return null;
  }
}
