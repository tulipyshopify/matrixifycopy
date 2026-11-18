import fs from "node:fs";
import path from "node:path";
import prisma from "../../db.server";
import { ENTITIES } from "../entities";
import { OPTIONS_VERSION, getJob } from "./jobs.server";
import type { ExportConfig } from "./runner.server";
import { isValidTimeZone, nextRun } from "./schedule-time";
import { backupDir, resolveStored } from "./storage.server";

/**
 * Store backups: a full export of the chosen data types, run every day (or on
 * demand), kept on this server for a number of days. A backup can be restored
 * through the normal import, starting with a preview.
 *
 * Meant to become a paid feature: backupsAllowed() is the single place that
 * decides which stores may use it (today: BACKUP_SHOPS, "*" for every store).
 */

/** Data types a backup can hold. Payouts are reports, not store data. */
export const BACKUP_TYPES = ENTITIES.filter((e) => e.export && e.key !== "payouts").map((e) => ({ key: e.key, label: e.sheet, restorable: !!e.import }));

export const DEFAULT_BACKUP_TYPES = BACKUP_TYPES.map((t) => t.key);

export const KEEP_DAYS = [7, 14, 30, 90];

export function backupsAllowed(shop: string): boolean {
  const list = (process.env.BACKUP_SHOPS ?? "*").split(/[,\s]+/).filter(Boolean);
  return list.includes("*") || list.includes(shop);
}

/** The export settings of a backup: every column and every data group of each type. */
export function backupConfig(types: string[]): ExportConfig {
  const keys = types.filter((t) => DEFAULT_BACKUP_TYPES.includes(t));
  if (!keys.length) throw new Error("Choose at least one data type to back up");
  return {
    entities: keys.map((key) => {
      const e = ENTITIES.find((x) => x.key === key)!;
      // All data groups except discount codes, which can run into millions.
      const groups = (e.groups ?? []).map((g) => g.key).filter((g) => !(key === "discounts" && g === "codes"));
      return { entity: key, options: { v: OPTIONS_VERSION, ...(groups.length ? { groups } : {}) } };
    }),
  };
}

export async function getBackupSchedule(shop: string) {
  return prisma.schedule.findFirst({ where: { shop, kind: "backup" } });
}

export interface BackupSettingsInput {
  enabled: boolean;
  /** "HH:MM" in `timezone`. */
  runAt: string;
  timezone: string;
  types: string[];
  keepDays: number;
}

/** Creates or updates the store's daily backup. */
export async function saveBackupSettings(shop: string, input: BackupSettingsInput) {
  if (!backupsAllowed(shop)) throw new Error("Backups aren't part of this store's plan");
  const m = /^(\d{1,2}):(\d{2})$/.exec(input.runAt.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error("Enter the time as HH:MM, for example 02:30");
  if (!isValidTimeZone(input.timezone)) throw new Error("Unknown time zone");
  const runAt = `${m[1].padStart(2, "0")}:${m[2]}`;
  const keepDays = KEEP_DAYS.includes(Number(input.keepDays)) ? Number(input.keepDays) : 30;
  const config = JSON.stringify(backupConfig(input.types));
  const timing = { intervalMinutes: 1440, runAt, timezone: input.timezone, weekday: null };
  const data = {
    name: "Store backup",
    type: "export",
    kind: "backup",
    format: "csv",
    config,
    ...timing,
    enabled: !!input.enabled,
    nextRunAt: nextRun(timing, new Date()),
  };
  await prisma.shopSetting.upsert({ where: { shop }, create: { shop, backupKeepDays: keepDays }, update: { backupKeepDays: keepDays } });
  const existing = await getBackupSchedule(shop);
  return existing ? prisma.schedule.update({ where: { id: existing.id }, data }) : prisma.schedule.create({ data: { shop, ...data } });
}

/** Starts a backup now with the saved (or default) data types. */
export async function backupNow(shop: string) {
  if (!backupsAllowed(shop)) throw new Error("Backups aren't part of this store's plan");
  const running = await prisma.job.findFirst({ where: { shop, kind: "backup", status: { in: ["queued", "running"] } } });
  if (running) throw new Error("A backup is already running");
  const schedule = await getBackupSchedule(shop);
  return prisma.job.create({
    data: {
      shop,
      type: "export",
      kind: "backup",
      format: "csv",
      name: "Store backup",
      config: schedule?.config ?? JSON.stringify(backupConfig(DEFAULT_BACKUP_TYPES)),
      scheduleId: schedule?.id ?? null,
    },
  });
}

function fileSize(file: string | null): number {
  if (!file) return 0;
  try {
    return fs.statSync(resolveStored(file)).size;
  } catch {
    return 0;
  }
}

/** The store's backups, newest first, with file sizes. */
export async function listBackups(shop: string, take = 100) {
  const rows = await prisma.job.findMany({
    where: { shop, kind: "backup" },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, status: true, createdAt: true, startedAt: true, finishedAt: true, resultFile: true, stats: true, error: true, progress: true, total: true, config: true },
  });
  return rows.map((r) => ({ ...r, size: fileSize(r.resultFile), fileName: r.resultFile ? path.basename(r.resultFile) : null }));
}

