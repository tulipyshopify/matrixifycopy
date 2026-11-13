import type { Command, DateRange, FilterCondition, Row } from "./types";
import { isValidTimeZone, localParts, zonedTimeToUtc } from "./time";
import { COMMANDS, ImportError } from "./types";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** gid://shopify/Product/123 -> "123", gid://shopify/TaxonomyCategory/aa-1 -> "aa-1" */
export function gidToId(gid: string | null | undefined): string {
  if (!gid) return "";
  if (!gid.startsWith("gid://")) return gid;
  const m = /^gid:\/\/shopify\/[^/]+\/([^?]+)/.exec(gid);
  return m ? m[1] : gid;
}

/** ("Product", "123") -> gid://shopify/Product/123, passes through existing GIDs. */
export function toGid(type: string, id: string | number | null | undefined): string | undefined {
  if (id === null || id === undefined) return undefined;
  const s = String(id).trim();
  if (!s) return undefined;
  if (s.startsWith("gid://")) return s;
  if (!/^\d+$/.test(s)) throw new ImportError(`Invalid ${type} ID "${s}"`);
  return `gid://shopify/${type}/${s}`;
}

/** gid://shopify/MediaImage/1 -> "MediaImage" */
export function gidType(gid: string): string {
  const m = /^gid:\/\/shopify\/([^/]+)\//.exec(gid);
  return m ? m[1] : "";
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function has(row: Row, col: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, col);
}

/** Cell value, or undefined when the column is absent (as opposed to blank). */
export function cell(row: Row, col: string): string | undefined {
  return has(row, col) ? (row[col] ?? "").trim() : undefined;
}

export function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "") return undefined;
  if (["true", "yes", "y", "1", "on"].includes(s)) return true;
  if (["false", "no", "n", "0", "off"].includes(s)) return false;
  throw new ImportError(`Expected TRUE or FALSE but got "${v}"`);
}

export function boolCell(b: boolean | null | undefined): string {
  if (b === null || b === undefined) return "";
  return b ? "TRUE" : "FALSE";
}

export function parseNumber(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v.replace(/,/g, "").trim());
  if (Number.isNaN(n)) throw new ImportError(`Expected a number but got "${v}"`);
  return n;
}

export function parseInt10(v: string | undefined): number | undefined {
  const n = parseNumber(v);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) throw new ImportError(`Expected a whole number but got "${v}"`);
  return n;
}

export function splitTags(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function joinTags(tags: string[] | null | undefined): string {
  return (tags ?? []).join(", ");
}

/** Parse the "Command" column; falls back to the default command. */
export function parseCommand(v: string | undefined, fallback: Command): Command {
  const s = (v ?? "").trim().toUpperCase();
  if (!s) return fallback;
  if ((COMMANDS as string[]).includes(s)) return s as Command;
  throw new ImportError(`Unknown command "${v}"`);
}

/** Generic sub-command (Image Command, Variant Command, Tags Command...). */
export function parseSubCommand<T extends string>(
  v: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const s = (v ?? "").trim().toUpperCase();
  if (!s) return fallback;
  if ((allowed as readonly string[]).includes(s)) return s as T;
  throw new ImportError(`Unknown command "${v}", expected one of ${allowed.join(", ")}`);
}

// --- Metafield columns -------------------------------------------------------

export interface MetafieldColumn {
  prefix: string;
  namespace: string;
  key: string;
  type: string;
}

/**
 * Parses headers like `Metafield: custom.color [single_line_text_field]`.
 * The type is optional on import (defaults to single_line_text_field).
 */
export function parseMetafieldColumn(header: string, prefix = "Metafield"): MetafieldColumn | null {
  const re = new RegExp(`^${prefix}:\\s*([^.\\s]+)\\.([^\\s\\[]+)\\s*(?:\\[([^\\]]+)\\])?\\s*$`);
  const m = re.exec(header.trim());
  if (!m) return null;
  return { prefix, namespace: m[1], key: m[2], type: m[3] ?? "single_line_text_field" };
}

export function metafieldColumn(prefix: string, mf: { namespace: string; key: string; type: string }) {
  return `${prefix}: ${mf.namespace}.${mf.key} [${mf.type}]`;
}

/** Converts exported metafield value into the cell (lists one per line). */
export function metafieldToCell(type: string, value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (type.startsWith("list.")) {
    try {
      const arr = JSON.parse(value);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string" || typeof x === "number")) {
        return arr.join("\n");
      }
    } catch {
      // fall through and export raw
    }
  }
  return value;
}

/** Converts a cell back to a metafield value accepted by the API. */
export function cellToMetafieldValue(type: string, cellValue: string): string {
  const v = cellValue.trim();
  if (type.startsWith("list.") && !v.startsWith("[")) {
    const items = v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return JSON.stringify(type === "list.number_integer" ? items.map(Number) : items);
  }
  if (type === "boolean") return String(parseBool(v) ?? false);
  return v;
}

