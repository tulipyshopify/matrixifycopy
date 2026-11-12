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
