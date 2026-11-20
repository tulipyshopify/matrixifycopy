import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { usePolling } from "../components/usePolling";
import { loadEdit, saveEdit } from "../lib/jobs/edit.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { id: params.id!, ...(await loadEdit(session.shop, params.id!)) };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    const job = await saveEdit(session.shop, params.id!, JSON.parse(String(form.get("changes") ?? "[]")));
    return redirect(`/app/jobs/${job.id}`);
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: String(e?.message ?? e) };
  }
};

const PAGE = 100;
const cellKey = (i: number, column: string) => `${i}\u0000${column}`;

export default function EditTable() {
  const data = useLoaderData<typeof loader>();
  const waiting = !data.rows && (data.status === "queued" || data.status === "running");
  usePolling(waiting, 1500);
  const fetcher = useFetcher<{ error?: string }>();
  const rows = data.rows ?? [];
  const columns = data.columns;
  /** Changed cells only: the row's position in the file and its column -> the new value. */
  const [values, setValues] = useState<Record<string, string>>({});
  const [active, setActive] = useState<{ i: number; column: string } | null>(null);
  const [search, setSearch] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [page, setPage] = useState(0);
  const [fill, setFill] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const original = useMemo(() => new Map(rows.flatMap((r) => columns.map((c) => [cellKey(r.i, c.column), r.cells[c.column] ?? ""] as const))), [rows, columns]);
  const value = (i: number, column: string) => values[cellKey(i, column)] ?? original.get(cellKey(i, column)) ?? "";
  const isChanged = (i: number, column: string) => cellKey(i, column) in values;
  const editable = (r: (typeof rows)[number], column: string) => r.top || columns.find((c) => c.column === column)?.level === "variant";
  const set = (i: number, column: string, v: string) =>
    setValues((cur) => {
      const k = cellKey(i, column);
      const next = { ...cur };
      if (v === (original.get(k) ?? "")) delete next[k];
      else next[k] = v;
      return next;
    });

  const changedRows = useMemo(() => new Set(Object.keys(values).map((k) => Number(k.split("\u0000")[0]))), [values]);
  // A product is shown when it or one of its variants matches, so its rows stay together.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q && !onlyChanged) return rows;
    const ids = new Set<string>();
    for (const r of rows) {
      const hit = (!q || `${r.label} ${r.sub} ${columns.map((c) => value(r.i, c.column)).join(" ")}`.toLowerCase().includes(q)) && (!onlyChanged || changedRows.has(r.i));
      if (hit) ids.add(r.id);
    }
    return rows.filter((r) => ids.has(r.id) && (!onlyChanged || changedRows.has(r.i) || r.top));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, onlyChanged, values]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const at = Math.min(page, pages - 1);
  const visible = shown.slice(at * PAGE, at * PAGE + PAGE);
  const cells = Object.keys(values).length;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [active?.i, active?.column]);
  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!cells || fetcher.state !== "idle") return;
    const warn = (ev: BeforeUnloadEvent) => ev.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [cells, fetcher.state]);

  /** Moves to the next cell that can be edited, across the rows shown. */
  const move = (dr: number, dc: number) => {
    if (!active) return;
    let r = shown.findIndex((x) => x.i === active.i);
    let c = columns.findIndex((x) => x.column === active.column);
    for (let guard = 0; guard < shown.length * columns.length + 5; guard++) {
      if (dc) {
        c += dc;
        if (c >= columns.length) (c = 0), r++;
        if (c < 0) (c = columns.length - 1), r--;
      } else r += dr;
      if (r < 0 || r >= shown.length) return;
      if (editable(shown[r], columns[c].column)) {
        setActive({ i: shown[r].i, column: columns[c].column });
        if (Math.floor(r / PAGE) !== at) setPage(Math.floor(r / PAGE));
        return;
      }
    }
  };

  /** Pastes a block copied from a spreadsheet, starting at the active cell. */
  const paste = (text: string) => {
    if (!active) return;
    const block = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
    const r0 = shown.findIndex((x) => x.i === active.i);
    const c0 = columns.findIndex((x) => x.column === active.column);
    setValues((cur) => {
      const next = { ...cur };
      block.forEach((line, dr) => {
        const row = shown[r0 + dr];
        if (!row) return;
        line.forEach((v, dc) => {
          const col = columns[c0 + dc];
          if (!col || !editable(row, col.column)) return;
          const k = cellKey(row.i, col.column);
          if (v === (original.get(k) ?? "")) delete next[k];
          else next[k] = v;
        });
      });
      return next;
    });
  };

  const fillColumn = () => {
    if (!active) return;
    setValues((cur) => {
      const next = { ...cur };
      for (const row of shown) {
        if (!editable(row, active.column)) continue;
        const k = cellKey(row.i, active.column);
        if (fill === (original.get(k) ?? "")) delete next[k];
        else next[k] = fill;
      }
      return next;
    });
  };
  const activeColumn = columns.find((c) => c.column === active?.column);
  const fillCount = active ? shown.filter((r) => editable(r, active.column)).length : 0;

  if (!data.rows) {
    return (
      <s-page heading="Edit in a table" inlineSize="base">
        <s-link slot="breadcrumb-actions" href="/app/edit">
          Choose products
        </s-link>
        {waiting ? (
          <s-section>
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-spinner size="base" accessibilityLabel="Loading" />
              <s-text>Reading the products{data.progress ? ` (${data.progress.toLocaleString("en")} so far)` : ""}… The table opens by itself.</s-text>
            </s-stack>
          </s-section>
        ) : (
          <s-banner tone="critical" heading="The products could not be read">
            {data.error ?? "The job was stopped."} <s-link href="/app/edit">Start again</s-link>
          </s-banner>
        )}
      </s-page>
    );
  }

  return (
    <s-page heading="Edit in a table" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/edit">
        Choose products
      </s-link>
      {data.truncated ? (
        <s-banner tone="warning" heading="Only part of what you chose is in the table">
          <s-text>The table holds up to 1,000 products. The rest are not shown and not changed. Add a condition to work on a smaller group.</s-text>
        </s-banner>
      ) : null}
      {!rows.length ? (
        <s-banner tone="warning" heading="No product matches what you chose">
          <s-link href="/app/edit">Choose again</s-link>
        </s-banner>
      ) : null}
      <s-section padding="none" accessibilityLabel="Products">
        <s-box padding="base">
          <s-stack direction="block" gap="small">
            <s-grid gridTemplateColumns="minmax(180px, 1fr) auto" gap="base" alignItems="end">
              <s-search-field label="Find in the table" labelAccessibilityVisibility="exclusive" placeholder="Find a product, SKU or value" value={search} onInput={(ev: any) => (setSearch(String(ev.currentTarget.value)), setPage(0))} />
              <s-checkbox label={`Only changed rows (${changedRows.size.toLocaleString("en")})`} checked={onlyChanged} onChange={(ev: any) => (setOnlyChanged(!!ev.currentTarget.checked), setPage(0))} />
            </s-grid>
            <s-text color="subdued">
              {data.products.toLocaleString("en")} products, {rows.length.toLocaleString("en")} rows{shown.length !== rows.length ? ` · ${shown.length.toLocaleString("en")} shown` : ""}. Click a cell to change it. Enter moves down, Tab moves right, Esc puts the cell back. Paste from Excel or Google Sheets fills from the cell you are in.
            </s-text>
            {active && activeColumn ? (
              <div className="bp-grid-fill">
                <label>
                  Set <b>{activeColumn.label}</b> for all {fillCount.toLocaleString("en")} rows shown to
                  <input value={fill} onChange={(ev) => setFill(ev.currentTarget.value)} placeholder="value (empty clears)" />
                </label>
                <s-button onClick={fillColumn} disabled={!fillCount}>
                  Fill column
                </s-button>
              </div>
            ) : null}
          </s-stack>
        </s-box>
        <div className="bp-grid-wrap">
          <table className="bp-grid">
            <thead>
              <tr>
                <th className="bp-grid-name">Product</th>
                {columns.map((c) => (
                  <th key={c.column} title={c.hint} className={active?.column === c.column ? "bp-grid-colon" : ""}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.i} className={r.top ? "bp-grid-top" : ""}>
                  <th className="bp-grid-name" scope="row">
                    {r.label ? <b>{r.label}</b> : null}
                    <span>{r.sub}</span>
                  </th>
                  {columns.map((c) => {
                    const can = editable(r, c.column);
                    const on = active?.i === r.i && active.column === c.column;
                    const v = value(r.i, c.column);
                    if (!can) return <td key={c.column} className="bp-grid-na" aria-label="Set on the product's first row" />;
                    return (
                      <td key={c.column} className={`${isChanged(r.i, c.column) ? "bp-grid-changed" : ""}${on ? " bp-grid-on" : ""}`} onClick={() => (on ? null : (setActive({ i: r.i, column: c.column }), setFill(v)))}>
                        {on ? (
                          <input
                            ref={input}
                            aria-label={`${c.label}, ${r.label || r.sub}`}
                            value={v}
                            onChange={(ev) => set(r.i, c.column, ev.currentTarget.value)}
                            onPaste={(ev) => {
                              const text = ev.clipboardData.getData("text");
                              if (!/[\t\n]/.test(text.replace(/\n$/, ""))) return;
                              ev.preventDefault();
                              paste(text);
                            }}
                            onKeyDown={(ev) => {
                              if (ev.key === "Enter") (ev.preventDefault(), move(ev.shiftKey ? -1 : 1, 0));
                              else if (ev.key === "Tab") (ev.preventDefault(), move(0, ev.shiftKey ? -1 : 1));
                              else if (ev.key === "ArrowDown") (ev.preventDefault(), move(1, 0));
                              else if (ev.key === "ArrowUp") (ev.preventDefault(), move(-1, 0));
                              else if (ev.key === "Escape") {
                                ev.preventDefault();
                                set(r.i, c.column, original.get(cellKey(r.i, c.column)) ?? "");
                                setActive(null);
                              }
                            }}
                          />
                        ) : (
                          <span title={isChanged(r.i, c.column) ? `Was: ${original.get(cellKey(r.i, c.column)) || "(empty)"}` : undefined}>{v}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 ? (
          <s-box padding="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button disabled={at === 0} onClick={() => setPage(at - 1)}>
                Previous
              </s-button>
              <s-text>
                Rows {(at * PAGE + 1).toLocaleString("en")} to {Math.min(shown.length, at * PAGE + PAGE).toLocaleString("en")} of {shown.length.toLocaleString("en")}
              </s-text>
              <s-button disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
                Next
              </s-button>
            </s-stack>
          </s-box>
        ) : null}
      </s-section>

      {fetcher.data?.error && fetcher.state === "idle" ? (
        <s-banner tone="critical" heading="The preview could not be started">
          {fetcher.data.error}
        </s-banner>
      ) : null}

      <div className="bp-actionbar">
        <div>
          <s-text type="strong">{cells ? `${cells.toLocaleString("en")} cell${cells === 1 ? "" : "s"} changed in ${changedRows.size.toLocaleString("en")} row${changedRows.size === 1 ? "" : "s"}` : "Nothing changed yet"}</s-text>
          <br />
          <s-text color="subdued">Changed cells are marked. Nothing reaches the store until you have seen the preview and applied it.</s-text>
        </div>
        <s-stack direction="inline" gap="small">
          {cells ? (
            <s-button disabled={fetcher.state !== "idle"} onClick={() => (setValues({}), setActive(null))}>
              Discard changes
            </s-button>
          ) : null}
          <s-button
            variant="primary"
            loading={fetcher.state !== "idle"}
            disabled={!cells || fetcher.state !== "idle"}
            onClick={() =>
              fetcher.submit(
                {
                  changes: JSON.stringify(
                    Object.entries(values).map(([k, v]) => {
                      const [i, column] = k.split("\u0000");
                      return { i: Number(i), column, value: v };
                    }),
                  ),
                },
                { method: "post" },
              )
            }
          >
            Preview changes
          </s-button>
        </s-stack>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
