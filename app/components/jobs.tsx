const TONES: Record<string, "info" | "success" | "critical" | "warning" | "neutral"> = {
  queued: "neutral",
  uploading: "neutral",
  running: "info",
  finished: "success",
  failed: "critical",
  cancelled: "warning",
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
