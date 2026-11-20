import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createGql } from "../lib/core/gql";
import { countItems } from "../lib/jobs/counts.server";
import { FIELD_CHOICES, PICK_FIELDS, TEXT_COLUMNS, planTask, startTask, type TaskInput } from "../lib/jobs/tasks.server";
import { adjustedPrice } from "../lib/ai/changes";

const TASKS: Array<{ key: TaskInput["task"]; title: string; note: string }> = [
  { key: "prices", title: "Change prices", note: "Raise or lower by a percentage or an amount. Can start a sale." },
  { key: "end_sale", title: "End a sale", note: "Clear compare-at prices, with or without putting the old price back." },
  { key: "replace", title: "Find and replace text", note: "In titles, descriptions, SEO text, vendor or type." },
  { key: "tags", title: "Add or remove tags", note: "On every product you choose." },
  { key: "field", title: "Set a field", note: "Status, vendor, type, tax or what happens when out of stock." },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const task = new URL(request.url).searchParams.get("task");
  return {
    start: TASKS.some((t) => t.key === task) ? (task as TaskInput["task"]) : null,
    pickFields: PICK_FIELDS,
    textColumns: [...TEXT_COLUMNS],
    fieldChoices: FIELD_CHOICES,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect, admin } = await authenticate.admin(request);
  const form = await request.formData();
  let input: TaskInput;
  try {
    input = JSON.parse(String(form.get("task") ?? "{}"));
  } catch {
    return { error: "The form could not be read. Reload the page and try again." };
  }
  try {
    if (form.get("intent") === "count") {
      // How many products the choice matches, before anything is started.
      const plan = planTask({ ...input, all: true }, { counting: true });
      const gql = createGql(async (query, variables) => (await admin.graphql(query, { variables })).json());
      const r = await countItems(gql, "products", { filters: plan.filters });
      return { count: r && !r.unfiltered ? { n: r.count, exact: r.precision === "EXACT" } : null };
    }
    const job = await startTask(session.shop, input);
    return redirect(`/app/jobs/${job.id}`);
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return form.get("intent") === "count" ? { count: null } : { error: String(e?.message ?? e) };
  }
};

