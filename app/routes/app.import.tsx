import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  createImportJob,
  createSchedule,
  createUrlImportJob,
  entityCatalog,
  parseImportOptions,
} from "../lib/jobs/jobs.server";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 200);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { entities: entityCatalog().filter((e) => e.canImport), maxUploadMb: MAX_UPLOAD_MB };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_UPLOAD_MB * 1024 * 1024) return { error: `File is larger than ${MAX_UPLOAD_MB} MB` };
  const form = await request.formData();
  try {
    const options = parseImportOptions(JSON.parse(String(form.get("options") ?? "{}")));
    const source = String(form.get("source"));
    if (source === "url") {
      const url = String(form.get("url") ?? "").trim();
      const interval = Number(form.get("intervalMinutes") ?? 0);
      if (interval > 0) {
        await createSchedule(session.shop, {
          name: String(form.get("name") ?? ""),
          type: "import",
          config: { options },
          sourceUrl: url,
          intervalMinutes: interval,
        });
        return redirect("/app/schedules");
      }
      if (!/^(https?|ftps?):\/\//i.test(url)) throw new Error("Enter an http(s):// or ftp:// URL");
      const job = await createUrlImportJob(session.shop, url, options);
      return redirect(`/app/jobs/${job.id}`);
    }
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Choose a file to import");
    if (!/\.(xlsx|csv|zip)$/i.test(file.name)) throw new Error("Upload an .xlsx, .csv or .zip file");
    const job = await createImportJob(session.shop, file, options);
    return redirect(`/app/jobs/${job.id}`);
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};

export default function NewImport() {
  const { entities, maxUploadMb } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [source, setSource] = useState<"file" | "url">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [defaultCommand, setDefaultCommand] = useState("MERGE");
  const [dryRun, setDryRun] = useState(false);
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
    }
    fetcher.submit(form, { method: "post", encType: "multipart/form-data" });
  };

  const ready = source === "file" ? !!file : !!url.trim();

  return (
    <s-page heading="New import" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Jobs
      </s-link>
      <s-button slot="primary-action" variant="primary" onClick={submit} disabled={!ready || busy} loading={busy}>
        {source === "url" && interval > 0 ? "Save schedule" : dryRun ? "Check file" : "Import"}
      </s-button>

      {fetcher.data && "error" in fetcher.data ? (
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
        </s-stack>
      </s-section>

      <s-section heading="Recognised sheets" slot="aside">
        <s-paragraph>
          Sheet (or CSV file) names decide what is imported. Export first to get a file in the right layout.
        </s-paragraph>
        <s-unordered-list>
          {entities.map((e) => (
            <s-list-item key={e.key}>{e.sheet}</s-list-item>
          ))}
        </s-unordered-list>
        <s-link href="/app/help">Column reference</s-link>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
