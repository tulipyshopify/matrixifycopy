import { Fragment, useMemo, useState } from "react";
import type { PreviewItem } from "../lib/core/importer";
import type { ApplyConfirm, ApplyNeeds, PreviewSheet } from "../lib/jobs/jobs.server";

type Tone = "success" | "info" | "critical" | "warning" | "neutral";
const ACTIONS: Record<PreviewItem["action"], { label: string; tone: Tone }> = {
  // Amber, not green: a create or a replace is worth a second look.
  create: { label: "Create", tone: "warning" },
  update: { label: "Update", tone: "info" },
  replace: { label: "Delete and re-create", tone: "critical" },
  delete: { label: "Delete", tone: "critical" },
  none: { label: "No change", tone: "neutral" },
  failed: { label: "Would fail", tone: "critical" },
  skipped: { label: "Skipped", tone: "neutral" },
};
const actionOf = (a: string) => ACTIONS[a as PreviewItem["action"]] ?? { label: a || "Unknown", tone: "neutral" as Tone };

const FILTERS = [
  { key: "all", label: "All" },
  { key: "changes", label: "Changes" },
  { key: "attention", label: "Needs a look" },
  { key: "problems", label: "Problems" },
  { key: "none", label: "No change" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

const risky = (i: PreviewItem) => !!(i.warnings?.length || i.clears?.length || i.deletes || i.action === "delete" || i.action === "replace" || i.action === "create");
const matches = (f: FilterKey, i: PreviewItem) =>
  f === "all" ||
  (f === "changes" && ["create", "update", "replace", "delete"].includes(i.action)) ||
  (f === "attention" && i.action !== "failed" && risky(i)) ||
  (f === "problems" && (i.action === "failed" || i.action === "skipped")) ||
  (f === "none" && i.action === "none");

const PAGE = 100;
const n = (x: number) => x.toLocaleString("en");
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

/** A change line: the store's value struck against the new one when it has the form "label: old → new". */
function ChangeLine({ text }: { text: string }) {
  const m = /^(.*?): (.*) → (.*)$/s.exec(text);
  if (!m) return <s-text>{text}</s-text>;
  return (
    <s-text>
      <span className="bp-diff-label">{m[1]}:</span> <span className={/^\(.*\)$/.test(m[2]) ? "bp-diff-label" : "bp-diff-old"}>{m[2]}</span> <span aria-hidden>→</span> <span className="bp-diff-new">{m[3]}</span>
    </s-text>
  );
}

/**
 * The step between a preview and a real import: what would happen in numbers,
 * and a tick (or, for deletions, the typed word DELETE) for everything risky.
 */
export function ImportConfirm({
  needs,
  deleting,
  busy,
  onImport,
}: {
  needs: ApplyNeeds;
  /** Names of the first items that would be deleted. */
  deleting: string[];
  busy: boolean;
  onImport: (confirm: ApplyConfirm) => void;
}) {
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [typed, setTyped] = useState("");
  const tick = (k: string) => (ev: any) => setTicks((t) => ({ ...t, [k]: !!ev.currentTarget.checked }));
  const asks = [
    needs.creates ? { key: "creates", label: `Create ${plural(needs.creates, "new item")}`, details: "They don't exist in the store yet. If you only meant to update, check the handles or IDs for typos first (see Create in the list above)." } : null,
    needs.clearing ? { key: "clearing", label: `Empty fields on ${plural(needs.clearing, "item")}`, details: "A blank cell in a column of the file empties that field (tags, description…). They are marked \"(cleared)\" above. To leave a field alone, remove its column from the file." } : null,
    needs.warned ? { key: "warnings", label: `I have read the warnings on ${plural(needs.warned, "item")}`, details: "Allowed, but they look like mistakes: a big price drop, a zero price, a compare-at price below the price… See \"Needs a look\" above." } : null,
    needs.failing ? { key: "failing", label: `Skip ${plural(needs.failing, "item")} that would fail, and import the rest`, details: "The failing items are left exactly as they are. See Problems above for the reasons." } : null,
    needs.skippedSheets.length
      ? { key: "skippedSheets", label: `Leave out ${needs.skippedSheets.map((s) => `"${s.sheet}"`).join(", ")}`, details: `${needs.skippedSheets.length === 1 ? "This sheet is" : "These sheets are"} not imported at all (${plural(needs.skippedSheets.reduce((a, s) => a + s.rows, 0), "row")}).` }
      : null,
  ].filter((a): a is { key: string; label: string; details: string } => !!a);
  const ready = asks.every((a) => ticks[a.key]) && (!needs.deletes || typed.trim().toUpperCase() === "DELETE");

  if (!needs.changes) {
    return (
      <s-section heading="Nothing to import">
        <s-paragraph>
          {needs.failing
            ? `No item would change: ${plural(needs.failing, "item")} would fail (see Problems above) and ${plural(needs.unchanged, "item")} already match the store.`
            : `Every item already matches the store (${plural(needs.unchanged, "item")} checked), so there is nothing to import.`}
        </s-paragraph>
      </s-section>
    );
  }

  return (
    <s-section heading="Import for real">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small">
          {needs.updates ? <s-badge tone="info">Update: {n(needs.updates)}</s-badge> : null}
          {needs.creates ? <s-badge tone="warning">Create: {n(needs.creates)}</s-badge> : null}
          {needs.deletes ? <s-badge tone="critical">Delete: {n(needs.deletes)}</s-badge> : null}
          {needs.unchanged ? <s-badge>No change: {n(needs.unchanged)}</s-badge> : null}
          {needs.failing ? <s-badge tone="critical">Would fail: {n(needs.failing)}</s-badge> : null}
        </s-stack>
        {needs.deletes ? (
          <s-banner tone="critical" heading={`This import permanently deletes ${plural(needs.deletes, "item")}`}>
            <s-stack direction="block" gap="small">
              <s-text>
                {deleting.slice(0, 5).join("; ")}
                {needs.deletes > 5 ? `; and ${n(needs.deletes - Math.min(5, deleting.length))} more (filter the list above by Changes)` : ""}
              </s-text>
              <s-text>
                A deleted item can't be brought back from here. <s-link href="/app/backups">Make a backup first</s-link> if you don't have a recent one.
              </s-text>
              <s-text-field label='Type DELETE to confirm the deletions' value={typed} onInput={(ev: any) => setTyped(ev.currentTarget.value)} />
            </s-stack>
          </s-banner>
        ) : null}
        {asks.map((a) => (
          <s-checkbox key={a.key} label={a.label} details={a.details} checked={!!ticks[a.key]} onChange={tick(a.key)} />
        ))}
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button
            variant="primary"
            tone={needs.deletes ? "critical" : undefined}
            loading={busy}
            disabled={!ready || busy}
            onClick={() => onImport({ creates: ticks.creates, clearing: ticks.clearing, warnings: ticks.warnings, failing: ticks.failing, skippedSheets: ticks.skippedSheets, deletes: typed })}
          >
            Import {plural(needs.changes, "item")} for real
          </s-button>
          <s-text color="subdued">
            {ready
              ? "Each item is checked against the store once more: anything changed since this preview is left alone and reported."
              : "Tick each box above to confirm, then import."}
          </s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

/** What a dry-run import would do, item by item, per sheet. */
export function DryRunPreview({ sheets }: { sheets: PreviewSheet[] }) {
  const all = useMemo(() => sheets.flatMap((s) => s.items), [sheets]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of all) c[i.action] = (c[i.action] ?? 0) + 1;
    return c;
  }, [all]);
  const problems = (counts.failed ?? 0) + (counts.skipped ?? 0);
  const attention = all.filter((i) => matches("attention", i)).length;
  const [filter, setFilter] = useState<FilterKey>(problems ? "problems" : attention ? "attention" : "all");
  const [shown, setShown] = useState(PAGE);
  const compared = all.some((i) => i.compared);
  const firstStep = all.some((i) => !i.compared && i.changes.length);
  const sheetNotes = sheets.filter((s) => s.warnings?.length);

  return (
    <s-section heading="Preview">
      <s-stack direction="block" gap="base">
        {sheetNotes.map((s) => (
          <s-banner key={s.sheet} tone={s.entity === null ? "critical" : "warning"} heading={s.entity === null ? `Sheet "${s.sheet}" is not imported` : `About sheet "${s.sheet}"`}>
            <s-stack direction="block" gap="small-300">
              {s.warnings!.map((w, k) => (
                <s-text key={k}>{w.replace(/^Not imported: /, "It was ")}</s-text>
              ))}
            </s-stack>
          </s-banner>
        ))}
        {all.length ? (
          <s-stack direction="inline" gap="small">
            {FILTERS.map((f) => {
              const count = all.filter((i) => matches(f.key, i)).length;
              return (
                <s-button
                  key={f.key}
                  variant={filter === f.key ? "primary" : "secondary"}
                  disabled={!count && f.key !== "all"}
                  onClick={() => {
                    setFilter(f.key);
                    setShown(PAGE);
                  }}
                >
                  {f.label} ({n(count)})
                </s-button>
              );
            })}
          </s-stack>
        ) : null}
        {sheets.map((s) => {
          const items = s.items.filter((i) => matches(filter, i));
          if (!items.length) return null;
          return (
            <Fragment key={s.sheet}>
              {sheets.length > 1 ? <s-heading>{s.sheet}</s-heading> : null}
              <s-table>
                <s-table-header-row>
                  <s-table-header>Sheet row</s-table-header>
                  <s-table-header listSlot="primary">Item</s-table-header>
                  <s-table-header>Would</s-table-header>
                  <s-table-header>What changes (now → after)</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {items.slice(0, shown).map((i) => {
                    const a = actionOf(i.action);
                    const errors = i.errors?.length ? i.errors : i.action === "failed" || i.action === "skipped" ? [i.message || "Would fail"] : [];
                    return (
                      <s-table-row key={`${i.row}-${i.item}`}>
                        <s-table-cell>{i.row}</s-table-cell>
                        <s-table-cell>{i.item}</s-table-cell>
                        <s-table-cell>
                          <s-badge tone={a.tone}>{a.label}</s-badge>
                        </s-table-cell>
                        <s-table-cell>
                          <s-stack direction="block" gap="small-500">
                            {errors.map((e, k) => (
                              <s-text key={`e${k}`} tone="critical">
                                {e}
                              </s-text>
                            ))}
                            {i.action === "failed" ? null : i.changes.map((c, k) => <ChangeLine key={k} text={c} />)}
                            {(i.warnings ?? []).map((w, k) => (
                              <s-text key={`w${k}`} tone="caution">
                                Warning: {w}
                              </s-text>
                            ))}
                            {!errors.length && !i.changes.length ? <s-text color="subdued">{i.action === "none" ? "Already as in the file" : i.message || "—"}</s-text> : null}
                            {i.action !== "failed" && i.message && i.changes.length && !/^(would |no change)/.test(i.message) ? <s-text color="subdued">{i.message}</s-text> : null}
                          </s-stack>
                        </s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>
              {items.length > shown ? (
                <s-button variant="tertiary" onClick={() => setShown(shown + PAGE)}>
                  Show {Math.min(PAGE, items.length - shown)} more of {n(items.length)}
                </s-button>
              ) : null}
            </Fragment>
          );
        })}
        {all.length >= 1000 ? (
          <s-text color="subdued">
            The preview lists 1,000 items of each sheet, the ones with problems or warnings first. The counts above cover every item, and the results file has every row.
          </s-text>
        ) : null}
        {compared ? (
          <s-text color="subdued">
            Each line is one field: its value in the store now, then its value after the import. Fields that already match the file are not listed and are not touched. "Sheet row" counts the header as row 1, as a spreadsheet does.
          </s-text>
        ) : null}
        {firstStep ? (
          <s-text color="subdued">
            For data types other than products and redirects, the details show the values the first step would send (an item can need more than one step); the real import makes all of them.
          </s-text>
        ) : null}
      </s-stack>
    </s-section>
  );
}
