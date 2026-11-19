import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { usePolling } from "../components/usePolling";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { applyDryRun, applyNeeds, markReviewed, cancelJob, downloadLinks, entityCatalog, getJob, readPreview, rerunJob } from "../lib/jobs/jobs.server";
import { ImportReview, ImportSteps } from "../components/DryRunPreview";
import { jobHealth } from "../lib/jobs/health";
import { ExportDetails } from "../components/ExportDetails";
import { HealthBadge, StatusBadge, formatDate, isActive, jobSummary, jobTiming, progressText } from "../components/jobs";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const job = await getJob(session.shop, params.id!);
  // Opening a failed job counts as seeing it: it stops asking for attention.
  if (!job.reviewedAt && (job.status === "failed" || job.problems > 0)) await markReviewed(session.shop, job.id);
  let dryRun = false;
  try {
    dryRun = job.type === "import" && !!JSON.parse(job.config).options?.dryRun;
  } catch {
    // unreadable config: not a dry run
  }
  const preview = dryRun && job.status === "finished" ? await readPreview(session.shop, job.id) : [];
  return {
    dryRun,
    preview,
    canApply: dryRun && job.status === "finished" && !!job.inputFile,
    needs: dryRun && job.status === "finished" ? applyNeeds(job.stats) : null,
    job: {
      id: job.id,
      type: job.type,
      kind: job.kind,
      status: job.status,
      name: job.name,
      format: job.format,
      inputName: job.inputName,
      config: job.config,
      progress: job.progress,
      total: job.total,
      stats: JSON.parse(job.stats) as any[],
      statsRaw: job.stats,
      problems: job.problems,
      log: job.log,
      error: job.error,
      cancelRequested: job.cancelRequested,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    },
    links: downloadLinks(job),
    entities: job.type === "export" ? entityCatalog() : [],
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "cancel") await cancelJob(session.shop, params.id!);
  if (form.get("intent") === "apply") {
    try {
      let confirm = {};
      try {
        confirm = JSON.parse(String(form.get("confirm") ?? "{}"));
      } catch {
        confirm = {};
      }
      const job = await applyDryRun(session.shop, params.id!, confirm);
      return redirect(`/app/jobs/${job.id}`);
    } catch (e: any) {
      if (e instanceof Response) throw e;
      return { error: e.message as string };
    }
  }
  if (form.get("intent") === "rerun") {
    const job = await rerunJob(session.shop, params.id!);
    return redirect(`/app/jobs/${job.id}`);
  }
  return { ok: true };
};

export default function JobDetail() {
  const { job, links, entities, dryRun, preview, canApply, needs } = useLoaderData<typeof loader>();
  let exported: any[] = [];
  try {
    if (job.type === "export") exported = JSON.parse(job.config).entities ?? [];
  } catch {
    // unreadable config: just skip the details
  }
  const fetcher = useFetcher<{ error?: string }>();
  const applying = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "apply";
  const active = isActive(job.status);

  usePolling(active, 2000);

  // Timing depends on the current time, so it is computed in the browser only
  // (rendering it on the server would not match) and refreshed every second.
  const [timing, setTiming] = useState("");
  useEffect(() => {
    setTiming(jobTiming(job));
    if (!active) return;
    const t = setInterval(() => setTiming(jobTiming(job)), 1000);
    return () => clearInterval(t);
  }, [job, active]);
  const health = jobHealth({ type: job.type, status: job.status, stats: job.statsRaw, dryRun });
  const pct = job.total ? Math.min(100, Math.floor((job.progress / job.total) * 100)) : null;
  const heading = `${job.kind === "backup" ? "Backup" : job.type === "export" ? "Export" : dryRun ? "Preview (dry run)" : "Import"}: ${jobSummary(job)}`;

  return (
    <s-page heading={heading} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Jobs
      </s-link>
      {links.result ? (
        <s-button
          slot="primary-action"
          variant="primary"
          href={links.result}
          target="_blank"
          onClick={() => (globalThis as any).shopify?.toast?.show("Download started. Look in your browser's downloads.")}
        >
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
          {job.type === "import" ? "Preview again" : "Run again"}
        </s-button>
      )}

      {job.type === "import" && job.kind === "job" ? <ImportSteps step={dryRun ? 2 : 3} /> : null}

      {fetcher.data?.error ? (
        <s-banner tone="critical" heading="Could not start the import">
          {fetcher.data.error}
        </s-banner>
      ) : null}

      {dryRun && !job.error && job.status !== "failed" && job.status !== "cancelled" ? (
        <s-banner
          tone="info"
          heading={active ? "Preview running: nothing in the store is being changed" : "Preview only: nothing in the store was changed"}
        >
          <s-text>
            {active
              ? "Every row is checked against the store as a real import would, without changing anything."
              : "Every item was compared with what is in the store right now. Risky rows start as Skip: choose what to include, then review and apply."}
          </s-text>
        </s-banner>
      ) : null}

      {!job.error && job.status === "finished" && health.problems > 0 && !dryRun ? (
        <s-banner tone={dryRun ? "warning" : "critical"} heading={dryRun ? "The preview found problems" : "Finished with errors"}>
          <s-stack direction="block" gap="small">
            <s-text>{health.summary}.</s-text>
            <s-text>
              {dryRun
                ? "See the Problems filter in the preview below. Fix the file and preview it again; or confirm below to skip those items and import the rest."
                : "The rest went through. The reason for each failed row is in the log below and in the results file (Import Comment column). Fix those rows and import them again."}
            </s-text>
          </s-stack>
        </s-banner>
      ) : null}

      {job.error ? (
        <s-banner tone="critical" heading={job.status === "finished" ? "Finished, with a problem" : dryRun ? "The preview could not be made" : "Job failed"}>
          {job.error}
        </s-banner>
      ) : null}

      {needs && dryRun ? (
        <ImportReview
          sheets={preview}
          needs={needs}
          canApply={canApply}
          busy={applying}
          onImport={(confirm) => fetcher.submit({ intent: "apply", confirm: JSON.stringify(confirm) }, { method: "post" })}
        />
      ) : null}

      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack direction="inline" gap="base" alignItems="center">
              {job.cancelRequested && active ? (
                <StatusBadge status="stopping" />
              ) : (
                <HealthBadge job={{ type: job.type, status: job.status, error: job.error, stats: job.statsRaw, config: job.config }} />
              )}
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

      {exported.length ? (
        <>
          <s-box padding="base small-200 none small-200">
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-heading>What was exported</s-heading>
              <s-button href={`/app/export?from=${job.id}`}>Edit and export again</s-button>
            </s-stack>
          </s-box>
          <ExportDetails entities={entities} exported={exported} stats={job.stats} />
        </>
      ) : null}

      {job.stats.length && job.type !== "export" ? (
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
