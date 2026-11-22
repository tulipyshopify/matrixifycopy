import { HEALTH_TONE, isDryRunConfig, jobHealth } from "../lib/jobs/health";
const TONES: Record<string, "info" | "success" | "critical" | "warning" | "neutral"> = {
  queued: "neutral",
  uploading: "neutral",
  running: "info",
  finished: "success",
  failed: "critical",
  cancelled: "warning",
  stopping: "warning",
};

export function StatusBadge({ status }: { status: string }) {
  return <s-badge tone={TONES[status] ?? "neutral"}>{status[0].toUpperCase() + status.slice(1)}</s-badge>;
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function progressText(job: { status: string; progress: number; total: number; stats?: unknown }): string {
  if (job.status === "queued") return "Waiting";
  // A cancelled job: how far it really got, not the rows it gave up on.
  if (job.status === "cancelled" && job.total) {
    let stats: any[] = [];
    try {
      stats = typeof job.stats === "string" ? JSON.parse(job.stats) : Array.isArray(job.stats) ? job.stats : [];
    } catch {
      stats = [];
    }
    const done = stats.reduce((n, s) => n + (Number(s?.ok) || 0) + (Number(s?.failed) || 0), 0);
    if (stats.length && done <= job.total) return `${done.toLocaleString()} / ${job.total.toLocaleString()} (${Math.floor((done / job.total) * 100)}%), cancelled`;
  }
  if (!job.total) return job.progress ? `${job.progress.toLocaleString()} items` : "";
  const pct = Math.floor((job.progress / job.total) * 100);
  return `${job.progress.toLocaleString()} / ${job.total.toLocaleString()} (${pct}%)`;
}

/** Human summary of what a job does, from its stored config. */
export function jobSummary(job: { type: string; config: string; inputName: string | null; name: string }): string {
  try {
    const cfg = JSON.parse(job.config);
    if (job.type === "export") return cfg.entities.map((e: any) => e.entity.replace(/_/g, " ")).join(", ");
    // A change made in the app (a quick change, the table) is known by what it does, not by the file built for it.
    if (job.name && (cfg.generate || cfg.aiFix || /^(Quick change|Edited in a table|Change): /.test(job.name) || /^Edited in a table/.test(job.name))) return job.name.replace(/^Quick change: /, "");
    return job.inputName ?? job.name;
  } catch {
    return job.name;
  }
}

export const isActive = (status: string) => status === "queued" || status === "running" || status === "uploading";

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} sec`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * "Running for 2 min 10 sec · about 6 min left" for active jobs, "Took 8 min"
 * for finished ones. The estimate assumes the rest goes at the pace so far.
 */
export function jobTiming(job: {
  status: string;
  progress: number;
  total: number;
  createdAt?: string | Date | null;
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
}): string {
  if (!job.startedAt) return "";
  const start = new Date(job.startedAt).getTime();
  if (job.finishedAt) {
    // From the moment it was asked for: a job restarted after a deploy, or one that queued, took that long for the person waiting.
    const asked = job.createdAt ? new Date(job.createdAt).getTime() : start;
    const end = new Date(job.finishedAt).getTime();
    const waited = start - asked;
    return `Took ${duration(end - Math.min(asked, start))}${waited > 60_000 ? ` (${duration(waited)} of it waiting to start)` : ""}`;
  }
  if (job.status !== "running") return "";
  const elapsed = Date.now() - start;
  const fraction = job.total ? job.progress / job.total : 0;
  const left =
    fraction >= 0.03 && fraction < 1 && elapsed > 15_000 ? ` · about ${duration((elapsed * (1 - fraction)) / fraction)} left` : "";
  return `Running for ${duration(elapsed)}${left}`;
}

export interface JobRowInput {
  id: string;
  type: string;
  status: string;
  config: string;
  format: string;
  name: string;
  inputName: string | null;
  stats: string;
  progress: number;
  total: number;
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
}

const isDryRun = (config: string) => {
  try {
    return !!JSON.parse(config)?.options?.dryRun;
  } catch {
    return false;
  }
};

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * What one line of the job history shows: a short job number, what the job
 * was about, and count badges ("Exported: 912", "Failed: 3").
 */
export function jobRow(job: JobRowInput): {
  number: string;
  kind: "Export" | "Import" | "Preview";
  title: string;
  counts: Array<{ label: string; tone: "neutral" | "success" | "critical" | "info" }>;
  format: string;
  took: string;
} {
  let stats: any[] = [];
  try {
    stats = JSON.parse(job.stats);
  } catch {
    // Unreadable stats: show the row without counts.
  }
  const sum = (k: string) => stats.reduce((n, s) => n + (Number(s?.[k]) || 0), 0);
  const counts: ReturnType<typeof jobRow>["counts"] = [];
  let title = job.name;
  if (job.type === "export") {
    try {
      title = JSON.parse(job.config).entities.map((e: any) => titleCase(String(e.entity))).join(", ");
    } catch {
      // Keep the job name.
    }
    if (isActive(job.status) || job.status === "stopping") {
      const p = progressText(job);
      if (p) counts.push({ label: p, tone: "info" });
    } else if (stats.length) {
      counts.push({ label: `Exported: ${sum("items").toLocaleString("en")}`, tone: "success" });
      if (sum("rows") !== sum("items")) counts.push({ label: `Rows: ${sum("rows").toLocaleString("en")}`, tone: "neutral" });
    }
  } else {
    const sheets = [...new Set(stats.map((s) => s?.sheet).filter(Boolean))];
    title = sheets.length ? sheets.join(", ") : job.inputName ?? job.name ?? "Import";
    // A change made in the app is known by what it does.
    if (/^(Quick change|Change): |^Edited in a table/.test(job.name ?? "")) title = job.name.replace(/^Quick change: /, "");
    if (isActive(job.status) || job.status === "stopping") {
      const p = progressText(job);
      if (p) counts.push({ label: p, tone: "info" });
    } else if (stats.length) {
      counts.push({ label: `Total: ${sum("items").toLocaleString("en")}`, tone: "neutral" });
      if (sum("ok")) counts.push({ label: `OK: ${sum("ok").toLocaleString("en")}`, tone: "success" });
      if (sum("failed")) counts.push({ label: `Failed: ${sum("failed").toLocaleString("en")}`, tone: "critical" });
      // Rows a cancelled job never reached were not skipped by anyone's choice.
      if (sum("skipped")) counts.push({ label: `${job.status === "cancelled" ? "Not processed" : "Skipped"}: ${sum("skipped").toLocaleString("en")}`, tone: "neutral" });
    }
  }
  const ext = job.type === "import" ? (/\.(\w+)$/.exec(job.inputName ?? "")?.[1] ?? job.format) : job.format;
  // From when it was asked for (a job that queued, or was started again after a restart, took that long).
  const from = (job as { createdAt?: string | Date | null }).createdAt ?? job.startedAt;
  const took = from && job.finishedAt ? duration(new Date(job.finishedAt).getTime() - new Date(from).getTime()) : "";
  return {
    number: job.id.slice(-6).toUpperCase(),
    kind: job.type === "export" ? "Export" : isDryRun(job.config) ? "Preview" : "Import",
    title: title || (job.type === "export" ? "Export" : "Import"),
    counts,
    format: ext === "xlsx" ? "Excel" : ext.toUpperCase(),
    took,
  };
}

/** Status badge that also flags problems ("Finished with errors"). */
export function HealthBadge({ job }: { job: { type: string; status: string; error?: string | null; stats?: string | null; config?: string | null } }) {
  const h = jobHealth({ ...job, dryRun: isDryRunConfig(job.config) });
  return <s-badge tone={HEALTH_TONE[h.level]}>{h.label}</s-badge>;
}
