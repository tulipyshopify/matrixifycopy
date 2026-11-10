import { useMemo, useState } from "react";
import { useFetcher } from "react-router";
import type { EntityInfo } from "../lib/jobs/jobs.server";
import { FILTER_OPS, type FilterCondition, type FilterField, type FilterOp } from "../lib/core/types";
import { compileFilters } from "../lib/core/util";

// Boolean props on Polaris web components use `x || undefined`: React 18 server-renders
// false as the attribute ="false", which the components read as true.

export interface ExportPayload {
  entities: Array<{ entity: string; options: Record<string, unknown> }>;
  format: string;
  name: string;
  schedule?: { intervalMinutes: number; uploadUrl?: string; startAt?: string };
}

interface EntityState {
  enabled: boolean;
  groups: string[];
  columns: string[];
  filters: FilterCondition[];
  query: string;
  showColumns: boolean;
}

const INTERVALS = [
  { label: "Every hour", value: 60 },
  { label: "Every 6 hours", value: 360 },
  { label: "Every day", value: 1440 },
  { label: "Every week", value: 10080 },
];

const OP_LABELS: Record<FilterOp, string> = {
  is: "is",
  is_not: "is not",
  starts_with: "starts with",
  any_of: "is any of",
  gt: "is greater than",
  gte: "is at least / on or after",
  lt: "is less than",
  lte: "is at most / on or before",
  between: "is between",
};

function opLabel(field: FilterField, op: FilterOp): string {
  if (field.type === "date") return { gte: "on or after", lte: "on or before", between: "between" }[op as "gte"] ?? OP_LABELS[op];
  if (field.type === "number") return { gte: "at least", lte: "at most" }[op as "gte"] ?? OP_LABELS[op];
  return OP_LABELS[op];
}

function newCondition(field: FilterField): FilterCondition {
  return { field: field.key, op: FILTER_OPS[field.type][0], value: field.type === "boolean" ? "true" : "" };
}

/** Value input(s) for one filter row, chosen by field type and operator. */
function FilterValue({
  field,
  cond,
  onChange,
}: {
  field: FilterField;
  cond: FilterCondition;
  onChange: (patch: Partial<FilterCondition>) => void;
}) {
  if (field.type === "boolean") {
    return (
      <s-select label="Value" labelAccessibilityVisibility="exclusive" value={cond.value} onChange={(ev: any) => onChange({ value: ev.currentTarget.value })}>
        <s-option value="true">Yes</s-option>
        <s-option value="false">No</s-option>
      </s-select>
    );
  }
  if (field.type === "enum") {
    if (cond.op === "any_of") {
      const selected = cond.value ? cond.value.split(",") : [];
      return (
        <s-stack direction="inline" gap="small">
          {field.options!.map((o) => (
            <s-checkbox
              key={o.value}
              label={o.label}
              checked={(selected.includes(o.value)) || undefined}
              onChange={(ev: any) =>
                onChange({
                  value: (ev.currentTarget.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value)).join(","),
                })
              }
            />
          ))}
        </s-stack>
      );
    }
    return (
      <s-select label="Value" labelAccessibilityVisibility="exclusive" value={cond.value} placeholder="Choose…" onChange={(ev: any) => onChange({ value: ev.currentTarget.value })}>
        {field.options!.map((o) => (
          <s-option key={o.value} value={o.value}>
            {o.label}
          </s-option>
        ))}
      </s-select>
    );
  }
  const single = (value: string, key: "value" | "value2", label: string) =>
    field.type === "date" ? (
      <s-date-field key={key} label={label} labelAccessibilityVisibility="exclusive" value={value} onChange={(ev: any) => onChange({ [key]: ev.currentTarget.value })} />
    ) : field.type === "number" ? (
      <s-number-field key={key} label={label} labelAccessibilityVisibility="exclusive" value={value} onInput={(ev: any) => onChange({ [key]: ev.currentTarget.value })} />
    ) : (
      <s-text-field
        key={key}
        label={label}
        labelAccessibilityVisibility="exclusive"
        value={value}
        placeholder={field.help ?? (field.type === "id" ? "Numeric ID" : "")}
        onInput={(ev: any) => onChange({ [key]: ev.currentTarget.value })}
      />
    );
  if (cond.op === "between") {
    return (
      <s-stack direction="inline" gap="small" alignItems="center">
        {single(cond.value, "value", "From")}
        <s-text>and</s-text>
        {single(cond.value2 ?? "", "value2", "To")}
      </s-stack>
    );
  }
  return single(cond.value, "value", "Value");
}

