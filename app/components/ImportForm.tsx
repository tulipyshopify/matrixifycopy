import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { ScheduleTimeFields, browserTimeZone } from "./ScheduleTime";

/**
 * Import form: a drop zone or a link, then (once one is chosen) the default
 * command, dry run and schedule. Used on the
 * home page and on /app/import; posts to the /app/import action.
 */
export interface ImportScheduleBeingEdited {
  id: string;
  name: string;
  intervalMinutes: number;
  runAt: string;
  timezone: string;
  weekday: number;
  /** Shown with any password hidden; sent back unchanged it keeps the saved link. */
  sourceUrl: string;
  defaultCommand: string;
  dryRun: boolean;
  concurrency?: number;
  batch?: boolean;
  hold?: boolean;
}

/** Links that sign in with a user name and password. */
const NEEDS_SIGN_IN = /^(s?ftps?|webdavs?|davs?):\/\//i;
const LINK = /^(https?|ftps?|sftp|webdavs?|davs?):\/\/[^\s/]+\.[^\s]+|^(https?|ftps?|sftp|webdavs?|davs?):\/\/localhost/i;

/** What is wrong with a link as typed, or "" when it can be used. */
export function linkProblem(url: string): string {
  const u = url.trim();
  if (!u) return "Enter a link";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return "A link starts with https://, ftp://, sftp:// or webdavs://";
  if (!LINK.test(u)) return "This doesn't look like a complete link. It starts with https://, ftp://, sftp:// or webdavs:// and names a file";
  return "";
}