/**
 * Collects metafield inputs from a row for the given column prefix. Blank cells
 * delete the metafield on merge, but only if `deleteBlank` is set; otherwise
 * they are skipped.
 */
export function metafieldsFromRow(
  row: Row,
  prefix = "Metafield",
): { set: Array<{ namespace: string; key: string; type: string; value: string }>; blank: MetafieldColumn[] } {
  const set: Array<{ namespace: string; key: string; type: string; value: string }> = [];
  const blank: MetafieldColumn[] = [];
  for (const header of Object.keys(row)) {
    const col = parseMetafieldColumn(header, prefix);
    if (!col) continue;
    const v = (row[header] ?? "").trim();
    if (v === "") blank.push(col);
    else set.push({ namespace: col.namespace, key: col.key, type: col.type, value: cellToMetafieldValue(col.type, v) });
  }
  return { set, blank };
}

/** Export helper: flattens a metafields connection into columns on the row. */
export function metafieldsToRow(row: Row, metafields: any[] | undefined, prefix = "Metafield") {
  for (const mf of metafields ?? []) {
    if (!mf?.namespace) continue;
    row[metafieldColumn(prefix, mf)] = metafieldToCell(mf.type, mf.value);
  }
}

// --- Concurrency ------------------------------------------------------------

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Throws ImportError if a mutation payload has userErrors. */
export function assertNoUserErrors(payload: any, what: string) {
  const errs = payload?.userErrors ?? [];
  if (errs.length) {
    const msg = errs
      .map((e: any) => (e.field?.length ? `${e.field.join(".")}: ` : "") + e.message)
      .join("; ");
    throw new ImportError(`${what}: ${msg}`);
  }
}

