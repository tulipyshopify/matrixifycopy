import { useState } from "react";
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
}

export function ImportForm({ maxUploadMb, editing = null }: { maxUploadMb: number; editing?: ImportScheduleBeingEdited | null }) {
  const fetcher = useFetcher<{ error?: string }>();
  const [source, setSource] = useState<"file" | "url" | null>(editing ? "url" : null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState(editing?.sourceUrl ?? "");
  const pickFile = (f: File | null) => {
    setFile(f);
    setSource(f ? "file" : url.trim() ? "url" : null);
  };
  const [defaultCommand, setDefaultCommand] = useState(editing?.defaultCommand ?? "MERGE");
  const [dryRun, setDryRun] = useState(editing?.dryRun ?? false);
  const [runAt, setRunAt] = useState(editing?.runAt ?? "");
  const [weekday, setWeekday] = useState(editing?.weekday ?? 1);
  const [scheduled, setScheduled] = useState(!!editing);
  const [interval, setIntervalMinutes] = useState(editing?.intervalMinutes ?? 1440);
  const [name, setName] = useState(editing?.name ?? "");
  // Only a URL can be fetched again later; an uploaded file is imported once.
  const repeating = scheduled && source === "url";
  const busy = fetcher.state !== "idle";

  const submit = () => {
    const form = new FormData();
    if (!source) return;
    form.set("source", source);
    form.set("options", JSON.stringify({ defaultCommand, dryRun }));
    if (source === "file" && file) form.set("file", file);
    if (source === "url") {
      form.set("url", url);
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
              onInput={(ev: any) => setUrl(ev.currentTarget.value)}
            />
          ) : (
            <>
          <s-drop-zone
            label={`Add an Excel, CSV or ZIP file, up to ${maxUploadMb} MB`}
            accept=".xlsx,.csv,.zip"
            onInput={(ev: any) => pickFile(ev.currentTarget.files?.[0] ?? null)}
            onChange={(ev: any) => pickFile(ev.currentTarget.files?.[0] ?? null)}
          />
          <div className="bp-url-row">
            <s-url-field
              label="Or import from a link"
              placeholder="https://… or ftp://user:password@host/file.xlsx"
              value={url}
              onInput={(ev: any) => setUrl(ev.currentTarget.value)}
            />
            <s-button disabled={!url.trim()} onClick={() => setSource("url")}>
              Import from link
            </s-button>
          </div>
          <s-text tone="neutral">Google Sheets, Dropbox and other direct links work. Only a link can be repeated on a schedule.</s-text>
          {source === "file" && file ? <s-text>Selected file: {file.name}</s-text> : null}
          {source === "url" ? <s-text>Selected link: {url.trim() || "enter a link above"}</s-text> : null}
            </>
          )}
        </s-stack>
      </s-section>

      {source ? (
      <s-section heading="Import options">
        <s-stack direction="block" gap="base">
          <s-select
            label="Command for rows with an empty Command column"
            value={defaultCommand}
            onChange={(ev: any) => setDefaultCommand(ev.currentTarget.value)}
          >
            <s-option value="MERGE">MERGE: update if found, create if not</s-option>
            <s-option value="UPDATE">UPDATE: only update existing items</s-option>
            <s-option value="NEW">NEW: only create new items</s-option>
            <s-option value="REPLACE">REPLACE: delete and re-create</s-option>
            <s-option value="DELETE">DELETE: delete the items</s-option>
          </s-select>
          <s-checkbox
            label="Dry run"
            details="Read and check the file without changing anything in the store"
            checked={dryRun}
            onChange={(ev: any) => setDryRun(ev.currentTarget.checked)}
          />
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
              <s-select label="How often" value={String(interval)} onChange={(ev: any) => setIntervalMinutes(Number(ev.currentTarget.value))}>
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
                <s-text tone="neutral">Every run applies the file to the store. Rows that add to stock are applied again each time.</s-text>
              )}
            </>
          ) : null}
          <s-stack direction="inline" justifyContent="end">
            <s-button variant="primary" onClick={submit} disabled={!ready || busy} loading={busy}>
              {editing ? "Save changes" : repeating ? "Save schedule" : dryRun ? "Check file" : "Import"}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
      ) : null}
    </>
  );
}
