import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { usePolling } from "../components/usePolling";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  BACKUP_TYPES,
  DEFAULT_BACKUP_TYPES,
  backupDestination,
  backupNow,
  destinationExpiresIn,
  testDestination,
  backupsAllowed,
  getBackupSchedule,
  listBackups,
  restorePreview,
  saveBackupSettings,
} from "../lib/jobs/backups.server";
import prisma from "../db.server";
import { disconnectDrive, driveAvailable, driveConnectUrl, driveConnected } from "../lib/jobs/drive.server";
import { RESTORE_FIELDS } from "../lib/jobs/runner.server";
import { downloadLinks } from "../lib/jobs/jobs.server";
import { HealthBadge, formatDate, isActive } from "../components/jobs";
import { browserTimeZone } from "../components/ScheduleTime";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const allowed = backupsAllowed(session.shop);
  if (!allowed) return { allowed, schedule: null, backups: [], keepDays: 30, types: BACKUP_TYPES, destination: "", destinationExpiresIn: null, restoreFields: [], drive: { available: false, connected: false, connectUrl: "" } };
  const [schedule, backups, settings] = await Promise.all([getBackupSchedule(session.shop), listBackups(session.shop), prisma.shopSetting.findUnique({ where: { shop: session.shop } })]);
  let types = DEFAULT_BACKUP_TYPES;
  try {
    if (schedule) types = JSON.parse(schedule.config).entities.map((e: any) => e.entity);
  } catch {
    // defaults
  }
  return {
    allowed,
    types: BACKUP_TYPES,
    keepDays: settings?.backupKeepDays ?? 30,
    schedule: schedule
      ? { enabled: schedule.enabled, runAt: schedule.runAt ?? "02:30", timezone: schedule.timezone ?? "", nextRunAt: schedule.nextRunAt, types }
      : null,
    destination: backupDestination(schedule),
    destinationExpiresIn: destinationExpiresIn(schedule),
    drive: { available: driveAvailable(), connected: await driveConnected(session.shop), connectUrl: driveAvailable() ? driveConnectUrl(session.shop) : "" },
    restoreFields: RESTORE_FIELDS.map(({ key, label, note, byDefault }) => ({ key, label, note, byDefault })),
    backups: backups.map((b) => ({
      id: b.id,
      status: b.status,
      createdAt: b.createdAt,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      error: b.error,
      size: b.size,
      zipped: /\.zip$/i.test(b.fileName ?? ""),
      progress: b.progress,
      total: b.total,
      stats: b.stats,
      config: b.config,
      link: downloadLinks({ id: b.id, resultFile: b.resultFile, inputFile: null }).result,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "test-destination") {
      const where = await testDestination(session.shop);
      return { ok: `It works: a small test file was written to ${where}. You can delete it.` };
    }
    if (intent === "drive-off") {
      await disconnectDrive(session.shop);
      return { ok: "Google Drive is disconnected. Backups already saved there stay in your Drive." };
    }
    if (intent === "now") {
      await backupNow(session.shop);
      return { ok: "Backup started. It appears in the list below." };
    }
    if (intent === "restore") {
      const only = String(form.get("only") ?? "").split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
      const fields = form.has("fields") ? String(form.get("fields")).split(",").filter(Boolean) : undefined;
      const job = await restorePreview(session.shop, String(form.get("id")), only, fields);
      return redirect(`/app/jobs/${job.id}`);
    }
    await saveBackupSettings(session.shop, {
      enabled: form.get("enabled") === "true",
      runAt: String(form.get("runAt") ?? ""),
      timezone: String(form.get("timezone") ?? ""),
      types: String(form.get("types") ?? "").split(",").filter(Boolean),
      keepDays: Number(form.get("keepDays")),
      uploadUrl: form.has("uploadUrl") ? String(form.get("uploadUrl")) : undefined,
      uploadUser: String(form.get("uploadUser") ?? ""),
      uploadPassword: String(form.get("uploadPassword") ?? ""),
    });
    return { ok: "Saved" };
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};

function size(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function contents(stats: string): string {
  try {
    return (JSON.parse(stats) as Array<{ entity: string; items: number; rows?: number; error?: string }>)
      .map((s) => (s.error ? `${BACKUP_LABEL[s.entity] ?? s.entity}: NOT backed up` : `${(s.items ?? 0).toLocaleString("en")} ${BACKUP_LABEL[s.entity] ?? s.entity}${s.rows && s.rows !== s.items ? ` (${s.rows.toLocaleString("en")} rows)` : ""}`))
      .join(", ");
  } catch {
    return "";
  }
}

/** What a backup holds noticeably less of than the one before it (a sign that something was missed). */
function shrunk(stats: string, before: string | undefined): string[] {
  try {
    const now = JSON.parse(stats) as Array<{ entity: string; items: number; rows?: number }>;
    const was = new Map((JSON.parse(before ?? "[]") as Array<{ entity: string; items: number; rows?: number }>).map((s) => [s.entity, s]));
    const out: string[] = [];
    for (const s of now) {
      const p = was.get(s.entity);
      if (!p) continue;
      const label = BACKUP_LABEL[s.entity] ?? s.entity;
      if ((p.items ?? 0) >= 20 && (s.items ?? 0) < p.items * 0.9) out.push(`${(p.items - s.items).toLocaleString("en")} fewer ${label} than the backup before (${s.items.toLocaleString("en")}, was ${p.items.toLocaleString("en")})`);
      else if ((p.rows ?? 0) >= 50 && (s.rows ?? 0) < (p.rows ?? 0) * 0.8) out.push(`${label}: ${(s.rows ?? 0).toLocaleString("en")} rows, was ${(p.rows ?? 0).toLocaleString("en")} in the backup before (the same items with less detail)`);
    }
    return out;
  } catch {
    return [];
  }
}

const BACKUP_LABEL: Record<string, string> = {};

export default function Backups() {
  const data = useLoaderData<typeof loader>();
  for (const t of data.types) BACKUP_LABEL[t.key] = t.label.toLowerCase();
  const fetcher = useFetcher<{ ok?: string; error?: string }>();
  const [enabled, setEnabled] = useState(data.schedule?.enabled ?? false);
  const [runAt, setRunAt] = useState(data.schedule?.runAt ?? "02:30");
  const [types, setTypes] = useState<string[]>(data.schedule?.types ?? data.types.map((t) => t.key));
  const [keepDays, setKeepDays] = useState(String(data.keepDays));
  const [confirm, setConfirm] = useState<string | null>(null);
  const [only, setOnly] = useState("");
  const [fields, setFields] = useState<string[]>(data.restoreFields.filter((f) => f.byDefault).map((f) => f.key));
  const [destination, setDestination] = useState(data.destination);
  const [destUser, setDestUser] = useState("");
  const [destPassword, setDestPassword] = useState("");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // The restore choices open below a long list: bring them into view, or the button seems to do nothing.
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => document.getElementById("bp-restore")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    return () => clearTimeout(t);
  }, [confirm]);
  const busy = fetcher.state !== "idle";
  const running = data.backups.some((b) => isActive(b.status));
  const total = data.backups.reduce((n, b) => n + b.size, 0);

  usePolling(running, 3000);

  if (!data.allowed) {
    return (
      <s-page heading="Backups" inlineSize="base">
        <s-section>
          <s-stack direction="block" gap="base">
            <s-heading>Daily store backups</s-heading>
            <s-paragraph>
              Keep a copy of your products, collections, customers, orders, discounts, pages, metafields and more on our servers, taken every
              day and kept for up to 90 days. Restore anything with a preview first.
            </s-paragraph>
            <s-paragraph>Backups are part of the Bulkport paid plan, coming soon.</s-paragraph>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Backups" inlineSize="base">
      <s-button slot="primary-action" variant="primary" disabled={busy || running} onClick={() => fetcher.submit({ intent: "now" }, { method: "post" })}>
        Back up now
      </s-button>
      {fetcher.data?.error ? (
        <s-banner tone="critical" heading="That didn't work">
          {fetcher.data.error}
        </s-banner>
      ) : fetcher.data?.ok ? (
        <s-banner tone="success" heading={fetcher.data.ok} />
      ) : null}

      <s-section heading="Daily backup">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            A full copy of the chosen data, kept on Bulkport's server. Each backup is a ZIP of CSV files in the same layout as exports, so
            you can open it in Excel or import it back.
          </s-paragraph>
          <s-text tone="neutral">
            Keeping customer and order data for a long time is a choice to make deliberately (GDPR asks that personal data is kept no longer than needed).
          </s-text>
          <s-switch label="Back up every day" checked={enabled} onChange={(ev: any) => setEnabled(ev.currentTarget.checked)} />
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text-field
              label="Time"
              value={runAt}
              placeholder="02:30"
              details={`24-hour time, ${data.schedule?.timezone || "your time zone"}. A quiet hour is best.`}
              onInput={(ev: any) => setRunAt(ev.currentTarget.value)}
            />
            {/* Re-created once in the browser: the server-rendered select can come up showing its first option. */}
            <s-select key={mounted ? "client" : "server"} label="Keep backups for" value={keepDays} onChange={(ev: any) => setKeepDays(ev.currentTarget.value)}>
              {[7, 14, 30, 90, 180, 365].map((d) => (
                <s-option key={d} value={String(d)}>
                  {d === 180 ? "6 months" : d === 365 ? "1 year" : `${d} days`}
                </s-option>
              ))}
            </s-select>
          </s-grid>
          <s-stack direction="block" gap="small">
            <s-text type="strong">What to back up</s-text>
            <s-grid gridTemplateColumns="repeat(auto-fill, minmax(190px, 1fr))" gap="small base">
              {data.types.map((t) => (
                <s-checkbox
                  key={t.key}
                  label={t.label}
                  details={t.restorable ? undefined : "Kept for reference; can't be imported back"}
                  checked={types.includes(t.key)}
                  onChange={(ev: any) => setTypes(ev.currentTarget.checked ? [...types, t.key] : types.filter((x) => x !== t.key))}
                />
              ))}
            </s-grid>
            <s-text tone="neutral">Discount codes of code-pool discounts are left out (they can run into millions); the discounts themselves are kept.</s-text>
          </s-stack>
          <s-stack direction="block" gap="small">
            <s-text type="strong">Also copy each backup to your own storage (optional)</s-text>
            <s-url-field
              label="Cloud storage, or a folder on an SFTP, FTP or WebDAV server"
              labelAccessibilityVisibility="exclusive"
              placeholder="s3://s3.eu-west-2.amazonaws.com/my-bucket/backups/"
              details="A second copy that you hold. Amazon S3: s3://s3.REGION.amazonaws.com/BUCKET/folder/ with an access key and secret below. Google Cloud Storage: s3://storage.googleapis.com/BUCKET/folder/ with an HMAC key. Azure: paste the container's Blob SAS URL (https://ACCOUNT.blob.core.windows.net/CONTAINER?sv=…), made for that one container with Write and Create only, never the account key. Also Cloudflare R2, Backblaze, SFTP, FTP, or WebDAV drives (Nextcloud, Box, pCloud…). Leave empty to keep backups on Bulkport's server only."
              value={destination}
              onInput={(ev: any) => setDestination(ev.currentTarget.value)}
            />
            {data.destinationExpiresIn !== null ? (
              <s-text tone={data.destinationExpiresIn <= 7 ? "critical" : "caution"}>
                {data.destinationExpiresIn < 0 ? "The Azure SAS token has expired: backup copies are failing. Paste a new address." : `The Azure SAS token expires in ${data.destinationExpiresIn} day${data.destinationExpiresIn === 1 ? "" : "s"}. Paste a new address before then.`}
              </s-text>
            ) : null}
            {data.destination && destination === data.destination ? (
              <s-stack direction="inline">
                <s-button loading={busy && fetcher.formData?.get("intent") === "test-destination"} disabled={busy} onClick={() => fetcher.submit({ intent: "test-destination" }, { method: "post" })}>
                  Test connection
                </s-button>
              </s-stack>
            ) : null}
            {destination.trim() && !/blob\.core\.windows\.net/i.test(destination) ? (
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-text-field label="User name or access key" autocomplete="off" details={data.destination ? "Leave empty to keep the saved sign-in." : undefined} value={destUser} onInput={(ev: any) => setDestUser(ev.currentTarget.value)} />
                <s-password-field label="Password or secret" autocomplete="new-password" details="Stored encrypted and never shown again." value={destPassword} onInput={(ev: any) => setDestPassword(ev.currentTarget.value)} />
              </s-grid>
            ) : null}
          </s-stack>
          <s-stack direction="block" gap="small">
            <s-text type="strong">Google Drive</s-text>
            {data.drive.connected ? (
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone="success">Connected</s-badge>
                <s-text tone="neutral">Each backup is also saved to the "Bulkport backups" folder in your Drive.</s-text>
                <s-button variant="tertiary" tone="critical" onClick={() => fetcher.submit({ intent: "drive-off" }, { method: "post" })}>
                  Disconnect
                </s-button>
              </s-stack>
            ) : data.drive.available ? (
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-button href={data.drive.connectUrl} target="_blank">
                  Connect Google Drive
                </s-button>
                <s-text tone="neutral">Opens Google in a new tab. Bulkport can only see the files it saves there. Reload this page afterwards.</s-text>
              </s-stack>
            ) : (
              <s-text tone="neutral">Coming soon. Until then, use cloud storage above for a copy you hold.</s-text>
            )}
          </s-stack>
          {data.schedule?.enabled ? <s-text tone="neutral">Next backup: {formatDate(data.schedule.nextRunAt)}</s-text> : null}
          <s-stack direction="inline" justifyContent="end">
            <s-button
              variant="primary"
              disabled={busy || !types.length}
              onClick={() =>
                fetcher.submit(
                  { intent: "save", enabled: String(enabled), runAt, timezone: data.schedule?.timezone || browserTimeZone(), types: types.join(","), keepDays, uploadUrl: destination, uploadUser: destUser, uploadPassword: destPassword },
                  { method: "post" },
                )
              }
            >
              Save
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading={`Backups${data.backups.length ? ` (${data.backups.length}, ${size(total)})` : ""}`} padding="none">
        <s-box padding="base">
          <s-text color="subdued">Size is no guide to what a backup holds: backups are compressed (older single-type ones were not, and are about ten times larger for the same data). The Contents column counts what is inside, and says so when a backup holds noticeably less than the one before.</s-text>
        </s-box>
        {data.backups.length === 0 ? (
          <s-box padding="base">
            <s-text tone="neutral">No backups yet. Press "Back up now" for the first one.</s-text>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Taken</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Contents</s-table-header>
              <s-table-header format="numeric">Size</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.backups.map((b, at) => {
                // Checked against the finished backup taken before this one.
                const previous = data.backups.slice(at + 1).find((x) => x.status === "finished" && !x.error);
                const less = b.status === "finished" ? shrunk(b.stats, previous?.stats) : [];
                return (
                <s-table-row key={b.id}>
                  <s-table-cell>
                    <s-link href={`/app/jobs/${b.id}`}>{formatDate(b.createdAt)}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <HealthBadge job={{ type: "export", status: b.status, error: b.error, stats: b.stats, config: b.config }} />
                  </s-table-cell>
                  <s-table-cell>
                    {b.error ? <s-text tone="critical">{b.error}</s-text> : contents(b.stats) || (isActive(b.status) ? "Working…" : "—")}
                    {less.map((l) => (
                      <div key={l}>
                        <s-text tone="caution">! {l}</s-text>
                      </div>
                    ))}
                  </s-table-cell>
                  <s-table-cell>
                    {size(b.size)}
                    {b.size && !b.zipped ? <s-text color="subdued"> (not compressed)</s-text> : null}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {b.link ? (
                        <s-button variant="secondary" icon="download" href={b.link} target="_blank">
                          Download
                        </s-button>
                      ) : null}
                      {b.status === "finished" && b.link ? (
                        <s-button variant={confirm === b.id ? "primary" : "tertiary"} onClick={() => setConfirm(confirm === b.id ? null : b.id)}>
                          {confirm === b.id ? "Choosing what to restore ↓" : "Restore…"}
                        </s-button>
                      ) : null}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>
      <div id="bp-restore" style={{ scrollMarginTop: "16px" }} />
      {confirm && data.backups.some((b) => b.id === confirm) ? (
        <s-section heading={`Restore from the backup of ${formatDate(data.backups.find((b) => b.id === confirm)!.createdAt)}`}>
          <s-stack direction="block" gap="base">
            <s-text-area
              label="Restore only these items (optional)"
              details="One per line: a product or collection handle, an ID, an order name (#1234), a customer email or a redirect path, as in the backup. Leave empty to compare the whole backup with the store."
              rows={4}
              value={only}
              onInput={(ev: any) => setOnly(ev.currentTarget.value)}
            />
            <s-stack direction="block" gap="small">
              <s-text type="strong">What to bring back</s-text>
              <s-grid gridTemplateColumns="repeat(auto-fill, minmax(240px, 1fr))" gap="small base">
                {data.restoreFields.map((f) => (
                  <s-checkbox key={f.key} label={f.label} details={f.note} checked={fields.includes(f.key)} onChange={(ev: any) => setFields(ev.currentTarget.checked ? [...fields, f.key] : fields.filter((x) => x !== f.key))} />
                ))}
              </s-grid>
            </s-stack>
            <s-text tone="neutral">
              Either way this starts a preview: it lists only what differs from the backup, field by field, and changes nothing until you confirm there.
            </s-text>
            <s-stack direction="inline" gap="small">
              <s-button variant="primary" loading={busy} disabled={busy || !fields.length} onClick={() => fetcher.submit({ intent: "restore", id: confirm, only, fields: fields.join(",") }, { method: "post" })}>
                {only.trim() ? "Preview restoring these items" : "Preview restoring everything"}
              </s-button>
              <s-button variant="tertiary" onClick={() => setConfirm(null)}>
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ) : null}
      <s-section heading="What a backup covers">
        <s-unordered-list>
          <s-list-item>Kept and restorable: products with variants, prices, images (as links), stock per location and metafields; collections; customers; companies; discounts; draft orders; pages and blog posts; redirects; menus; metaobjects; shop metafields.</s-list-item>
          <s-list-item>Kept for reference only: orders, payouts and files. Shopify doesn't let past orders be written back, so they can be read in the backup but not restored.</s-list-item>
          <s-list-item>Not in a backup: the theme and its settings, other apps' data, gift card codes, customer passwords and payment details, and the codes of code-pool discounts.</s-list-item>
          <s-list-item>Images are kept as links to Shopify's copies: an image deleted from Shopify's Files can't be restored from a backup.</s-list-item>
        </s-unordered-list>
      </s-section>
      <s-section>
        <s-paragraph>
          Restoring starts with a preview: you see what would be created or updated, and nothing changes until you press "Import for real".
          Items are merged back (updated or re-created); nothing that was added since the backup is deleted. Only what differs from the
          backup is written; items that still match it are left alone.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
