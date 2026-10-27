import type { Command, ItemResult, Row } from "../core/types";
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

export interface Done {
  id: string;
  /** Extra notes appended to the result message. */
  notes?: string[];
  rowPatches?: Array<Row | undefined>;
}

export interface CommandOps<E> {
  /** Human name used in messages, e.g. "Page". */
  what: string;
  idOf: (existing: E) => string;
  create: () => Promise<Done>;
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
 * missing; MERGE creates or updates; REPLACE deletes then creates.
 */
export async function runCommand<E>(command: Command, existing: E | null, ops: CommandOps<E>): Promise<ItemResult> {
  switch (command) {
    case "DELETE": {
      if (!existing) return { status: "Failed", command, message: `${ops.what} not found` };
      await ops.remove(existing);
      return { status: "OK", command, id: ops.idOf(existing), message: "Deleted" };
    }
    case "NEW": {
      if (existing) return { status: "Failed", command, id: ops.idOf(existing), message: `${ops.what} already exists` };
      const r = await ops.create();
      return { status: "OK", command, id: r.id, message: msg("Created", r.notes), rowPatches: r.rowPatches };
    }
    case "REPLACE": {
      if (existing && ops.replace) {
        const r = await ops.replace(existing);
        return { status: "OK", command, id: r.id, message: msg(r.message ?? "Replaced", r.notes), rowPatches: r.rowPatches };
      }
      if (existing) await ops.remove(existing);
      const r = await ops.create();
      return { status: "OK", command, id: r.id, message: msg(existing ? "Replaced" : "Created", r.notes), rowPatches: r.rowPatches };
    }
    case "UPDATE":
    case "MERGE": {
      if (!existing) {
        if (command === "UPDATE") return { status: "Failed", command, message: `${ops.what} not found` };
        const r = await ops.create();
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
