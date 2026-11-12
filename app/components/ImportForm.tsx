import { useState } from "react";
import { useFetcher } from "react-router";
import { ScheduleTimeFields, browserTimeZone } from "./ScheduleTime";

/**
 * Import form: upload or URL source, default command and dry run. Used on the
 * home page and on /app/import; posts to the /app/import action.
 */
export function ImportForm({ maxUploadMb }: { maxUploadMb: number }) {
  const fetcher = useFetcher<{ error?: string }>();
  const [source, setSource] = useState<"file" | "url">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [defaultCommand, setDefaultCommand] = useState("MERGE");
  const [dryRun, setDryRun] = useState(false);
  const [runAt, setRunAt] = useState("");
  const [weekday, setWeekday] = useState(1);
  const [interval, setIntervalMinutes] = useState(0);
  const busy = fetcher.state !== "idle";

  const submit = () => {
    const form = new FormData();
    form.set("source", source);
    form.set("options", JSON.stringify({ defaultCommand, dryRun }));
    if (source === "file" && file) form.set("file", file);
    if (source === "url") {
      form.set("url", url);
      form.set("intervalMinutes", String(interval));
      if (runAt.trim() && interval >= 1440) {
        form.set("runAt", runAt.trim());
        form.set("timezone", browserTimeZone());
        if (interval >= 10080) form.set("weekday", String(weekday));
      }
    }
    fetcher.submit(form, { method: "post", encType: "multipart/form-data", action: "/app/import" });
  };

  const ready = source === "file" ? !!file : !!url.trim();

  return (
    <>
      {fetcher.data?.error ? (
        <s-banner tone="critical" heading="Could not start import">
          {fetcher.data.error}
        </s-banner>
      ) : null}

      <s-section heading="File">
        <s-stack direction="block" gap="base">
          <s-choice-list
            label="Source"
            values={[source]}
            onChange={(ev: any) => setSource(ev.currentTarget.values[0])}
          >
            <s-choice value="file">Upload a file</s-choice>
            <s-choice value="url">Download from a URL (Google Sheets, Dropbox, FTP…)</s-choice>
          </s-choice-list>
          {source === "file" ? (
            <s-drop-zone
              label={`Excel, CSV or ZIP file, up to ${maxUploadMb} MB`}
              accept=".xlsx,.csv,.zip"
              onInput={(ev: any) => setFile(ev.currentTarget.files?.[0] ?? null)}
              onChange={(ev: any) => setFile(ev.currentTarget.files?.[0] ?? null)}
            />
          ) : (
            <>
              <s-url-field
                label="File URL"
                details="Google Sheets links are exported as Excel automatically. FTP: ftp://user:password@host/path/file.xlsx"
                value={url}
                onInput={(ev: any) => setUrl(ev.currentTarget.value)}
              />
              <s-select
                label="Repeat"
                value={String(interval)}
                onChange={(ev: any) => setIntervalMinutes(Number(ev.currentTarget.value))}
              >
                <s-option value="0">Import once now</s-option>
                <s-option value="60">Every hour</s-option>
                <s-option value="360">Every 6 hours</s-option>
                <s-option value="1440">Every day</s-option>
                <s-option value="10080">Every week</s-option>
              </s-select>
              <ScheduleTimeFields
                intervalMinutes={interval}
                runAt={runAt}
                weekday={weekday}
                onChange={(p) => {
                  if (p.runAt !== undefined) setRunAt(p.runAt);
                  if (p.weekday !== undefined) setWeekday(p.weekday);
                }}
              />
            </>
          )}
          {file && source === "file" ? <s-text>Selected: {file.name}</s-text> : null}
        </s-stack>
      </s-section>

      <s-section heading="Options">
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
          <s-stack direction="inline" justifyContent="end">
            <s-button variant="primary" onClick={submit} disabled={!ready || busy} loading={busy}>
              {source === "url" && interval > 0 ? "Save schedule" : dryRun ? "Check file" : "Import"}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

    </>
  );
}
