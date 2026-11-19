import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { EXPORT_HISTORY_DAYS, type JobFilter, cancelJob, rerunJob } from "../lib/jobs/jobs.server";
import { jobListData } from "../lib/jobs/joblist.server";
import { JobList } from "../components/JobList";
import { isActive } from "../components/jobs";
import { usePolling } from "../components/usePolling";

/** Jobs shown per page. */
const PAGE = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = (["export", "import", "problems", "scheduled"].includes(url.searchParams.get("show") ?? "") ? url.searchParams.get("show") : "all") as JobFilter;
  const take = Math.min(500, Math.max(PAGE, Number(url.searchParams.get("n")) || PAGE));
  const { jobs, total } = await jobListData(session.shop, take, filter);
  return { jobs, total, filter, historyDays: EXPORT_HISTORY_DAYS };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id"));
  if (form.get("intent") === "cancel") await cancelJob(session.shop, id);
  if (form.get("intent") === "rerun") return redirect(`/app/jobs/${(await rerunJob(session.shop, id)).id}`);
  return { ok: true };
};

const FILTERS: Array<{ key: JobFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "export", label: "Exports" },
  { key: "import", label: "Imports and previews" },
  { key: "scheduled", label: "Scheduled" },
  { key: "problems", label: "Problems" },
];

export default function Jobs() {
  const { jobs, total, filter, historyDays } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [params, setParams] = useSearchParams();
  const pendingId = fetcher.state !== "idle" ? String(fetcher.formData?.get("id") ?? "") || null : null;
  usePolling(jobs.some((j) => isActive(j.status)), 3000);

  return (
    <s-page heading="Jobs" inlineSize="large">
      <div className="bp-column">
        <div className="bp-tabs" role="tablist" style={{ alignSelf: "flex-start" }}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={`bp-tab${filter === f.key ? " bp-tab-on" : ""}`}
              onClick={() => setParams(f.key === "all" ? {} : { show: f.key }, { replace: true, preventScrollReset: true })}
            >
              {f.label}
            </button>
          ))}
        </div>
        {jobs.length === 0 ? (
          <s-section>
            <s-text tone="neutral">
              {filter === "all"
                ? "Exports and imports you run will be listed here."
                : filter === "problems"
                  ? "Nothing has failed. Jobs that fail or finish with errors are listed here."
                  : "No jobs of this kind yet."}
            </s-text>
          </s-section>
        ) : (
          <s-section padding="none" accessibilityLabel="Jobs">
            <JobList jobs={jobs} pendingId={pendingId} onAction={(intent, id) => fetcher.submit({ intent, id }, { method: "post" })} />
          </s-section>
        )}
        {total > jobs.length ? (
          <s-stack direction="inline" gap="small" alignItems="center" justifyContent="center">
            <s-text tone="neutral">
              Showing {jobs.length} of {total.toLocaleString("en")}
            </s-text>
            <s-button
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("n", String(jobs.length + PAGE));
                setParams(next, { replace: true, preventScrollReset: true });
              }}
            >
              Show more
            </s-button>
          </s-stack>
        ) : null}
        {historyDays > 0 ? (
          <s-text tone="neutral">
            Exports stay in this list for {historyDays} days, then they and their files are cleared. A schedule's latest file is kept for its permanent link.
          </s-text>
        ) : null}
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
