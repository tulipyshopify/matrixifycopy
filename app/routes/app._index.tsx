import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { userOf } from "../lib/user.server";
import { cancelJob, createExportJob, homeStats, listPresets, markReviewed, needsAttention, parseExportConfig, rerunJob } from "../lib/jobs/jobs.server";
import { jobListData } from "../lib/jobs/joblist.server";
import { formatDate, isActive, jobRow } from "../components/jobs";
import { JobList } from "../components/JobList";
import { usePolling } from "../components/usePolling";
import { isDryRunConfig, jobHealth } from "../lib/jobs/health";
import { ImportForm } from "../components/ImportForm";
import { AskBox } from "../components/AskBox";
import { ActionTile, EmptyState, StatTile } from "../components/ui";
import { EXPORT_TEMPLATES, getTemplate } from "../lib/jobs/templates";
import { latestChecks, scoreDrop } from "../lib/check/check.server";
import { DEFAULT_BACKUP_TYPES, backupNow, backupsAllowed, saveBackupSettings } from "../lib/jobs/backups.server";
import { browserTimeZone } from "../components/ScheduleTime";
import { assistantAllowed } from "../lib/ai/assistant.server";

/** Jobs shown on Home; the Jobs page has them all. */
const RECENT = 6;

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 200);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const { session } = auth;
  const user = userOf(auth);
  const [stats, list, attention, presets] = await Promise.all([homeStats(session.shop), jobListData(session.shop, RECENT), needsAttention(session.shop), listPresets(session.shop, user)]);
  const checkScore = (await latestChecks(session.shop)).latest?.report?.score ?? null;
  const checkDrop = await scoreDrop(session.shop);
  return {
    jobs: list.jobs,
    total: list.total,
    attention: attention.map((j) => {
      const row = jobRow({ ...j, format: "", progress: 0, total: 0, startedAt: null, finishedAt: null });
      return {
        id: j.id,
        title: `${row.kind} #${row.number}: ${row.title.length > 70 ? `${row.title.slice(0, 67)}…` : row.title}`,
        summary: jobHealth({ ...j, dryRun: isDryRunConfig(j.config) }).summary,
        createdAt: j.createdAt,
        // A one-off import from a link also carries a (hidden) schedule: not "scheduled".
        scheduled: !!j.scheduleId && list.repeats.has(j.scheduleId),
      };
    }),
    stats,
    checkScore,
    checkDrop,
    templates: EXPORT_TEMPLATES.map(({ key, title, description }) => ({ key, title, description })),
    presets: presets.slice(0, 6).map((p) => ({ id: p.id, name: p.name })),
    backupsEnabled: backupsAllowed(session.shop),
    askEnabled: assistantAllowed(session.shop),
    scheduleCount: list.schedules.filter((s) => s.enabled).length,
    maxUploadMb: MAX_UPLOAD_MB,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const { session, redirect } = auth;
  const user = userOf(auth);
  const form = await request.formData();
  const id = String(form.get("id"));
  if (form.get("intent") === "cancel") await cancelJob(session.shop, id);
  if (form.get("intent") === "rerun") return redirect(`/app/jobs/${(await rerunJob(session.shop, id)).id}`);
  if (form.get("intent") === "seen-all") await markReviewed(session.shop);
  if (form.get("intent") === "quick-export") {
    // One click: a template or a saved export, run as it is.
    try {
      const [kind, key] = id.split(/:(.*)/s);
      const preset = kind === "preset" ? (await listPresets(session.shop, user)).find((p) => p.id === key) : null;
      const template = kind === "template" ? getTemplate(key) : null;
      if (!preset && !template) throw new Error("That export is no longer there");
      const config = parseExportConfig({ entities: preset ? preset.data.entities : template!.entities });
      const job = await createExportJob(session.shop, config, preset?.data.format ?? "xlsx", preset?.name ?? template!.title);
      return redirect(`/app/jobs/${job.id}`);
    } catch (e: any) {
      if (e instanceof Response) throw e;
      return { error: e.message as string };
    }
  }
  if (form.get("intent") === "enable-backups") {
    // One click: every data type, daily at 02:30 in the merchant's time zone, kept 30 days, first backup now.
    try {
      await saveBackupSettings(session.shop, { enabled: true, runAt: "02:30", timezone: String(form.get("timezone") || "UTC"), types: DEFAULT_BACKUP_TYPES, keepDays: 30 });
      await backupNow(session.shop).catch(() => {});
    } catch (e: any) {
      return { error: e.message as string };
    }
  }
  return { ok: true };
};

