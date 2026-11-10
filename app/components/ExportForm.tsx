import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import type { EntityInfo } from "../lib/jobs/jobs.server";
import {
  DATE_PRESETS,
  FILTER_OPS,
  type DateRange,
  type DatePreset,
  type FilterCondition,
  type FilterField,
  type FilterOp,
} from "../lib/core/types";
import { compileFilters } from "../lib/core/util";

export interface ExportPayload {
  entities: Array<{ entity: string; options: Record<string, unknown> }>;
  format: string;
  name: string;
  schedule?: { intervalMinutes: number; uploadUrl?: string; startAt?: string };
}

interface EntityState {
  enabled: boolean;
  open: boolean;
  groups: string[];
  columns: string[];
  filters: FilterCondition[];
  dateRange: DateRange | null;
  query: string;
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
              checked={selected.includes(o.value)}
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

/** Date filter: which date field, and a preset or custom range. */
function DateRangeFilter({
  entity,
  value,
  onChange,
}: {
  entity: EntityInfo;
  value: DateRange | null;
  onChange: (r: DateRange | null) => void;
}) {
  const dateFields = entity.filters.filter((f) => f.type === "date");
  if (!dateFields.length) return null;
  const field = value?.field ?? (dateFields.find((f) => f.key === "created_at") ?? dateFields[0]).key;
  return (
    <s-grid gridTemplateColumns={value?.preset === "custom" ? "1fr 1fr 1fr 1fr" : "1fr 1fr 2fr"} gap="small" alignItems="end">
      <s-select
        label="Date"
        value={field}
        onChange={(ev: any) => onChange(value ? { ...value, field: ev.currentTarget.value } : null)}
      >
        {dateFields.map((f) => (
          <s-option key={f.key} value={f.key}>
            {f.label}
          </s-option>
        ))}
      </s-select>
      <s-select
        label="Range"
        value={value?.preset ?? ""}
        onChange={(ev: any) => {
          const preset = ev.currentTarget.value as DatePreset | "";
          onChange(preset ? { field, preset, from: value?.from, to: value?.to } : null);
        }}
      >
        <s-option value="">Any time</s-option>
        {DATE_PRESETS.map((p) => (
          <s-option key={p.value} value={p.value}>
            {p.label}
          </s-option>
        ))}
      </s-select>
      {value?.preset === "custom" ? (
        <>
          <s-date-field label="From" value={value.from ?? ""} onChange={(ev: any) => onChange({ ...value, from: ev.currentTarget.value })} />
          <s-date-field label="To" value={value.to ?? ""} onChange={(ev: any) => onChange({ ...value, to: ev.currentTarget.value })} />
        </>
      ) : (
        <span />
      )}
    </s-grid>
  );
}

const SECTION_NAMES: Record<string, string> = {
  Variant: "Variants",
  Image: "Images",
  Category: "Category",
  Line: "Line items",
  Address: "Addresses",
  Location: "Locations",
  Contact: "Contacts",
  Rule: "Rules",
  Item: "Menu items",
  Field: "Fields",
  Product: "Products",
  Transaction: "Transactions",
  Billing: "Billing address",
  Shipping: "Shipping",
  Customer: "Customer",
  Blog: "Blog",
  Definition: "Definition",
};

/** Splits an entity's columns into named sections by their prefix. */
function columnSections(entity: EntityInfo): Array<{ name: string; columns: string[] }> {
  const sections: Array<{ name: string; columns: string[] }> = [];
  for (const c of entity.columns) {
    const m = /^([^:]+):/.exec(c) ?? /^(Variant|Image|Option\d|Address|Line|Location|Contact|Item|Rule|Transaction)\b/.exec(c);
    const prefix = m ? m[1].replace(/^Option\d$/, "Variant") : "";
    const name = prefix ? (SECTION_NAMES[prefix] ?? prefix) : "Basic columns";
    const found = sections.find((x) => x.name === name);
    if (found) found.columns.push(c);
    else sections.push({ name, columns: [c] });
  }
  // Basic columns first.
  sections.sort((a, b) => Number(b.name === "Basic columns") - Number(a.name === "Basic columns"));
  return sections;
}

/** Data groups that add API work per item and so make exports slower. */
const isSlowGroup = (key: string) => /metafield|inventory|publication|transaction|item/.test(key);

function Section({
  title,
  checked,
  indeterminate,
  onToggle,
  badge,
  children,
  defaultOpen,
}: {
  title: string;
  checked: boolean;
  indeterminate?: boolean;
  onToggle: (on: boolean) => void;
  badge?: string;
  children?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <s-box background="subdued" borderRadius="base" padding="small-100 base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-checkbox
              label={title}
              checked={checked}
              indeterminate={indeterminate}
              onChange={(ev: any) => onToggle(ev.currentTarget.checked)}
            />
            {badge ? <s-badge>{badge}</s-badge> : null}
          </s-stack>
          {children ? (
            <s-button
              variant="tertiary"
              icon={open ? "chevron-up" : "chevron-down"}
              accessibilityLabel={open ? `Collapse ${title}` : `Expand ${title}`}
              onClick={() => setOpen(!open)}
            />
          ) : null}
        </s-stack>
        {open && children ? <s-box padding="none none small large">{children}</s-box> : null}
      </s-stack>
    </s-box>
  );
}

const firstWord = (t: string) => t.toLowerCase().split(/[^a-z]+/).find(Boolean)?.replace(/s$/, "") ?? "";

/** Column checklist: master checkbox, then collapsible sections of columns and extra data. */
function ColumnPicker({
  entity,
  columns,
  groups,
  onChange,
}: {
  entity: EntityInfo;
  columns: string[];
  groups: string[];
  onChange: (patch: { columns?: string[]; groups?: string[] }) => void;
}) {
  const required = new Set(["ID", ...entity.keyColumns]);
  // A data group ("Variants & options") that matches a column section ("Variants")
  // is merged into it: the section's checkbox then also controls fetching that data.
  const sections = useMemo(() => {
    const secs = columnSections(entity).map((sec) => ({ ...sec, group: undefined as undefined | { key: string; label: string } }));
    const extra: Array<{ key: string; label: string }> = [];
    for (const g of entity.groups) {
      const sec = secs.find((x) => !x.group && firstWord(x.name) === firstWord(g.label));
      if (sec) sec.group = g;
      else extra.push(g);
    }
    return { secs, extra };
  }, [entity]);
  const optional = entity.columns.filter((c) => !required.has(c));
  const selected = entity.columns.filter((c) => required.has(c) || columns.includes(c)).length;
  const all = selected === entity.columns.length;
  const setGroup = (list: string[], key: string, on: boolean) => (on ? [...new Set([...list, key])] : list.filter((x) => x !== key));

  return (
    <s-stack direction="block" gap="small">
      <s-box background="subdued" borderRadius="base" padding="small-100 base">
        <s-checkbox
          label={`${selected} of ${entity.columns.length} columns selected`}
          checked={all}
          indeterminate={!all && selected > required.size}
          onChange={(ev: any) => {
            const on = ev.currentTarget.checked;
            onChange({
              columns: on ? [...new Set([...columns, ...optional])] : columns.filter((c) => !optional.includes(c)),
              // Selecting everything also turns on the data the columns need.
              ...(on ? { groups: [...new Set([...groups, ...sections.secs.flatMap((x) => (x.group ? [x.group.key] : []))])] } : {}),
            });
          }}
        />
      </s-box>
      {sections.secs.map((sec, i) => {
        const opt = sec.columns.filter((c) => !required.has(c));
        const groupOn = !sec.group || groups.includes(sec.group.key);
        const on = groupOn ? opt.filter((c) => columns.includes(c)).length : 0;
        const toggleSection = (v: boolean) =>
          onChange({
            columns: v ? [...new Set([...columns, ...opt])] : columns.filter((c) => !opt.includes(c)),
            ...(sec.group ? { groups: setGroup(groups, sec.group.key, v) } : {}),
          });
        return (
          <Section
            key={sec.name}
            title={sec.name}
            checked={opt.length > 0 && on === opt.length}
            indeterminate={on > 0 && on < opt.length}
            badge={sec.group && isSlowGroup(sec.group.key) ? "Slower" : undefined}
            onToggle={toggleSection}
            defaultOpen={i === 0}
          >
            <s-grid gridTemplateColumns="repeat(auto-fill, minmax(200px, 1fr))" gap="small-200">
              {sec.columns.map((c) => (
                <s-checkbox
                  key={c}
                  label={c}
                  checked={required.has(c) || (groupOn && columns.includes(c))}
                  disabled={required.has(c)}
                  onChange={(ev: any) => {
                    const v = ev.currentTarget.checked;
                    onChange({
                      columns: v ? [...new Set([...columns, c])] : columns.filter((x) => x !== c),
                      // Ticking a column of a switched-off section switches its data on.
                      ...(v && sec.group && !groupOn ? { groups: setGroup(groups, sec.group.key, true) } : {}),
                    });
                  }}
                />
              ))}
            </s-grid>
          </Section>
        );
      })}
      {sections.extra.map((g) => (
        <Section
          key={g.key}
          title={g.label}
          checked={groups.includes(g.key)}
          badge={isSlowGroup(g.key) ? "Slower" : undefined}
          onToggle={(v) => onChange({ groups: setGroup(groups, g.key, v) })}
        />
      ))}
      <s-text tone="neutral">Key columns ({[...required].join(", ")}) are always included so the file can be imported back.</s-text>
    </s-stack>
  );
}

/** Export options for one entity panel, as sent to the server. */
function panelOptions(e: EntityInfo, s: EntityState) {
  const allColumns = e.columns.every((c) => s.columns.includes(c));
  const filters = s.filters.filter((f) => f.value && (f.op !== "between" || f.value2));
  return {
    groups: e.groups.length ? s.groups : undefined,
    columns: allColumns ? undefined : s.columns,
    filters: filters.length ? filters : undefined,
    dateRange: s.dateRange ?? undefined,
    query: s.query || undefined,
  };
}

/**
 * Live item total for a panel, refreshed when its filters change. Uses plain
 * fetch (App Bridge adds the session token) so a failed count only hides the
 * total instead of triggering the route error boundary or a page revalidation.
 */
function useItemCount(e: EntityInfo, s: EntityState): string | null {
  const [label, setLabel] = useState<string | null>(null);
  const key = JSON.stringify([s.enabled, s.filters, s.dateRange, s.query]);
  useEffect(() => {
    if (!s.enabled) return;
    const controller = new AbortController();
    const t = setTimeout(async () => {
      setLabel("Counting…");
      try {
        const res = await fetch("/app/api/count", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity: e.key, options: panelOptions(e, s) }),
          signal: controller.signal,
        });
        const data = res.ok ? await res.json() : null;
        const r = data?.result as { count: number; precision: string; unfiltered?: boolean } | null | undefined;
        if (!r) return setLabel(null);
        const n = r.count.toLocaleString();
        setLabel(`Total: ${r.precision === "AT_LEAST" ? `${n}+` : n}${r.unfiltered ? " (before filters)" : ""}`);
      } catch {
        if (!controller.signal.aborted) setLabel(null);
      }
    }, 600);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return label;
}

