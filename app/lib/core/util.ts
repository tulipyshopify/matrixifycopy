import type { Command, Row } from "./types";
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

/** Builds a Shopify search query string from export options. */
export function buildSearchQuery(opts: {
  query?: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
}): string {
  const parts: string[] = [];
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
