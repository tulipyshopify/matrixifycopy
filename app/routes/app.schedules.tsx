import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  deleteSchedule,
  disablePublicLink,
  hasPersonalData,
  listSchedules,
  publicFileUrl,
  resetPublicToken,
  updateSchedule,
} from "../lib/jobs/jobs.server";
import { openSecret } from "../lib/jobs/storage.server";
import { describeSchedule } from "../lib/jobs/schedule-time";
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
      repeats: describeSchedule(s),
      nextRunAt: s.nextRunAt,
      lastJobId: s.lastJobId,
      sourceUrl: s.sourceUrl ? redactUrl(openSecret(s.sourceUrl)!) : null,
      uploadUrl: s.uploadUrl ? redactUrl(openSecret(s.uploadUrl)!) : null,
      personalData: hasPersonalData(s.config),
      linkDownloads: s.linkDownloads,
      lastDownloadAt: s.lastDownloadAt,
      format: s.format,
      fileUrl: publicFileUrl(s),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id"));
  const intent = form.get("intent");
  if (intent === "toggle")
    await updateSchedule(session.shop, id, {
      enabled: form.get("enabled") === "true",
    });
  if (intent === "run")
    await updateSchedule(session.shop, id, { runNow: true });
  if (intent === "delete") await deleteSchedule(session.shop, id);
  if (intent === "resetLink" || intent === "enableLink")
    await resetPublicToken(session.shop, id);
  if (intent === "disableLink") await disablePublicLink(session.shop, id);
  return { ok: true };
};

export default function Schedules() {
  const { schedules } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const navigate = useNavigate();
  const post = (data: Record<string, string>) =>
    fetcher.submit(data, { method: "post" });

  return (
    <s-page heading="Schedules">
      <s-button slot="primary-action" onClick={() => navigate("/app")}>
        New scheduled export
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={() => navigate("/app?tab=import")}
      >
        New scheduled import
      </s-button>
      {schedules.length === 0 ? (
        <s-section>
          <s-paragraph>
            No schedules yet. Turn on "Repeat this export on a schedule" when
            creating an export, or choose a repeat interval when importing from
            a URL.
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
                      {s.sourceUrl ? (
                        <s-text tone="neutral">From {s.sourceUrl}</s-text>
                      ) : null}
                      {s.uploadUrl ? (
                        <s-text tone="neutral">Upload to {s.uploadUrl}</s-text>
                      ) : null}
                      {s.fileUrl ? (
                        <s-stack direction="block" gap="small-300">
                          <s-text tone="neutral">
                            Permanent link (
                            {s.format === "csv" ? "CSV" : "Excel"}), always the
                            latest file:
                          </s-text>
                          <s-stack
                            direction="inline"
                            gap="small-200"
                            alignItems="center"
                          >
                            <code style={{ wordBreak: "break-all" }}>
                              {s.fileUrl}
                            </code>
                            <s-button
                              variant="tertiary"
                              onClick={() => {
                                navigator.clipboard.writeText(s.fileUrl!);
                                (window as any).shopify?.toast?.show(
                                  "Link copied",
                                );
                              }}
                            >
                              Copy
                            </s-button>
                            <s-button
                              variant="tertiary"
                              onClick={() =>
                                post({ intent: "resetLink", id: s.id })
                              }
                            >
                              Reset link
                            </s-button>
                            <s-button
                              variant="tertiary"
                              tone="critical"
                              onClick={() =>
                                post({ intent: "disableLink", id: s.id })
                              }
                            >
                              Turn off link
                            </s-button>
                          </s-stack>
                          <s-text
                            tone={s.personalData ? "critical" : "caution"}
                          >
                            {s.personalData
                              ? "This export contains customer data. Anyone who has this link can download names, emails and addresses without logging in."
                              : "Anyone who has this link can download the file without logging in."}
                          </s-text>
                          <s-text tone="neutral">
                            {s.linkDownloads
                              ? `Downloaded ${s.linkDownloads} time${s.linkDownloads === 1 ? "" : "s"}, last on ${formatDate(s.lastDownloadAt)}.`
                              : "Not downloaded through the link yet."}
                          </s-text>
                        </s-stack>
                      ) : s.type === "export" ? (
                        <s-stack
                          direction="inline"
                          gap="small-200"
                          alignItems="center"
                        >
                          <s-button
                            variant="tertiary"
                            onClick={() =>
                              post({ intent: "enableLink", id: s.id })
                            }
                          >
                            Create permanent link
                          </s-button>
                          <s-text
                            tone={s.personalData ? "critical" : "neutral"}
                          >
                            {s.personalData
                              ? "Off. This export contains customer data: a link would let anyone who has it download that data."
                              : "Off. A link lets other tools fetch the latest file without logging in."}
                          </s-text>
                        </s-stack>
                      ) : null}
                      {s.lastJobId ? (
                        <s-link href={`/app/jobs/${s.lastJobId}`}>
                          Last run
                        </s-link>
                      ) : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{s.repeats}</s-table-cell>
                  <s-table-cell>
                    {s.enabled ? (
                      formatDate(s.nextRunAt)
                    ) : (
                      <s-badge>Paused</s-badge>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      <s-button
                        variant="secondary"
                        onClick={() => post({ intent: "run", id: s.id })}
                      >
                        Run now
                      </s-button>
                      <s-button
                        variant="tertiary"
                        onClick={() =>
                          post({
                            intent: "toggle",
                            id: s.id,
                            enabled: String(!s.enabled),
                          })
                        }
                      >
                        {s.enabled ? "Pause" : "Resume"}
                      </s-button>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        onClick={() => {
                          // Two clicks instead of a browser dialog, which embedded app frames can block.
                          if (confirmDelete === s.id)
                            post({ intent: "delete", id: s.id });
                          else setConfirmDelete(s.id);
                        }}
                      >
                        {confirmDelete === s.id
                          ? "Click again to delete"
                          : "Delete"}
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