export function ImportForm({
  maxUploadMb,
  editing = null,
  scheduleFirst = false,
}: {
  maxUploadMb: number;
  editing?: ImportScheduleBeingEdited | null;
  /** Opened from "New scheduled import": start with the schedule switched on. */
  scheduleFirst?: boolean;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const [source, setSource] = useState<"file" | "url" | null>(editing ? "url" : null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState(editing?.sourceUrl ?? "");
  const pickFile = (f: File | null) => {
    setFile(f);
    setSource(f ? "file" : url.trim() ? "url" : null);
  };
  const [defaultCommand, setDefaultCommand] = useState(editing?.defaultCommand ?? "UPDATE");
  const [linkError, setLinkError] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const signIn = NEEDS_SIGN_IN.test(url.trim());
  // A sign-in typed into the link is moved to its own fields, so it is never left on show.
  const tidyLink = (value: string): string => {
    try {
      const u = new URL(value.trim());
      if (!NEEDS_SIGN_IN.test(value.trim()) || (!u.username && !u.password) || u.password === "****") return value;
      if (u.username) setUsername(decodeURIComponent(u.username));
      if (u.password) setPassword(decodeURIComponent(u.password));
      u.username = "";
      u.password = "";
      const clean = u.toString();
      setUrl(clean);
      return clean;
    } catch {
      return value;
    }
  };
  const useLink = () => {
    const problem = linkProblem(tidyLink(url));
    setLinkError(problem);
    if (!problem) setSource("url");
  };
  const [dryRun, setDryRun] = useState(editing?.dryRun ?? false);
  // Server-rendered selects show their first option until remounted in the browser.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const selectKey = mounted ? "client" : "server";
  const [concurrency, setConcurrency] = useState(String(editing?.concurrency ?? 4));
  const [batch, setBatch] = useState(editing?.batch ?? false);
  // New schedules hold unusual results for approval; existing ones keep how they were set.
  const [hold, setHold] = useState(editing ? !!editing.hold : true);
  const [runAt, setRunAt] = useState(editing?.runAt ?? "");
  const [weekday, setWeekday] = useState(editing?.weekday ?? 1);
  const [scheduled, setScheduled] = useState(!!editing || scheduleFirst);
  const [interval, setIntervalMinutes] = useState(editing?.intervalMinutes ?? 1440);
  const [name, setName] = useState(editing?.name ?? "");
  // Only a URL can be fetched again later; an uploaded file is imported once.
  const repeating = scheduled && source === "url";
  const busy = fetcher.state !== "idle";

  // `preview`: a one-off dry run, whatever the tick-box says.
  const [previewing, setPreviewing] = useState(false);
  const submit = (preview = false) => {
    const form = new FormData();
    if (!source) return;
    let link = url;
    if (source === "url") {
      link = tidyLink(url);
      const problem = linkProblem(link);
      setLinkError(problem);
      if (problem) return;
    }
    setPreviewing(preview);
    form.set("source", source);
    form.set("options", JSON.stringify({ defaultCommand, dryRun: preview || (repeating && dryRun), concurrency: Number(concurrency), batch, hold: repeating && hold && !dryRun }));
    if (source === "file" && file) form.set("file", file);
    if (source === "url") {
      form.set("url", link);
      // Read from the link itself when it was only just tidied (state updates land after this call).
      let typed: URL | null = null;
      try {
        typed = new URL(url.trim());
      } catch {
        typed = null;
      }
      const user = username || (typed && typed.password !== "****" ? decodeURIComponent(typed.username) : "");
      const pass = password || (typed && typed.password !== "****" ? decodeURIComponent(typed.password) : "");
      if (NEEDS_SIGN_IN.test(link) && user) form.set("username", user);
      if (NEEDS_SIGN_IN.test(link) && pass) form.set("password", pass);
      if (editing) form.set("scheduleId", editing.id);
      form.set("intervalMinutes", String(repeating ? interval : 0));
      if (repeating && name.trim()) form.set("name", name.trim());
      if (repeating && runAt.trim() && interval >= 1440) {
        form.set("runAt", runAt.trim());
        // An unchanged time keeps the zone it was set in.
        form.set("timezone", editing?.timezone && runAt.trim() === editing.runAt ? editing.timezone : browserTimeZone());
        if (interval >= 10080) form.set("weekday", String(weekday));
      }
    }
    fetcher.submit(form, { method: "post", encType: "multipart/form-data", action: "/app/import" });
  };

  const ready = source === "file" ? !!file : !!url.trim();

  return (
    <>
      {fetcher.data?.error ? (
        <s-banner tone="critical" heading={editing ? "Could not save the schedule" : "Could not start import"}>
          {fetcher.data.error}
        </s-banner>
      ) : null}

      <s-section heading={editing ? "File" : "Import"}>
        <s-stack direction="block" gap="base">
          {editing ? (
            <s-url-field
              label="Link to the file"
              details="Downloaded again at every run. A saved password is shown as ****; leave it like that to keep it."
              value={url}
              error={linkError || undefined}
              onInput={(ev: any) => {
                setUrl(ev.currentTarget.value);
                setLinkError("");
              }}
            />
          ) : (
            <>
          <s-drop-zone
            label={`Add an Excel, CSV or ZIP file, up to ${maxUploadMb} MB`}
            accept=".xlsx,.xlsm,.csv,.tsv,.txt,.zip"
            onInput={(ev: any) => pickFile(ev.currentTarget.files?.[0] ?? null)}
            onChange={(ev: any) => pickFile(ev.currentTarget.files?.[0] ?? null)}
          />
          <div className="bp-url-row">
            <s-url-field
              label="Or import from a link"
              details="Web link, Google Sheets, Google Drive or Dropbox share link, ftp://, sftp:// or webdavs://"
              placeholder="https://… or sftp://files.example.com/folder/file.xlsx"
              value={url}
              error={linkError || undefined}
              onInput={(ev: any) => {
                setUrl(ev.currentTarget.value);
                setLinkError("");
                if (source === "url") setSource(file ? "file" : null);
              }}
            />
            <s-button disabled={!url.trim()} onClick={useLink}>
              Use this link
            </s-button>
          </div>
          <s-text tone="neutral">
            The file can have any name: what it holds (products, orders, customers…) is recognised from its columns.
            Google Sheets, Dropbox and other direct links work. Only a link can be repeated on a schedule.
          </s-text>
          {source === "file" && file ? <s-text>Selected file: {file.name}</s-text> : null}
          {source === "url" ? <s-text>Selected link: {url.trim() || "enter a link above"}{username ? ` (signing in as ${username})` : ""}</s-text> : null}
            </>
          )}
          {signIn && (source === "url" || editing) ? (
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field
                label="User name"
                details={editing ? "Leave empty to keep the saved sign-in." : "For the FTP, SFTP or WebDAV server."}
                autocomplete="off"
                value={username}
                onInput={(ev: any) => setUsername(ev.currentTarget.value)}
              />
              <s-password-field
                label="Password"
                details="Stored encrypted and never shown again. Keep it out of the link itself."
                autocomplete="new-password"
                value={password}
                onInput={(ev: any) => setPassword(ev.currentTarget.value)}
              />
            </s-grid>
          ) : null}
        </s-stack>
      </s-section>

      {source ? (
      <s-section heading="Import options">
        <s-stack direction="block" gap="base">
          <s-select
            key={`command-${selectKey}`}
            label="Command for rows with an empty Command column"
            value={defaultCommand}
            onChange={(ev: any) => setDefaultCommand(ev.currentTarget.value)}
          >
            <s-option value="UPDATE">UPDATE: only change items that already exist (safest)</s-option>
            <s-option value="MERGE">MERGE: update if found, create if not</s-option>
            <s-option value="NEW">NEW: only create new items</s-option>
            <s-option value="REPLACE">REPLACE: delete and re-create</s-option>
            <s-option value="DELETE">DELETE: delete the items</s-option>
          </s-select>
          {defaultCommand === "MERGE" ? <s-text tone="caution">With MERGE, a row whose handle or ID isn't found creates a new item, so a typo makes a new product. New products start as drafts.</s-text> : null}
          {defaultCommand === "DELETE" || defaultCommand === "REPLACE" ? (
            <s-text tone="critical">
              {defaultCommand === "DELETE" ? "Every row without its own Command deletes its item." : "Every row without its own Command deletes its item and creates it again from the file: anything not in the file is lost."} The preview lists them and asks you to confirm.
            </s-text>
          ) : null}
          <s-select
            key={`speed-${selectKey}`}
            label="Speed"
            details="How many items are sent to Shopify at once. Lower it if other apps on the store are being slowed down."
            value={concurrency}
            onChange={(ev: any) => setConcurrency(ev.currentTarget.value)}
          >
            <s-option value="1">1 at a time (gentlest)</s-option>
            <s-option value="2">2 at a time</s-option>
            <s-option value="4">4 at a time (standard)</s-option>
            <s-option value="8">8 at a time (fastest)</s-option>
          </s-select>
          <s-checkbox
            label="Batch mode for large metafield updates"
            details="A sheet with only ID and Metafield columns, 50 rows or more, is handed to Shopify as one bulk job instead of row by row: much faster for thousands of rows. Other sheets import the normal way, and the log says why."
            checked={batch}
            onChange={(ev: any) => setBatch(ev.currentTarget.checked)}
          />
          {repeating ? (
            <s-checkbox
              label="Hold unusual results for approval"
              details="Each run is previewed first. A clean result is applied straight away; one that would create or delete items, empty fields, or has warnings or failing rows waits for you, and you are alerted."
              checked={hold && !dryRun}
              disabled={dryRun}
              onChange={(ev: any) => setHold(ev.currentTarget.checked)}
            />
          ) : null}
          {repeating ? (
            <s-checkbox
              label="Dry run every time"
              details="Each scheduled run only checks the file and shows a preview, without changing the store"
              checked={dryRun}
              onChange={(ev: any) => setDryRun(ev.currentTarget.checked)}
            />
          ) : null}
          {editing ? null : (
          <s-switch
            label="Repeat this import on a schedule"
            details={
              source === "url"
                ? "The file is downloaded from the link again at every run."
                : "Import from a link to repeat an import: an uploaded file can only be imported once."
            }
            checked={repeating}
            disabled={source !== "url"}
            onChange={(ev: any) => setScheduled(ev.currentTarget.checked)}
          />
          )}
          {repeating ? (
            <>
              <s-select key={`often-${selectKey}`} label="How often" value={String(interval)} onChange={(ev: any) => setIntervalMinutes(Number(ev.currentTarget.value))}>
                <s-option value="60">Every hour</s-option>
                <s-option value="360">Every 6 hours</s-option>
                <s-option value="1440">Every day</s-option>
                <s-option value="10080">Every week</s-option>
              </s-select>
              <ScheduleTimeFields
                intervalMinutes={interval}
                runAt={runAt}
                weekday={weekday}
                keepZone={editing?.timezone && runAt.trim() === editing.runAt ? editing.timezone : undefined}
                onChange={(p) => {
                  if (p.runAt !== undefined) setRunAt(p.runAt);
                  if (p.weekday !== undefined) setWeekday(p.weekday);
                }}
              />
              <s-text-field
                label={editing ? "Schedule name" : "Schedule name (optional)"}
                placeholder="Scheduled import"
                value={name}
                onInput={(ev: any) => setName(ev.currentTarget.value)}
              />
              {dryRun ? (
                <s-text tone="caution">Dry run is on: every scheduled run will only check the file and change nothing.</s-text>
              ) : (
                <s-text tone="neutral">{hold ? "Clean runs are applied automatically; unusual ones wait for your approval." : "Every run applies the file to the store without a look."} Rows that add to stock are applied again each time.</s-text>
              )}
            </>
          ) : null}
          <s-stack direction="inline" gap="small" justifyContent="end" alignItems="center">
            {repeating ? (
              <s-button variant="primary" onClick={() => submit()} disabled={!ready || busy} loading={busy}>
                {editing ? "Save changes" : "Save schedule"}
              </s-button>
            ) : (
              <>
                <s-text tone="neutral">Nothing is changed yet: you see what the file would do, then confirm.</s-text>
                <s-button variant="primary" icon="view" onClick={() => submit(true)} disabled={!ready || busy} loading={busy}>
                  Preview
                </s-button>
              </>
            )}
          </s-stack>
        </s-stack>
      </s-section>
      ) : null}
    </>
  );
}
