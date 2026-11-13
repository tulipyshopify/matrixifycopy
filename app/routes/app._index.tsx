import path from "node:path";
import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { EXPORT_HISTORY_DAYS, cancelJob, downloadLinks, listJobs, listSchedules, rerunJob } from "../lib/jobs/jobs.server";
import { describeSchedule } from "../lib/jobs/schedule-time";
import { StatusBadge, formatDate, isActive, jobRow } from "../components/jobs";
import { ImportForm } from "../components/ImportForm";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 200);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [jobs, schedules] = await Promise.all([listJobs(session.shop), listSchedules(session.shop)]);
  const repeats = new Map(schedules.map((s) => [s.id, describeSchedule(s)]));
  return {
    jobs: jobs.map(({ resultFile, scheduleId, ...j }) => ({
      ...j,
      links: downloadLinks({ id: j.id, resultFile, inputFile: null }),
      fileName: resultFile ? path.basename(resultFile) : null,
      repeat: scheduleId ? (repeats.get(scheduleId) ?? null) : null,
    })),
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
  return { ok: true };
};

export default function Home() {
  const { jobs, scheduleCount, maxUploadMb, historyDays } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
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

        {jobs.length === 0 ? (
          <s-section>
            <s-text tone="neutral">Exports and imports you run will be listed here.</s-text>
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
                      {job.error ? <s-text tone="critical">{job.error}</s-text> : null}
                    </div>
                    <div className="bp-job-side">
                      <div className="bp-job-line bp-job-end">
                        <s-badge>{row.format}</s-badge>
                        <StatusBadge status={job.status} />
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
