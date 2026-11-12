import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { cancelJob, downloadLinks, entityCatalog, latestExportPreset, listPresets, listJobs, rerunJob } from "../lib/jobs/jobs.server";
import { StatusBadge, formatDate, isActive, jobSummary, progressText } from "../components/jobs";
import { ExportForm } from "../components/ExportForm";
import { ImportForm } from "../components/ImportForm";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 200);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const jobs = await listJobs(session.shop);
  return {
    jobs: jobs.map((j) => ({ ...j, links: downloadLinks({ ...j, inputFile: null }) })),
    entities: entityCatalog().filter((e) => e.canExport),
    presets: await listPresets(session.shop),
    // "Edit and export again" on a job page opens the form with that job's set-up.
    latest: await latestExportPreset(session.shop, new URL(request.url).searchParams.get("from") ?? undefined),
    maxUploadMb: MAX_UPLOAD_MB,
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
  const { jobs, entities, maxUploadMb, presets, latest } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "import" ? "import" : "export";
  const setTab = (t: string) => setParams(t === "export" ? {} : { tab: t }, { replace: true });
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
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
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button variant={tab === "export" ? "primary" : "secondary"} onClick={() => setTab("export")}>
            Export
          </s-button>
          <s-button variant={tab === "import" ? "primary" : "secondary"} onClick={() => setTab("import")}>
            Import
          </s-button>
          <s-text tone="neutral">
            {tab === "export"
              ? "Choose data, filters and columns, then download an Excel or CSV file."
              : "Upload an edited file to create, update or delete items in bulk."}
          </s-text>
        </s-stack>
      </s-section>

      {tab === "export" ? <ExportForm entities={entities} presets={presets} latest={latest} /> : <ImportForm maxUploadMb={maxUploadMb} />}

      {jobs.length === 0 ? null : (
        <s-section heading="Recent jobs">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Job</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Progress</s-table-header>
              <s-table-header>Created</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {jobs.map((job) => (
                <s-table-row key={job.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-500">
                      <s-link href={`/app/jobs/${job.id}`}>
                        {job.type === "export" ? "Export" : "Import"}: {jobSummary(job)}
                      </s-link>
                      {job.error ? <s-text tone="critical">{job.error}</s-text> : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <StatusBadge status={job.status} />
                  </s-table-cell>
                  <s-table-cell>{progressText(job)}</s-table-cell>
                  <s-table-cell>{formatDate(job.createdAt)}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {job.links.result ? (
                        <s-button variant="secondary" href={job.links.result} target="_blank">
                          Download
                        </s-button>
                      ) : null}
                      {isActive(job.status) ? (
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          onClick={() => fetcher.submit({ intent: "cancel", id: job.id }, { method: "post" })}
                        >
                          Cancel
                        </s-button>
                      ) : (
                        <s-button
                          variant="tertiary"
                          onClick={() => fetcher.submit({ intent: "rerun", id: job.id }, { method: "post" })}
                        >
                          Run again
                        </s-button>
                      )}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
