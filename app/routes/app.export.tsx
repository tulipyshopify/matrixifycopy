import { useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createExportJob, createSchedule, entityCatalog, parseExportConfig } from "../lib/jobs/jobs.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { entities: entityCatalog().filter((e) => e.canExport) };
};

interface ExportPayload {
  entities: Array<{ entity: string; options: Record<string, unknown> }>;
  format: string;
  name: string;
  schedule?: { intervalMinutes: number; uploadUrl?: string; startAt?: string };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const body = (await request.json()) as ExportPayload;
  try {
    const config = parseExportConfig(body);
    if (body.schedule) {
      await createSchedule(session.shop, {
        name: body.name,
        type: "export",
        config,
        format: body.format,
        uploadUrl: body.schedule.uploadUrl,
        intervalMinutes: body.schedule.intervalMinutes,
        startAt: body.schedule.startAt,
      });
      return redirect("/app/schedules");
    }
    const job = await createExportJob(session.shop, config, body.format, body.name);
    return redirect(`/app/jobs/${job.id}`);
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};

interface EntityState {
  enabled: boolean;
  groups: string[];
  query: string;
  updatedAfter: string;
  createdAfter: string;
}

const INTERVALS = [
  { label: "Every hour", value: 60 },
  { label: "Every 6 hours", value: 360 },
  { label: "Every day", value: 1440 },
  { label: "Every week", value: 10080 },
];

export default function NewExport() {
  const { entities } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [state, setState] = useState<Record<string, EntityState>>(() =>
    Object.fromEntries(
      entities.map((e) => [
        e.key,
        {
          enabled: e.key === "products",
          groups: e.groups.filter((g) => g.default).map((g) => g.key),
          query: "",
          updatedAfter: "",
          createdAfter: "",
        },
      ]),
    ),
  );
  const [format, setFormat] = useState("xlsx");
  const [name, setName] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [uploadUrl, setUploadUrl] = useState("");

  const selected = useMemo(() => entities.filter((e) => state[e.key].enabled), [entities, state]);
  const update = (key: string, patch: Partial<EntityState>) =>
    setState((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  const busy = fetcher.state !== "idle";

  const submit = () => {
    const payload: ExportPayload = {
      format,
      name,
      entities: selected.map((e) => {
        const s = state[e.key];
        return {
          entity: e.key,
          options: {
            groups: e.groups.length ? s.groups : undefined,
            query: s.query || undefined,
            updatedAfter: s.updatedAfter || undefined,
            createdAfter: s.createdAfter || undefined,
          },
        };
      }),
      ...(scheduled ? { schedule: { intervalMinutes, uploadUrl: uploadUrl || undefined } } : {}),
    };
    fetcher.submit(payload as any, { method: "post", encType: "application/json" });
  };

  return (
    <s-page heading="New export" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Jobs
      </s-link>
      <s-button slot="primary-action" variant="primary" onClick={submit} disabled={!selected.length || busy} loading={busy}>
        {scheduled ? "Save schedule" : "Export"}
      </s-button>

      {fetcher.data && "error" in fetcher.data ? (
        <s-banner tone="critical" heading="Could not start export">
          {fetcher.data.error}
        </s-banner>
      ) : null}

      <s-section heading="What to export">
        <s-stack direction="block" gap="base">
          {entities.map((e) => {
            const s = state[e.key];
            return (
              <s-box key={e.key} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-checkbox
                    label={e.sheet}
                    details={e.description}
                    checked={s.enabled}
                    onChange={(ev: any) => update(e.key, { enabled: ev.currentTarget.checked })}
                  />
                  {s.enabled ? (
                    <s-stack direction="block" gap="small" padding="none none none large">
                      {e.groups.length ? (
                        <s-stack direction="inline" gap="base">
                          {e.groups.map((g) => (
                            <s-checkbox
                              key={g.key}
                              label={g.label}
                              checked={s.groups.includes(g.key)}
                              onChange={(ev: any) =>
                                update(e.key, {
                                  groups: ev.currentTarget.checked
                                    ? [...s.groups, g.key]
                                    : s.groups.filter((x) => x !== g.key),
                                })
                              }
                            />
                          ))}
                        </s-stack>
                      ) : null}
                      {e.supportsQuery ? (
                        <s-grid gridTemplateColumns="2fr 1fr 1fr" gap="base">
                          <s-text-field
                            label="Filter"
                            details="Shopify search syntax, e.g. status:active vendor:Acme tag:sale"
                            value={s.query}
                            onInput={(ev: any) => update(e.key, { query: ev.currentTarget.value })}
                          />
                          <s-date-field
                            label="Created after"
                            value={s.createdAfter}
                            onChange={(ev: any) => update(e.key, { createdAfter: ev.currentTarget.value })}
                          />
                          <s-date-field
                            label="Updated after"
                            value={s.updatedAfter}
                            onChange={(ev: any) => update(e.key, { updatedAfter: ev.currentTarget.value })}
                          />
                        </s-grid>
                      ) : null}
                    </s-stack>
                  ) : null}
                </s-stack>
              </s-box>
            );
          })}
        </s-stack>
      </s-section>

      <s-section heading="File">
        <s-stack direction="block" gap="base">
          <s-select label="Format" value={format} onChange={(ev: any) => setFormat(ev.currentTarget.value)}>
            <s-option value="xlsx">Excel (.xlsx), one sheet per data type</s-option>
            <s-option value="csv">CSV (.csv, zipped when several data types)</s-option>
          </s-select>
          <s-text-field
            label="File name (optional)"
            value={name}
            placeholder="Export_2026-10-27"
            onInput={(ev: any) => setName(ev.currentTarget.value)}
          />
        </s-stack>
      </s-section>

      <s-section heading="Schedule">
        <s-stack direction="block" gap="base">
          <s-switch
            label="Repeat this export on a schedule"
            checked={scheduled}
            onChange={(ev: any) => setScheduled(ev.currentTarget.checked)}
          />
          {scheduled ? (
            <>
              <s-select
                label="How often"
                value={String(intervalMinutes)}
                onChange={(ev: any) => setIntervalMinutes(Number(ev.currentTarget.value))}
              >
                {INTERVALS.map((i) => (
                  <s-option key={i.value} value={String(i.value)}>
                    {i.label}
                  </s-option>
                ))}
              </s-select>
              <s-url-field
                label="Upload to FTP (optional)"
                details="ftp://user:password@host/folder/ — the file is also kept in the app"
                value={uploadUrl}
                onInput={(ev: any) => setUploadUrl(ev.currentTarget.value)}
              />
            </>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
