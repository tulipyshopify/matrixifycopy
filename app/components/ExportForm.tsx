import { Fragment, useEffect, useMemo, useState } from "react";
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
  schedule?: {
    intervalMinutes: number;
    uploadUrl?: string;
    startAt?: string;
    publicLink?: boolean;
  };
}

interface EntityState {
  enabled: boolean;
  open: boolean;
  groups: string[];
  columns: string[];
  filters: FilterCondition[];
  dateRange: DateRange | null;
  query: string;
  /** Custom column order (all of the entity's columns); null = the standard order. */
  order: string[] | null;
  /** Inventory locations to export; null = all. */
  locations: string[] | null;
  /** "namespace.key" lists, comma separated; blank = all. */
  metafields: string;
  variantMetafields: string;
}

export interface PresetData {
  entities: Array<{ entity: string; options: Record<string, any> }>;
  format: string;
}

/** Data types whose exports contain personal data (same list as the server's). */
const PERSONAL_DATA = ["customers", "orders", "draft_orders", "companies"];

const splitList = (v: string) =>
  v
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function blankState(
  entities: EntityInfo[],
  enabled: string[] = [],
): Record<string, EntityState> {
  return Object.fromEntries(
    entities.map((e) => [
      e.key,
      {
        enabled: enabled.includes(e.key),
        open: true,
        groups: e.groups.filter((g) => g.default).map((g) => g.key),
        columns: [...e.columns],
        filters: [],
        dateRange: null,
        query: "",
        order: null,
        locations: null,
        metafields: "",
        variantMetafields: "",
      },
    ]),
  );
}

