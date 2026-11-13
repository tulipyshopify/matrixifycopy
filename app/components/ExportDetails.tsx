import type { EntityInfo } from "../lib/jobs/jobs.server";
import { DATE_PRESETS, type DateRange, type FilterCondition } from "../lib/core/types";
import { columnSections, opLabel } from "./ExportForm";

interface ExportedEntity {
  entity: string;
  options: {
    columns?: string[];
    groups?: string[];
    filters?: FilterCondition[];
    dateRange?: DateRange;
    query?: string;
    locations?: string[];
    metafields?: string[];
    variantMetafields?: string[];
  };
}

function dateRangeText(e: EntityInfo, r: DateRange): string {
  const field = e.filters.find((f) => f.key === r.field)?.label ?? r.field;
  if (r.preset === "last_n_days") return `${field}: last ${r.days ?? "?"} days`;
  if (r.preset === "last_n") return `${field}: last ${r.amount ?? "?"} ${r.unit ?? "days"}`;
  if (r.preset !== "custom") return `${field}: ${DATE_PRESETS.find((p) => p.value === r.preset)?.label ?? r.preset}`;
  return `${field}: ${r.from ? `from ${r.from}` : ""}${r.from && r.to ? " " : ""}${r.to ? `to ${r.to}` : ""}`;
}

function filterText(e: EntityInfo, f: FilterCondition): string {
  const field = e.filters.find((x) => x.key === f.field);
  if (!field) return `${f.field} ${f.op} ${f.value}`;
  const label = (v: string) => field.options?.find((o) => o.value === v)?.label ?? v;
  const value =
    field.type === "boolean"
      ? f.value === "true"
        ? "Yes"
        : "No"
      : f.op === "between"
        ? `${f.value} and ${f.value2 ?? ""}`
        : f.value.split(",").map(label).join(", ");
  return `${field.label} ${field.type === "boolean" ? "is" : opLabel(field, f.op)} ${value}`;
}

/**
 * Read-only record of what an export job included: per data type, the item
 * count, filters, columns (by section and in file order) and extra data.
 */
export function ExportDetails({
  entities,
  exported,
  stats,
}: {
  entities: EntityInfo[];
  exported: ExportedEntity[];
  stats: Array<{ entity?: string; items?: number; rows?: number }>;
}) {
  return (
    <>
      {exported.map(({ entity, options: o }) => {
        const e = entities.find((x) => x.key === entity);
        if (!e) return null;
        const stat = stats.find((s) => s.entity === entity);
        const chosen = o.columns ?? e.columns;
        const groups = o.groups ?? e.groups.filter((g) => g.default).map((g) => g.key);
        const filters = [
          ...(o.dateRange ? [dateRangeText(e, o.dateRange)] : []),
          ...(o.filters ?? []).map((f) => filterText(e, f)),
          ...(o.query ? [`Search query: ${o.query}`] : []),
        ];
        const sections = columnSections(e)
          .map((sec) => ({ name: sec.name, total: sec.columns.length, on: sec.columns.filter((c) => chosen.includes(c)).length }))
          .filter((sec) => sec.on > 0);
        return (
          <s-section key={entity}>
            <s-box padding="small base">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-heading>{e.sheet}</s-heading>
                  {stat?.items !== undefined ? <s-badge tone="success">Exported: {stat.items.toLocaleString()}</s-badge> : null}
                  {stat?.rows !== undefined ? <s-badge>{stat.rows.toLocaleString()} rows</s-badge> : null}
                </s-stack>

                <s-divider />
                <s-stack direction="block" gap="small-200">
                  <s-heading>Filters</s-heading>
                  {filters.length ? (
                    filters.map((f, i) => <s-text key={i}>{f}</s-text>)
                  ) : (
                    <s-text tone="neutral">None: every item was exported.</s-text>
                  )}
                </s-stack>

                <s-divider />
                <s-stack direction="block" gap="small">
                  <s-heading>
                    Columns: {chosen.length} of {e.columns.length}
                  </s-heading>
                  <s-stack direction="inline" gap="small">
                    {sections.map((sec) => (
                      <s-badge key={sec.name} tone={sec.on < sec.total ? "warning" : "neutral"}>
                        {sec.name}: {sec.on === sec.total ? `${sec.total} columns` : `${sec.on} of ${sec.total}`}
                      </s-badge>
                    ))}
                  </s-stack>
                  <s-text tone="neutral">In file order:</s-text>
                  <div className="bp-chips" role="list">
                    {chosen.map((c) => (
                      <div key={c} role="listitem" className="bp-chip bp-chip-static">
                        {c}
                      </div>
                    ))}
                  </div>
                </s-stack>

                {e.groups.length ? (
                  <>
                    <s-divider />
                    <s-stack direction="block" gap="small-200">
                      <s-heading>Extra data</s-heading>
                      <s-stack direction="inline" gap="small">
                        {e.groups.map((g) => (
                          <s-badge key={g.key} tone={groups.includes(g.key) ? "info" : "neutral"}>
                            {g.label}: {groups.includes(g.key) ? "included" : "not included"}
                          </s-badge>
                        ))}
                      </s-stack>
                      {o.locations ? <s-text>Inventory locations: {o.locations.join(", ")}</s-text> : null}
                      {o.metafields ? <s-text>Metafields: {o.metafields.join(", ")}</s-text> : null}
                      {o.variantMetafields ? <s-text>Variant metafields: {o.variantMetafields.join(", ")}</s-text> : null}
                    </s-stack>
                  </>
                ) : null}
              </s-stack>
            </s-box>
          </s-section>
        );
      })}
    </>
  );
}
