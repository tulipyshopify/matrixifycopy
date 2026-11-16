import { Fragment, useMemo, useState } from "react";
import type { PreviewItem } from "../lib/core/importer";

const ACTIONS: Record<PreviewItem["action"], { label: string; tone: "success" | "info" | "critical" | "warning" | "neutral" }> = {
  create: { label: "Create", tone: "success" },
  update: { label: "Update", tone: "info" },
  replace: { label: "Replace", tone: "warning" },
  delete: { label: "Delete", tone: "critical" },
  none: { label: "No change", tone: "neutral" },
  failed: { label: "Would fail", tone: "critical" },
  skipped: { label: "Skipped", tone: "neutral" },
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "changes", label: "Changes" },
  { key: "problems", label: "Problems" },
  { key: "none", label: "No change" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

const matches = (f: FilterKey, a: PreviewItem["action"]) =>
  f === "all" ||
  (f === "changes" && ["create", "update", "replace", "delete"].includes(a)) ||
  (f === "problems" && (a === "failed" || a === "skipped")) ||
  (f === "none" && a === "none");

const PAGE = 100;

/** What a dry-run import would do, item by item, per sheet. */
export function DryRunPreview({ sheets }: { sheets: Array<{ sheet: string; entity: string | null; items: PreviewItem[] }> }) {
  const all = useMemo(() => sheets.flatMap((s) => s.items), [sheets]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of all) c[i.action] = (c[i.action] ?? 0) + 1;
    return c;
  }, [all]);
  const problems = (counts.failed ?? 0) + (counts.skipped ?? 0);
  const [filter, setFilter] = useState<FilterKey>(problems ? "problems" : "all");
  const [shown, setShown] = useState(PAGE);

  return (
    <s-section heading="Preview">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small">
          {(Object.keys(ACTIONS) as Array<PreviewItem["action"]>)
            .filter((a) => counts[a])
            .map((a) => (
              <s-badge key={a} tone={ACTIONS[a].tone}>
                {ACTIONS[a].label}: {counts[a].toLocaleString("en")}
              </s-badge>
            ))}
        </s-stack>
        <s-stack direction="inline" gap="small">
          {FILTERS.map((f) => {
            const n = all.filter((i) => matches(f.key, i.action)).length;
            return (
              <s-button
                key={f.key}
                variant={filter === f.key ? "primary" : "secondary"}
                disabled={!n && f.key !== "all"}
                onClick={() => {
                  setFilter(f.key);
                  setShown(PAGE);
                }}
              >
                {f.label} ({n.toLocaleString("en")})
              </s-button>
            );
          })}
        </s-stack>
        {sheets.map((s) => {
          const items = s.items.filter((i) => matches(filter, i.action));
          if (!items.length) return null;
          return (
            <Fragment key={s.sheet}>
              {sheets.length > 1 ? <s-heading>{s.sheet}</s-heading> : null}
              <s-table>
                <s-table-header-row>
                  <s-table-header>Row</s-table-header>
                  <s-table-header listSlot="primary">Item</s-table-header>
                  <s-table-header>Would</s-table-header>
                  <s-table-header>Details</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {items.slice(0, shown).map((i) => (
                    <s-table-row key={`${i.row}-${i.item}`}>
                      <s-table-cell>{i.row}</s-table-cell>
                      <s-table-cell>{i.item}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={ACTIONS[i.action].tone}>{ACTIONS[i.action].label}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-500">
                          {i.changes.length ? (
                            i.changes.map((c, k) => (
                              <s-text key={k} tone={k === 0 ? "neutral" : undefined}>
                                {c}
                              </s-text>
                            ))
                          ) : (
                            <s-text tone={i.action === "failed" ? "critical" : "neutral"}>{i.message || "—"}</s-text>
                          )}
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
              {items.length > shown ? (
                <s-button variant="tertiary" onClick={() => setShown(shown + PAGE)}>
                  Show {Math.min(PAGE, items.length - shown)} more of {items.length.toLocaleString("en")}
                </s-button>
              ) : null}
            </Fragment>
          );
        })}
        {all.length >= 1000 ? (
          <s-text tone="neutral">The preview lists the first 1,000 items of each sheet. The results file has every row.</s-text>
        ) : null}
        <s-text tone="neutral">
          "Details" shows the values the first change would send. An item can need more than one change (for example a product and then its
          variants); the real import makes all of them.
        </s-text>
      </s-stack>
    </s-section>
  );
}