function EntityPanel({
  entity: e,
  state: s,
  update,
}: {
  entity: EntityInfo;
  state: EntityState;
  update: (patch: Partial<EntityState>) => void;
}) {
  const total = useItemCount(e, s);
  const [advanced, setAdvanced] = useState(!!s.query);
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-heading>{e.sheet}</s-heading>
            {total ? <s-badge>{total}</s-badge> : null}
          </s-stack>
          <s-stack direction="inline" gap="small-200">
            <s-button
              variant="tertiary"
              icon={s.open ? "chevron-up" : "chevron-down"}
              accessibilityLabel={s.open ? `Collapse ${e.sheet}` : `Expand ${e.sheet}`}
              onClick={() => update({ open: !s.open })}
            />
            <s-button variant="tertiary" icon="delete" accessibilityLabel={`Remove ${e.sheet}`} onClick={() => update({ enabled: false })} />
          </s-stack>
        </s-stack>
        {s.open ? (
          <>
            <s-text tone="neutral">{e.description}</s-text>
            {e.filters.length ? (
              <s-stack direction="block" gap="small">
                <s-heading>Filters</s-heading>
                <DateRangeFilter entity={e} value={s.dateRange} onChange={(dateRange) => update({ dateRange })} />
                <FilterBuilder entity={e} filters={s.filters} onChange={(filters) => update({ filters })} />
              </s-stack>
            ) : null}
            {e.supportsQuery ? (
              advanced ? (
                <s-text-field
                  label="Shopify search query"
                  details="Added to the filters above with AND, e.g. tag:sale OR tag:clearance"
                  value={s.query}
                  onInput={(ev: any) => update({ query: ev.currentTarget.value })}
                />
              ) : (
                <s-stack direction="inline">
                  <s-button variant="tertiary" onClick={() => setAdvanced(true)}>
                    Advanced search query
                  </s-button>
                </s-stack>
              )
            ) : null}
            <s-stack direction="block" gap="small">
              <s-heading>Columns</s-heading>
              <ColumnPicker entity={e} columns={s.columns} groups={s.groups} onChange={(patch) => update(patch)} />
            </s-stack>
          </>
        ) : null}
      </s-stack>
    </s-box>
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
          open: true,
          groups: e.groups.filter((g) => g.default).map((g) => g.key),
          columns: [...e.columns],
          filters: [],
          dateRange: null,
          query: "",
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
  const available = entities.filter((e) => !state[e.key].enabled);
  const update = (key: string, patch: Partial<EntityState>) => setState((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  const busy = fetcher.state !== "idle";

  const submit = () => {
    const payload: ExportPayload = {
      format,
      name,
      entities: selected.map((e) => ({ entity: e.key, options: panelOptions(e, state[e.key]) })),
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

      <s-section heading="Data to export">
        <s-stack direction="block" gap="base">
          {selected.map((e) => (
            <EntityPanel key={e.key} entity={e} state={state[e.key]} update={(patch) => update(e.key, patch)} />
          ))}
          {available.length ? (
            <s-select
              label="Add data type"
              labelAccessibilityVisibility={selected.length ? "exclusive" : undefined}
              placeholder="+ Add data type…"
              value=""
              onChange={(ev: any) => {
                const key = ev.currentTarget.value;
                if (key) update(key, { enabled: true, open: true });
              }}
            >
              {available.map((e) => (
                <s-option key={e.key} value={e.key}>
                  {e.sheet}
                </s-option>
              ))}
            </s-select>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="File">
        <s-stack direction="block" gap="base">
          <s-select label="Format" value={format} onChange={(ev: any) => setFormat(ev.currentTarget.value)}>
            <s-option value="xlsx">Excel (.xlsx), one sheet per data type</s-option>
            <s-option value="csv">CSV (.csv, zipped when several data types)</s-option>
          </s-select>
          <s-text-field label="File name (optional)" value={name} placeholder="Export_2026-11-10" onInput={(ev: any) => setName(ev.currentTarget.value)} />
          <s-switch label="Repeat this export on a schedule" checked={scheduled} onChange={(ev: any) => setScheduled(ev.currentTarget.checked)} />
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
            <s-button variant="primary" onClick={submit} disabled={!selected.length || busy} loading={busy}>
              {scheduled ? "Save schedule" : `Export ${selected.map((e) => e.sheet).join(", ") || "…"}`}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </>
  );
}
