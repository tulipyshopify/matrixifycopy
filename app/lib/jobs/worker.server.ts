import path from "node:path";
import prisma from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { createBulkRunner } from "../core/bulk";
import { createGql } from "../core/gql";
import { executeJob } from "./runner.server";
import { countItems } from "./counts.server";
import { cleanupOldFiles, jobDir, openSecret } from "./storage.server";
import { downloadSource, redactUrl, uploadResult } from "./sources.server";

/**
 * In-process job worker. Polls the Job table, runs at most one job per shop
 * at a time (Shopify allows one bulk query per app and shop) and up to
 * WORKER_CONCURRENCY jobs overall. Also fires due schedules.
 *
 * Runs inside the web server process; set WORKER_ENABLED=false on extra web
 * replicas so only one instance processes jobs.
 */

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 3);
const POLL_MS = 2000;
const MAX_LOG_CHARS = 200_000;

/** Jobs running longer than this are stopped and marked failed. */
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_HOURS ?? 12) * 3600_000;
/** An export interrupted by this many server restarts is not started again. */
const MAX_ATTEMPTS = 2;

const running = new Set<string>(); // job ids
// One export and one import may run per shop at a time, so an import never
// waits behind a long export. Keys are "<shop>:<type>".
const runningShops = new Set<string>();
const slot = (job: { shop: string; type: string }) => `${job.shop}:${job.type}`;

