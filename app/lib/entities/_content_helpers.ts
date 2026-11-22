import type { Command, Gql, ItemPreview, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import { cell, has, parseBool, parseMetafieldColumn, splitTags } from "../core/util";

/**
 * Small helpers shared by the content entities (pages, blog posts, redirects,
 * files, metaobjects, menus, shop). Kept out of core on purpose.
 */

/** Memoises a promise in the job cache so concurrent items share one lookup. */
export function cachedPromise<T>(cache: Map<string, unknown>, key: string, load: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) {
    const p = load();
    cache.set(key, p);
    // Do not cache failures: a later item may retry.
    p.catch(() => cache.delete(key));
  }
  return cache.get(key) as Promise<T>;
}

/**
 * Quotes a value for Shopify search syntax, e.g. `handle:"about-us"`. The
 * result is passed as a GraphQL variable, never interpolated into a document.
 */
export function searchTerm(field: string, value: string): string {
  return `${field}:"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/** Last path segment of a URL without query string, e.g. CDN file names. */
export function fileNameFromUrl(url: string | null | undefined): string {
  if (!url) return "";
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0];
  }
  const name = path.split("/").pop() ?? "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

interface Page<T> {
  nodes: T[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null } | null;
}

/**
 * Pages through a search connection and returns the single node that matches
 * exactly. Shopify search does prefix / fuzzy matching, so the exact match may
 * be on a later page; more than one exact match is an error (`ambiguous`).
 * `after` is only sent from the second page on.
 */
export async function findExact<T>(
  gql: Gql,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: any) => Page<T>,
  isMatch: (node: T) => boolean,
  ambiguous: string,
): Promise<T | null> {
  const matches: T[] = [];
  let after: string | null = null;
  do {
    const conn = pick(await gql(query, after ? { ...variables, after } : variables));
    for (const n of conn.nodes) if (isMatch(n)) matches.push(n);
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  if (matches.length > 1) throw new ImportError(ambiguous);
  return matches[0] ?? null;
}

export interface Done {
  id: string;
  /** Extra notes appended to the result message. */
  notes?: string[];
  rowPatches?: Array<Row | undefined>;
}

export interface CommandOps<E, I> {
  /** Human name used in messages, e.g. "Page". */
  what: string;
  idOf: (existing: E) => string;
  /**
   * Builds and validates everything `create` needs (parsing, required columns,
   * lookups) without changing anything that would be lost. Runs before the
   * delete of REPLACE, so a row that cannot be created never deletes the item.
   */
  prepare: () => Promise<I>;
  /** Sends the create mutation(s) for a prepared input. */
  create: (input: I) => Promise<Done>;
  update: (existing: E) => Promise<Done>;
  remove: (existing: E) => Promise<void>;
  /** Optional override for REPLACE (default: remove then create). */
  replace?: (existing: E) => Promise<Done & { message?: string }>;
  /** Set in a dry run: the item is compared with the store, field by field, and nothing is written. */
  dry?: DryCompare<E>;
}

export interface DryCompare<E> {
  /** The file's top row for this item. */
  row: Row;
  /** The item as it is in the store now, in the same columns an export gives. */
  current: (existing: E) => Promise<Row>;
  name: (existing: E | null) => string;
  /** Columns that are not compared (set by Shopify, or only used to find the item). */
  skip?: string[];
  /** Compare metafield columns too (the store row holds the item's metafields). */
  metafields?: boolean;
  /** Extra warnings, given the file's row and the store's (null for a new item). */
  warn?: (row: Row, store: Row | null) => string[];
}

const NOT_COMPARED = new Set(["ID", "Command", "Created At", "Updated At", "Row #", "Top Row", "Used Count", "Summary", "Display Name"]);
const DATE_LIKE = /^\d{4}-\d\d-\d\d/;
const NUMBER_LIKE = /^-?\d+(\.\d+)?$/;

function shown(v: string): string {
  if (v === "") return "(empty)";
  const flat = v.replace(/\s+/g, " ");
  return flat.length > 70 ? `${flat.slice(0, 67)}…` : flat;
}

function listOf(v: string): string {
  return v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).sort().join(",");
}

/** True when two cells mean the same thing, however they are written (TRUE / true, 10 / 10.0, two spellings of one date). */
export function sameCell(a: string, b: string): boolean {
  if (a === b) return true;
  const x = a.trim();
  const y = b.trim();
  if (x === y) return true;
  const yesNo = (v: string) => (/^(true|yes|y|on)$/i.test(v) ? true : /^(false|no|n|off)$/i.test(v) ? false : undefined);
  const bx = yesNo(x);
  const by = yesNo(y);
  if (bx !== undefined && by !== undefined) return bx === by;
  if (NUMBER_LIKE.test(x) && NUMBER_LIKE.test(y)) return Number(x) === Number(y);
  if (DATE_LIKE.test(x) && DATE_LIKE.test(y)) {
    const dx = Date.parse(x);
    const dy = Date.parse(y);
    if (!Number.isNaN(dx) && !Number.isNaN(dy)) return dx === dy;
  }
  if (x.length < 40 && y.length < 40 && x.toLowerCase() === y.toLowerCase()) return true;
  if ((x.includes(",") || y.includes(",")) && x.length < 2000 && listOf(x) === listOf(y)) return true;
  return false;
}

/**
 * Compares a file row with the same item as the store has it now (both in
 * export columns). Only cells the file would write are compared: a column the
 * file lacks, or a blank that is left alone, changes nothing.
 */
export function diffRows(file: Row, store: Row, opts: { skip?: string[]; metafields?: boolean } = {}): { changes: string[]; clears: string[] } {
  const changes: string[] = [];
  const clears: string[] = [];
  const skip = new Set(opts.skip ?? []);
  let storeMetafields: Map<string, string> | undefined;
  for (const col of Object.keys(file)) {
    if (NOT_COMPARED.has(col) || skip.has(col) || /Command$/.test(col) || !has(file, col)) continue;
    let next = (file[col] ?? "").trim();
    let old: string;
    if (Object.prototype.hasOwnProperty.call(store, col)) {
      old = store[col] ?? "";
    } else {
      const mf = parseMetafieldColumn(col);
      if (!mf || !opts.metafields) continue;
      // The same metafield may be headed with or without its type.
      if (!storeMetafields) {
        storeMetafields = new Map();
        for (const c of Object.keys(store)) {
          const m = parseMetafieldColumn(c);
          if (m) storeMetafields.set(`${m.namespace}.${m.key}`, store[c] ?? "");
        }
      }
      old = storeMetafields.get(`${mf.namespace}.${mf.key}`) ?? "";
    }
    if (col === "Handle" && !next) continue;
    if (col === "Tags") {
      const mode = (cell(file, "Tags Command") ?? "REPLACE").toUpperCase();
      const had = splitTags(old);
      const given = splitTags(next);
      const lower = (t: string[]) => new Set(t.map((x) => x.toLowerCase()));
      const result =
        mode === "MERGE" ? [...had, ...given.filter((t) => !lower(had).has(t.toLowerCase()))] : mode === "DELETE" ? had.filter((t) => !lower(given).has(t.toLowerCase())) : given;
      const added = result.filter((t) => !lower(had).has(t.toLowerCase()));
      const removed = had.filter((t) => !lower(result).has(t.toLowerCase()));
      if (!added.length && !removed.length) continue;
      changes.push(`Tags: ${[added.length ? `adds ${added.join(", ")}` : "", removed.length ? `removes ${removed.join(", ")}` : ""].filter(Boolean).join("; ")}`);
      if (!result.length && had.length) clears.push("Tags");
      continue;
    }
    if (sameCell(old, next)) continue;
    if (next === "" && old !== "") clears.push(col);
    if (old.length > 120 || next.length > 120) {
      changes.push(next === "" ? `${col}: emptied (was ${old.length.toLocaleString("en-GB")} characters)` : `${col}: text changed (${old.length.toLocaleString("en-GB")} → ${next.length.toLocaleString("en-GB")} characters)`);
    } else {
      changes.push(`${col}: ${shown(old)} → ${shown(next)}`);
    }
  }
  return { changes, clears };
}

/** What a new item would be given: the file's filled cells. */
function filledCells(row: Row, skip: string[] = []): string[] {
  const out: string[] = [];
  for (const col of Object.keys(row)) {
    if (NOT_COMPARED.has(col) || skip.includes(col) || /Command$/.test(col) || !has(row, col)) continue;
    const v = (row[col] ?? "").trim();
    if (!v) continue;
    out.push(v.length > 120 ? `${col}: ${v.length.toLocaleString("en-GB")} characters` : `${col}: ${shown(v)}`);
  }
  return out;
}

/** A dry-run write is stopped by the importer; reaching it means the row passed every check before it. */
function stoppedAtWrite(e: unknown): boolean {
  return /^Dry run stopped at /.test((e as any)?.message ?? "");
}

async function dryCommand<E, I>(command: Command, existing: E | null, ops: CommandOps<E, I>, dry: DryCompare<E>): Promise<ItemResult> {
  const what = ops.what.toLowerCase();
  const done = (preview: ItemPreview, e: E | null = existing): ItemResult => ({ status: "OK", command, id: e ? ops.idOf(e) : undefined, title: dry.name(e) || undefined, preview });
  const creates = async (): Promise<ItemResult> => {
    try {
      await ops.prepare();
    } catch (e) {
      // Preparing may create something the item needs (a blog for its post); the rest was checked.
      if (!stoppedAtWrite(e)) throw e;
    }
    return done({ action: "create", changes: filledCells(dry.row, dry.skip), warnings: dry.warn?.(dry.row, null) ?? [], creates: 1 }, null);
  };
  switch (command) {
    case "DELETE":
      if (!existing) return { status: "Failed", command, message: `${ops.what} not found` };
      return done({ action: "delete", changes: [`Deletes the ${what} "${dry.name(existing)}".`], warnings: [], deletes: 1 });
    case "NEW":
      if (existing) return { status: "Failed", command, id: ops.idOf(existing), message: `${ops.what} already exists` };
      return creates();
    case "REPLACE": {
      if (!existing) return creates();
      if (!ops.replace) await ops.prepare();
      const store = await dry.current(existing);
      const d = diffRows(dry.row, store, dry);
      return done({
        action: "replace",
        changes: [`Deletes the ${what} "${dry.name(existing)}" and creates it again from the file: anything the file leaves out is lost.`, ...d.changes],
        warnings: dry.warn?.(dry.row, store) ?? [],
        deletes: 1,
        creates: 1,
      });
    }
    case "UPDATE":
    case "MERGE": {
      if (!existing) {
        if (command === "UPDATE") return { status: "Failed", command, message: `${ops.what} not found` };
        return creates();
      }
      // Runs the update up to its first write, so a row that would be refused is reported as such.
      try {
        await ops.update(existing);
      } catch (e) {
        if (!stoppedAtWrite(e)) throw e;
      }
      const store = await dry.current(existing);
      const d = diffRows(dry.row, store, dry);
      return done({ action: d.changes.length ? "update" : "none", changes: d.changes, warnings: dry.warn?.(dry.row, store) ?? [], ...(d.clears.length ? { clears: d.clears } : {}) });
    }
    default:
      return { status: "Skipped", command };
  }
}

function msg(base: string, notes?: string[]) {
  return [base, ...(notes ?? [])].join("; ");
}

/**
 * Standard Matrixify command semantics, as in products.ts:
 * DELETE needs an existing item; NEW fails if it exists; UPDATE fails if it is
 * missing; MERGE creates or updates; REPLACE prepares the new item, then
 * deletes the old one, then creates.
 */
export async function runCommand<E, I>(command: Command, existing: E | null, ops: CommandOps<E, I>): Promise<ItemResult> {
  if (ops.dry) return dryCommand(command, existing, ops, ops.dry);
  switch (command) {
    case "DELETE": {
      if (!existing) return { status: "Failed", command, message: `${ops.what} not found` };
      await ops.remove(existing);
      return { status: "OK", command, id: ops.idOf(existing), message: "Deleted" };
    }
    case "NEW": {
      if (existing) return { status: "Failed", command, id: ops.idOf(existing), message: `${ops.what} already exists` };
      const r = await ops.create(await ops.prepare());
      return { status: "OK", command, id: r.id, message: msg("Created", r.notes), rowPatches: r.rowPatches };
    }
    case "REPLACE": {
      if (existing && ops.replace) {
        const r = await ops.replace(existing);
        return { status: "OK", command, id: r.id, message: msg(r.message ?? "Replaced", r.notes), rowPatches: r.rowPatches };
      }
      const input = await ops.prepare();
      if (existing) await ops.remove(existing);
      const r = await ops.create(input);
      return { status: "OK", command, id: r.id, message: msg(existing ? "Replaced" : "Created", r.notes), rowPatches: r.rowPatches };
    }
    case "UPDATE":
    case "MERGE": {
      if (!existing) {
        if (command === "UPDATE") return { status: "Failed", command, message: `${ops.what} not found` };
        const r = await ops.create(await ops.prepare());
        return { status: "OK", command, id: r.id, message: msg("Created", r.notes), rowPatches: r.rowPatches };
      }
      const r = await ops.update(existing);
      return { status: "OK", command, id: r.id, message: msg("Updated", r.notes), rowPatches: r.rowPatches };
    }
    default:
      return { status: "Skipped", command };
  }
}

/**
 * Published / Published At columns for online store content (pages, articles):
 * maps to `isPublished` and `publishDate` on the create/update inputs.
 */
export function publishFields(row: Row): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  const published = parseBool(cell(row, "Published"));
  if (published !== undefined) f.isPublished = published;
  const at = cell(row, "Published At");
  if (at && published !== false) f.publishDate = at;
  return f;
}

/** Warnings about what visitors would stop or start seeing. */
export function publishWarnings(row: Row, store: Row | null, what: string): string[] {
  const out: string[] = [];
  let published: boolean | undefined;
  try {
    published = parseBool(cell(row, "Published"));
  } catch {
    published = undefined;
  }
  if (store && published === false && parseBool(store.Published) === true) out.push(`This ${what} is live now and would be hidden from the shop.`);
  if (store && published === true && parseBool(store.Published) === false) out.push(`This ${what} is hidden now and would go live.`);
  const handle = cell(row, "Handle");
  if (store && handle && store.Handle && handle !== store.Handle) out.push(`The address changes from /${store.Handle} to /${handle}. A redirect from the old address is added.`);
  if (store && cell(row, "Body HTML") === "" && (store["Body HTML"] ?? "") !== "") out.push(`The ${what}'s text would be emptied.`);
  return out;
}
