import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { cancelJob, downloadLinks, listJobs, rerunJob } from "../lib/jobs/jobs.server";
import { StatusBadge, formatDate, isActive, jobSummary, progressText } from "../components/jobs";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const jobs = await listJobs(session.shop);
  return {
    jobs: jobs.map((j) => ({ ...j, links: downloadLinks({ ...j, inputFile: null }) })),
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

export default function Jobs() {
  const { jobs } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
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
    <s-page heading="Jobs">
      <s-button slot="primary-action" variant="primary" onClick={() => navigate("/app/export")}>
        New export
      </s-button>
      <s-button slot="secondary-actions" onClick={() => navigate("/app/import")}>
        New import
      </s-button>

      {jobs.length === 0 ? (
        <s-section>
          <s-stack direction="block" gap="base" alignItems="center" padding="large">
            <s-heading>Move your store data in bulk</s-heading>
            <s-paragraph>
              Export products, collections, customers, orders and more to Excel or CSV. Edit the file, then import it
              back to create, update or delete items in bulk.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" onClick={() => navigate("/app/export")}>
                Start an export
              </s-button>
              <s-button onClick={() => navigate("/app/import")}>Import a file</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ) : (
        <s-section padding="none">
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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