export default function Tasks() {
  const { start, pickFields, textColumns, fieldChoices } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ error?: string }>();
  const counter = useFetcher<{ count?: { n: number; exact: boolean } | null }>();
  const [task, setTask] = useState<TaskInput["task"]>(start ?? "prices");
  const [pick, setPick] = useState<Array<{ field: string; value: string }>>([{ field: "vendor", value: "" }]);
  const [all, setAll] = useState(false);
  const [confirmAll, setConfirmAll] = useState("");
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [by, setBy] = useState<"percent" | "amount">("percent");
  const [number, setNumber] = useState("");
  const [ending, setEnding] = useState("");
  const [showOldPrice, setShowOldPrice] = useState(true);
  const [restorePrice, setRestorePrice] = useState(true);
  const [column, setColumn] = useState("Title");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [tagAction, setTagAction] = useState<"add" | "remove">("add");
  const [tags, setTags] = useState("");
  const [field, setField] = useState(fieldChoices[0].column);
  const [value, setValue] = useState(fieldChoices[0].options?.[0] ?? "");

  const setValueAt = (i: number, v: string) => setPick((cur) => cur.map((x, j) => (j === i ? { ...x, value: v } : x)));
  const busy = fetcher.state !== "idle";
  const chosen = pick.filter((p) => p.value.trim() !== "");
  const input: TaskInput = {
    task,
    pick: all ? [] : chosen,
    all,
    confirmAll,
    direction,
    by,
    number,
    ending,
    showOldPrice,
    restorePrice,
    column: task === "field" ? field : column,
    find,
    replace,
    matchCase,
    tagAction,
    tags,
    value,
  };
  // The number of products the choice matches, shortly after it changes.
  const pickKey = JSON.stringify(all ? "all" : chosen);
  useEffect(() => {
    if (!all && !chosen.length) return;
    const t = setTimeout(() => counter.submit({ intent: "count", task: JSON.stringify({ task: "end_sale", pick: all ? [] : chosen, all: true }) }, { method: "post" }), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickKey]);
  const count = (all || chosen.length) && counter.state === "idle" ? counter.data?.count : undefined;

  const fieldChoice = fieldChoices.find((f) => f.column === field)!;
  const n = Number(number.replace(",", ".").replace(/[%£$€]/g, ""));
  const example =
    task === "prices" && Number.isFinite(n) && n > 0
      ? ["9.99", "24.50", "120.00"]
          .map((p) => `${p} → ${adjustedPrice(p, { action: "adjust_price", value: "", ...(by === "percent" ? { percent: direction === "down" ? -n : n } : { amount: direction === "down" ? -n : n }), ending }) ?? "unchanged"}`)
          .join("   ·   ")
      : "";

  return (
    <s-page heading="Quick changes" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      <s-banner tone="info" heading="Nothing changes until you have seen the preview">
        <s-text>Choose a change and the products it is for. Bulkport works out the new value for every product and shows them as a preview, old value beside new. You then choose what to apply, and it can be undone afterwards.</s-text>
      </s-banner>

      <s-section heading="1. What to change">
        <div className="bp-tasks" role="radiogroup" aria-label="What to change">
          {TASKS.map((t) => (
            <button key={t.key} type="button" role="radio" aria-checked={task === t.key} className={`bp-task${task === t.key ? " bp-task-on" : ""}`} onClick={() => setTask(t.key)}>
              <b>{t.title}</b>
              <span>{t.note}</span>
            </button>
          ))}
        </div>
      </s-section>

      <s-section heading="2. The change">
        <s-stack direction="block" gap="base">
          {task === "prices" ? (
            <>
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base" alignItems="end">
                <s-select label="Prices go" value={direction} onChange={(ev: any) => setDirection(ev.currentTarget.value)}>
                  <s-option value="up">Up</s-option>
                  <s-option value="down">Down</s-option>
                </s-select>
                <s-text-field label={by === "percent" ? "By (percent)" : "By (amount)"} value={number} placeholder={by === "percent" ? "5" : "2.00"} onInput={(ev: any) => setNumber(ev.currentTarget.value)} />
                <s-select label="As" value={by} onChange={(ev: any) => setBy(ev.currentTarget.value)}>
                  <s-option value="percent">A percentage</s-option>
                  <s-option value="amount">An amount of money</s-option>
                </s-select>
                <s-select label="New prices end in" value={ending} onChange={(ev: any) => setEnding(ev.currentTarget.value)}>
                  <s-option value="">No rounding to an ending</s-option>
                  <s-option value="99">.99</s-option>
                  <s-option value="95">.95</s-option>
                  <s-option value="50">.50</s-option>
                  <s-option value="00">.00</s-option>
                </s-select>
              </s-grid>
              {direction === "down" ? (
                <s-checkbox
                  label="Show the old price as the compare-at price (a sale)"
                  details="Shoppers then see the old price struck through. A higher compare-at price that is already there is kept."
                  checked={showOldPrice}
                  onChange={(ev: any) => setShowOldPrice(!!ev.currentTarget.checked)}
                />
              ) : null}
              {example ? <s-text color="subdued">For example: {example}</s-text> : null}
              <s-text color="subdued">Every variant of the chosen products is changed. Variants with no price are left alone.</s-text>
            </>
          ) : null}

          {task === "end_sale" ? (
            <>
              <s-checkbox
                label="Put the price back to the compare-at price"
                details="For sales made by lowering the price. Untick to keep today's prices and only remove the struck-through price."
                checked={restorePrice}
                onChange={(ev: any) => setRestorePrice(!!ev.currentTarget.checked)}
              />
              <s-text color="subdued">Only variants that have a compare-at price are changed.</s-text>
            </>
          ) : null}

          {task === "replace" ? (
            <>
              <s-select label="Look in" value={column} onChange={(ev: any) => setColumn(ev.currentTarget.value)}>
                {textColumns.map((c) => (
                  <s-option key={c} value={c}>
                    {c === "Body HTML" ? "Description" : c === "Type" ? "Product type" : c}
                  </s-option>
                ))}
              </s-select>
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
                <s-text-field label="Find" value={find} onInput={(ev: any) => setFind(ev.currentTarget.value)} />
                <s-text-field label="Replace with" details="Leave empty to remove the text" value={replace} onInput={(ev: any) => setReplace(ev.currentTarget.value)} />
              </s-grid>
              <s-checkbox label="Match capitals exactly" checked={matchCase} onChange={(ev: any) => setMatchCase(!!ev.currentTarget.checked)} />
              <s-text color="subdued">Products that don't contain the text are left out of the preview altogether.</s-text>
            </>
          ) : null}

          {task === "tags" ? (
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base" alignItems="end">
              <s-select label="Do" value={tagAction} onChange={(ev: any) => setTagAction(ev.currentTarget.value)}>
                <s-option value="add">Add</s-option>
                <s-option value="remove">Remove</s-option>
              </s-select>
              <s-text-field label="Tags" details="Several tags: separate them with commas. Other tags on the products are kept." value={tags} onInput={(ev: any) => setTags(ev.currentTarget.value)} />
            </s-grid>
          ) : null}

          {task === "field" ? (
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base" alignItems="end">
              <s-select
                label="Set"
                value={field}
                onChange={(ev: any) => {
                  const next = fieldChoices.find((f) => f.column === ev.currentTarget.value)!;
                  setField(next.column);
                  setValue(next.options?.[0] ?? "");
                }}
              >
                {fieldChoices.map((f) => (
                  <s-option key={f.column} value={f.column}>
                    {f.label}
                  </s-option>
                ))}
              </s-select>
              {fieldChoice.options ? (
                <s-select label="To" value={value} onChange={(ev: any) => setValue(ev.currentTarget.value)}>
                  {fieldChoice.options.map((o) => (
                    <s-option key={o} value={o}>
                      {o === "TRUE" ? "Yes" : o === "FALSE" ? "No" : o === "deny" ? "Stop selling" : o === "continue" ? "Keep selling" : o}
                    </s-option>
                  ))}
                </s-select>
              ) : (
                <s-text-field label="To" value={value} onInput={(ev: any) => setValue(ev.currentTarget.value)} />
              )}
            </s-grid>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="3. Which products">
        <s-stack direction="block" gap="base">
          {all ? null : (
            <>
              {pick.map((p, i) => {
                const spec = pickFields.find((f) => f.key === p.field) ?? pickFields[0];
                return (
                  <s-grid key={i} gridTemplateColumns={pick.length > 1 ? "minmax(0, 1fr) minmax(0, 1fr) auto" : "minmax(0, 1fr) minmax(0, 1fr)"} gap="small" alignItems="end">
                    <s-select
                      label={i === 0 ? "Products where" : "and"}
                      value={p.field}
                      onChange={(ev: any) => {
                        const key = String(ev.currentTarget.value);
                        setPick((cur) => cur.map((x, j) => (j === i ? { field: key, value: pickFields.find((f) => f.key === key)?.options?.[0] ?? "" } : x)));
                      }}
                    >
                      {pickFields.map((f) => (
                        <s-option key={f.key} value={f.key}>
                          {f.label}
                        </s-option>
                      ))}
                    </s-select>
                    {spec.options ? (
                      <s-select label="Value" labelAccessibilityVisibility="exclusive" value={p.value} onChange={(ev: any) => setValueAt(i, String(ev.currentTarget.value))}>
                        {spec.options.map((o) => (
                          <s-option key={o} value={o}>
                            {o === "true" ? "Yes" : o === "false" ? "No" : o[0].toUpperCase() + o.slice(1)}
                          </s-option>
                        ))}
                      </s-select>
                    ) : (
                      <s-text-field label="Value" labelAccessibilityVisibility="exclusive" details={spec.hint} value={p.value} onInput={(ev: any) => setValueAt(i, String(ev.currentTarget.value))} />
                    )}
                    {pick.length > 1 ? (
                      <s-button variant="tertiary" icon="delete" accessibilityLabel="Remove this condition" onClick={() => setPick((cur) => cur.filter((_, j) => j !== i))} />
                    ) : null}
                  </s-grid>
                );
              })}
              {pick.length < 4 ? (
                <div>
                  <s-button variant="tertiary" icon="plus" onClick={() => setPick((cur) => [...cur, { field: pickFields.find((f) => !cur.some((c) => c.field === f.key))?.key ?? "tag", value: "" }])}>
                    Add a condition
                  </s-button>
                </div>
              ) : null}
            </>
          )}
          <s-checkbox label="Every product in the store" checked={all} onChange={(ev: any) => setAll(!!ev.currentTarget.checked)} />
          {all ? (
            <s-text-field
              label="Type ALL to confirm"
              details="This change is for the whole catalogue. The preview still comes first, and risky rows there start on Skip."
              value={confirmAll}
              onInput={(ev: any) => setConfirmAll(String(ev.currentTarget.value))}
            />
          ) : null}
          {count ? (
            <s-text type="strong">
              {count.exact ? "" : "About "}
              {count.n.toLocaleString("en")} {count.n === 1 ? "product matches" : "products match"}
              {count.n === 0 ? ". Check the spelling: values must match exactly." : ""}
            </s-text>
          ) : (all || chosen.length) && counter.state !== "idle" ? (
            <s-text color="subdued">Counting…</s-text>
          ) : null}
        </s-stack>
      </s-section>

      {fetcher.data?.error && !busy ? (
        <s-banner tone="critical" heading="Not started">
          {fetcher.data.error}
        </s-banner>
      ) : null}

      <div className="bp-actionbar">
        <div>
          <s-text type="strong">Next: a preview of every change</s-text>
          <br />
          <s-text color="subdued">Bulkport reads the products, works out each new value and lists them. The store is not touched.</s-text>
        </div>
        <s-button variant="primary" loading={busy} disabled={busy || (!all && !chosen.length) || (all && confirmAll.trim().toUpperCase() !== "ALL") || count?.n === 0} onClick={() => fetcher.submit({ intent: "start", task: JSON.stringify(input) }, { method: "post" })}>
          Preview changes
        </s-button>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