/** Quotes a value for Shopify search syntax. */
function searchValue(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Escapes a bare term (used with a trailing wildcard, which can't be quoted). */
function bareTerm(v: string): string {
  return v.replace(/([\\:()"'\s*])/g, "\\$1");
}

/** Turns a date or datetime cell into a quoted Shopify search date. */
function searchDate(v: string): string {
  return `'${v.replace(/'/g, "")}'`;
}

/**
 * Compiles structured filters to Shopify search syntax. Conditions are AND-ed;
 * values are quoted so user input can't change the query structure.
 */
/** `namespace.key=value` (or `namespace.key: value`). */
export const METAFIELD_FILTER = /^([\w-]+)\.([\w-]+)\s*[=:]\s*(.+)$/;

export function compileFilters(filters: FilterCondition[] | undefined): string {
  const parts: string[] = [];
  for (const f of filters ?? []) {
    // Checked by the export itself (see FilterField.local).
    if (f.local) continue;
    let k = f.field;
    let v = (f.value ?? "").trim();
    // "namespace.key=value" searches a metafield.
    if (k === "metafield") {
      const m = METAFIELD_FILTER.exec(v);
      if (!m) continue;
      k = `metafields.${m[1]}.${m[2]}`;
      v = m[3].trim();
    }
    switch (f.op) {
      case "is":
        parts.push(/^(true|false)$/.test(v) || /^-?\d+(\.\d+)?$/.test(v) ? `${k}:${v}` : `${k}:${searchValue(v)}`);
        break;
      case "is_not":
        parts.push(`-${k}:${searchValue(v)}`);
        break;
      case "starts_with":
        parts.push(`${k}:${bareTerm(v)}*`);
        break;
      case "any_of": {
        const values = v.split(",").map((x) => x.trim()).filter(Boolean);
        parts.push(values.length === 1 ? `${k}:${searchValue(values[0])}` : `(${values.map((x) => `${k}:${searchValue(x)}`).join(" OR ")})`);
        break;
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const sym = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.op];
        parts.push(`${k}:${sym}${/^-?\d+(\.\d+)?$/.test(v) ? v : searchDate(v)}`);
        break;
      }
      case "between": {
        const lo = /^-?\d+(\.\d+)?$/.test(v) ? v : searchDate(v);
        const v2 = (f.value2 ?? "").trim();
        const hi = /^-?\d+(\.\d+)?$/.test(v2) ? v2 : searchDate(v2);
        parts.push(`${k}:>=${lo} AND ${k}:<=${hi}`);
        break;
      }
    }
  }
  return parts.join(" AND ");
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Resolves a date range (preset or custom) to inclusive YYYY-MM-DD bounds.
 * "Today" is the current date in `timeZone` (the shop's), not in UTC.
 */
export function resolveDateRange(r: DateRange, now = new Date(), timeZone = "UTC"): { from?: string; to?: string } {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const local = localParts(now, tz);
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  switch (r.preset) {
    case "today":
      return { from: ymd(day), to: ymd(day) };
    case "yesterday":
      return { from: ymd(addDays(day, -1)), to: ymd(addDays(day, -1)) };
    case "last_7_days":
      return { from: ymd(addDays(day, -6)), to: ymd(day) };
    case "last_30_days":
      return { from: ymd(addDays(day, -29)), to: ymd(day) };
    case "last_90_days":
      return { from: ymd(addDays(day, -89)), to: ymd(day) };
    case "last_n_days":
      return { from: ymd(addDays(day, -(Math.max(1, Math.floor(r.days ?? 1)) - 1))), to: ymd(day) };
    case "last_n":
      // Worked out as exact instants in dateRangeInstants.
      return {};
    case "this_month":
      return { from: ymd(new Date(Date.UTC(y, m, 1))), to: ymd(day) };
    case "last_month":
      return { from: ymd(new Date(Date.UTC(y, m - 1, 1))), to: ymd(new Date(Date.UTC(y, m, 0))) };
    case "this_year":
      return { from: `${y}-01-01`, to: ymd(day) };
    case "last_year":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "custom":
      return { from: r.from || undefined, to: r.to || undefined };
  }
}

/** Midnight at the start of a YYYY-MM-DD date in a time zone, as a UTC timestamp for search. */
export function startOfDay(date: string, timeZone: string, plusDays = 0): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  // Date.UTC normalises day overflow, giving the right calendar date.
  const cal = new Date(Date.UTC(y, m - 1, d + plusDays));
  return zonedTimeToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), 0, 0, timeZone)
    .toISOString()
    .replace(".000Z", "Z");
}

/**
 * Date range as search syntax. Bounds are exact instants (shop-local
 * midnights): with a bare date Shopify takes "<2026-11-01" to include all of
 * 1 November, which made "Last month" pull in the first day of this month.
 */
export function compileDateRange(r: DateRange | undefined, now = new Date(), timeZone = "UTC"): string {
  if (!r) return "";
  const { from, to } = dateRangeInstants(r, now, timeZone);
  const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");
  // A date Shopify can't search by (e.g. when a fulfillment was created):
  // anything that happened to the item since `from` also updated it, so the
  // search is narrowed by that and the export checks the real date itself.
  if (r.searchBy) return from ? `${r.searchBy}:>='${iso(from)}'` : "";
  const parts: string[] = [];
  if (from) parts.push(`${r.field}:>='${iso(from)}'`);
  if (to) parts.push(`${r.field}:<'${iso(to)}'`);
  return parts.join(" AND ");
}

/** The range as instants: `from` inclusive, `to` exclusive. */
export function dateRangeInstants(r: DateRange, now = new Date(), timeZone = "UTC"): { from?: Date; to?: Date } {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  if (r.preset === "last_n") {
    const n = Math.max(1, Math.floor(r.amount ?? 1));
    // Minutes and hours count back from this moment; nothing later is cut off.
    if (r.unit === "minutes") return { from: new Date(now.getTime() - n * 60_000) };
    if (r.unit === "hours") return { from: new Date(now.getTime() - n * 3600_000) };
    const local = localParts(now, tz);
    if (r.unit === "months") {
      // The same day of the month, n months back (Date.UTC evens out short months).
      const d = new Date(Date.UTC(local.year, local.month - 1 - n, local.day));
      return { from: new Date(startOfDay(d.toISOString().slice(0, 10), tz)) };
    }
    // Days: whole days in the shop's time zone, today included.
    return dateRangeInstants({ ...r, preset: "last_n_days", days: n }, now, tz);
  }
  const { from, to } = resolveDateRange(r, now, tz);
  return { from: from ? new Date(startOfDay(from, tz)) : undefined, to: to ? new Date(startOfDay(to, tz, 1)) : undefined };
}

/** Builds a Shopify search query string from export options. */
export function buildSearchQuery(opts: {
  query?: string;
  filters?: FilterCondition[];
  dateRange?: DateRange;
  /** The shop's time zone, used for date ranges. */
  timezone?: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
}): string {
  const parts: string[] = [];
  const dates = compileDateRange(opts.dateRange, new Date(), opts.timezone);
  if (dates) parts.push(dates);
  const compiled = compileFilters(opts.filters);
  if (compiled) parts.push(compiled);
  if (opts.query?.trim()) parts.push(`(${opts.query.trim()})`);
  if (opts.createdAfter) parts.push(`created_at:>='${opts.createdAfter}'`);
  if (opts.createdBefore) parts.push(`created_at:<='${opts.createdBefore}'`);
  if (opts.updatedAfter) parts.push(`updated_at:>='${opts.updatedAfter}'`);
  if (opts.updatedBefore) parts.push(`updated_at:<='${opts.updatedBefore}'`);
  return parts.join(" AND ");
}

/** Escapes a string for safe embedding in a GraphQL string literal. */
export function gqlString(s: string): string {
  return JSON.stringify(s);
}

export function moneyAmount(m: { amount?: string } | null | undefined): string {
  return m?.amount ?? "";
}

/** Returns true when every cell of the row is blank. */
export function isBlankRow(row: Row): boolean {
  return Object.values(row).every((v) => (v ?? "").trim() === "");
}