function FilterBuilder({
  entity,
  filters,
  onChange,
}: {
  entity: EntityInfo;
  filters: FilterCondition[];
  onChange: (filters: FilterCondition[]) => void;
}) {
  const byKey = new Map(entity.filters.map((f) => [f.key, f]));
  const update = (i: number, patch: Partial<FilterCondition>) => onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <s-stack direction="block" gap="small">
      {filters.length === 0 ? <s-text tone="neutral">No filters: every item is exported.</s-text> : null}
      {filters.map((cond, i) => {
        const field = byKey.get(cond.field)!;
        return (
          <s-grid key={i} gridTemplateColumns="minmax(160px, 1fr) minmax(140px, 0.8fr) 2fr auto" gap="small" alignItems="center">
            <s-select
              label="Field"
              labelAccessibilityVisibility="exclusive"
              value={cond.field}
              onChange={(ev: any) => {
                const f = byKey.get(ev.currentTarget.value)!;
                onChange(filters.map((x, j) => (j === i ? newCondition(f) : x)));
              }}
            >
              {entity.filters.map((f) => (
                <s-option key={f.key} value={f.key}>
                  {f.label}
                </s-option>
              ))}
            </s-select>
            {field.type === "boolean" ? (
              <s-text>is</s-text>
            ) : (
              <s-select
                label="Condition"
                labelAccessibilityVisibility="exclusive"
                value={cond.op}
                onChange={(ev: any) => update(i, { op: ev.currentTarget.value, ...(field.type === "enum" ? { value: "" } : {}) })}
              >
                {FILTER_OPS[field.type].map((op) => (
                  <s-option key={op} value={op}>
                    {opLabel(field, op)}
                  </s-option>
                ))}
              </s-select>
            )}
            <FilterValue field={field} cond={cond} onChange={(patch) => update(i, patch)} />
            <s-button variant="tertiary" icon="delete" accessibilityLabel="Remove filter" onClick={() => onChange(filters.filter((_, j) => j !== i))} />
          </s-grid>
        );
      })}
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-button icon="plus" onClick={() => onChange([...filters, newCondition(entity.filters[0])])}>
          Add filter
        </s-button>
        {filters.some((f) => f.value) ? (
          <s-text tone="neutral">
            Shopify search: <code>{compileFilters(filters.filter((f) => f.value && (f.op !== "between" || f.value2)))}</code>
          </s-text>
        ) : null}
      </s-stack>
    </s-stack>
  );
}

