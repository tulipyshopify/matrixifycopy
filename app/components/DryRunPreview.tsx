import { Fragment, useMemo, useState } from "react";
import type { PreviewItem } from "../lib/core/importer";
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

const PAGE = 100;
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

/** Where an import is in its three steps. */
export function ImportSteps({ step }: { step: 1 | 2 | 3 }) {
  const steps = ["File and settings", "Preview changes", "Confirm and apply"];
  return (
    <div className="bp-stepper" role="list" aria-label="Import steps">
      {steps.map((label, i) => (
        <div key={label} role="listitem" className={`bp-step${i + 1 === step ? " bp-step-on" : ""}${i + 1 < step ? " bp-step-done" : ""}`} aria-current={i + 1 === step ? "step" : undefined}>
          <span className="bp-step-n">{i + 1 < step ? "✓" : i + 1}</span>
          {label}
        </div>
      ))}
    </div>
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
  onImport,
}: {
  sheets: PreviewSheet[];
  needs: ApplyNeeds;
  canApply: boolean;
  busy: boolean;
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
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [rest, setRest] = useState(false);

  const risky = all.filter((x) => RISKY.has(x.kind));
  const inc = risky.filter((x) => included[x.id]);
  const skipped = risky.length - inc.length;
  const count = (k: PreviewKind) => inc.filter((x) => x.kind === k).length;
  const applying = totals.update + inc.length + (rest ? unlistedRisky : 0);
  const deletesIncluded = count("delete") + (rest ? Math.max(0, totals.delete - (listed.delete ?? 0)) : 0);
  const setAll = (kind: PreviewKind, on: boolean) => setIncluded((cur) => ({ ...cur, ...Object.fromEntries(risky.filter((x) => x.kind === kind).map((x) => [x.id, on])) }));

  const submit = () => {
    const group = (list: typeof risky) => {
      const out: Record<string, string[]> = {};
      for (const x of list) if (x.item.key) (out[x.sheet] ??= []).push(x.item.key);
      return out;
    };
    onImport({ exclude: group(risky.filter((x) => !included[x.id])), include: group(inc), deletes: typed, rest });
  };

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
            {s.warnings!.map((w, k) => (
              <s-text key={k}>{w.replace(/^Not imported: /, "It was ")}</s-text>
            ))}
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
                        const on = items.filter((x) => x.kind === k).every((x) => included[x.id]);
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
                    const on = !!included[id];
                    return (
                      <div key={id} role="listitem" className={`bp-row bp-row-${kind}${RISKY.has(kind) && !on ? " bp-row-off" : ""}`}>
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
                          {kind === "failed" ? null : i.changes.map((c, k) => <ChangeLine key={k} text={c} />)}
                          {(i.warnings ?? []).map((w, k) => (
                            <s-text key={`w${k}`} tone="caution">
                              ! {w}
                            </s-text>
                          ))}
                          {kind === "create" ? <s-text tone="caution">+ Nothing in the store has this handle or ID. Check for a typo before including it.</s-text> : null}
                          {!errors.length && !i.changes.length ? <s-text color="subdued">{kind === "none" ? "Same as the store" : i.message || "—"}</s-text> : null}
                        </div>
                        <div className="bp-row-do">
                          {RISKY.has(kind) && canApply ? (
                            <div className="bp-choice" role="group" aria-label={`${i.item}: include or skip`}>
                              <button type="button" className={on ? "bp-choice-on" : ""} aria-pressed={on} onClick={() => setIncluded((c) => ({ ...c, [id]: true }))}>
                                {kind === "delete" ? "Delete" : kind === "create" ? "Create" : "Include"}
                              </button>
                              <button type="button" className={!on ? "bp-choice-on" : ""} aria-pressed={!on} onClick={() => setIncluded((c) => ({ ...c, [id]: false }))}>
                                Skip
                              </button>
                            </div>
                          ) : (
                            <s-badge tone={a.tone}>{a.label}</s-badge>
                          )}
                        </div>
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
              {compared ? (
                <s-text color="subdued">
                  Each line is one field: its value in the store now, then its value after the import. Fields that already match the file are not listed and are not touched. The number on the left is the row in your sheet, counting the header as row 1.
                </s-text>
              ) : null}
              {firstStep ? (
                <s-text color="subdued">For data types other than products and redirects, the details show the values the first step would send (an item can need more than one step); the real import makes all of them.</s-text>
              ) : null}
            </s-stack>
          </s-box>
        </s-section>
      ) : null}

      {canApply && needs.changes > 0 && confirming ? (
        <s-section heading={`Apply ${plural(applying, "change")} to your store?`}>
          <s-stack direction="block" gap="base">
            <div className="bp-sum">
              <div><b>{n(totals.update)}</b><s-badge tone="info">Update</s-badge><span>items changed as shown in the preview</span></div>
              {count("look") ? <div><b>{n(count("look"))}</b><s-badge tone="warning">Accepted warning</s-badge><span>{inc.filter((x) => x.kind === "look").slice(0, 3).map((x) => x.item.title || x.item.item).join("; ")}{count("look") > 3 ? "…" : ""}</span></div> : null}
              {totals.create ? <div><b>{n(count("create"))}</b><s-badge tone="warning">Create</s-badge><span>{count("create") ? "new items, as drafts unless the file says otherwise" : `${plural(totals.create, "possible new item")} not included`}</span></div> : null}
              {totals.delete ? <div><b>{n(count("delete"))}</b><s-badge tone="critical">Delete</s-badge><span>{count("delete") ? inc.filter((x) => x.kind === "delete").slice(0, 3).map((x) => x.item.title || x.item.item).join("; ") : `${plural(totals.delete, "deletion")} not included`}</span></div> : null}
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
            <s-text color="subdued">
              Each item is checked against the store once more as it is applied: anything changed since this preview is left alone and reported. Items that already match the store are not touched.
            </s-text>
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
                    `${n(totals.update)} ${totals.update === 1 ? "update" : "updates"}`,
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
