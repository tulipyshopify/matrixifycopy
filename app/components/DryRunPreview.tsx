import { Fragment, useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import type { PartialPreview, PreviewItem } from "../lib/core/importer";
import type { EditableRows } from "../lib/jobs/fix.server";
import type { ApplyConfirm, ApplyNeeds, PreviewKind, PreviewSheet } from "../lib/jobs/jobs.server";

type Tone = "success" | "info" | "critical" | "warning" | "neutral";
const ACTIONS: Record<PreviewItem["action"], { label: string; tone: Tone }> = {
  // Amber, not green: a create or a replace is worth a second look.
  create: { label: "Create", tone: "warning" },
  update: { label: "Update", tone: "info" },
  replace: { label: "Delete and re-create", tone: "critical" },
  delete: { label: "Delete", tone: "critical" },
  none: { label: "No change", tone: "neutral" },
  failed: { label: "Can't apply", tone: "critical" },
  skipped: { label: "Skipped", tone: "neutral" },
};
const actionOf = (a: string) => ACTIONS[a as PreviewItem["action"]] ?? { label: a || "Unknown", tone: "neutral" as Tone };

/** Same rule as the server's previewKind (kept here so the page needs no server code). */
function kindOf(i: PreviewItem): PreviewKind {
  if (i.action === "failed" || i.action === "skipped") return "failed";
  if (i.action === "none") return "none";
  if (i.action === "delete" || i.action === "replace" || i.deletes) return "delete";
  if (i.action === "create") return "create";
  if (i.warnings?.length || i.clears?.length) return "look";
  return "update";
}
const RISKY = new Set<PreviewKind>(["delete", "create", "look"]);

const FILTERS: Array<{ key: "all" | PreviewKind | "changes"; label: string }> = [
  { key: "all", label: "All" },
  { key: "changes", label: "Changes" },
  { key: "look", label: "Need a look" },
  { key: "create", label: "Creates" },
  { key: "delete", label: "Deletes" },
  { key: "failed", label: "Can't apply" },
  { key: "none", label: "No change" },
];
type FilterKey = (typeof FILTERS)[number]["key"];
const matches = (f: FilterKey, k: PreviewKind) => f === "all" || f === k || (f === "changes" && k !== "none" && k !== "failed");

/** Data types whose imports keep an undo record (the server's UNDOABLE_TYPES; kept here so the page needs no server code). */
const UNDOABLE = new Set(["products", "customers", "companies", "smart_collections", "custom_collections", "orders", "draft_orders", "pages", "blog_posts", "redirects"]);
const PAGE = 50;
/** Change lines shown per item before "Show all". */
const LINES = 12;
const n = (x: number) => x.toLocaleString("en");
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

/** A change line: the store's value struck against the new one when it has the form "label: old → new". */
function ChangeLine({ text }: { text: string }) {
  const m = /^(.*?): (.*) → (.*)$/s.exec(text);
  if (!m) return <s-text>{text}</s-text>;
  return (
    <s-text>
      <span className="bp-diff-label">{m[1]}:</span> <span className={/^\(.*\)$/.test(m[2]) ? "bp-diff-label" : "bp-diff-old"}>{m[2]}</span> <span aria-hidden>→</span>{" "}
      <span className={/\(cleared|\(deleted|\(removed/.test(m[3]) ? "bp-diff-new bp-diff-gone" : "bp-diff-new"}>{m[3]}</span>
    </s-text>
  );
}

const undoUntil = (days: number) => new Date(Date.now() + days * 86400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Where an import is in its three steps. */
export function ImportSteps({ step }: { step: 1 | 2 | 3 }) {
  const steps = ["File and settings", "Preview changes", "Confirm and apply"];
  return (
    <div className="bp-stepper" role="list" aria-label="Import steps">
      {steps.map((label, i) => (
        <div key={label} role="listitem" className={`bp-stp${i + 1 === step ? " bp-stp-on" : ""}${i + 1 < step ? " bp-stp-done" : ""}`} aria-current={i + 1 === step ? "step" : undefined}>
          <span className="bp-stp-n">{i + 1 < step ? "✓" : i + 1}</span>
          {label}
        </div>
      ))}
    </div>
  );
}

type RowAnswer = { rows?: EditableRows; rowError?: string; fixed?: { sheet: string; row: number; actions: string[]; message: string } };

/**
 * Corrects one item's cells right in the preview: its rows are loaded from
 * the file, changed cells are saved beside the preview (never in the file),
 * and just this item is checked against the store again.
 */
function RowEditor({ sheet, item, onClose }: { sheet: string; item: PreviewItem; onClose: () => void }) {
  const loadRows = useFetcher<RowAnswer>();
  const save = useFetcher<RowAnswer>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [allColumns, setAllColumns] = useState(false);
  useEffect(() => {
    loadRows.submit({ intent: "row", sheet, row: String(item.row) }, { method: "post" });
    // Loaded once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const data = loadRows.data?.rows;
  const saving = save.state !== "idle";
  const done = save.state === "idle" && save.data?.fixed;
  useEffect(() => {
    if (!done) return;
    const still = save.data!.fixed!.actions.includes("failed");
    (globalThis as any).shopify?.toast?.show(still ? "Checked again: this row still has a problem" : "Checked again: the row is fine now");
    if (!still) onClose();
    else {
      // Show the row as it is now saved, with what is still wrong.
      setValues({});
      loadRows.submit({ intent: "row", sheet, row: String(item.row) }, { method: "post" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  if (loadRows.data?.rowError) {
    return (
      <div className="bp-edit">
        <s-text tone="critical">{loadRows.data.rowError}</s-text>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="bp-edit">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-spinner size="base" accessibilityLabel="Loading" />
          <s-text color="subdued">Reading this row from the file…</s-text>
        </s-stack>
      </div>
    );
  }
  const text = [item.message, ...(item.errors ?? []), ...(item.warnings ?? []), ...item.changes].join("\n").toLowerCase();
  // The columns worth showing first: keys, cells with a value, and any column a problem or change names.
  const relevant = data.headers.filter((h) => data.keyColumns.includes(h) || h === "Command" || data.rows.some((r) => r.cells[h] !== "") || text.includes(h.toLowerCase()));
  const columns = allColumns ? data.headers : relevant;
  const id = (index: number, h: string) => `${index}\u0000${h}`;
  const changed = Object.entries(values).filter(([k, v]) => {
    const [index, h] = k.split("\u0000");
    return data.rows.find((r) => String(r.index) === index)?.cells[h] !== v;
  });
  const wasEdited = data.rows.some((r) => r.edited.length);
  const edit = (index: number, h: string, value: string) => setValues((c) => ({ ...c, [id(index, h)]: value }));
  // A cell is marked when a problem names its column (and, where the problem says which row, its row).
  const problems = [item.message, ...(item.errors ?? [])].filter(Boolean).map((e) => e.toLowerCase());
  const named = (h: string, rowNumber: number) =>
    problems.some((e) => {
      const at = /^row (\d+)/.exec(e);
      if (at && Number(at[1]) !== rowNumber) return false;
      const c = h.toLowerCase();
      return e.includes(`"${c}"`) || e.includes(`${c}:`) || e.includes(` ${c} `);
    });
  return (
    <div className="bp-edit">
      {data.rows.map((r) => (
        <div key={r.index} className="bp-edit-row">
          {data.rows.length > 1 ? <div className="bp-edit-n">Row {r.number}</div> : null}
          <div className="bp-edit-grid">
            {columns.map((h) => {
              const v = values[id(r.index, h)] ?? r.cells[h];
              const long = v.length > 60 || v.includes("\n");
              const cls = `bp-edit-cell${long ? " bp-edit-wide" : ""}${kindOf(item) === "failed" && named(h, r.number) ? " bp-edit-flag" : ""}${r.edited.includes(h) || (values[id(r.index, h)] !== undefined && values[id(r.index, h)] !== r.cells[h]) ? " bp-edit-changed" : ""}`;
              return (
                <label key={h} className={cls}>
                  <span>{h}</span>
                  {long ? (
                    <textarea rows={3} value={v} disabled={saving} onChange={(ev) => edit(r.index, h, ev.currentTarget.value)} />
                  ) : (
                    <input type="text" value={v} disabled={saving} onChange={(ev) => edit(r.index, h, ev.currentTarget.value)} />
                  )}
                </label>
              );
            })}
          </div>
        </div>
      ))}
      {save.data?.rowError && !saving ? <s-text tone="critical">✕ {save.data.rowError}</s-text> : null}
      {save.data?.fixed?.message && !saving && !changed.length ? <s-text tone="critical">✕ Still a problem: {save.data.fixed.message}</s-text> : null}
      <div className="bp-edit-bar">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-button
            variant="primary"
            loading={saving && save.formData?.get("intent") === "fix"}
            disabled={saving || !changed.length}
            onClick={() =>
              save.submit(
                {
                  intent: "fix",
                  sheet,
                  row: String(item.row),
                  fixes: JSON.stringify(
                    changed.map(([k, value]) => {
                      const [index, column] = k.split("\u0000");
                      return { index: Number(index), column, value };
                    }),
                  ),
                },
                { method: "post" },
              )
            }
          >
            Save and check again
          </s-button>
          <s-button disabled={saving} onClick={onClose}>
            Cancel
          </s-button>
          {wasEdited ? (
            <s-button variant="tertiary" loading={saving && save.formData?.get("intent") === "unfix"} disabled={saving} onClick={() => save.submit({ intent: "unfix", sheet, row: String(item.row) }, { method: "post" })}>
              Back to the file's values
            </s-button>
          ) : null}
        </s-stack>
        {data.headers.length > relevant.length ? (
          <s-link onClick={() => setAllColumns(!allColumns)}>{allColumns ? "Show fewer columns" : `Show all ${n(data.headers.length)} columns`}</s-link>
        ) : null}
      </div>
      <s-text color="subdued">Only this item is checked again, against the store as it is now. Your file is not changed: the correction is kept with this preview and used when you apply it. An empty box means an empty cell.</s-text>
    </div>
  );
}

/**
 * While a preview is still running: the first rows it has checked, so a wrong
 * file or a wrong column shows within seconds instead of at the end.
 */
export function FirstLook({ sheets, timing }: { sheets: PartialPreview[]; timing?: string }) {
  const checked = sheets.reduce((x, s) => x + s.checked, 0);
  const total = sheets.reduce((x, s) => x + s.total, 0);
  const failed = sheets.reduce((x, s) => x + s.failed, 0);
  const shown = sheets.reduce((x, s) => x + s.items.length, 0);
  if (!shown) return null;
  const left = /about (.+) left/.exec(timing ?? "")?.[1];
  // Most of what was checked so far can't be applied: probably the wrong file or column, worth stopping for.
  const bad = checked >= 10 && failed / checked > 0.5;
  return (
    <s-section heading={`First look: ${n(checked)} of ${n(total)} checked so far`} padding="none">
      <s-box padding="base">
        <s-stack direction="block" gap="small">
          <s-text color="subdued">
            These are the first rows of the file. The rest is still being checked{left ? `, about ${left} to go` : ""}; choosing what to include comes when it has finished.
          </s-text>
          {bad ? (
            <s-banner tone="warning" heading={`${n(failed)} of the first ${n(checked)} can't be applied`}>
              <s-text>If the reasons below point to the wrong file or a wrong column, stop the preview now, fix the file and start again. Otherwise let it finish: single rows can be corrected on this page afterwards.</s-text>
            </s-banner>
          ) : null}
          {sheets.flatMap((s) => (s.warnings ?? []).slice(0, 4).map((w, k) => (
            <s-text key={`${s.sheet}${k}`} tone="caution">
              ! {sheets.length > 1 ? `${s.sheet}: ` : ""}{w}
            </s-text>
          )))}
        </s-stack>
      </s-box>
      {sheets.map((s) =>
        s.items.length ? (
          <Fragment key={s.sheet}>
            {sheets.length > 1 ? (
              <s-box padding="small base">
                <s-heading>{s.sheet}</s-heading>
              </s-box>
            ) : null}
            <div className="bp-rows" role="list">
              {s.items.slice(0, 50).map((i) => {
                const kind = kindOf(i);
                const a = actionOf(i.action);
                const errors = i.errors?.length ? i.errors : kind === "failed" ? [i.message || "Can't be applied"] : [];
                return (
                  <div key={`${i.row}${i.key ?? ""}`} role="listitem" className={`bp-row bp-row-${kind}`}>
                    <div className="bp-row-n">{i.row}</div>
                    <div className="bp-row-item">
                      <s-text type="strong">{i.title || i.item.replace(/^[A-Za-z ]+: /, "")}</s-text>
                      <s-text color="subdued">{i.title ? i.item : i.item.split(":")[0]}</s-text>
                    </div>
                    <div className="bp-row-what">
                      {errors.map((e, k) => (
                        <s-text key={`e${k}`} tone="critical">
                          ✕ {e}
                        </s-text>
                      ))}
                      {kind === "failed" ? null : i.changes.slice(0, 6).map((c, k) => <ChangeLine key={k} text={c} />)}
                      {kind !== "failed" && i.changes.length > 6 ? <s-text color="subdued">…and {n(i.changes.length - 6)} more changes</s-text> : null}
                      {(i.warnings ?? []).map((w, k) => (
                        <s-text key={`w${k}`} tone="caution">
                          ! {w}
                        </s-text>
                      ))}
                      {!errors.length && !i.changes.length ? <s-text color="subdued">{kind === "none" ? "Same as the store" : i.message || "—"}</s-text> : null}
                    </div>
                    <div className="bp-row-do">
                      <s-badge tone={a.tone}>{a.label}</s-badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </Fragment>
        ) : null,
      )}
    </s-section>
  );
}

const SEGMENTS: Array<{ kind: PreviewKind; label: (x: number) => string }> = [
  { kind: "none", label: (x) => `${n(x)} no change` },
  { kind: "update", label: (x) => `${n(x)} will update` },
  { kind: "look", label: (x) => `${n(x)} need a look` },
  { kind: "create", label: (x) => `${n(x)} would create` },
  { kind: "delete", label: (x) => `${n(x)} would delete` },
  { kind: "failed", label: (x) => `${n(x)} can't be applied` },
];

/**
 * A preview and the way from it to a real import, on one page: the whole
 * file in one bar, every item with what would change, an Include or Skip for
 * everything risky (which starts as Skip), and a last summary before anything
 * is applied.
 */
export function ImportReview({
  sheets,
  needs,
  canApply,
  busy,
  undoDays = 90,
  onImport,
  editedRows = 0,
  error,
}: {
  /** Why the last try to apply was refused: shown where the button is. */
  error?: string;
  /** The preview's job (rows are corrected against it). */
  jobId?: string;
  /** Rows of the file carrying corrections made on this page. */
  editedRows?: number;
  sheets: PreviewSheet[];
  needs: ApplyNeeds;
  canApply: boolean;
  busy: boolean;
  /** How long an import's undo record is kept. */
  undoDays?: number;
  onImport: (confirm: ApplyConfirm) => void;
}) {
  const all = useMemo(() => sheets.flatMap((s) => s.items.map((i) => ({ sheet: s.sheet, item: i, kind: kindOf(i), id: `${s.sheet}\u0000${i.key ?? i.row}` }))), [sheets]);
  const listed = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of all) c[x.kind] = (c[x.kind] ?? 0) + 1;
    return c;
  }, [all]);
  // Totals cover every item; the list may hold only the first 1,000 of a sheet.
  const totals: Record<PreviewKind, number> = {
    none: Math.max(needs.unchanged, listed.none ?? 0),
    failed: Math.max(needs.failing, listed.failed ?? 0),
    create: Math.max(needs.creates, listed.create ?? 0),
    delete: Math.max(needs.deletes, listed.delete ?? 0),
    look: Math.max(listed.look ?? 0, 0),
    update: 0,
  };
  totals.update = Math.max(0, needs.changes - totals.create - totals.delete - totals.look);
  const unlistedRisky = Math.max(0, totals.create - (listed.create ?? 0)) + Math.max(0, totals.delete - (listed.delete ?? 0)) + Math.max(0, needs.clearing + needs.warned > 0 && all.length >= 1000 ? Math.max(needs.clearing, needs.warned) - (listed.look ?? 0) : 0);
  const rowsChecked = totals.none + totals.failed + totals.create + totals.delete + totals.look + totals.update;

  // Risky items start as Skip: including one is a deliberate act.
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<FilterKey>(listed.failed ? "all" : "all");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /** The row being corrected, by its sheet and row number. */
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [rest, setRest] = useState(false);

  // Plain updates are included unless set to Skip; risky rows are skipped unless set to Include.
  const isOn = (x: { id: string; kind: PreviewKind }) => included[x.id] ?? x.kind === "update";
  const risky = all.filter((x) => RISKY.has(x.kind));
  const inc = risky.filter(isOn);
  const updatesOff = all.filter((x) => x.kind === "update" && !isOn(x));
  const skipped = risky.length - inc.length + updatesOff.length;
  const count = (k: PreviewKind) => inc.filter((x) => x.kind === k).length;
  const updating = totals.update - updatesOff.length;
  const applying = updating + inc.length + (rest ? unlistedRisky : 0);
  const deletesIncluded = count("delete") + (rest ? Math.max(0, totals.delete - (listed.delete ?? 0)) : 0);
  const setAll = (kind: PreviewKind, on: boolean) => setIncluded((cur) => ({ ...cur, ...Object.fromEntries(risky.filter((x) => x.kind === kind).map((x) => [x.id, on])) }));

  const submit = () => {
    const group = (list: typeof risky) => {
      const out: Record<string, string[]> = {};
      for (const x of list) if (x.item.key) (out[x.sheet] ??= []).push(x.item.key);
      return out;
    };
    onImport({ exclude: group([...risky.filter((x) => !isOn(x)), ...updatesOff]), include: group(inc), deletes: typed, rest });
  };

  // Sheets with something to apply, and those whose data type keeps no undo record.
  const changingSheets = sheets.filter((sh) => sh.items.some((i) => i.action !== "none" && i.action !== "failed" && i.action !== "skipped"));
  // Named by what they hold ("discounts"), not by the file's name.
  const noUndo = [...new Set(changingSheets.filter((sh) => !UNDOABLE.has(sh.entity ?? "")).map((sh) => (sh.entity ?? sh.sheet).replace(/_/g, " ")))];
  const compared = all.some((x) => x.item.compared);
  const firstStep = all.some((x) => !x.item.compared && x.item.changes.length && x.kind !== "failed");
  const sheetNotes = sheets.filter((s) => s.warnings?.length);
  // Rows that need a decision or a fix first, then the rest in file order.
  const order: Record<PreviewKind, number> = { failed: 1, delete: 0, look: 0, create: 0, update: 2, none: 3 };

  return (
    <>
      <s-section>
        <s-stack direction="block" gap="small">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
            <s-heading>{plural(rowsChecked, "item")} checked</s-heading>
            <s-text color="subdued">Click a part of the bar to filter</s-text>
          </s-stack>
          <div className="bp-bar" role="group" aria-label="What the file would do">
            {SEGMENTS.filter((seg) => totals[seg.kind] > 0).map((seg) => (
              <button
                key={seg.kind}
                type="button"
                className={`bp-bar-seg bp-kind-${seg.kind}${filter === seg.kind ? " bp-bar-on" : ""}`}
                style={{ flexGrow: Math.max(totals[seg.kind], rowsChecked * 0.04) }}
                title={seg.label(totals[seg.kind])}
                onClick={() => {
                  setFilter(filter === seg.kind ? "all" : seg.kind);
                  setShown(PAGE);
                }}
              >
                {n(totals[seg.kind])}
              </button>
            ))}
          </div>
          <div className="bp-legend">
            {SEGMENTS.filter((seg) => totals[seg.kind] > 0).map((seg) => (
              <span key={seg.kind}>
                <i className={`bp-dot bp-kind-${seg.kind}`} /> {seg.label(totals[seg.kind])}
              </span>
            ))}
          </div>
        </s-stack>
      </s-section>

      {sheetNotes.map((s) => (
        <s-banner key={s.sheet} tone={s.entity === null ? "critical" : "warning"} heading={s.entity === null ? `Sheet "${s.sheet}" is not imported` : `About sheet "${s.sheet}"`}>
          <s-stack direction="block" gap="small-300">
            {s.warnings!.slice(0, 12).map((w, k) => (
              <s-text key={k}>{w.replace(/^Not imported: /, "It was ")}</s-text>
            ))}
            {s.warnings!.length > 12 ? <s-text color="subdued">…and {n(s.warnings!.length - 12)} more notes, listed in the job log.</s-text> : null}
          </s-stack>
        </s-banner>
      ))}

      {all.length ? (
        <s-section padding="none">
          <s-box padding="base">
            <s-stack direction="inline" gap="small" justifyContent="space-between" alignItems="center">
              <div className="bp-tabs" role="tablist">
                {FILTERS.filter((f) => f.key === "all" || all.some((x) => matches(f.key, x.kind))).map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    role="tab"
                    aria-selected={filter === f.key}
                    className={`bp-tab${filter === f.key ? " bp-tab-on" : ""}`}
                    onClick={() => {
                      setFilter(f.key);
                      setShown(PAGE);
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <s-text color="subdued">Rows that need a look come first</s-text>
            </s-stack>
          </s-box>
          {sheets.map((s) => {
            const items = all
              .filter((x) => x.sheet === s.sheet && matches(filter, x.kind))
              .sort((a, b) => order[a.kind] - order[b.kind] || a.item.row - b.item.row);
            if (!items.length) return null;
            const riskyHere = (["look", "create", "delete"] as PreviewKind[]).filter((k) => (filter === k || filter === "all" || filter === "changes") && items.some((x) => x.kind === k));
            return (
              <Fragment key={s.sheet}>
                {sheets.length > 1 ? (
                  <s-box padding="small base">
                    <s-heading>{s.sheet}</s-heading>
                  </s-box>
                ) : null}
                {canApply && riskyHere.length && items.filter((x) => RISKY.has(x.kind)).length > 3 ? (
                  <s-box padding="none base small base">
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-text color="subdued">All at once:</s-text>
                      {riskyHere.map((k) => {
                        const on = items.filter((x) => x.kind === k).every(isOn);
                        return (
                          <s-button key={k} variant="tertiary" onClick={() => setAll(k, !on)}>
                            {on ? "Skip" : "Include"} every {k === "look" ? "warning" : k}
                          </s-button>
                        );
                      })}
                    </s-stack>
                  </s-box>
                ) : null}
                <div className="bp-rows" role="list">
                  {items.slice(0, shown).map(({ item: i, kind, id }) => {
                    const a = actionOf(i.action);
                    const errors = i.errors?.length ? i.errors : kind === "failed" ? [i.message || "Can't be applied"] : [];
                    const on = isOn({ id, kind });
                    return (
                      <div key={id} role="listitem" className={`bp-row bp-row-${kind}${(RISKY.has(kind) || kind === "update") && !on ? " bp-row-off" : ""}`}>
                        <div className="bp-row-n" title="Row in the sheet (the header is row 1)">
                          {i.row}
                        </div>
                        <div className="bp-row-item">
                          <s-text type="strong">{i.title || i.item.replace(/^[A-Za-z ]+: /, "")}</s-text>
                          <s-text color="subdued">{i.title ? i.item : i.item.split(":")[0]}</s-text>
                        </div>
                        <div className="bp-row-what">
                          {errors.map((e, k) => (
                            <s-text key={`e${k}`} tone="critical">
                              ✕ {e}
                            </s-text>
                          ))}
                          {kind === "failed" ? null : (open[id] ? i.changes : i.changes.slice(0, LINES)).map((c, k) => <ChangeLine key={k} text={c} />)}
                          {kind !== "failed" && i.changes.length > LINES && !open[id] ? (
                            <s-link onClick={() => setOpen((cur) => ({ ...cur, [id]: true }))}>Show all {n(i.changes.length)} changes</s-link>
                          ) : null}
                          {(i.warnings ?? []).map((w, k) => (
                            <s-text key={`w${k}`} tone="caution">
                              ! {w}
                            </s-text>
                          ))}
                          {kind === "create" ? <s-text tone="caution">+ Nothing in the store has this handle or ID. Check for a typo before including it.</s-text> : null}
                          {!errors.length && !i.changes.length ? <s-text color="subdued">{kind === "none" ? "Same as the store" : i.message || "—"}</s-text> : null}
                          {i.edited ? <s-text color="subdued">✎ Corrected on this page. The file itself is unchanged; the import uses the corrected values.</s-text> : null}
                          {canApply && i.action !== "skipped" ? (
                            <div>
                              <s-button variant={kind === "failed" ? "secondary" : "tertiary"} icon="edit" onClick={() => setEditing(editing === `${s.sheet}\u0000${i.row}` ? null : `${s.sheet}\u0000${i.row}`)}>
                                {kind === "failed" ? "Fix this row" : "Edit row"}
                              </s-button>
                            </div>
                          ) : null}
                        </div>
                        <div className="bp-row-do">
                          {(RISKY.has(kind) || kind === "update") && canApply ? (
                            <div className="bp-choice" role="group" aria-label={`${i.item}: include or skip`}>
                              <button type="button" className={on ? "bp-choice-on" : ""} aria-pressed={on} onClick={() => setIncluded((c) => ({ ...c, [id]: true }))}>
                                {kind === "delete" ? "Delete" : kind === "create" ? "Create" : kind === "update" ? "Update" : "Include"}
                              </button>
                              <button type="button" className={!on ? "bp-choice-on" : ""} aria-pressed={!on} onClick={() => setIncluded((c) => ({ ...c, [id]: false }))}>
                                Skip
                              </button>
                            </div>
                          ) : (
                            <s-badge tone={a.tone}>{a.label}</s-badge>
                          )}
                        </div>
                        {editing === `${s.sheet}\u0000${i.row}` ? <RowEditor sheet={s.sheet} item={i} onClose={() => setEditing(null)} /> : null}
                      </div>
                    );
                  })}
                </div>
                {items.length > shown ? (
                  <s-box padding="base">
                    <s-button variant="tertiary" onClick={() => setShown(shown + PAGE)}>
                      Show {Math.min(PAGE, items.length - shown)} more of {n(items.length)}
                    </s-button>
                  </s-box>
                ) : null}
              </Fragment>
            );
          })}
          <s-box padding="base">
            <s-stack direction="block" gap="small-300">
              {all.length >= 1000 ? (
                <s-text color="subdued">The list holds 1,000 items of each sheet, the ones with problems or warnings first. The bar counts every item, and the results file has every row.</s-text>
              ) : null}
              {editedRows ? (
                <s-text color="subdued">
                  {plural(editedRows, "row")} of the file {editedRows === 1 ? "was" : "were"} corrected on this page. Your file is not changed; the import uses the corrected values, and the log below lists each correction.
                </s-text>
              ) : null}
              {compared ? (
                <s-text color="subdued">
                  Each line is one field: its value in the store now, then its value after the import. Fields that already match the file are not listed and are not touched. The number on the left is the row in your sheet, counting the header as row 1.
                </s-text>
              ) : null}
              {firstStep ? (
                <s-text color="subdued">Items marked "First step" belong to a data type that is not compared with the store field by field: the details show the values the first step would send (an item can need more than one step); the real import makes all of them.</s-text>
              ) : null}
            </s-stack>
          </s-box>
        </s-section>
      ) : null}

      {canApply && needs.changes > 0 && confirming ? (
        <s-section heading={`Apply ${plural(applying, "change")} to your store?`}>
          <s-stack direction="block" gap="base">
            <div className="bp-sum">
              <div><b>{n(updating)}</b><s-badge tone="info">Update</s-badge><span>items changed as shown in the preview</span></div>
              {count("look") ? <div><b>{n(count("look"))}</b><s-badge tone="warning">Accepted warning</s-badge><span>{inc.filter((x) => x.kind === "look").slice(0, 3).map((x) => x.item.title || x.item.item).join("; ")}{count("look") > 3 ? "…" : ""}</span></div> : null}
              {totals.create ? <div><b>{n(count("create"))}</b><s-badge tone="warning">Create</s-badge><span>{count("create") ? "new items, as drafts unless the file says otherwise" : `${plural(totals.create, "possible new item")} not included`}</span></div> : null}
              {totals.delete ? <div><b>{n(count("delete"))}</b><s-badge tone="critical">Delete</s-badge><span>{count("delete")
                ? inc
                    .filter((x) => x.kind === "delete")
                    .slice(0, 3)
                    // A row that removes part of an item (a variant) keeps the item: say what goes, not the item's name alone.
                    .map((x) => (x.item.action === "delete" || x.item.action === "replace" ? x.item.title || x.item.item : `${x.item.deletes} ${x.sheet === "Products" || /products/i.test(x.sheet) ? (x.item.deletes === 1 ? "variant" : "variants") : x.item.deletes === 1 ? "part" : "parts"} of ${x.item.title || x.item.item} (the item itself stays)`))
                    .join("; ")
                : `${plural(totals.delete, "deletion")} not included`}</span></div> : null}
              <div><b>{n(totals.failed + skipped)}</b><s-badge>Skipped</s-badge><span>{[totals.failed ? `${n(totals.failed)} can't be applied` : "", skipped ? `${n(skipped)} you skipped` : ""].filter(Boolean).join(", ") || "nothing"}</span></div>
            </div>
            {unlistedRisky ? (
              <s-checkbox
                label={`Also apply ${plural(unlistedRisky, "more item")} that would create, delete or empty something`}
                details="This file is too large for the preview to list them one by one. Leave unticked to skip them; the results file of this preview shows each."
                checked={rest}
                onChange={(ev: any) => setRest(!!ev.currentTarget.checked)}
              />
            ) : null}
            {deletesIncluded ? (
              <s-banner tone="critical" heading={`This permanently deletes ${plural(deletesIncluded, "item")}`}>
                <s-stack direction="block" gap="small">
                  <s-text>
                    A deleted item can't be brought back from here. <s-link href="/app/backups">Make a backup first</s-link> if you don't have a recent one.
                  </s-text>
                  <s-text-field label="Type DELETE to confirm the deletions" value={typed} onInput={(ev: any) => setTyped(ev.currentTarget.value)} />
                </s-stack>
              </s-banner>
            ) : null}
            {noUndo.length ? (
              <s-banner tone="warning" heading={`No undo for ${noUndo.join(", ")}`}>
                <s-text>Imports of {noUndo.join(", ")} are not recorded for undo: what they change can only be put back by hand, or from a backup that includes them. {changingSheets.some((sh) => UNDOABLE.has(sh.entity ?? "")) ? "The other sheets in this file can be undone as described below." : ""}</s-text>
              </s-banner>
            ) : null}
            {changingSheets.length && !changingSheets.some((sh) => UNDOABLE.has(sh.entity ?? "")) ? null : (
            <s-banner tone={deletesIncluded && deletesIncluded >= applying ? "warning" : "success"} heading={deletesIncluded && deletesIncluded >= applying ? `Deleted items can be created again until ${undoUntil(undoDays)}, not truly restored` : `You can undo this until ${undoUntil(undoDays)}`}>
              <s-text>
                What each item looked like is recorded before it is changed (undo removes new products; other new items, such as customers or pages, have to be removed by hand), and kept on Bulkport's server for {undoDays} days. "Undo this import" on the job's page then opens a preview of putting it back.
                {deletesIncluded ? " Undoing a deletion creates the item again from that record: it gets a new ID, and what Shopify ties to the old one (a product's sales history and reviews, a customer's orders) does not come back." : ""}
              </s-text>
            </s-banner>
            )}
            <s-text color="subdued">
              Each item is checked against the store once more as it is applied: anything changed since this preview is left alone and reported. Items that already match the store are not touched.
            </s-text>
            {error ? (
              <s-banner tone="critical" heading="Not applied">
                {error}
              </s-banner>
            ) : null}
            <s-stack direction="inline" gap="small" justifyContent="end">
              <s-button onClick={() => setConfirming(false)}>Back to preview</s-button>
              <s-button variant="primary" tone={deletesIncluded ? "critical" : undefined} loading={busy} disabled={busy || applying <= 0 || (deletesIncluded > 0 && typed.trim().toUpperCase() !== "DELETE")} onClick={submit}>
                Apply {plural(applying, "change")}
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ) : null}

      {canApply && !confirming ? (
        <div className="bp-actionbar">
          <div>
            <s-text type="strong">{needs.changes ? `${plural(applying, "change")} will be applied` : "Nothing to import"}</s-text>
            <br />
            <s-text color="subdued">
              {needs.changes
                ? [
                    `${n(updating)} ${updating === 1 ? "update" : "updates"}`,
                    count("look") ? `${n(count("look"))} accepted ${count("look") === 1 ? "warning" : "warnings"}` : "",
                    count("create") ? `${n(count("create"))} ${count("create") === 1 ? "create" : "creates"}` : "",
                    count("delete") ? `${n(count("delete"))} ${count("delete") === 1 ? "deletion" : "deletions"}` : "",
                    skipped ? `${n(skipped)} set to Skip` : "",
                    totals.failed ? `${n(totals.failed)} can't be applied` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : totals.failed
                  ? `${plural(totals.failed, "item")} can't be applied and ${plural(totals.none, "item")} already match the store.`
                  : `Every item already matches the store (${plural(totals.none, "item")} checked).`}
            </s-text>
          </div>
          <s-button variant="primary" disabled={applying <= 0 || !needs.changes} onClick={() => setConfirming(true)}>
            Review and apply
          </s-button>
        </div>
      ) : null}
    </>
  );
}