async function claimNext() {
  const candidates = await prisma.job.findMany({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  for (const job of candidates) {
    if (runningShops.has(slot(job))) continue;
    // Atomic claim: only one worker flips queued -> running.
    const { count } = await prisma.job.updateMany({
      where: { id: job.id, status: "queued" },
      data: { status: "running", startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (count === 1) return job;
  }
  return null;
}

async function runOne(job: Awaited<ReturnType<typeof claimNext>> & {}) {
  running.add(job.id);
  runningShops.add(slot(job));
  const startedAt = Date.now();
  let timedOut = false;

  let logBuf = "";
  let progress = { done: 0, total: 0 };
  let dirty = false;
  let cancelled = false;
  const log = (msg: string) => {
    logBuf += `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
    dirty = true;
  };
  const flush = async () => {
    if (!dirty) return;
    dirty = false;
    const current = await prisma.job.findUnique({ where: { id: job.id }, select: { log: true, cancelRequested: true } });
    cancelled = !!current?.cancelRequested;
    const merged = ((current?.log ?? "") + logBuf).slice(-MAX_LOG_CHARS);
    logBuf = "";
    await prisma.job.update({
      where: { id: job.id },
      data: { log: merged, progress: progress.done, total: progress.total },
    });
  };
  const timer = setInterval(() => flush().catch(() => {}), 2000);
  const isCancelled = async () => {
    if (cancelled) return true;
    if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
      timedOut = true;
      cancelled = true;
      return true;
    }
    const j = await prisma.job.findUnique({ where: { id: job.id }, select: { cancelRequested: true } });
    cancelled = !!j?.cancelRequested;
    return cancelled;
  };

  try {
    const { admin } = await unauthenticated.admin(job.shop);
    const gql = createGql(async (query, variables) => {
      const res = await admin.graphql(query, { variables, tries: 3 });
      return res.json();
    }, log);
    const bulkEvents = { onRoots: (_n: number) => {} };
    const bulk = createBulkRunner(gql, { log, isCancelled, onRoots: (n) => bulkEvents.onRoots(n) });

    // Imports scheduled from a URL fetch their file at run time.
    if (job.type === "import" && !job.inputFile) {
      const schedule = job.scheduleId ? await prisma.schedule.findUnique({ where: { id: job.scheduleId } }) : null;
      const sourceUrl = openSecret(schedule?.sourceUrl);
      if (!sourceUrl) throw new Error("No input file");
      log(`Downloading ${redactUrl(sourceUrl)}`);
      const { file, name } = await downloadSource(sourceUrl, jobDir(job.shop, job.id));
      job.inputFile = file;
      job.inputName = name;
      await prisma.job.update({ where: { id: job.id }, data: { inputFile: file, inputName: name } });
    }

    const { resultFile, stats } = await executeJob(job, {
      gql,
      bulk,
      log,
      progress: (done, total) => {
        progress = { done, total };
        dirty = true;
      },
      isCancelled,
      bulkEvents,
      count: async (entity, options) => {
        const r = await countItems(gql, entity, options);
        return r && !r.unfiltered && r.precision === "EXACT" ? r.count : null;
      },
    });

    if (job.type === "export" && job.scheduleId) {
      const schedule = await prisma.schedule.findUnique({ where: { id: job.scheduleId } });
      const uploadUrl = openSecret(schedule?.uploadUrl);
      if (uploadUrl) {
        log(`Uploading to ${redactUrl(uploadUrl)}`);
        const remote = await uploadResult(resultFile, uploadUrl);
        log(`Uploaded ${path.basename(resultFile)} to ${remote}`);
      }
    }

    log(cancelled ? "Cancelled" : "Finished");
    await flush();
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: (await isCancelled()) ? "cancelled" : "finished",
        resultFile,
        stats: JSON.stringify(stats),
        finishedAt: new Date(),
      },
    });
  } catch (e: any) {
    const message = e?.message ?? String(e);
    log(`Error: ${message}`);
    dirty = true;
    await flush().catch(() => {});
    await prisma.job.update({
      where: { id: job.id },
      data: timedOut
        ? { status: "failed", error: `Stopped after ${JOB_TIMEOUT_MS / 3600_000} hours (time limit).`, finishedAt: new Date() }
        : { status: message === "Cancelled" ? "cancelled" : "failed", error: message, finishedAt: new Date() },
    });
  } finally {
    clearInterval(timer);
    running.delete(job.id);
    runningShops.delete(slot(job));
  }
}

async function fireSchedules() {
  const due = await prisma.schedule.findMany({ where: { enabled: true, nextRunAt: { lte: new Date() } } });
  for (const s of due) {
    // Skip a run if the previous one is still going.
    const prev = s.lastJobId ? await prisma.job.findUnique({ where: { id: s.lastJobId } }) : null;
    const busy = prev && (prev.status === "queued" || prev.status === "running");
    const nextRunAt = new Date(Date.now() + s.intervalMinutes * 60_000);
    if (busy) {
      await prisma.schedule.update({ where: { id: s.id }, data: { nextRunAt } });
      continue;
    }
    const job = await prisma.job.create({
      data: { shop: s.shop, type: s.type, config: s.config, format: s.format, name: s.name, scheduleId: s.id },
    });
    await prisma.schedule.update({ where: { id: s.id }, data: { nextRunAt, lastJobId: job.id } });
  }
}

async function recoverInterrupted() {
  // Exports are safe to retry; imports may have partially applied, so fail them.
  // …but only so often: an export that was running at several restarts is
  // probably what brought the server down, so it is not started again.
  await prisma.job.updateMany({
    where: { status: "running", type: "export", attempts: { gte: MAX_ATTEMPTS } },
    data: {
      status: "failed",
      error: "Stopped: the server restarted while this export was running, more than once. Narrow it with filters, or export fewer data types at a time.",
      finishedAt: new Date(),
    },
  });
  await prisma.job.updateMany({ where: { status: "running", type: "export" }, data: { status: "queued" } });
  await prisma.job.updateMany({
    where: { status: "running", type: "import" },
    data: { status: "failed", error: "Interrupted by a server restart. Check the store before re-running.", finishedAt: new Date() },
  });
}

let started = false;

export function startWorker() {
  if (started) return;
  started = true;
  let lastCleanup = 0;
  const tick = async () => {
    try {
      await fireSchedules();
      while (running.size < CONCURRENCY) {
        const job = await claimNext();
        if (!job) break;
        void runOne(job);
      }
      if (Date.now() - lastCleanup > 6 * 3600_000) {
        lastCleanup = Date.now();
        const n = await cleanupOldFiles();
        if (n) console.log(`[worker] removed ${n} old job folders`);
      }
    } catch (e) {
      console.error("[worker] tick failed", e);
    } finally {
      setTimeout(tick, POLL_MS);
    }
  };
  recoverInterrupted()
    .catch((e) => console.error("[worker] recovery failed", e))
    .finally(() => setTimeout(tick, 500));
  console.log(`[worker] started (concurrency ${CONCURRENCY})`);
}
