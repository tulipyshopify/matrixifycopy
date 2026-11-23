import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { usePolling } from "../components/usePolling";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { applyDryRun, applyNeeds, markReviewed, cancelJob, downloadLinks, entityCatalog, getJob, readPartialPreview, readPreview, rerunJob, startUndo } from "../lib/jobs/jobs.server";
import { editableRows, editedRowCount, fixPreviewRows } from "../lib/jobs/fix.server";
import { createGql } from "../lib/core/gql";
import { SHARE_DAYS, createShare, shareStatus, stopShare } from "../lib/jobs/share.server";
import { feedSummary, readFeedDiff } from "../lib/jobs/feed.server";
import { undoFileOf } from "../lib/jobs/runner.server";
import { jobDir, RETENTION_DAYS } from "../lib/jobs/storage.server";
import { FirstLook, ImportReview, ImportSteps } from "../components/DryRunPreview";
import { jobHealth } from "../lib/jobs/health";
import { ExportDetails } from "../components/ExportDetails";
import { Icon } from "../components/ui";
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
  const sameUpload = new URL(request.url).searchParams.get("same") === "1";
  // While a preview is still running: the first rows it has checked, to look at straight away.
  const firstLook = dryRun && (job.status === "running" || job.status === "queued") ? await readPartialPreview(session.shop, job.id) : [];
  const editedRows = dryRun && job.status === "finished" ? await editedRowCount(session.shop, job.id) : 0;
  let undoOf: string | null = null;
  try {
    undoOf = JSON.parse(job.config).undoOf ?? null;
  } catch {
    undoOf = null;
  }
  const done = job.status === "finished" || job.status === "failed" || job.status === "cancelled";
  return {
    // A real import that recorded how to put things back.
    canUndo: job.type === "import" && !dryRun && done && !!undoFileOf(jobDir(session.shop, job.id)),
    undoDays: RETENTION_DAYS,
    undoOf,
    dryRun,
    preview,
    firstLook,
    editedRows,
    sameUpload,
    feed: await (async () => {
      // A scheduled import from a link: what differs from the file fetched last time.
      const d = job.type === "import" && job.scheduleId ? await readFeedDiff(jobDir(session.shop, job.id)) : null;
      return d ? { lines: feedSummary(d), examples: d.sheets.flatMap((s) => s.examples).slice(0, 6), previousAt: d.previousAt, alarming: d.sheets.some((s) => s.removed > 20 && s.removed > (s.rows + s.removed) * 0.3) } : null;
    })(),
    share: dryRun && job.status === "finished" ? await shareStatus(session.shop, job.id) : null,
    shareDays: SHARE_DAYS,
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
  const { session, redirect, admin } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "cancel") await cancelJob(session.shop, params.id!);
  // A link to this preview for someone to check (read only).
  if (form.get("intent") === "share") {
    try {
      const made = await createShare(session.shop, params.id!);
      return { shareUrl: `${(process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "")}${made.path}` };
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  }
  if (form.get("intent") === "unshare") {
    await stopShare(session.shop, params.id!);
    return { ok: true };
  }
  // Correcting a row on the preview's page: its cells, then a fresh check of just that row.
  if (form.get("intent") === "row") {
    try {
      return { rows: await editableRows(session.shop, params.id!, String(form.get("sheet")), Number(form.get("row"))) };
    } catch (e: any) {
      return { rowError: String(e?.message ?? e) };
    }
  }
  if (form.get("intent") === "fix" || form.get("intent") === "unfix") {
    try {
      const gql = createGql(async (query, variables) => (await admin.graphql(query, { variables })).json());
      let fixes = [];
      try {
        fixes = JSON.parse(String(form.get("fixes") ?? "[]"));
      } catch {
        fixes = [];
      }
      const items = await fixPreviewRows(session.shop, params.id!, String(form.get("sheet")), Number(form.get("row")), fixes, gql, { reset: form.get("intent") === "unfix" });
      return { fixed: { sheet: String(form.get("sheet")), row: Number(form.get("row")), actions: items.map((i) => i.action), message: items.find((i) => i.action === "failed")?.message ?? "" } };
    } catch (e: any) {
      if (e instanceof Response) throw e;
      return { rowError: String(e?.message ?? e) };
    }
  }
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
  if (form.get("intent") === "undo") {
    try {
      const job = await startUndo(session.shop, params.id!);
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
  const { job, links, entities, dryRun, preview, firstLook, editedRows, sameUpload, share, shareDays, feed, canApply, needs, canUndo, undoDays, undoOf } = useLoaderData<typeof loader>();
  const stopped = job.stats.some((s: any) => s?.stopped);
  const undoRows = job.stats.reduce((n: number, s: any) => n + (Number(s?.undoRows) || 0), 0);
  const undoNotes: string[] = job.stats.flatMap((s: any) => s?.undoNotes ?? []);
  let exported: any[] = [];
  try {
    if (job.type === "export") exported = JSON.parse(job.config).entities ?? [];
  } catch {
    // unreadable config: just skip the details
  }
  // Keyed by the job: a refusal shown on one preview doesn't follow to the next ("Preview again").
  const fetcher = useFetcher<{ error?: string }>({ key: `job-${job.id}` });
  const sharer = useFetcher<{ shareUrl?: string; error?: string }>();
  const [copied, setCopied] = useState(false);
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

      {job.type === "import" && !dryRun && job.status === "finished" && !job.error ? (
        (() => {
          const sum = (k: string) => job.stats.reduce((x: number, st: any) => x + (Number(st?.[k]) || 0), 0);
          const ok = sum("ok");
          const failed = sum("failed");
          const skipped = sum("skipped");
          return (
            <div className={`bp-done${failed || stopped ? " bp-done-warn" : ""}`}>
              <span className="bp-done-icon">
                <Icon name={failed || stopped ? "alert" : "check"} size={24} />
              </span>
              <div className="bp-done-text">
                <b>{stopped ? "Import stopped part-way" : failed ? "Import finished, with rows to look at" : "Import complete"}</b>
                <span>
                  {timing ? `${timing}. ` : ""}
                  {canUndo ? `You can undo it for ${undoDays} days.` : "The store now has these values."}
                </span>
              </div>
              <div className="bp-done-nums">
                <span>
                  <b>{ok.toLocaleString("en")}</b>applied
                </span>
                {failed ? (
                  <span>
                    <b style={{ color: "#b3261e" }}>{failed.toLocaleString("en")}</b>failed
                  </span>
                ) : null}
                {skipped ? (
                  <span>
                    <b>{skipped.toLocaleString("en")}</b>
                    skipped
                  </span>
                ) : null}
              </div>
              <div className="bp-done-actions">
                {links.result ? (
                  <s-button href={links.result} target="_blank">
                    Results file
                  </s-button>
                ) : null}
                <s-button href={`/app/history?job=${job.id}`}>What changed</s-button>
              </div>
            </div>
          );
        })()
      ) : null}

      {fetcher.data?.error && !(needs && dryRun) ? (
        <s-banner tone="critical" heading="Could not start the import">
          {fetcher.data.error}
        </s-banner>
      ) : null}

      {stopped ? (
        <s-banner tone="critical" heading="The import stopped: too many rows were failing">
          <s-text>The rows before the stop were imported; the rest were not. See the reasons below, fix the file and preview it again. What was imported can be undone with the button below.</s-text>
        </s-banner>
      ) : null}
      {undoOf && dryRun ? (
        <s-banner tone="info" heading="This is the undo of an earlier import">
          <s-text>
            It puts back the values <s-link href={`/app/jobs/${undoOf}`}>that import</s-link> changed. Anything edited since then shows here as a change too, so check the list before applying.
          </s-text>
        </s-banner>
      ) : null}
      {canUndo ? (
        <s-section>
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack direction="block" gap="small-300">
              <s-heading>This import can be undone</s-heading>
              <s-text tone="neutral">
                The values it changed were recorded first ({undoRows.toLocaleString("en")} rows), and are kept for {undoDays} days. Undo opens a preview of putting them back; nothing changes until you apply it.
                {undoNotes.length ? ` Not covered: ${undoNotes.slice(0, 3).join("; ")}${undoNotes.length > 3 ? ` and ${undoNotes.length - 3} more` : ""}.` : ""}
              </s-text>
            </s-stack>
            <s-button icon="undo" loading={fetcher.state !== "idle" && fetcher.formData?.get("intent") === "undo"} onClick={() => fetcher.submit({ intent: "undo" }, { method: "post" })}>
              Undo this import
            </s-button>
          </s-stack>
        </s-section>
      ) : null}

      {dryRun && !job.error && job.status !== "failed" && job.status !== "cancelled" ? (
        <s-banner
          tone="info"
          heading={active ? "Preview running: nothing in the store is being changed" : "Preview only: nothing in the store was changed"}
        >
          <s-text>
            {active
              ? "Every row is checked against the store as a real import would, without changing anything."
              : preview.some((s: any) => (s.items ?? []).some((i: any) => !i.compared && i.action !== "failed" && i.action !== "skipped" && i.changes?.length))
                ? "Every row was checked against the store. For some data types in this file the preview shows what the first step would send rather than a field-by-field comparison; those items are marked. Risky rows start as Skip: choose what to include, then review and apply."
                : "Every item was compared with what is in the store right now. Risky rows start as Skip: choose what to include, then review and apply."}
          </s-text>
        </s-banner>
      ) : null}

      {!job.error && job.status === "finished" && health.problems > 0 && !dryRun ? (
        <s-banner tone={dryRun || job.type === "export" ? "warning" : "critical"} heading={job.type === "export" ? "Some sheets are not in this export" : dryRun ? "The preview found problems" : "Finished with errors"}>
          <s-stack direction="block" gap="small">
            <s-text>{health.summary}.</s-text>
            <s-text>
              {job.type === "export"
                ? "For a sheet the app has no permission for, leave it out of the export; the developer can add the permission if you need that data."
                : dryRun
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

      {dryRun && job.status === "finished" && links.input && (job.stats.some((x: any) => x?.entity === null && x?.skipped) || job.stats.some((x: any) => (x?.warnings ?? []).some((w: string) => /not .* columns? and (is|are) ignored|use "Match columns"/.test(w)))) ? (
        <s-banner tone="warning" heading={job.stats.some((x: any) => x?.entity === null && x?.skipped) ? "Bulkport could not tell what this file holds" : "Some columns of this file were not recognised"}>
          <s-stack direction="block" gap="small">
            <s-text>If the file comes from a supplier or another system, its columns have their own names. Say once which column is which, and files like it are read correctly from then on.</s-text>
            <div>
              <s-button variant="primary" href={`/app/jobs/${job.id}/columns`}>
                Match columns
              </s-button>
            </div>
          </s-stack>
        </s-banner>
      ) : null}

      {dryRun && job.status === "finished" && job.stats.some((x: any) => (x?.warnings ?? []).some((w: string) => w.startsWith("Read with your saved column matching"))) ? (
        <s-banner tone="warning" heading="This file was read with a column matching you saved earlier">
          <s-stack direction="block" gap="small">
            {job.stats.flatMap((x: any) => (x?.warnings ?? []).filter((w: string) => w.startsWith("Read with your saved column matching"))).slice(0, 3).map((w: string, k: number) => (
              <s-text key={k}>{w}</s-text>
            ))}
            <s-text>Bulkport did not ask again because the columns are the same as before. Check the matches are still right for this file, prices above all, before you apply it.</s-text>
            {links.input ? (
              <div>
                <s-button href={`/app/jobs/${job.id}/columns`}>Check or change the matching</s-button>
              </div>
            ) : null}
          </s-stack>
        </s-banner>
      ) : null}
      {sameUpload ? (
        <s-banner tone="info" heading="This is the same file you uploaded a moment ago">
          <s-text>It was already here with the same settings, so no second job was started. This is the one that is running (or its finished preview).</s-text>
        </s-banner>
      ) : null}
      {feed ? (
        <s-banner tone={feed.alarming ? "warning" : "info"} heading={`Compared with the file fetched ${formatDate(feed.previousAt)}`}>
          <s-stack direction="block" gap="small-300">
            {feed.lines.map((l: string, k: number) => (
              <s-text key={k}>{l[0].toUpperCase() + l.slice(1)}</s-text>
            ))}
            {feed.examples.length ? <s-text color="subdued">For example: {feed.examples.join("; ")}</s-text> : null}
          </s-stack>
        </s-banner>
      ) : null}

      {active && dryRun && firstLook.length ? <FirstLook sheets={firstLook} timing={timing} /> : null}

      {needs && dryRun ? (
        <ImportReview
          jobId={job.id}
          editedRows={editedRows}
          error={fetcher.state === "idle" ? fetcher.data?.error : undefined}
          sheets={preview}
          needs={needs}
          canApply={canApply}
          busy={applying}
          undoDays={undoDays}
          onImport={(confirm) => fetcher.submit({ intent: "apply", confirm: JSON.stringify(confirm) }, { method: "post" })}
        />
      ) : null}

      {share && needs && needs.changes > 0 ? (
        <s-section heading="Ask someone to check this preview">
          <s-stack direction="block" gap="small">
            {share.replies.map((r: any) => (
              <s-banner key={r.at} tone={r.verdict === "approve" ? "info" : "warning"} heading={`Through the shared link, someone giving the name "${r.name}" ${r.verdict === "approve" ? "approved this preview" : "asked for changes"}`}>
                <s-text>
                  {formatDate(r.at)}
                  {r.note ? `: “${r.note}”` : ""}
                </s-text>
                <s-text color="subdued">Name not verified: it was typed in, and anyone who has the link can answer under any name. Check with the person if it matters. This answer applies nothing.</s-text>
              </s-banner>
            ))}
            <s-text color="subdued">
              A link that shows this preview, read only, to a colleague or a client without access to your store. They can answer "approved" or "please change"; their answer appears here. It can't apply anything. Anyone who has the link can see the preview's contents for {shareDays} days, so send it only to people who may see this data.
            </s-text>
            {sharer.data?.shareUrl ? (
              <s-stack direction="inline" gap="small" alignItems="end">
                <s-text-field label="Link to send (shown once)" readOnly value={sharer.data.shareUrl} />
                <s-button
                  onClick={() => {
                    void navigator.clipboard?.writeText(sharer.data!.shareUrl!);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </s-button>
              </s-stack>
            ) : null}
            {sharer.data?.error ? <s-text tone="critical">{sharer.data.error}</s-text> : null}
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button loading={sharer.state !== "idle" && sharer.formData?.get("intent") === "share"} onClick={() => (setCopied(false), sharer.submit({ intent: "share" }, { method: "post" }))}>
                {share.active ? "Make a new link (the old one stops working)" : "Create a link"}
              </s-button>
              {share.active ? (
                <>
                  <s-button variant="tertiary" tone="critical" onClick={() => sharer.submit({ intent: "unshare" }, { method: "post" })}>
                    Stop sharing
                  </s-button>
                  <s-text color="subdued">A link is active until {formatDate(share.expiresAt)}.</s-text>
                </>
              ) : null}
            </s-stack>
          </s-stack>
        </s-section>
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
                {job.cancelRequested ? "Stopping…" : job.type === "export" ? "Stop export" : dryRun ? "Stop preview" : "Stop import"}
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
          {links.input && job.type === "import" && !active ? <s-link href={`/app/jobs/${job.id}/columns`}>Match this file's columns</s-link> : null}
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
                  <s-table-header format="numeric">{job.status === "cancelled" ? "Not processed" : "Skipped"}</s-table-header>
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