/** Form state for a saved set-up; data types it doesn't mention stay blank. */
function stateFromPreset(
  entities: EntityInfo[],
  preset: PresetData,
): Record<string, EntityState> {
  const state = blankState(entities);
  for (const { entity, options: o } of preset.entities) {
    const e = entities.find((x) => x.key === entity);
    if (!e) continue;
    state[entity] = {
      enabled: true,
      open: preset.entities.length === 1,
      groups: o.groups ?? state[entity].groups,
      columns: o.columns
        ? e.columns.filter((c) => o.columns.includes(c))
        : [...e.columns],
      filters: o.filters ?? [],
      dateRange: o.dateRange ?? null,
      query: o.query ?? "",
      // A saved order that differs from the standard one is restored; columns
      // the preset left out go after it.
      order:
        o.columns &&
        o.columns.join("|") !==
          e.columns.filter((c: string) => o.columns.includes(c)).join("|")
          ? [
              ...o.columns.filter((c: string) => e.columns.includes(c)),
              ...e.columns.filter((c) => !o.columns.includes(c)),
            ]
          : null,
      locations: o.locations ?? null,
      metafields: (o.metafields ?? []).join(", "),
      variantMetafields: (o.variantMetafields ?? []).join(", "),
    };
  }
  return state;
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

export function opLabel(field: FilterField, op: FilterOp): string {
  if (field.type === "date")
    return (
      { gte: "on or after", lte: "on or before", between: "between" }[
        op as "gte"
      ] ?? OP_LABELS[op]
    );
  if (field.type === "number")
    return { gte: "at least", lte: "at most" }[op as "gte"] ?? OP_LABELS[op];
  return OP_LABELS[op];
}

function newCondition(field: FilterField): FilterCondition {
  return {
    field: field.key,
    op: FILTER_OPS[field.type][0],
    value: field.type === "boolean" ? "true" : "",
  };
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
      <s-select
        label="Value"
        labelAccessibilityVisibility="exclusive"
        value={cond.value}
        onChange={(ev: any) => onChange({ value: ev.currentTarget.value })}
      >
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
                  value: (ev.currentTarget.checked
                    ? [...selected, o.value]
                    : selected.filter((v) => v !== o.value)
                  ).join(","),
                })
              }
            />
          ))}
        </s-stack>
      );
    }
    return (
      <s-select
        label="Value"
        labelAccessibilityVisibility="exclusive"
        value={cond.value}
        placeholder="Choose…"
        onChange={(ev: any) => onChange({ value: ev.currentTarget.value })}
      >
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
      <s-date-field
        key={key}
        label={label}
        labelAccessibilityVisibility="exclusive"
        value={value}
        onChange={(ev: any) => onChange({ [key]: ev.currentTarget.value })}
      />
    ) : field.type === "number" ? (
      <s-number-field
        key={key}
        label={label}
        labelAccessibilityVisibility="exclusive"
        value={value}
        onInput={(ev: any) => onChange({ [key]: ev.currentTarget.value })}
      />
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
  const update = (i: number, patch: Partial<FilterCondition>) =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <s-stack direction="block" gap="base">
      {filters.map((cond, i) => {
        const field = byKey.get(cond.field)!;
        return (
          <s-grid
            key={i}
            gridTemplateColumns="minmax(160px, 1fr) minmax(140px, 0.8fr) 2fr auto"
            gap="base"
            alignItems="center"
          >
            <s-select
              label="Field"
              labelAccessibilityVisibility="exclusive"
              value={cond.field}
              onChange={(ev: any) => {
                const f = byKey.get(ev.currentTarget.value)!;
                onChange(
                  filters.map((x, j) => (j === i ? newCondition(f) : x)),
                );
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
                onChange={(ev: any) =>
                  update(i, {
                    op: ev.currentTarget.value,
                    ...(field.type === "enum" ? { value: "" } : {}),
                  })
                }
              >
                {FILTER_OPS[field.type].map((op) => (
                  <s-option key={op} value={op}>
                    {opLabel(field, op)}
                  </s-option>
                ))}
              </s-select>
            )}
            <FilterValue
              field={field}
              cond={cond}
              onChange={(patch) => update(i, patch)}
            />
            <s-button
              variant="tertiary"
              icon="delete"
              accessibilityLabel="Remove filter"
              onClick={() => onChange(filters.filter((_, j) => j !== i))}
            />
          </s-grid>
        );
      })}
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-button
          icon="plus"
          onClick={() =>
            onChange([...filters, newCondition(entity.filters[0])])
          }
        >
          Add filter
        </s-button>
        {filters.some((f) => f.value) ? (
          <s-text tone="neutral">
            Shopify search:{" "}
            <code>
              {compileFilters(
                filters.filter(
                  (f) => f.value && (f.op !== "between" || f.value2),
                ),
              )}
            </code>
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
  const field =
    value?.field ??
    (dateFields.find((f) => f.key === "created_at") ?? dateFields[0]).key;
  return (
    <s-grid
      gridTemplateColumns={
        value?.preset === "custom" ? "1fr 1fr 1fr 1fr" : "1fr 1fr 2fr"
      }
      gap="base"
      alignItems="end"
    >
      <s-select
        label="Date"
        value={field}
        onChange={(ev: any) =>
          onChange(value ? { ...value, field: ev.currentTarget.value } : null)
        }
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
          onChange(
            preset ? { field, preset, from: value?.from, to: value?.to } : null,
          );
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
          <s-date-field
            label="From"
            value={value.from ?? ""}
            onChange={(ev: any) =>
              onChange({ ...value, from: ev.currentTarget.value })
            }
          />
          <s-date-field
            label="To"
            value={value.to ?? ""}
            onChange={(ev: any) =>
              onChange({ ...value, to: ev.currentTarget.value })
            }
          />
        </>
      ) : (
        <span />
      )}
    </s-grid>
  );
}