function ColumnPicker({
  entity,
  columns,
  onChange,
}: {
  entity: EntityInfo;
  columns: string[];
  onChange: (columns: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const required = new Set(["ID", ...entity.keyColumns]);
  const visible = entity.columns.filter((c) => c.toLowerCase().includes(search.toLowerCase()));
  // Group by the column's prefix ("Variant SKU" -> Variant, "Billing: City" -> Billing).
  const groupOf = (c: string) => {
    const m = /^([^:]+):/.exec(c) ?? /^(Variant|Image|Option\d|Address|Line|Location|Contact|Item|Rule|Product|Shipping|Billing|Customer|Transaction|Field|Definition|Blog)\b/.exec(c);
    if (!m) return entity.sheet.replace(/s$/, "");
    return m[1].replace(/^Option\d$/, "Variant");
  };
  const groups: Array<[string, string[]]> = [];
  for (const c of visible) {
    const g = groupOf(c);
    const found = groups.find(([name]) => name === g);
    if (found) found[1].push(c);
    else groups.push([g, [c]]);
  }
  return (
    <s-stack direction="block" gap="small">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-search-field label="Find a column" labelAccessibilityVisibility="exclusive" placeholder="Find a column" value={search} onInput={(ev: any) => setSearch(ev.currentTarget.value)} />
        <s-button variant="tertiary" onClick={() => onChange([...entity.columns])}>
          Select all
        </s-button>
        <s-button variant="tertiary" onClick={() => onChange(entity.columns.filter((c) => required.has(c)))}>
          Keys only
        </s-button>
        <s-text tone="neutral">
          {columns.length} of {entity.columns.length} selected
        </s-text>
      </s-stack>
      {groups.map(([group, cols]) => {
        const optional = cols.filter((c) => !required.has(c));
        const allOn = optional.every((c) => columns.includes(c));
        return (
          <s-stack key={group} direction="block" gap="small-200">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">{group}</s-text>
              {optional.length > 1 ? (
                <s-button
                  variant="tertiary"
                  onClick={() =>
                    onChange(allOn ? columns.filter((c) => !optional.includes(c)) : [...new Set([...columns, ...optional])])
                  }
                >
                  {allOn ? "Clear" : "All"}
                </s-button>
              ) : null}
            </s-stack>
            <s-grid gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))" gap="small-200">
              {cols.map((c) => (
                <s-checkbox
                  key={c}
                  label={c}
                  checked={(columns.includes(c) || required.has(c)) || undefined}
                  disabled={(required.has(c)) || undefined}
                  onChange={(ev: any) => onChange(ev.currentTarget.checked ? [...columns, c] : columns.filter((x) => x !== c))}
                />
              ))}
            </s-grid>
          </s-stack>
        );
      })}
      <s-text tone="neutral">Greyed-out key columns are always included so the file can be imported back.</s-text>
    </s-stack>
  );
}

/**
 * The export builder: data types, filters, columns, file format and schedule.
 * Used on the home page and on /app/export; posts to the /app/export action.
 */
