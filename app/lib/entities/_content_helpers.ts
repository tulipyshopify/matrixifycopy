import type { Command, Gql, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import { cell, parseBool } from "../core/util";

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
