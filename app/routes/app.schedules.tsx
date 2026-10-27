import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { deleteSchedule, listSchedules, updateSchedule } from "../lib/jobs/jobs.server";
import { redactUrl } from "../lib/jobs/sources.server";
import { formatDate } from "../components/jobs";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const schedules = await listSchedules(session.shop);
  return {
    schedules: schedules.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      intervalMinutes: s.intervalMinutes,
      nextRunAt: s.nextRunAt,
      lastJobId: s.lastJobId,
      sourceUrl: s.sourceUrl ? redactUrl(s.sourceUrl) : null,
      uploadUrl: s.uploadUrl ? redactUrl(s.uploadUrl) : null,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id"));
  const intent = form.get("intent");
  if (intent === "toggle") await updateSchedule(session.shop, id, { enabled: form.get("enabled") === "true" });
  if (intent === "run") await updateSchedule(session.shop, id, { runNow: true });
  if (intent === "delete") await deleteSchedule(session.shop, id);
  return { ok: true };
};

function every(minutes: number): string {
  if (minutes % 10080 === 0) return minutes === 10080 ? "Weekly" : `Every ${minutes / 10080} weeks`;
  if (minutes % 1440 === 0) return minutes === 1440 ? "Daily" : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "Hourly" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

export default function Schedules() {
  const { schedules } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const post = (data: Record<string, string>) => fetcher.submit(data, { method: "post" });

  return (
    <s-page heading="Schedules">
      <s-button slot="primary-action" onClick={() => navigate("/app/export")}>
        New scheduled export
      </s-button>
      <s-button slot="secondary-actions" onClick={() => navigate("/app/import")}>
        New scheduled import
      </s-button>
      {schedules.length === 0 ? (
        <s-section>
          <s-paragraph>
            No schedules yet. Turn on "Repeat this export on a schedule" when creating an export, or choose a repeat
            interval when importing from a URL.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Name</s-table-header>
              <s-table-header>Repeats</s-table-header>
              <s-table-header>Next run</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {schedules.map((s) => (
                <s-table-row key={s.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-500">
                      <s-text type="strong">
                        {s.type === "export" ? "Export" : "Import"}: {s.name}
                      </s-text>
                      {s.sourceUrl ? <s-text tone="neutral">From {s.sourceUrl}</s-text> : null}
                      {s.uploadUrl ? <s-text tone="neutral">Upload to {s.uploadUrl}</s-text> : null}
                      {s.lastJobId ? <s-link href={`/app/jobs/${s.lastJobId}`}>Last run</s-link> : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{every(s.intervalMinutes)}</s-table-cell>
                  <s-table-cell>{s.enabled ? formatDate(s.nextRunAt) : <s-badge>Paused</s-badge>}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      <s-button variant="secondary" onClick={() => post({ intent: "run", id: s.id })}>
                        Run now
                      </s-button>
                      <s-button
                        variant="tertiary"
                        onClick={() => post({ intent: "toggle", id: s.id, enabled: String(!s.enabled) })}
                      >
                        {s.enabled ? "Pause" : "Resume"}
                      </s-button>
                      <s-button variant="tertiary" tone="critical" onClick={() => post({ intent: "delete", id: s.id })}>
                        Delete
                      </s-button>
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
