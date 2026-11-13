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

export function progressText(job: { status: string; progress: number; total: number }): string {
  if (job.status === "queued") return "Waiting";
  if (!job.total) return job.progress ? `${job.progress.toLocaleString()} items` : "";
  const pct = Math.floor((job.progress / job.total) * 100);
  return `${job.progress.toLocaleString()} / ${job.total.toLocaleString()} (${pct}%)`;
}

/** Human summary of what a job does, from its stored config. */
export function jobSummary(job: { type: string; config: string; inputName: string | null; name: string }): string {
  try {
    const cfg = JSON.parse(job.config);
    if (job.type === "export") return cfg.entities.map((e: any) => e.entity.replace(/_/g, " ")).join(", ");
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
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
}): string {
  if (!job.startedAt) return "";
  const start = new Date(job.startedAt).getTime();
  if (job.finishedAt) return `Took ${duration(new Date(job.finishedAt).getTime() - start)}`;
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

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * What one line of the job history shows: a short job number, what the job
 * was about, and count badges ("Exported: 912", "Failed: 3").
 */
export function jobRow(job: JobRowInput): {
  number: string;
  kind: "Export" | "Import";
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
    if (isActive(job.status) || job.status === "stopping") {
      const p = progressText(job);
      if (p) counts.push({ label: p, tone: "info" });
    } else if (stats.length) {
      counts.push({ label: `Total: ${sum("items").toLocaleString("en")}`, tone: "neutral" });
      if (sum("ok")) counts.push({ label: `OK: ${sum("ok").toLocaleString("en")}`, tone: "success" });
      if (sum("failed")) counts.push({ label: `Failed: ${sum("failed").toLocaleString("en")}`, tone: "critical" });
      if (sum("skipped")) counts.push({ label: `Skipped: ${sum("skipped").toLocaleString("en")}`, tone: "neutral" });
    }
  }
  const ext = job.type === "import" ? (/\.(\w+)$/.exec(job.inputName ?? "")?.[1] ?? job.format) : job.format;
  const took =
    job.startedAt && job.finishedAt ? duration(new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) : "";
  return {
    number: job.id.slice(-6).toUpperCase(),
    kind: job.type === "export" ? "Export" : "Import",
    title: title || (job.type === "export" ? "Export" : "Import"),
    counts,
    format: ext === "xlsx" ? "Excel" : ext.toUpperCase(),
    took,
  };
}
