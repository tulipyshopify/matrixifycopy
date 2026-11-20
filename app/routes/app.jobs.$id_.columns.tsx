import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { matchLayout, oddMatches, suggestColumn } from "../lib/core/layouts";
import { detectEntity } from "../lib/core/registry";
import { ENTITIES, getEntity } from "../lib/entities";
import { getJob, rerunJob } from "../lib/jobs/jobs.server";
import { listLayouts, saveLayout } from "../lib/jobs/layouts.server";
import { readImportSheets } from "../lib/jobs/runner.server";

/** Columns that are worked out by Shopify or the app: never a target for someone's data. */
const NOT_A_TARGET = /^(Row #|Top Row|Created At|Updated At|URL|Total Inventory Qty|Category: Name|Image Width|Image Height|Variant Inventory Item ID|Orders Count|Total Spent|State|Verified Email|Products Count|Import Result|Import Comment)$|: Updated At$/;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const job = await getJob(session.shop, params.id!);
  if (job.type !== "import" || !job.inputFile) throw new Response("This job has no file to match columns for", { status: 404 });
  const layouts = await listLayouts(session.shop);
  let sheets: Array<{ sheet: string; headers: string[]; samples: Record<string, string[]>; rows: number; entity: string; map: Record<string, string>; layout: string | null }> = [];
  let error: string | null = null;
  try {
    // The file as it is, before any saved matching is applied.
    const read = await readImportSheets({ inputFile: job.inputFile, inputName: job.inputName }, {} as any);
    sheets = read.slice(0, 10).map((s) => {
      const saved = matchLayout(s.headers, layouts);
      const entity = (saved ? getEntity(saved.entity) : null) ?? detectEntity(s, ENTITIES);
      const usable = entity?.import ? entity : getEntity("products")!;
      const map: Record<string, string> = {};
      const taken = new Set<string>();
      const savedByHeader = new Map(Object.entries(saved?.map ?? {}).map(([k, v]) => [k.toLowerCase().trim(), v]));
      for (const h of s.headers) {
        const kept = savedByHeader.get(h.toLowerCase().trim());
        const to = kept !== undefined ? kept : (suggestColumn(usable, h) ?? "");
        map[h] = to && !taken.has(to) ? to : "";
        if (map[h]) taken.add(map[h]);
      }
      return {
        sheet: s.label ?? s.name,
        headers: s.headers.slice(0, 300),
        samples: Object.fromEntries(s.headers.slice(0, 300).map((h) => [h, s.rows.map((r) => r[h]).filter(Boolean).slice(0, 3).map((v) => (v.length > 60 ? `${v.slice(0, 57)}…` : v))])),
        rows: s.rows.length,
        entity: usable.key,
        map,
        layout: saved?.name ?? null,
      };
    });
  } catch (e: any) {
    error = String(e?.message ?? e);
  }
  return {
    job: { id: job.id, name: job.inputName ?? job.name },
    sheets,
    error,
    entities: ENTITIES.filter((e) => e.import).map((e) => ({ key: e.key, sheet: e.sheet, keyColumns: e.import!.keyColumns, columns: e.columns.filter((c) => !NOT_A_TARGET.test(c)) })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    const sheets = JSON.parse(String(form.get("sheets") ?? "[]")) as Array<{ name: string; entity: string; map: Record<string, string>; confirmedOdd?: boolean }>;
    if (!sheets.length) throw new Error("Nothing to save");
    for (const s of sheets) await saveLayout(session.shop, s);
    const job = await rerunJob(session.shop, params.id!);
    return redirect(`/app/jobs/${job.id}`);
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: String(e?.message ?? e) };
  }
};

