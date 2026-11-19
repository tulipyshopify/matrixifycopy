import { isDryRunConfig, jobHealth } from "../lib/jobs/health";
import { HealthBadge, formatDate, isActive, jobRow } from "./jobs";

export interface ListedJob {
  id: string;
  type: string;
  status: string;
  name: string;
  format: string;
  inputName: string | null;
  progress: number;
  total: number;
  createdAt: string | Date;
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
  error: string | null;
  config: string;
  stats: string;
  problems: number;
  reviewedAt: string | Date | null;
  links: { result: string | null; input: string | null };
  fileName: string | null;
  repeat: string | null;
}

/** Exports and imports as rows, each with its next action: stop, review, download, run again. */
export function JobList({ jobs, pendingId, onAction }: { jobs: ListedJob[]; pendingId: string | null; onAction: (intent: "cancel" | "rerun", id: string) => void }) {
  return (
            <div className="bp-jobs">
              {jobs.map((job) => {
                const row = jobRow(job as any);
                return (
                  <div className="bp-job" key={job.id}>
                    <div className="bp-job-main">
                      <div className="bp-job-line">
                        <span className={`bp-kind bp-kind-${job.type}`} aria-hidden="true">
                          {job.type === "export" ? "↑" : "↓"}
                        </span>
                        <s-link href={`/app/jobs/${job.id}`}>
                          {row.kind} #{row.number}
                        </s-link>
                        <s-text type="strong">{row.title}</s-text>
                        {row.counts.map((c) => (
                          <s-badge key={c.label} tone={c.tone}>
                            {c.label}
                          </s-badge>
                        ))}
                      </div>
                      <div className="bp-job-line bp-job-meta">
                        <span>{formatDate(job.createdAt)}</span>
                        {row.took ? <span>{row.took}</span> : null}
                        {job.repeat ? <span>↻ {job.repeat}</span> : null}
                      </div>
                      {job.error ? (
                        <s-text tone="critical">{job.error}</s-text>
                      ) : job.problems ? (
                        <s-text tone="critical">{jobHealth({ ...job, dryRun: isDryRunConfig(job.config) }).summary}</s-text>
                      ) : null}
                    </div>
                    <div className="bp-job-side">
                      <div className="bp-job-line bp-job-end">
                        <s-badge>{row.format}</s-badge>
                        <HealthBadge job={job as any} />
                      </div>
                      <div className="bp-job-line bp-job-end">
                        {job.links.result ? (
                          <s-link href={job.links.result} target="_blank">
                            {job.fileName ?? "Download"}
                          </s-link>
                        ) : null}
                        {isActive(job.status) ? (
                          <s-button
                            variant="secondary"
                            tone="critical"
                            icon="stop-circle"
                            loading={pendingId === job.id}
                            onClick={() => onAction("cancel", job.id)}
                          >
                            Stop
                          </s-button>
                        ) : row.kind === "Preview" ? (
                          <s-button variant="secondary" icon="view" href={`/app/jobs/${job.id}`}>
                            Review
                          </s-button>
                        ) : (
                          <s-button
                            variant="secondary"
                            icon="refresh"
                            loading={pendingId === job.id}
                            disabled={pendingId !== null && pendingId !== job.id}
                            accessibilityLabel={`Run ${row.kind.toLowerCase()} ${row.number} again`}
                            onClick={() => onAction("rerun", job.id)}
                          >
                            {row.kind === "Import" ? "Preview again" : "Run again"}
                          </s-button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
  );
}