export function ExportForm({ entities }: { entities: EntityInfo[] }) {
  const fetcher = useFetcher<{ error?: string }>();
  const [state, setState] = useState<Record<string, EntityState>>(() =>
    Object.fromEntries(
      entities.map((e) => [
        e.key,
        {
          enabled: e.key === "products",
          groups: e.groups.filter((g) => g.default).map((g) => g.key),
          columns: [...e.columns],
          filters: [],
          query: "",
          showColumns: false,
        },
      ]),
    ),
  );
  const [format, setFormat] = useState("xlsx");
  const [name, setName] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [uploadUrl, setUploadUrl] = useState("");

  const selected = useMemo(() => entities.filter((e) => state[e.key].enabled), [entities, state]);
  const update = (key: string, patch: Partial<EntityState>) => setState((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  const busy = fetcher.state !== "idle";

  const submit = () => {
    const payload: ExportPayload = {
      format,
      name,
      entities: selected.map((e) => {
        const s = state[e.key];
        const allColumns = e.columns.every((c) => s.columns.includes(c));
        return {
          entity: e.key,
          options: {
            groups: e.groups.length ? s.groups : undefined,
            columns: allColumns ? undefined : s.columns,
            filters: s.filters.length ? s.filters : undefined,
            query: s.query || undefined,
          },
        };
      }),
      ...(scheduled ? { schedule: { intervalMinutes, uploadUrl: uploadUrl || undefined } } : {}),
    };
    fetcher.submit(payload as any, { method: "post", encType: "application/json", action: "/app/export" });
  };

  return (
    <>
      {fetcher.data?.error ? (
        <s-banner tone="critical" heading="Could not start export">
          {fetcher.data.error}
        </s-banner>
      ) : null}

      <s-section heading="What to export">
        <s-stack direction="block" gap="base">
          {entities.map((e) => {
            const s = state[e.key];
            return (
              <s-box key={e.key} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-checkbox
                    label={e.sheet}
                    details={e.description}
                    checked={(s.enabled) || undefined}
                    onChange={(ev: any) => update(e.key, { enabled: ev.currentTarget.checked })}
                  />
                  {s.enabled ? (
                    <s-stack direction="block" gap="base" padding="none none none large">
                      {e.filters.length ? (
                        <s-stack direction="block" gap="small">
                          <s-heading>Filters</s-heading>
                          <FilterBuilder entity={e} filters={s.filters} onChange={(filters) => update(e.key, { filters })} />
                        </s-stack>
                      ) : null}

                      <s-stack direction="block" gap="small">
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-heading>Columns</s-heading>
                          <s-text tone="neutral">
                            {s.columns.length === e.columns.length ? "All columns" : `${s.columns.length} of ${e.columns.length}`}
                          </s-text>
                          <s-button variant="tertiary" onClick={() => update(e.key, { showColumns: !s.showColumns })}>
                            {s.showColumns ? "Hide" : "Choose columns"}
                          </s-button>
                        </s-stack>
                        {s.showColumns ? <ColumnPicker entity={e} columns={s.columns} onChange={(columns) => update(e.key, { columns })} /> : null}
                        {e.groups.length ? (
                          <s-stack direction="inline" gap="base">
                            {e.groups.map((g) => (
                              <s-checkbox
                                key={g.key}
                                label={g.label}
                                checked={(s.groups.includes(g.key)) || undefined}
                                onChange={(ev: any) =>
                                  update(e.key, {
                                    groups: ev.currentTarget.checked ? [...s.groups, g.key] : s.groups.filter((x) => x !== g.key),
                                  })
                                }
                              />
                            ))}
                          </s-stack>
                        ) : null}
                      </s-stack>

                      {e.supportsQuery ? (
                        <s-text-field
                          label="Advanced: Shopify search query (optional)"
                          details="Added to the filters above with AND, e.g. tag:sale OR tag:clearance"
                          value={s.query}
                          onInput={(ev: any) => update(e.key, { query: ev.currentTarget.value })}
                        />
                      ) : null}
                    </s-stack>
                  ) : null}
                </s-stack>
              </s-box>
            );
          })}
        </s-stack>
      </s-section>

      <s-section heading="File">
        <s-stack direction="block" gap="base">
          <s-select label="Format" value={format} onChange={(ev: any) => setFormat(ev.currentTarget.value)}>
            <s-option value="xlsx">Excel (.xlsx), one sheet per data type</s-option>
            <s-option value="csv">CSV (.csv, zipped when several data types)</s-option>
          </s-select>
          <s-text-field label="File name (optional)" value={name} placeholder="Export_2026-11-09" onInput={(ev: any) => setName(ev.currentTarget.value)} />
        </s-stack>
      </s-section>

      <s-section heading="Schedule">
        <s-stack direction="block" gap="base">
          <s-switch label="Repeat this export on a schedule" checked={(scheduled) || undefined} onChange={(ev: any) => setScheduled(ev.currentTarget.checked)} />
          {scheduled ? (
            <>
              <s-select label="How often" value={String(intervalMinutes)} onChange={(ev: any) => setIntervalMinutes(Number(ev.currentTarget.value))}>
                {INTERVALS.map((i) => (
                  <s-option key={i.value} value={String(i.value)}>
                    {i.label}
                  </s-option>
                ))}
              </s-select>
              <s-url-field
                label="Upload to FTP (optional)"
                details="ftp://user:password@host/folder/ — the file is also kept in the app"
                value={uploadUrl}
                onInput={(ev: any) => setUploadUrl(ev.currentTarget.value)}
              />
            </>
          ) : null}
          <s-stack direction="inline" justifyContent="end">
            <s-button variant="primary" onClick={submit} disabled={(!selected.length || busy) || undefined} loading={(busy) || undefined}>
              {scheduled ? "Save schedule" : `Export ${selected.map((e) => e.sheet).join(", ") || "…"}`}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </>
  );
}
