import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ProductPicker, type Pick } from "../components/ProductPicker";
import { createGql } from "../lib/core/gql";
import { countItems } from "../lib/jobs/counts.server";
import { EDIT_COLUMNS, MAX_EDIT_PRODUCTS, startEdit } from "../lib/jobs/edit.server";
import { PICK_FIELDS, planTask } from "../lib/jobs/tasks.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { pickFields: PICK_FIELDS, columns: EDIT_COLUMNS, max: MAX_EDIT_PRODUCTS };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect, admin } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    const input = JSON.parse(String(form.get("input") ?? "{}"));
    if (form.get("intent") === "count") {
      const plan = planTask({ task: "end_sale", pick: input.pick, all: true }, { counting: true });
      const gql = createGql(async (query, variables) => (await admin.graphql(query, { variables })).json());
      const r = await countItems(gql, "products", { filters: plan.filters });
      return { count: r && !r.unfiltered ? { n: r.count, exact: r.precision === "EXACT" } : null };
    }
    const job = await startEdit(session.shop, input);
    return redirect(`/app/edit/${job.id}`);
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return form.get("intent") === "count" ? { count: null } : { error: String(e?.message ?? e) };
  }
};

export default function EditStart() {
  const { pickFields, columns, max } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ error?: string }>();
  const counter = useFetcher<{ count?: { n: number; exact: boolean } | null }>();
  const [pick, setPick] = useState<Pick>([{ field: "vendor", value: "" }]);
  const [all, setAll] = useState(false);
  const [cols, setCols] = useState<string[]>(columns.filter((c) => c.on).map((c) => c.column));
  const chosen = pick.filter((p) => p.value.trim() !== "");
  const key = JSON.stringify(all ? "all" : chosen);
  useEffect(() => {
    if (!all && !chosen.length) return;
    const t = setTimeout(() => counter.submit({ intent: "count", input: JSON.stringify({ pick: all ? [] : chosen }) }, { method: "post" }), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const count = (all || chosen.length) && counter.state === "idle" ? counter.data?.count : undefined;
  const busy = fetcher.state !== "idle";
  const toggle = (c: string, on: boolean) => setCols((cur) => (on ? [...cur, c] : cur.filter((x) => x !== c)));

  return (
    <s-page heading="Edit in a table" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      <s-banner tone="info" heading="Edit products like a spreadsheet, without leaving the app">
        <s-text>Choose the products and the columns. They open in a table you can type in, paste into from Excel, and fill a whole column at once. Your changes then go through the usual preview before anything is applied.</s-text>
      </s-banner>
      <s-section heading="1. Which products">
        <ProductPicker fields={pickFields} pick={pick} setPick={setPick} all={all} setAll={setAll} count={count} counting={counter.state !== "idle"} />
        {count && count.n > max ? <s-text tone="caution">The table holds the first {max.toLocaleString("en")} products. Add a condition to work on a smaller group, or use Export and Import for the whole catalogue.</s-text> : null}
      </s-section>
      <s-section heading="2. Which columns to edit">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
          {(["product", "variant"] as const).map((level) => (
            <s-stack key={level} direction="block" gap="small-300">
              <s-text type="strong">{level === "product" ? "The product" : "Each variant"}</s-text>
              {columns
                .filter((c) => c.level === level)
                .map((c) => (
                  <s-checkbox key={c.column} label={c.label} checked={cols.includes(c.column)} onChange={(ev: any) => toggle(c.column, !!ev.currentTarget.checked)} />
                ))}
            </s-stack>
          ))}
        </s-grid>
      </s-section>
      {fetcher.data?.error && !busy ? (
        <s-banner tone="critical" heading="Not started">
          {fetcher.data.error}
        </s-banner>
      ) : null}
      <div className="bp-actionbar">
        <div>
          <s-text type="strong">Next: the table</s-text>
          <br />
          <s-text color="subdued">Reading the products takes a few seconds to a few minutes, depending on how many there are.</s-text>
        </div>
        <s-button variant="primary" loading={busy} disabled={busy || (!all && !chosen.length) || !cols.length || count?.n === 0} onClick={() => fetcher.submit({ intent: "start", input: JSON.stringify({ pick: all ? [] : chosen, all, columns: cols }) }, { method: "post" })}>
          Open the table
        </s-button>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