export default function MatchColumns() {
  const { job, sheets, error, entities } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ error?: string }>();
  const base = job.name.replace(/\.[a-z]+$/i, "").replace(/[_-]+/g, " ").trim() || "Supplier file";
  const [state, setState] = useState(() => sheets.map((s) => ({ entity: s.entity, map: s.map, name: s.layout ?? (sheets.length > 1 ? `${base} (${s.sheet})` : base), on: true, confirmedOdd: false })));
  const busy = fetcher.state !== "idle";
  const patch = (i: number, p: Partial<(typeof state)[number]>) => setState((cur) => cur.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <s-page heading="Match columns" inlineSize="base">
      <s-link slot="breadcrumb-actions" href={`/app/jobs/${job.id}`}>
        Preview
      </s-link>
      <s-banner tone="info" heading={`Tell Bulkport what the columns of "${job.name}" are`}>
        <s-text>For each column of the file, choose what it holds. The matching is saved under a name: the next file with the same columns is read the same way without asking, in scheduled imports too. Your file is not changed.</s-text>
      </s-banner>
      {error ? (
        <s-banner tone="critical" heading="The file could not be read">
          {error}
        </s-banner>
      ) : null}

      {sheets.map((s, i) => {
        const st = state[i];
        const entity = entities.find((e) => e.key === st.entity) ?? entities[0];
        const used = new Map<string, number>();
        for (const to of Object.values(st.map)) if (to) used.set(to, (used.get(to) ?? 0) + 1);
        const matched = Object.values(st.map).filter(Boolean).length;
        const hasKey = entity.keyColumns.some((k) => used.has(k));
        return (
          <s-section key={s.sheet} heading={sheets.length > 1 ? `Sheet "${s.sheet}"` : undefined} padding="none">
            <s-box padding="base">
              <s-stack direction="block" gap="base">
                {sheets.length > 1 ? <s-checkbox label="Save a matching for this sheet" checked={st.on} onChange={(ev: any) => patch(i, { on: !!ev.currentTarget.checked })} /> : null}
                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base" alignItems="end">
                  <s-select
                    label="This sheet holds"
                    value={st.entity}
                    onChange={(ev: any) => {
                      const key = String(ev.currentTarget.value);
                      const cols = new Set(entities.find((e) => e.key === key)?.columns ?? []);
                      // Matches that don't exist for the new data type are dropped.
                      patch(i, { entity: key, map: Object.fromEntries(Object.entries(st.map).map(([h, to]) => [h, cols.has(to) ? to : ""])) });
                    }}
                  >
                    {entities.map((e) => (
                      <s-option key={e.key} value={e.key}>
                        {e.sheet}
                      </s-option>
                    ))}
                  </s-select>
                  <s-text-field label="Save this matching as" details="For example the supplier's name" value={st.name} onInput={(ev: any) => patch(i, { name: String(ev.currentTarget.value) })} />
                </s-grid>
                <s-text color="subdued">
                  {s.rows.toLocaleString("en")} rows · {matched} of {s.headers.length} columns matched
                  {s.layout ? ` · currently read with "${s.layout}"` : ""}
                </s-text>
                {oddMatches(st.map).length ? (
                  <s-banner tone="warning" heading="Check this match">
                    <s-stack direction="block" gap="small-300">
                      {oddMatches(st.map).map((o) => (
                        <s-text key={o}>{o}.</s-text>
                      ))}
                      <s-checkbox label="This is right: save it as it is" checked={st.confirmedOdd} onChange={(ev: any) => patch(i, { confirmedOdd: !!ev.currentTarget.checked })} />
                    </s-stack>
                  </s-banner>
                ) : null}
                {!hasKey ? (
                  <s-text tone="critical">
                    Match one column to {entity.keyColumns.join(", or ")}: it tells which {entity.sheet.toLowerCase().replace(/s$/, "")} each row is.
                  </s-text>
                ) : null}
              </s-stack>
            </s-box>
            <div className="bp-match" role="table" aria-label="Columns of the file">
              <div className="bp-match-head" role="row">
                <span role="columnheader">Column in the file</span>
                <span role="columnheader">First values</span>
                <span role="columnheader">Is our column</span>
              </div>
              {s.headers.map((h) => {
                const to = st.map[h] ?? "";
                const twice = !!to && (used.get(to) ?? 0) > 1;
                return (
                  <div key={h} role="row" className={`bp-match-row${to ? "" : " bp-match-off"}`}>
                    <b role="cell">{h}</b>
                    <span role="cell" className="bp-match-sample">
                      {s.samples[h]?.length ? s.samples[h].join(" · ") : "(empty)"}
                    </span>
                    <span role="cell">
                      <select aria-label={`What "${h}" holds`} className={twice ? "bp-match-bad" : ""} value={to} onChange={(ev) => patch(i, { map: { ...st.map, [h]: ev.currentTarget.value } })}>
                        <option value="">Not imported</option>
                        {entity.columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                            {entity.keyColumns.includes(c) ? " (identifies the row)" : ""}
                          </option>
                        ))}
                      </select>
                      {twice ? <small>Matched twice</small> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </s-section>
        );
      })}

      {fetcher.data?.error && !busy ? (
        <s-banner tone="critical" heading="Not saved">
          {fetcher.data.error}
        </s-banner>
      ) : null}

      {sheets.length ? (
        <div className="bp-actionbar">
          <div>
            <s-text type="strong">Next: the preview, read with this matching</s-text>
            <br />
            <s-text color="subdued">Saved matchings can be removed in Settings. Nothing in the store changes until you apply the preview.</s-text>
          </div>
          <s-button
            variant="primary"
            loading={busy}
            disabled={busy || !state.some((x) => x.on)}
            onClick={() => fetcher.submit({ sheets: JSON.stringify(state.filter((x) => x.on).map((x) => ({ name: x.name, entity: x.entity, map: x.map, confirmedOdd: x.confirmedOdd }))) }, { method: "post" })}
          >
            Save and preview again
          </s-button>
        </div>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
