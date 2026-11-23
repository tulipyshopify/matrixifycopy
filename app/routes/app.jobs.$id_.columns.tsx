import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useLocation, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createGql } from "../lib/core/gql";
import { looksLikeStock, matchLayout, oddMatches, stockColumn, stockFromText, suggestAll } from "../lib/core/layouts";
import { getLocations } from "../lib/core/lookups";
import { detectEntity } from "../lib/core/registry";
import { ENTITIES, getEntity } from "../lib/entities";
import { getJob, rerunJob } from "../lib/jobs/jobs.server";
import { listLayouts, saveLayout } from "../lib/jobs/layouts.server";
import { headerRowFromLayouts, layoutKeys, readImportSheets } from "../lib/jobs/runner.server";

/** Columns that are worked out by Shopify or the app: never a target for someone's data. */
const NOT_A_TARGET = /^(Row #|Top Row|Created At|Updated At|URL|Total Inventory Qty|Category: Name|Image Width|Image Height|Variant Inventory Item ID|Orders Count|Total Spent|State|Verified Email|Products Count|Import Result|Import Comment)$|: Updated At$/;

/** "0:14,2:0": the row of column names chosen by hand, per sheet (by its position in the file). */
function chosenRows(v: string | null): Map<number, number> {
  const out = new Map<number, number>();
  for (const part of (v ?? "").split(",")) {
    const m = /^(\d+):(\d+)$/.exec(part.trim());
    if (m) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const job = await getJob(session.shop, params.id!);
  if (job.type !== "import" || !job.inputFile) throw new Response("This job has no file to match columns for", { status: 404 });
  const layouts = await listLayouts(session.shop);
  const chosen = chosenRows(new URL(request.url).searchParams.get("rows"));
  let locations: string[] = [];
  try {
    const gql = createGql(async (query, variables) => (await admin.graphql(query, { variables })).json(), () => {}, 2);
    locations = (await getLocations(gql, new Map())).filter((l) => l.isActive).map((l) => l.name);
  } catch {
    // Without them stock can still be matched to the product's total.
  }
  const fileName = job.inputName ?? job.name ?? "";
  let sheets: Array<{
    index: number;
    sheet: string;
    headers: string[];
    samples: Record<string, string[]>;
    rows: number;
    entity: string;
    map: Record<string, string>;
    layout: string | null;
    headerRow: number;
    rowChosen: boolean;
    top: Array<{ row: number; cells: string[] }>;
    textStock: string[];
    skipUnknown: boolean;
    inStockQty: number | null;
  }> = [];
  let error: string | null = null;
  try {
    // The file as it is, before any saved matching is applied; its row of column names as chosen here, else as saved, else as found.
    const fromLayouts = headerRowFromLayouts(layouts);
    const read = await readImportSheets({ inputFile: job.inputFile, inputName: job.inputName }, {} as any, () => {}, [], { headerRow: (top, i) => chosen.get(i) ?? fromLayouts?.(top, i) });
    sheets = read.slice(0, 12).map((s, index) => {
      const saved = matchLayout(s.headers, layouts);
      const entity = (saved ? getEntity(saved.entity) : null) ?? detectEntity(s, ENTITIES);
      const usable = entity?.import ? entity : getEntity("products")!;
      const map = suggestAll(usable, s.headers, { locations, fileName: `${fileName} ${s.name}` });
      if (saved) {
        const savedByHeader = new Map(Object.entries(saved.map).map(([k, v]) => [k.toLowerCase().trim(), v]));
        const taken = new Set<string>();
        for (const h of s.headers) {
          const kept = savedByHeader.get(h.toLowerCase().trim());
          if (kept !== undefined) map[h] = kept;
        }
        // A saved match wins over a fresh suggestion for the same column of ours.
        for (const h of s.headers) {
          if (map[h] && taken.has(map[h])) map[h] = "";
          if (map[h]) taken.add(map[h]);
        }
      }
      const headers = s.headers.slice(0, 300);
      return {
        index,
        sheet: s.label ?? s.name,
        headers,
        samples: Object.fromEntries(headers.map((h) => [h, s.rows.map((r) => r[h]).filter(Boolean).slice(0, 3).map((v) => (v.length > 60 ? `${v.slice(0, 57)}…` : v))])),
        rows: s.rows.length,
        entity: usable.key,
        map,
        layout: saved?.name ?? null,
        headerRow: s.headerRow ?? 1,
        rowChosen: chosen.has(index) || saved?.headerRow !== undefined,
        top: (s.top ?? [])
          .map((cells, i) => ({ row: i + 1, cells: cells.filter((c) => c.trim()).slice(0, 6) }))
          .filter((r) => r.cells.length)
          .slice(0, 30),
        // Columns that read like stock but hold words ("IN STOCK") in the first rows.
        textStock: headers.filter((h) => looksLikeStock(h) && s.rows.slice(0, 200).some((r) => ["in", "out", "unknown"].includes(stockFromText(r[h] ?? "", null).read))),
        skipUnknown: saved ? saved.skipUnknown !== false : true,
        inStockQty: saved?.inStockQty ?? null,
      };
    });
  } catch (e: any) {
    error = String(e?.message ?? e);
  }
  return {
    job: { id: job.id, name: job.inputName ?? job.name },
    sheets,
    error,
    locations,
    fileName,
    entities: ENTITIES.filter((e) => e.import).map((e) => {
      const columns = e.columns.filter((c) => !NOT_A_TARGET.test(c));
      // Stock is held per location: one choice for each.
      const at = e.key === "products" ? columns.indexOf("Variant Inventory Qty") : -1;
      if (at >= 0 && locations.length) columns.splice(at, 1, ...locations.map(stockColumn));
      return { key: e.key, sheet: e.sheet, keyColumns: layoutKeys(e.key), columns };
    }),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    const sheets = JSON.parse(String(form.get("sheets") ?? "[]")) as Array<{ name: string; entity: string; map: Record<string, string>; confirmedOdd?: boolean; headerRow?: number; skipUnknown?: boolean; inStockQty?: number | null }>;
    if (!sheets.length) throw new Error("Nothing to save");
    for (const s of sheets) await saveLayout(session.shop, s);
    const job = await rerunJob(session.shop, params.id!);
    return redirect(`/app/jobs/${job.id}`);
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: String(e?.message ?? e) };
  }
};

/** How a column of ours is shown in the list of choices. */
const shownColumn = (c: string) => (c.startsWith("Inventory Available: ") ? `Available stock at ${c.slice("Inventory Available: ".length)}` : c);

export default function MatchColumnsPage() {
  // A different row of column names is a different table: start from what the reader then finds.
  const { search } = useLocation();
  return <MatchColumns key={search} />;
}

function MatchColumns() {
  const { job, sheets, error, entities, locations, fileName } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { search } = useLocation();
  const pickRow = (index: number, row: number) => {
    const q = new URLSearchParams(search);
    const rows = new Map((q.get("rows") ?? "").split(",").filter(Boolean).map((p) => p.split(":").map(Number) as [number, number]));
    rows.set(index, row);
    q.set("rows", [...rows.entries()].map(([i, r]) => `${i}:${r}`).join(","));
    navigate(`?${q.toString()}`, { replace: true });
  };
  const fetcher = useFetcher<{ error?: string }>();
  const base = job.name.replace(/\.[a-z]+$/i, "").replace(/[_-]+/g, " ").trim() || "Supplier file";
  const [state, setState] = useState(() => sheets.map((s) => ({ entity: s.entity, map: s.map, name: s.layout ?? (sheets.length > 1 ? `${base} (${s.sheet})` : base), on: true, confirmedOdd: false, skipUnknown: s.skipUnknown, inStockQty: s.inStockQty === null ? "" : String(s.inStockQty) })));
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
                      const next = entities.find((e) => e.key === key);
                      // A different kind of data: the columns are looked at afresh for it.
                      patch(i, { entity: key, map: next ? suggestAll(next, s.headers, { locations, fileName: `${fileName} ${s.sheet}` }) : {} });
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
                {s.top.length ? (
                  <s-select
                    label="The column names are in"
                    details={s.headerRow > 1 ? `Rows above row ${s.headerRow} (a title, an address) are not imported.` : "Change this if the names shown below are not the file's column names."}
                    value={String(s.headerRow)}
                    onChange={(ev: any) => pickRow(s.index, Number(ev.currentTarget.value))}
                  >
                    {s.top.map((r) => (
                      <s-option key={r.row} value={String(r.row)}>
                        Row {r.row}: {r.cells.join(" · ").slice(0, 90)}
                      </s-option>
                    ))}
                    <s-option value="0">No row holds column names (call them Column A, B, C…)</s-option>
                  </s-select>
                ) : null}
                {entity.key === "products" ? (
                  <s-checkbox
                    label="Skip rows for products that are not in my shop"
                    details="A supplier's list usually holds much you don't sell. Skipped rows are counted, not reported as failures."
                    checked={st.skipUnknown}
                    onChange={(ev: any) => patch(i, { skipUnknown: !!ev.currentTarget.checked })}
                  />
                ) : null}
                {s.headers.some((h) => /^(Inventory Available: |Variant Inventory Qty$)/.test(st.map[h] ?? "") && s.textStock.includes(h)) ? (
                  <s-number-field
                    label={'Stock written as "IN STOCK" counts as'}
                    details={'Leave empty to leave the stock of those rows as it is. "OUT OF STOCK" is always read as 0.'}
                    min={0}
                    value={st.inStockQty}
                    onInput={(ev: any) => {
                      const v = String(ev.currentTarget.value);
                      patch(i, { inStockQty: v });
                    }}
                  />
                ) : null}
                {entity.key === "products" && locations.length > 1 && s.headers.some((h) => looksLikeStock(h) && !st.map[h]) ? (
                  <s-banner tone="info" heading="Which location is this stock for?">
                    <s-text>
                      {s.headers.filter((h) => looksLikeStock(h) && !st.map[h]).map((h) => `"${h}"`).join(", ")} looks like stock. Choose "Available stock at …" for the location it belongs to ({locations.slice(0, 6).join(", ")}
                      {locations.length > 6 ? "…" : ""}), or leave it as "Not imported".
                    </s-text>
                  </s-banner>
                ) : null}
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
                            {shownColumn(c)}
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
            onClick={() => fetcher.submit({ sheets: JSON.stringify(
                  state
                    .map((x, i) => ({ x, s: sheets[i] }))
                    .filter(({ x }) => x.on)
                    .map(({ x, s }) => ({
                      name: x.name,
                      entity: x.entity,
                      map: x.map,
                      confirmedOdd: x.confirmedOdd,
                      skipUnknown: x.skipUnknown,
                      inStockQty: x.inStockQty === "" ? null : Number(x.inStockQty),
                      // Saved only when it was set by hand: otherwise the reader finds the row by itself.
                      ...(s.rowChosen ? { headerRow: s.headerRow } : {}),
                    })),
                ) }, { method: "post" })}
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
