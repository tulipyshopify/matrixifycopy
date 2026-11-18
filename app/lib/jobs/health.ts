/**
 * How a job went, in one place: used by the worker (to store the problem count
 * and decide on alerts), the job history, the job page and the schedules page.
 */

export type HealthLevel = "ok" | "warning" | "critical" | "running";

export interface JobHealth {
  level: HealthLevel;
  /** Badge text: "Finished", "Finished with errors", "Failed"… */
  label: string;
  /** Rows that failed plus rows of sheets that couldn't be imported. */
  problems: number;
  /** One line saying what went wrong, empty when nothing did. */
  summary: string;
}

interface StatLike {
  sheet?: string;
  entity?: string | null;
  items?: number;
  failed?: number;
  skipped?: number;
}

const ACTIVE = new Set(["queued", "running", "uploading"]);

/** Problems in an import's per-sheet stats: failed items, and every row of a sheet that wasn't imported. */
export function countProblems(stats: StatLike[]): { failed: number; unimported: number; sheets: string[] } {
  let failed = 0;
  let unimported = 0;
  const sheets: string[] = [];
  for (const s of stats ?? []) {
    failed += Number(s.failed) || 0;
    if (s.entity === null) {
      unimported += Number(s.skipped) || Number(s.items) || 0;
      if (s.sheet) sheets.push(s.sheet);
    }
  }
  return { failed, unimported, sheets };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

export function jobHealth(job: { type: string; status: string; error?: string | null; stats?: string | StatLike[] | null; dryRun?: boolean }): JobHealth {
  if (ACTIVE.has(job.status)) return { level: "running", label: job.status === "queued" ? "Queued" : "Running", problems: 0, summary: "" };
  if (job.status === "failed") return { level: "critical", label: "Failed", problems: 0, summary: job.error ?? "The job stopped with an error." };
  if (job.status === "cancelled") return { level: "warning", label: "Cancelled", problems: 0, summary: "Stopped before the end." };
  let stats: StatLike[] = [];
  try {
    stats = typeof job.stats === "string" ? JSON.parse(job.stats) : (job.stats ?? []);
  } catch {
    stats = [];
  }
  if (job.type !== "import") return { level: "ok", label: "Finished", problems: 0, summary: "" };
  const { failed, unimported, sheets } = countProblems(stats);
  const problems = failed + unimported;
  if (!problems) return { level: "ok", label: job.dryRun ? "Preview ready" : "Finished", problems: 0, summary: "" };
  const parts = [
    failed ? `${plural(failed, job.dryRun ? "item would fail" : "item failed", job.dryRun ? "items would fail" : "items failed")}` : "",
    unimported ? `${plural(sheets.length, "sheet")} not imported (${sheets.join(", ")})` : "",
  ].filter(Boolean);
  return {
    level: job.dryRun ? "warning" : "critical",
    label: job.dryRun ? "Preview: problems" : "Finished with errors",
    problems,
    summary: parts.join("; "),
  };
}

/** Badge tone for a health level. */
export const HEALTH_TONE: Record<HealthLevel, "success" | "warning" | "critical" | "info"> = {
  ok: "success",
  warning: "warning",
  critical: "critical",
  running: "info",
};

export function isDryRunConfig(config: string | null | undefined): boolean {
  try {
    return !!JSON.parse(config ?? "{}")?.options?.dryRun;
  } catch {
    return false;
  }
}
