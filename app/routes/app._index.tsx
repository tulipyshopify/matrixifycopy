import path from "node:path";
import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { EXPORT_HISTORY_DAYS, type JobFilter, cancelJob, countJobs, downloadLinks, listJobs, markReviewed, needsAttention, listSchedules, rerunJob } from "../lib/jobs/jobs.server";
import { describeSchedule } from "../lib/jobs/schedule-time";
import { HealthBadge, formatDate, isActive, jobRow } from "../components/jobs";
import { isDryRunConfig, jobHealth } from "../lib/jobs/health";
import { ImportForm } from "../components/ImportForm";

/** Jobs shown per page of the history. */
const PAGE = 30;

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 200);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = (["export", "import", "problems", "scheduled"].includes(url.searchParams.get("show") ?? "") ? url.searchParams.get("show") : "all") as JobFilter;
  const take = Math.min(500, Math.max(PAGE, Number(url.searchParams.get("n")) || PAGE));
  const [jobs, schedules, attention, total] = await Promise.all([
    listJobs(session.shop, take, filter),
    listSchedules(session.shop),
    needsAttention(session.shop),
    countJobs(session.shop, filter),
  ]);
  const repeats = new Map(schedules.map((s) => [s.id, describeSchedule(s)]));
  return {
    jobs: jobs.map(({ resultFile, scheduleId, ...j }) => ({
      ...j,
      links: downloadLinks({ id: j.id, resultFile, inputFile: null }),
      fileName: resultFile ? path.basename(resultFile) : null,
      repeat: scheduleId ? (repeats.get(scheduleId) ?? null) : null,
    })),
    attention: attention.map((j) => {
      const row = jobRow({ ...j, format: "", progress: 0, total: 0, startedAt: null, finishedAt: null });
      return {
      id: j.id,
      title: `${row.kind} #${row.number}: ${row.title}`,
      summary: jobHealth({ ...j, dryRun: isDryRunConfig(j.config) }).summary,
      createdAt: j.createdAt,
      scheduled: !!j.scheduleId,
      };
    }),
    filter,
    total,
    scheduleCount: schedules.filter((s) => s.enabled).length,
    maxUploadMb: MAX_UPLOAD_MB,
    historyDays: EXPORT_HISTORY_DAYS,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id"));
  if (form.get("intent") === "cancel") await cancelJob(session.shop, id);
  if (form.get("intent") === "rerun") await rerunJob(session.shop, id);
  if (form.get("intent") === "seen-all") await markReviewed(session.shop);
  return { ok: true };
};

const HISTORY_FILTERS: Array<{ key: JobFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "export", label: "Exports" },
  { key: "import", label: "Imports" },
  { key: "scheduled", label: "Scheduled" },
  { key: "problems", label: "Problems" },
];

export default function Home() {
  const { jobs, attention, filter, total, scheduleCount, maxUploadMb, historyDays } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
  const [params, setParams] = useSearchParams();
  // The job whose button was just pressed, until the list has refreshed.
  const pendingId = fetcher.state !== "idle" ? String(fetcher.formData?.get("id") ?? "") || null : null;
  const anyActive = jobs.some((j) => isActive(j.status));

  // Poll while jobs are running.
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(t);
  }, [anyActive, revalidator]);

  return (
    <s-page heading="Bulkport" inlineSize="large">
      <div className="bp-column">
        {attention.length ? (
          <s-banner tone="critical" heading={`${attention.length} ${attention.length === 1 ? "job needs" : "jobs need"} your attention`}>
            <s-stack direction="block" gap="small">
              {attention.slice(0, 5).map((a) => (
                <s-text key={a.id}>
                  <s-link href={`/app/jobs/${a.id}`}>{a.title}</s-link>
                  {a.scheduled ? " (scheduled)" : ""} · {formatDate(a.createdAt)}: {a.summary}
                </s-text>
              ))}
              {attention.length > 5 ? <s-text tone="neutral">…and {attention.length - 5} more in the list below.</s-text> : null}
              <s-stack direction="inline" gap="small">
                <s-button onClick={() => fetcher.submit({ intent: "seen-all", id: "" }, { method: "post" })}>Mark all as seen</s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        ) : null}
        <s-section heading="Export">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-text tone="neutral">Choose data, filters and columns, then download an Excel or CSV file.</s-text>
            <s-button variant="primary" href="/app/export">
              New export
            </s-button>
          </s-stack>
        </s-section>

        <ImportForm maxUploadMb={maxUploadMb} />

        <s-paragraph>
          {scheduleCount === 0 ? (
            <>
              Nothing is scheduled yet. <s-link href="/app/schedules">Schedules</s-link>
            </>
          ) : (
            <>
              You have{" "}
              <s-link href="/app/schedules">
                {scheduleCount} scheduled {scheduleCount === 1 ? "job" : "jobs"}
              </s-link>
              .
            </>
          )}
        </s-paragraph>

        <s-stack direction="inline" gap="small" alignItems="center">
          <s-heading>History</s-heading>
          {HISTORY_FILTERS.map((f) => (
            <s-button
              key={f.key}
              variant={filter === f.key ? "primary" : "tertiary"}
              onClick={() => setParams(f.key === "all" ? {} : { show: f.key }, { replace: true, preventScrollReset: true })}
            >
              {f.label}
            </s-button>
          ))}
        </s-stack>
        {jobs.length === 0 ? (
          <s-section>
            <s-text tone="neutral">
              {filter === "all"
                ? "Exports and imports you run will be listed here."
                : filter === "problems"
                  ? "Nothing has failed. Jobs that fail or finish with errors are listed here."
                  : "No jobs of this kind yet."}
            </s-text>
          </s-section>
        ) : (
          <s-section padding="none" accessibilityLabel="Job history">
            <div className="bp-jobs">
              {jobs.map((job) => {
                const row = jobRow(job);
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
                        <HealthBadge job={job} />
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
                            onClick={() => fetcher.submit({ intent: "cancel", id: job.id }, { method: "post" })}
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
                            onClick={() => fetcher.submit({ intent: "rerun", id: job.id }, { method: "post" })}
                          >
                            Run again
                          </s-button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </s-section>
        )}
        {total > jobs.length ? (
          <s-stack direction="inline" gap="small" alignItems="center" justifyContent="center">
            <s-text tone="neutral">
              Showing {jobs.length} of {total.toLocaleString("en")}
            </s-text>
            <s-button
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("n", String(jobs.length + 30));
                setParams(next, { replace: true, preventScrollReset: true });
              }}
            >
              Show more
            </s-button>
          </s-stack>
        ) : null}
        {historyDays > 0 ? (
          <s-text tone="neutral">
            Exports stay in this list for {historyDays} days, then they and their files are cleared. A schedule's latest file is kept for its permanent link.
          </s-text>
        ) : null}
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