const SECTION_NAMES: Record<string, string> = {
  Fulfillment: "Fulfillments",
  Price: "Prices",
  Tax: "Taxes",
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
export function columnSections(
  entity: EntityInfo,
): Array<{ name: string; columns: string[] }> {
  const sections: Array<{ name: string; columns: string[] }> = [];
  for (const c of entity.columns) {
    const m =
      /^([^:]+):/.exec(c) ??
      /^(Variant|Image|Option\d|Address|Line|Location|Contact|Item|Rule|Transaction)\b/.exec(
        c,
      );
    const prefix = m
      ? m[1].replace(/^Option\d$/, "Variant").replace(/^Tax \d+$/, "Tax")
      : "";
    // Current product/variant data of order lines is its own (slower) section.
    const name = /^Line: (Product (Type|Tags)|Variant (?!ID$|Title$))/.test(c)
      ? "Line items product data"
      : prefix
        ? (SECTION_NAMES[prefix] ?? prefix)
        : "Basic columns";
    const found = sections.find((x) => x.name === name);
    if (found) found.columns.push(c);
    else sections.push({ name, columns: [c] });
  }
  // Basic columns first.
  sections.sort(
    (a, b) =>
      Number(b.name === "Basic columns") - Number(a.name === "Basic columns"),
  );
  return sections;
}

/** Data groups that add API work per item and so make exports slower. */
const isSlowGroup = (key: string) =>
  /metafield|inventory|publication|transaction|item|browser/.test(key);

function Section({
  title,
  checked,
  indeterminate,
  onToggle,
  badge,
  count,
  children,
}: {
  title: string;
  checked: boolean;
  indeterminate?: boolean;
  onToggle: (on: boolean) => void;
  badge?: string;
  /** Selection summary shown on the right, e.g. "3 of 22 columns". */
  count?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <s-box padding="small small-200">
      <s-stack direction="block" gap="base">
        <s-stack
          direction="inline"
          gap="base"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-checkbox
              label={title}
              checked={checked}
              indeterminate={indeterminate}
              onChange={(ev: any) => onToggle(ev.currentTarget.checked)}
            />
            {badge ? <s-badge>{badge}</s-badge> : null}
          </s-stack>
          <s-stack direction="inline" gap="small" alignItems="center">
            {count ? (
              <s-badge tone={indeterminate ? "warning" : "neutral"}>
                {count}
              </s-badge>
            ) : null}
            {children ? (
              <s-button
                variant="tertiary"
                icon={open ? "chevron-up" : "chevron-down"}
                accessibilityLabel={
                  open ? `Collapse ${title}` : `Expand ${title}`
                }
                onClick={() => setOpen(!open)}
              />
            ) : null}
          </s-stack>
        </s-stack>
        {open && children ? (
          <s-box padding="small none base large-200">{children}</s-box>
        ) : null}
      </s-stack>
    </s-box>
  );
}

const firstWord = (t: string) =>
  t
    .toLowerCase()
    .split(/[^a-z]+/)
    .find(Boolean)
    ?.replace(/s$/, "") ?? "";

/** Column checklist: master checkbox, then collapsible sections of columns and extra data. */
function ColumnPicker({
  entity,
  columns,
  groups,
  onChange,
  state,
}: {
  entity: EntityInfo;
  columns: string[];
  groups: string[];
  onChange: (patch: Partial<EntityState>) => void;
  state: EntityState;
}) {
  // Nothing is forced: key columns can be left out for report-style exports.
  const required = new Set<string>();
  const keyColumns = ["ID", ...entity.keyColumns];
  const missingKeys = keyColumns.every((c) => !columns.includes(c));
  const storeLocations = useLocations(
    entity.groups.some((g) => g.key === "inventory") &&
      groups.includes("inventory"),
  );
  // A data group ("Variants & options") that matches a column section ("Variants")
  // is merged into it: the section's checkbox then also controls fetching that data.
  const sections = useMemo(() => {
    const secs = columnSections(entity).map((sec) => ({
      ...sec,
      group: undefined as undefined | { key: string; label: string },
    }));
    const extra: Array<{ key: string; label: string }> = [];
    for (const g of entity.groups) {
      const sec =
        secs.find(
          (x) => !x.group && x.name.toLowerCase() === g.label.toLowerCase(),
        ) ??
        secs.find((x) => !x.group && firstWord(x.name) === firstWord(g.label));
      if (sec) sec.group = g;
      else extra.push(g);
    }
    return { secs, extra };
  }, [entity]);
  const optional = entity.columns.filter((c) => !required.has(c));
  const selected = entity.columns.filter(
    (c) => required.has(c) || columns.includes(c),
  ).length;
  const allGroups = entity.groups.every((g) => groups.includes(g.key));
  const all = selected === entity.columns.length && allGroups;
  const setGroup = (list: string[], key: string, on: boolean) =>
    on ? [...new Set([...list, key])] : list.filter((x) => x !== key);

  return (
    <s-stack direction="block" gap="none">
      <s-box background="subdued" borderRadius="base" padding="small base">
        <s-checkbox
          label={`${selected} of ${entity.columns.length} columns selected`}
          checked={all}
          indeterminate={
            !all && (selected > required.size || groups.length > 0)
          }
          onChange={(ev: any) => {
            const on = ev.currentTarget.checked;
            onChange({
              columns: on
                ? [...new Set([...columns, ...optional])]
                : columns.filter((c) => !optional.includes(c)),
              // Select all / none covers every data row too (inventory, metafields…).
              groups: on ? entity.groups.map((g) => g.key) : [],
            });
          }}
        />
      </s-box>
      {sections.secs.map((sec) => {
        const opt = sec.columns.filter((c) => !required.has(c));
        const groupOn = !sec.group || groups.includes(sec.group.key);
        const on = groupOn ? opt.filter((c) => columns.includes(c)).length : 0;
        const toggleSection = (v: boolean) =>
          onChange({
            columns: v
              ? [...new Set([...columns, ...opt])]
              : columns.filter((c) => !opt.includes(c)),
            ...(sec.group
              ? { groups: setGroup(groups, sec.group.key, v) }
              : {}),
          });
        return (
          <Fragment key={sec.name}>
            <Section
              title={sec.name}
              checked={opt.length > 0 && on === opt.length}
              indeterminate={on > 0 && on < opt.length}
              badge={
                sec.group && isSlowGroup(sec.group.key) ? "Slower" : undefined
              }
              count={
                on === 0
                  ? undefined
                  : on === opt.length
                    ? `${sec.columns.length} columns`
                    : `${on} of ${opt.length} columns`
              }
              onToggle={toggleSection}
            >
              <s-grid
                gridTemplateColumns="repeat(auto-fill, minmax(210px, 1fr))"
                gap="small base"
              >
                {sec.columns.map((c) => (
                  <s-checkbox
                    key={c}
                    label={c}
                    checked={
                      required.has(c) || (groupOn && columns.includes(c))
                    }
                    disabled={required.has(c)}
                    onChange={(ev: any) => {
                      const v = ev.currentTarget.checked;
                      onChange({
                        columns: v
                          ? [...new Set([...columns, c])]
                          : columns.filter((x) => x !== c),
                        // Ticking a column of a switched-off section switches its data on.
                        ...(v && sec.group && !groupOn
                          ? { groups: setGroup(groups, sec.group.key, true) }
                          : {}),
                      });
                    }}
                  />
                ))}
              </s-grid>
            </Section>
            <s-divider />
          </Fragment>
        );
      })}
      {sections.extra.map((g) => (
        <Fragment key={g.key}>
          <Section
            title={g.label}
            checked={groups.includes(g.key)}
            badge={isSlowGroup(g.key) ? "Slower" : undefined}
            count={
              !groups.includes(g.key)
                ? undefined
                : g.key === "inventory" && state.locations
                  ? `${state.locations.length} of ${storeLocations?.length ?? "?"} locations`
                  : g.key === "metafields" && splitList(state.metafields).length
                    ? `${splitList(state.metafields).length} metafields`
                    : g.key === "variant_metafields" &&
                        splitList(state.variantMetafields).length
                      ? `${splitList(state.variantMetafields).length} metafields`
                      : undefined
            }
            onToggle={(v) => onChange({ groups: setGroup(groups, g.key, v) })}
          >
            {g.key === "inventory" ? (
              storeLocations === null ? (
                <s-text tone="neutral">Loading locations…</s-text>
              ) : storeLocations.length === 0 ? (
                <s-text tone="neutral">
                  Could not load locations; all locations will be exported.
                </s-text>
              ) : (
                <s-stack direction="block" gap="small">
                  <s-text tone="neutral">
                    Locations to include as stock columns:
                  </s-text>
                  <s-grid
                    gridTemplateColumns="repeat(auto-fill, minmax(210px, 1fr))"
                    gap="small base"
                  >
                    {storeLocations.map((l) => {
                      const chosen = state.locations ?? storeLocations;
                      return (
                        <s-checkbox
                          key={l}
                          label={l}
                          checked={chosen.includes(l)}
                          onChange={(ev: any) => {
                            const next = ev.currentTarget.checked
                              ? [...chosen, l]
                              : chosen.filter((x) => x !== l);
                            onChange({
                              locations:
                                next.length === storeLocations.length
                                  ? null
                                  : next,
                              groups: setGroup(groups, g.key, true),
                            });
                          }}
                        />
                      );
                    })}
                  </s-grid>
                </s-stack>
              )
            ) : g.key === "metafields" || g.key === "variant_metafields" ? (
              <s-text-field
                label="Only these metafields (optional)"
                details="namespace.key, separated by commas, e.g. custom.material, custom.care. Leave empty for all."
                value={
                  g.key === "metafields"
                    ? state.metafields
                    : state.variantMetafields
                }
                onInput={(ev: any) =>
                  onChange(
                    g.key === "metafields"
                      ? { metafields: ev.currentTarget.value }
                      : { variantMetafields: ev.currentTarget.value },
                  )
                }
              />
            ) : undefined}
          </Section>
          <s-divider />
        </Fragment>
      ))}
      <s-box padding="base none none small-200">
        <s-text tone={missingKeys ? "caution" : "neutral"}>
          {missingKeys
            ? `Without ${keyColumns.join(" or ")} this file can't be imported back. Fine for reports.`
            : `Keep ${keyColumns.join(" or ")} if you plan to import the file back.`}
        </s-text>
      </s-box>
    </s-stack>
  );
}

let locationsCache: string[] | null = null;

/** Store's active location names (fetched once); null while loading. */
function useLocations(enabled: boolean): string[] | null {
  const [list, setList] = useState<string[] | null>(locationsCache);
  useEffect(() => {
    if (!enabled || locationsCache) return;
    let live = true;
    fetch("/app/api/locations")
      .then((r) => (r.ok ? r.json() : { locations: [] }))
      .then((d) => {
        if (d.locations?.length) locationsCache = d.locations;
        if (live) setList(d.locations ?? []);
      })
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [enabled]);
  return list;
}

/**
 * The selected columns as chips, in file order. Drag a chip (or focus it and
 * press the left / right arrow keys) to move it.
 */
function ColumnOrder({
  entity,
  columns,
  order,
  onChange,
}: {
  entity: EntityInfo;
  columns: string[];
  order: string[] | null;
  onChange: (order: string[] | null) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const full = order ?? entity.columns;
  const shown = full.filter((c) => columns.includes(c));
  // Moves `col` to sit just before `before` (or to the end) within the full order.
  const move = (col: string, before: string | null) => {
    if (col === before) return;
    const next = full.filter((c) => c !== col);
    const at = before ? next.indexOf(before) : next.length;
    next.splice(at < 0 ? next.length : at, 0, col);
    onChange(next);
  };
  const nudge = (col: string, dir: -1 | 1) => {
    const i = shown.indexOf(col);
    const j = i + dir;
    if (j < 0 || j >= shown.length) return;
    // Moving right means landing after the neighbour, i.e. before the one after it.
    move(col, dir === -1 ? shown[j] : (shown[j + 1] ?? null));
  };
  return (
    <s-stack direction="block" gap="small">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-text tone="neutral">
          Drag to change the order of the columns in the file.
        </s-text>
        {order ? (
          <s-button variant="tertiary" onClick={() => onChange(null)}>
            Reset order
          </s-button>
        ) : null}
      </s-stack>
      <div className="bp-chips" role="list">
        {shown.map((c) => (
          <div
            key={c}
            role="listitem"
            tabIndex={0}
            draggable
            className={`bp-chip${dragging === c ? " bp-chip-dragging" : ""}${over === c && dragging !== c ? " bp-chip-over" : ""}`}
            aria-label={`${c}. Use the left and right arrow keys to move.`}
            onDragStart={(ev) => {
              setDragging(c);
              ev.dataTransfer.effectAllowed = "move";
              ev.dataTransfer.setData("text/plain", c);
            }}
            onDragOver={(ev) => {
              ev.preventDefault();
              setOver(c);
            }}
            onDrop={(ev) => {
              ev.preventDefault();
              if (dragging) move(dragging, c);
              setDragging(null);
              setOver(null);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onKeyDown={(ev) => {
              if (ev.key === "ArrowLeft") nudge(c, -1);
              if (ev.key === "ArrowRight") nudge(c, 1);
            }}
          >
            <span aria-hidden="true" className="bp-grip">
              ⠿
            </span>
            {c}
          </div>
        ))}
      </div>
    </s-stack>
  );
}

/** Export options for one entity panel, as sent to the server. */
function panelOptions(e: EntityInfo, s: EntityState) {
  const allColumns = e.columns.every((c) => s.columns.includes(c)) && !s.order;
  // Sent in display order: the custom order if there is one, else the standard order.
  const ordered = (s.order ?? e.columns).filter((c) => s.columns.includes(c));
  const filters = s.filters.filter(
    (f) => f.value && (f.op !== "between" || f.value2),
  );
  return {
    groups: e.groups.length ? s.groups : undefined,
    columns: allColumns ? undefined : ordered,
    filters: filters.length ? filters : undefined,
    dateRange: s.dateRange ?? undefined,
    query: s.query || undefined,
    locations:
      s.groups.includes("inventory") && s.locations ? s.locations : undefined,
    metafields: splitList(s.metafields).length
      ? splitList(s.metafields)
      : undefined,
    variantMetafields: splitList(s.variantMetafields).length
      ? splitList(s.variantMetafields)
      : undefined,
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
        const r = data?.result as
          | { count: number; precision: string; unfiltered?: boolean }
          | null
          | undefined;
        if (!r) return setLabel(null);
        const n = r.count.toLocaleString();
        setLabel(
          `Total: ${r.precision === "AT_LEAST" ? `${n}+` : n}${r.unfiltered ? " (before filters)" : ""}`,
        );
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
    <s-section>
      <s-box padding="small base">
        <s-stack direction="block" gap="large">
          <s-stack
            direction="inline"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-heading>{e.sheet}</s-heading>
              {total ? <s-badge>{total}</s-badge> : null}
            </s-stack>
            <s-stack direction="inline" gap="small-200">
              <s-button
                variant="tertiary"
                icon={s.open ? "chevron-up" : "chevron-down"}
                accessibilityLabel={
                  s.open ? `Collapse ${e.sheet}` : `Expand ${e.sheet}`
                }
                onClick={() => update({ open: !s.open })}
              />
              <s-button
                variant="tertiary"
                icon="delete"
                accessibilityLabel={`Remove ${e.sheet}`}
                onClick={() => update({ enabled: false })}
              />
            </s-stack>
          </s-stack>
          {s.open ? (
            <>
              <s-text tone="neutral">{e.description}</s-text>
              {e.filters.length ? (
                <>
                  <s-divider />
                  <s-stack direction="block" gap="base">
                    <s-heading>Filters</s-heading>
                    <DateRangeFilter
                      entity={e}
                      value={s.dateRange}
                      onChange={(dateRange) => update({ dateRange })}
                    />
                    <FilterBuilder
                      entity={e}
                      filters={s.filters}
                      onChange={(filters) => update({ filters })}
                    />
                  </s-stack>
                </>
              ) : null}
              {e.supportsQuery ? (
                advanced ? (
                  <s-text-field
                    label="Shopify search query"
                    details="Added to the filters above with AND, e.g. tag:sale OR tag:clearance"
                    value={s.query}
                    onInput={(ev: any) =>
                      update({ query: ev.currentTarget.value })
                    }
                  />
                ) : (
                  <s-stack direction="inline">
                    <s-button
                      variant="tertiary"
                      onClick={() => setAdvanced(true)}
                    >
                      Advanced search query
                    </s-button>
                  </s-stack>
                )
              ) : null}
              <s-divider />
              <s-stack direction="block" gap="base">
                <s-heading>Columns</s-heading>
                <ColumnPicker
                  entity={e}
                  columns={s.columns}
                  groups={s.groups}
                  state={s}
                  onChange={(patch) => update(patch)}
                />
                <s-heading>Column order</s-heading>
                <ColumnOrder
                  entity={e}
                  columns={s.columns}
                  order={s.order}
                  onChange={(order) => update({ order })}
                />
              </s-stack>
            </>
          ) : null}
        </s-stack>
      </s-box>
    </s-section>
  );
}

/**
 * The export builder: data types, filters, columns, file format and schedule.
 * Used on the home page and on /app/export; posts to the /app/export action.
 */
interface SavedPreset {
  id: string;
  name: string;
  data: PresetData;
}

export function ExportForm({
  entities,
  presets: initialPresets = [],
  latest = null,
}: {
  entities: EntityInfo[];
  presets?: SavedPreset[];
  latest?: PresetData | null;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const [presets, setPresets] = useState(initialPresets);
  // "latest" | "blank" | preset id
  const [presetId, setPresetId] = useState(latest ? "latest" : "blank");
  const [presetName, setPresetName] = useState("");
  const [presetMsg, setPresetMsg] = useState<{
    tone: "success" | "critical";
    text: string;
  } | null>(null);
  const [state, setState] = useState<Record<string, EntityState>>(() =>
    latest
      ? stateFromPreset(entities, latest)
      : blankState(entities, ["products"]),
  );
  const [format, setFormat] = useState(
    latest?.format === "csv" ? "csv" : "xlsx",
  );
  const [name, setName] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [uploadUrl, setUploadUrl] = useState("");
  const [publicLink, setPublicLink] = useState(true);

  const selected = useMemo(
    () => entities.filter((e) => state[e.key].enabled),
    [entities, state],
  );
  const available = entities.filter((e) => !state[e.key].enabled);
  const update = (key: string, patch: Partial<EntityState>) =>
    setState((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  const busy = fetcher.state !== "idle";
  const currentPreset = presets.find((p) => p.id === presetId);

  const loadPreset = (id: string) => {
    setPresetId(id);
    setPresetMsg(null);
    const data =
      id === "latest" ? latest : presets.find((p) => p.id === id)?.data;
    setState(data ? stateFromPreset(entities, data) : blankState(entities));
    if (data) setFormat(data.format === "csv" ? "csv" : "xlsx");
    setPresetName(presets.find((p) => p.id === id)?.name ?? "");
  };

  const presetRequest = async (body: Record<string, unknown>) => {
    try {
      const res = await fetch("/app/api/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error)
        return setPresetMsg({ tone: "critical", text: data.error });
      setPresets(data.presets);
      return data as { savedId?: string };
    } catch {
      setPresetMsg({
        tone: "critical",
        text: "Could not reach the server. Try again.",
      });
    }
  };

  const savePreset = async () => {
    const name = presetName.trim();
    const data = {
      format,
      entities: selected.map((e) => ({
        entity: e.key,
        options: panelOptions(e, state[e.key]),
      })),
    };
    const result = await presetRequest({ intent: "save", name, data });
    if (result?.savedId) {
      setPresetId(result.savedId);
      setPresetMsg({ tone: "success", text: `Saved preset "${name}".` });
    }
  };

  const deleteCurrentPreset = async () => {
    if (!currentPreset) return;
    const result = await presetRequest({
      intent: "delete",
      id: currentPreset.id,
    });
    if (result) {
      setPresetMsg({
        tone: "success",
        text: `Deleted preset "${currentPreset.name}".`,
      });
      setPresetId("blank");
      setPresetName("");
    }
  };

  const submit = () => {
    const payload: ExportPayload = {
      format,
      name,
      entities: selected.map((e) => ({
        entity: e.key,
        options: panelOptions(e, state[e.key]),
      })),
      ...(scheduled
        ? {
            schedule: {
              intervalMinutes,
              uploadUrl: uploadUrl || undefined,
              publicLink,
            },
          }
        : {}),
    };
    fetcher.submit(payload as any, {
      method: "post",
      encType: "application/json",
      action: "/app/export",
    });
  };

  return (
    <>
      {fetcher.data?.error ? (
        <s-banner tone="critical" heading="Could not start export">
          {fetcher.data.error}
        </s-banner>
      ) : null}

      <s-section heading="Preset">
        <s-stack direction="block" gap="base">
          <s-grid
            gridTemplateColumns="1fr 1fr auto auto"
            gap="base"
            alignItems="end"
          >
            <s-select
              label="Start from"
              value={presetId}
              onChange={(ev: any) => loadPreset(ev.currentTarget.value)}
            >
              {latest ? (
                <s-option value="latest">Latest export</s-option>
              ) : null}
              <s-option value="blank">New blank export</s-option>
              {presets.length ? (
                <s-option-group label="Saved">
                  {presets.map((p) => (
                    <s-option key={p.id} value={p.id}>
                      {p.name}
                    </s-option>
                  ))}
                </s-option-group>
              ) : null}
            </s-select>
            <s-text-field
              label="Save current set-up as"
              placeholder="Preset name"
              value={presetName}
              onInput={(ev: any) => setPresetName(ev.currentTarget.value)}
            />
            <s-button
              onClick={savePreset}
              disabled={!presetName.trim() || !selected.length}
            >
              {presets.some((p) => p.name === presetName.trim())
                ? "Update preset"
                : "Save preset"}
            </s-button>
            {currentPreset ? (
              <s-button
                variant="tertiary"
                tone="critical"
                onClick={deleteCurrentPreset}
              >
                Delete
              </s-button>
            ) : (
              <span />
            )}
          </s-grid>
          {presetMsg ? (
            <s-text tone={presetMsg.tone}>{presetMsg.text}</s-text>
          ) : null}
        </s-stack>
      </s-section>

      <s-box padding="base small-200 none small-200">
        <s-grid
          gridTemplateColumns="1fr minmax(220px, 280px)"
          gap="base"
          alignItems="center"
        >
          <s-heading>Data to export</s-heading>
          {available.length ? (
            <s-select
              key={available.map((e) => e.key).join(",")}
              label="Add data type"
              labelAccessibilityVisibility="exclusive"
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
          ) : (
            <span />
          )}
        </s-grid>
      </s-box>
      {selected.length === 0 ? (
        <s-section>
          <s-text tone="neutral">
            Nothing selected yet. Add a data type to start.
          </s-text>
        </s-section>
      ) : null}
      {selected.map((e) => (
        <EntityPanel
          key={e.key}
          entity={e}
          state={state[e.key]}
          update={(patch) => update(e.key, patch)}
        />
      ))}

      <s-section heading="File">
        <s-stack direction="block" gap="base">
          <s-select
            label="Format"
            value={format}
            onChange={(ev: any) => setFormat(ev.currentTarget.value)}
          >
            <s-option value="xlsx">
              Excel (.xlsx), one sheet per data type
            </s-option>
            <s-option value="csv">
              CSV (.csv, zipped when several data types)
            </s-option>
          </s-select>
          <s-text-field
            label="File name (optional)"
            value={name}
            placeholder={`Export_${new Date().toISOString().slice(0, 10)}`}
            onInput={(ev: any) => setName(ev.currentTarget.value)}
          />
          <s-switch
            label="Repeat this export on a schedule"
            checked={scheduled}
            onChange={(ev: any) => setScheduled(ev.currentTarget.checked)}
          />
          {scheduled ? (
            <>
              <s-select
                label="How often"
                value={String(intervalMinutes)}
                onChange={(ev: any) =>
                  setIntervalMinutes(Number(ev.currentTarget.value))
                }
              >
                {INTERVALS.map((i) => (
                  <s-option key={i.value} value={String(i.value)}>
                    {i.label}
                  </s-option>
                ))}
              </s-select>
              <s-switch
                label="Permanent link (URL) to the latest file"
                details="One fixed address for this export. Every run overwrites the file it serves."
                checked={publicLink}
                onChange={(ev: any) => setPublicLink(ev.currentTarget.checked)}
              />
              {publicLink ? (
                <s-text
                  tone={
                    selected.some((e) => PERSONAL_DATA.includes(e.key))
                      ? "critical"
                      : "neutral"
                  }
                >
                  {selected.some((e) => PERSONAL_DATA.includes(e.key))
                    ? "This export contains customer data. Anyone who has the link can download names, emails and addresses without logging in. Turn the link off unless you need it."
                    : "Anyone who has the link can download the file without logging in. You'll find the link on the Schedules page."}
                </s-text>
              ) : null}
              <s-url-field
                label="Upload to FTP (optional)"
                details="ftp://user:password@host/folder/ — the file is also kept in the app"
                value={uploadUrl}
                onInput={(ev: any) => setUploadUrl(ev.currentTarget.value)}
              />
            </>
          ) : null}
          <s-stack direction="inline" justifyContent="end">
            <s-button
              variant="primary"
              onClick={submit}
              disabled={!selected.length || busy}
              loading={busy}
            >
              {scheduled
                ? "Save schedule"
                : `Export ${selected.map((e) => e.sheet).join(", ") || "…"}`}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </>
  );
}