/** "today", "yesterday", "3 days ago". */
function daysAgo(d: string | Date): string {
  const n = Math.floor((Date.now() - new Date(d).getTime()) / 86400_000);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
}

export default function Home() {
  const { jobs, attention, total, scheduleCount, maxUploadMb, askEnabled, stats, templates, presets, backupsEnabled, checkScore, checkDrop } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ error?: string }>();
  const pendingIntent = fetcher.state !== "idle" ? String(fetcher.formData?.get("intent") ?? "") : "";
  // The job or export whose button was just pressed, until the list has refreshed.
  const pendingId = fetcher.state !== "idle" ? String(fetcher.formData?.get("id") ?? "") || null : null;
  usePolling(jobs.some((j) => isActive(j.status)), 3000);
  const first = attention[0];

  return (
    <s-page inlineSize="large">
      <div className="bp-column">
        <header className="bp-hero">
          <div className="bp-hero-text">
            <h1>What would you like to change today?</h1>
            <p>Every change is shown before it is made, and can be undone afterwards.</p>
          </div>
          <div className="bp-acts">
            <ActionTile primary href="#import" icon="import" title="Import a file" note="Excel, CSV or ZIP, with images" />
            <ActionTile href="/app/tasks" icon="bolt" title="Quick change" note="Prices, tags, text: no file needed" />
            <ActionTile href="/app/edit" icon="table" title="Edit in a table" note="Type and paste like a spreadsheet" />
            <ActionTile href="/app/export?new=1" icon="export" title="Export" note="Any data, the columns you choose" />
          </div>
        </header>
        {fetcher.data?.error ? (
          <s-banner tone="critical" heading="That didn't work">
            {fetcher.data.error}
          </s-banner>
        ) : null}
        {/* One banner for whatever needs action, with the way to it. */}
        {first ? (
          <s-banner tone="critical" heading={attention.length === 1 ? `${first.title} needs your attention` : `${attention.length} jobs need your attention`}>
            <s-stack direction="block" gap="small">
              {attention.slice(0, 3).map((a) => (
                <s-text key={a.id}>
                  <s-link href={`/app/jobs/${a.id}`}>{a.title}</s-link>
                  {a.scheduled ? " (scheduled)" : ""} · {formatDate(a.createdAt)}: {a.summary}
                </s-text>
              ))}
              <s-stack direction="inline" gap="small">
                <s-button variant="primary" href={attention.length === 1 ? `/app/jobs/${first.id}` : "/app/jobs?show=problems"}>
                  {attention.length === 1 ? "Open it" : "See them all"}
                </s-button>
                <s-button onClick={() => fetcher.submit({ intent: "seen-all", id: "" }, { method: "post" })}>Mark as seen</s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        ) : checkDrop ? (
          <s-banner tone="warning" heading={`Your catalogue health score dropped from ${checkDrop.from} to ${checkDrop.to}`}>
            <s-stack direction="block" gap="small">
              <s-text>The weekly check found more products with gaps than last time, often newly added ones.</s-text>
              <s-stack direction="inline">
                <s-button href="/app/check">See what changed</s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        ) : null}

        <div className="bp-stats" aria-label="Status">
          {backupsEnabled ? (
            <StatTile
              href="/app/backups"
              icon="shield"
              label="Backups"
              value={stats.backupOn ? "On" : "Off"}
              note={stats.lastBackupAt ? `Last ${daysAgo(stats.lastBackupAt)}` : stats.backupOn ? "First one tonight" : "No backup yet"}
              tone={stats.backupOn ? "ok" : "warn"}
            />
          ) : null}
          <StatTile
            href="/app/check"
            icon="heart"
            label="Catalogue health"
            value={checkScore === null ? "Not checked" : `${checkScore} / 100`}
            note={checkScore === null ? "Run a check" : checkDrop ? `Down ${checkDrop.from - checkDrop.to} since last week` : checkScore >= 80 ? "In good shape" : "Gaps to fix"}
            tone={checkScore === null ? "idle" : checkScore >= 80 && !checkDrop ? "ok" : "warn"}
          />
          <StatTile
            href="/app/schedules"
            icon="clock"
            label="Automations"
            value={scheduleCount ? `${scheduleCount} on` : "None"}
            note={stats.nextSchedule ? `Next ${formatDate(stats.nextSchedule.nextRunAt)}` : "Repeat an export or import"}
            tone={stats.nextSchedule ? "ok" : "idle"}
          />
          <StatTile
            href="/app/jobs?show=problems"
            icon={stats.problems ? "alert" : "check"}
            label="Last 7 days"
            value={stats.problems ? `${stats.problems} ${stats.problems === 1 ? "problem" : "problems"}` : "No problems"}
            note={stats.problems ? "Open to see them" : "Everything went through"}
            tone={stats.problems ? "bad" : "ok"}
          />
        </div>
        {backupsEnabled && !stats.backupOn && !stats.lastBackupAt ? (
          <s-banner tone="info" heading="Keep a daily backup, so a mistake can be put right">
            <s-stack direction="inline" gap="small">
              <s-button
                variant="primary"
                loading={pendingIntent === "enable-backups"}
                disabled={pendingIntent === "enable-backups"}
                onClick={() => fetcher.submit({ intent: "enable-backups", id: "", timezone: browserTimeZone() }, { method: "post" })}
              >
                Turn on daily backups
              </s-button>
              <s-button href="/app/backups">Choose options</s-button>
            </s-stack>
          </s-banner>
        ) : null}

        {stats.firstRun ? (
          <section className="bp-start" aria-label="Getting started">
            <b>New here? Three steps to your first safe change</b>
            <ol>
              <li>
                <span>1</span>
                <div>
                  <b>Get a file in the right layout</b>
                  Press Export on "All products" below, or use a file you already have.
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <b>Edit it and drop it in</b>
                  Change what you need in Excel or Google Sheets, then add the file under Import.
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <b>Check the preview, then apply</b>
                  You see the old and new value of every row first. Nothing changes until you say so.
                </div>
              </li>
            </ol>
          </section>
        ) : null}

        <div className="bp-home">
          <div className="bp-home-import" id="import">
            <ImportForm maxUploadMb={maxUploadMb} />
          </div>
          <s-section>
            <s-stack direction="block" gap="small">
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-heading>Export</s-heading>
                <s-button href="/app/export?new=1">Build your own</s-button>
              </s-stack>
              <s-text tone="neutral">One click starts the export; the file is ready on its page.</s-text>
              <div className="bp-quick">
                {[...templates.map((t) => ({ id: `template:${t.key}`, title: t.title, note: t.description, edit: `/app/export?template=${t.key}` })), ...presets.map((p) => ({ id: `preset:${p.id}`, title: p.name, note: "Your saved export", edit: "/app/export" }))].map((x, i) => (
                  <div key={x.id} className={`bp-quick-row${i >= 3 ? " bp-quick-more" : ""}`}>
                    <div className="bp-quick-text">
                      <s-text type="strong">{x.title}</s-text>
                      <s-text tone="neutral">{x.note}</s-text>
                    </div>
                    <s-button variant="tertiary" href={x.edit} accessibilityLabel={`Adjust ${x.title} before exporting`}>
                      Adjust
                    </s-button>
                    <s-button loading={pendingIntent === "quick-export" && pendingId === x.id} disabled={pendingIntent === "quick-export"} onClick={() => fetcher.submit({ intent: "quick-export", id: x.id }, { method: "post" })}>
                      Export
                    </s-button>
                  </div>
                ))}
              </div>
            </s-stack>
          </s-section>
        </div>

        <s-section padding="none" accessibilityLabel="Recent jobs">
          <s-box padding="base">
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-stack direction="block" gap="small-300">
                <s-heading>Recent jobs</s-heading>
                <s-text tone="neutral">Previews change nothing and are marked as previews, so they are never counted as imports.</s-text>
              </s-stack>
              <s-link href="/app/jobs">All jobs{total > jobs.length ? ` (${total.toLocaleString("en")})` : ""}</s-link>
            </s-stack>
          </s-box>
          {jobs.length ? (
            <JobList jobs={jobs} pendingId={pendingIntent === "quick-export" ? null : pendingId} onAction={(intent, id) => fetcher.submit({ intent, id }, { method: "post" })} />
          ) : (
            <EmptyState icon="history" title="Nothing here yet">
              Exports and imports you run are listed here, each with its file, its result and a way to undo it.
            </EmptyState>
          )}
        </s-section>

        <AskBox enabled={askEnabled} />
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