/**
 * Deletes backups older than each store's keep period. The newest finished
 * backup of a store is always kept, however old.
 */
export async function pruneBackups(now = new Date()): Promise<number> {
  const shops = await prisma.job.groupBy({ by: ["shop"], where: { kind: "backup" } });
  let removed = 0;
  for (const { shop } of shops) {
    const keepDays = (await prisma.shopSetting.findUnique({ where: { shop } }))?.backupKeepDays ?? 30;
    const newest = await prisma.job.findFirst({ where: { shop, kind: "backup", status: "finished" }, orderBy: { createdAt: "desc" }, select: { id: true } });
    const old = await prisma.job.findMany({
      where: {
        shop,
        kind: "backup",
        status: { in: ["finished", "failed", "cancelled"] },
        createdAt: { lt: new Date(now.getTime() - keepDays * 86400_000) },
        ...(newest ? { id: { not: newest.id } } : {}),
      },
      select: { id: true },
    });
    for (const { id } of old) {
      await fs.promises.rm(backupDir(shop, id), { recursive: true, force: true }).catch(() => {});
      await prisma.job.delete({ where: { id } });
      removed++;
    }
  }
  return removed;
}

/**
 * Restoring starts as a preview: an import of the backup file with dry run on,
 * so nothing changes until "Import for real" on its page.
 */
export async function restorePreview(shop: string, backupId: string) {
  const backup = await getJob(shop, backupId);
  if (backup.kind !== "backup" || backup.status !== "finished" || !backup.resultFile) throw new Error("This backup can't be restored");
  if (!fs.existsSync(resolveStored(backup.resultFile))) throw new Error("This backup's file is no longer on the server");
  const when = backup.createdAt.toISOString().slice(0, 16).replace("T", " ");
  // A backup of one data type is a single CSV: name it after the type so the
  // import recognises it (a .zip holds one file per type, already named so).
  let inputName = `Backup ${when}${path.extname(backup.resultFile)}`;
  try {
    const types = (JSON.parse(backup.config) as ExportConfig).entities;
    const e = ENTITIES.find((x) => x.key === types[0]?.entity);
    if (types.length === 1 && e && backup.resultFile.endsWith(".csv")) inputName = `${e.sheet}.csv`;
  } catch {
    // keep the generic name
  }
  return prisma.job.create({
    data: {
      shop,
      type: "import",
      config: JSON.stringify({ options: { dryRun: true, defaultCommand: "MERGE" } }),
      name: `Restore from backup of ${when} UTC`,
      inputFile: backup.resultFile,
      inputName,
    },
  });
}
