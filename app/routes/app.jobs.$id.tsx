import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { cancelJob, downloadLinks, getJob, rerunJob } from "../lib/jobs/jobs.server";
import { StatusBadge, formatDate, isActive, jobSummary, jobTiming, progressText } from "../components/jobs";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const job = await getJob(session.shop, params.id!);
  return {
    job: {
      id: job.id,
      type: job.type,
      status: job.status,
      name: job.name,
      format: job.format,
      inputName: job.inputName,
      config: job.config,
      progress: job.progress,
      total: job.total,
      stats: JSON.parse(job.stats) as any[],
      log: job.log,
      error: job.error,
      cancelRequested: job.cancelRequested,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    },
    links: downloadLinks(job),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "cancel") await cancelJob(session.shop, params.id!);
  if (form.get("intent") === "rerun") {
    const job = await rerunJob(session.shop, params.id!);
    return redirect(`/app/jobs/${job.id}`);
  }
  return { ok: true };
};

export default function JobDetail() {
  const { job, links } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
  const active = isActive(job.status);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(t);
  }, [active, revalidator]);

  // Timing depends on the current time, so it is computed in the browser only
  // (rendering it on the server would not match) and refreshed every second.
  const [timing, setTiming] = useState("");
  useEffect(() => {
    setTiming(jobTiming(job));
    if (!active) return;
    const t = setInterval(() => setTiming(jobTiming(job)), 1000);
    return () => clearInterval(t);
  }, [job, active]);
  const pct = job.total ? Math.min(100, Math.floor((job.progress / job.total) * 100)) : null;
  const heading = `${job.type === "export" ? "Export" : "Import"}: ${jobSummary(job)}`;

  return (
    <s-page heading={heading} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Jobs
      </s-link>
      {links.result ? (
        <s-button slot="primary-action" variant="primary" href={links.result} target="_blank">
          {job.type === "export" ? "Download export" : "Download results"}
        </s-button>
      ) : null}
      {active ? (
        <s-button
          slot="secondary-actions"
          tone="critical"
          onClick={() => fetcher.submit({ intent: "cancel" }, { method: "post" })}
        >
          Cancel
        </s-button>
      ) : (
        <s-button slot="secondary-actions" onClick={() => fetcher.submit({ intent: "rerun" }, { method: "post" })}>
          Run again
        </s-button>
      )}

      {job.error ? (
        <s-banner tone="critical" heading="Job failed">
          {job.error}
        </s-banner>
      ) : null}

      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack direction="inline" gap="base" alignItems="center">
              <StatusBadge status={job.cancelRequested && active ? "stopping" : job.status} />
              <s-text>{progressText(job)}</s-text>
              {timing ? <s-text tone="neutral">{timing}</s-text> : null}
            </s-stack>
            {active ? (
              <s-button
                tone="critical"
                disabled={job.cancelRequested}
                onClick={() => fetcher.submit({ intent: "cancel" }, { method: "post" })}
              >
                {job.cancelRequested ? "Stopping…" : job.type === "export" ? "Stop export" : "Stop import"}
              </s-button>
            ) : null}
          </s-stack>
          {pct !== null && active ? (
            <s-box background="subdued" borderRadius="base" blockSize="8px">
              <div style={{ width: `${pct}%`, height: 8, borderRadius: 4, background: "var(--s-color-bg-fill-brand, #303030)" }} />
            </s-box>
          ) : null}
          <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
            <s-stack direction="block">
              <s-text tone="neutral">Created</s-text>
              <s-text>{formatDate(job.createdAt)}</s-text>
            </s-stack>
            <s-stack direction="block">
              <s-text tone="neutral">Started</s-text>
              <s-text>{formatDate(job.startedAt) || "—"}</s-text>
            </s-stack>
            <s-stack direction="block">
              <s-text tone="neutral">Finished</s-text>
              <s-text>{formatDate(job.finishedAt) || "—"}</s-text>
            </s-stack>
          </s-grid>
          {links.input ? (
            <s-link href={links.input} target="_blank">
              Download the original file ({job.inputName})
            </s-link>
          ) : null}
        </s-stack>
      </s-section>

      {job.stats.length ? (
        <s-section heading="Summary" padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Sheet</s-table-header>
              {job.type === "export" ? (
                <>
                  <s-table-header format="numeric">Items</s-table-header>
                  <s-table-header format="numeric">Rows</s-table-header>
                </>
              ) : (
                <>
                  <s-table-header format="numeric">OK</s-table-header>
                  <s-table-header format="numeric">Failed</s-table-header>
                  <s-table-header format="numeric">Skipped</s-table-header>
                </>
              )}
            </s-table-header-row>
            <s-table-body>
              {job.stats.map((s: any, i: number) => (
                <s-table-row key={i}>
                  <s-table-cell>{s.sheet ?? s.entity}</s-table-cell>
                  {job.type === "export" ? (
                    <>
                      <s-table-cell>{s.items.toLocaleString()}</s-table-cell>
                      <s-table-cell>{s.rows.toLocaleString()}</s-table-cell>
                    </>
                  ) : (
                    <>
                      <s-table-cell>{s.ok.toLocaleString()}</s-table-cell>
                      <s-table-cell>{s.failed.toLocaleString()}</s-table-cell>
                      <s-table-cell>{s.skipped.toLocaleString()}</s-table-cell>
                    </>
                  )}
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}

      <s-section heading="Log">
        <s-box padding="base" background="subdued" borderRadius="base" overflow="hidden">
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 420, overflowY: "auto" }}>
            {job.log || "Waiting to start…"}
          </pre>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
