import prisma from "../../db.server";
import type { Command, ExportOptions, ImportOptions } from "../core/types";
import { COMMANDS } from "../core/types";
import { ENTITIES, getEntity } from "../entities";
import type { ExportConfig, ImportConfig } from "./runner.server";
import { jobDir, saveUpload, signedDownloadUrl } from "./storage.server";

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
      if (options.limit) o.limit = Math.max(1, Math.floor(Number(options.limit)));
      return { entity: e.key, options: o };
    }),
  };
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
      sourceUrl: url,
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
      sourceUrl,
      uploadUrl,
      intervalMinutes: interval,
      nextRunAt: start,
    },
  });
}

export function listSchedules(shop: string) {
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
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.dirname(jobDir(shop, "_"));
  await fs.promises.rm(dir, { recursive: true, force: true });
}
