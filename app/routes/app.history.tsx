import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { searchHistory } from "../lib/jobs/history.server";
import { RETENTION_DAYS } from "../lib/jobs/storage.server";
import { formatDate } from "../components/jobs";

import { EmptyState, JOB_PAGES, SubNav } from "../components/ui";
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const job = params.get("job") ?? "";
  const entries = await searchHistory(session.shop, q, job ? 500 : 100, job);
  return { q, job, jobName: job ? (entries[0]?.jobName ?? "") : "", days: RETENTION_DAYS, entries };
};

const ACTIONS: Record<string, { label: string; tone: "info" | "warning" | "critical" | "neutral" }> = {
  update: { label: "Updated", tone: "info" },
  create: { label: "Created", tone: "warning" },
  delete: { label: "Deleted", tone: "critical" },
  replace: { label: "Re-created", tone: "critical" },
  undo: { label: "Undone", tone: "neutral" },
};

export default function History() {
  const { q, job, jobName, days, entries } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [text, setText] = useState(q);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const go = (value: string) => navigate(value.trim() ? `/app/history?q=${encodeURIComponent(value.trim())}` : "/app/history");

  return (
    <s-page heading="Jobs and history" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      <SubNav items={JOB_PAGES} current="/app/history" />
      <s-section>
        <s-stack direction="block" gap="small">
          <s-text color="subdued">What Bulkport's imports changed, item by item, for the last {days} days. Changes made in Shopify itself or by other apps are not listed here.</s-text>
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              go(text);
            }}
          >
            <s-grid gridTemplateColumns="minmax(0, 1fr) auto auto" gap="small" alignItems="end">
              <s-search-field label="Find an item" labelAccessibilityVisibility="exclusive" placeholder="Handle, ID, SKU, email or part of a title" value={text} onInput={(ev: any) => setText(String(ev.currentTarget.value))} />
              <s-button variant="primary" onClick={() => go(text)}>
                Search
              </s-button>
              {q || job ? <s-button onClick={() => (setText(""), go(""))}>Show everything</s-button> : null}
            </s-grid>
          </form>
        </s-stack>
      </s-section>

      <s-section heading={job ? `What ${jobName ? `"${jobName}"` : "this job"} changed` : q ? `Changes to "${q}"` : "Latest changes"} padding="none">
        {entries.length ? (
          <div className="bp-rows" role="list">
            {entries.map((e) => {
              const a = ACTIONS[e.action] ?? ACTIONS.update;
              const lines = open[e.id] ? e.changes : e.changes.slice(0, 5);
              return (
                <div key={e.id} role="listitem" className="bp-row bp-hist">
                  <div className="bp-row-item">
                    <s-text type="strong">{e.title || e.item.replace(/^[A-Za-z ]+: /, "")}</s-text>
                    <s-text color="subdued">{e.item}</s-text>
                    <s-text color="subdued">{formatDate(e.at)}</s-text>
                  </div>
                  <div className="bp-row-what">
                    {lines.length ? lines.map((c, k) => <s-text key={k}>{c}</s-text>) : <s-text color="subdued">Changed; the values were not recorded for this import.</s-text>}
                    {e.changes.length > 5 && !open[e.id] ? <s-link onClick={() => setOpen((c) => ({ ...c, [e.id]: true }))}>Show all {e.changes.length} changes</s-link> : null}
                    <s-link href={`/app/jobs/${e.jobId}`}>In: {e.jobName}</s-link>
                  </div>
                  <div className="bp-row-do">
                    <s-badge tone={a.tone}>{a.label}</s-badge>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon="history" title={q ? "No change found for that" : "No changes recorded yet"}>
            {q ? "No import in this period changed an item matching that. Try its handle, its ID or its SKU exactly as in the file." : "Every import you apply from now on is listed here, item by item, with the old and new values."}
          </EmptyState>
        )}
      </s-section>
      {entries.length ? (
        <s-section>
          <s-text color="subdued">To put a change back, open its import and choose "Undo this import". {entries.length >= 100 ? "The list shows the latest 100; search for an item to see its full history." : ""}</s-text>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
