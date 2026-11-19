import type { Command, Entity, ExportContext, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import { assertNoUserErrors, buildSearchQuery, cell, gidToId, gqlString, parseCommand, toGid } from "../core/util";
import { findExact, runCommand, searchTerm } from "./_content_helpers";

// --- Columns --------------------------------------------------------------------

const REDIRECT_COLUMNS = ["ID", "Path", "Command", "Target"];

// --- Export -------------------------------------------------------------------------

// urlRedirects is a plain QueryRoot connection, so it can be exported in bulk.
export function redirectsBulkQuery(search: string): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  return `{
    urlRedirects${args} { edges { node { id path target } } }
  }`;
}

export function redirectToRow(r: any): Row {
  return { ID: gidToId(r.id), Path: r.path ?? "", Command: "MERGE", Target: r.target ?? "" };
}

async function exportRedirects(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  // Search supports path:/target: filters; date options are passed through as for other entities.
  const search = buildSearchQuery(ctx.options);
  let n = 0;
  for await (const r of ctx.bulk(redirectsBulkQuery(search))) {
    await emit([redirectToRow(r)]);
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import ---------------------------------------------------------------------

const REDIRECT_BY_ID = `#graphql
  query ImportRedirectById($id: ID!) {
    urlRedirect(id: $id) { id path target }
  }
`;

const REDIRECT_BY_PATH = `#graphql
  query ImportRedirectByPath($query: String!, $after: String) {
    urlRedirects(first: 50, after: $after, query: $query) {
      nodes { id path target }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const REDIRECT_CREATE = `#graphql
  mutation ImportRedirectCreate($urlRedirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $urlRedirect) {
      urlRedirect { id path target }
      userErrors { field message code }
    }
  }
`;

const REDIRECT_UPDATE = `#graphql
  mutation ImportRedirectUpdate($id: ID!, $urlRedirect: UrlRedirectInput!) {
    urlRedirectUpdate(id: $id, urlRedirect: $urlRedirect) {
      urlRedirect { id path target }
      userErrors { field message code }
    }
  }
`;

const REDIRECT_DELETE = `#graphql
  mutation ImportRedirectDelete($id: ID!) {
    urlRedirectDelete(id: $id) {
      deletedUrlRedirectId
      userErrors { field message code }
    }
  }
`;

interface ExistingRedirect {
  id: string;
  path: string;
  target: string;
}

/** Shopify stores paths with a leading slash and without a trailing one. */
function normalizePath(p: string): string {
  let s = p.trim();
  if (!/^https?:\/\//i.test(s) && !s.startsWith("/")) s = "/" + s;
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

async function fetchRedirect(ctx: ImportContext, row: Row): Promise<ExistingRedirect | null> {
  const id = toGid("UrlRedirect", cell(row, "ID"));
  if (id) {
    const r = (await ctx.gql(REDIRECT_BY_ID, { id })).urlRedirect;
    if (r) return r;
  }
  const path = cell(row, "Path");
  if (!path) return null;
  const wanted = normalizePath(path).toLowerCase();
  // Search is prefix matching; only an exact path counts, on any page.
  return findExact<ExistingRedirect>(
    ctx.gql,
    REDIRECT_BY_PATH,
    { query: searchTerm("path", normalizePath(path)) },
    (d) => d.urlRedirects,
    (r) => normalizePath(r.path).toLowerCase() === wanted,
    `Several redirects have path "${normalizePath(path)}"; use the ID column`,
  );
}

function redirectInput(row: Row): { path?: string; target?: string } {
  const input: { path?: string; target?: string } = {};
  const path = cell(row, "Path");
  if (path) input.path = normalizePath(path);
  const target = cell(row, "Target");
  if (target) input.target = target.trim();
  return input;
}

const TARGET_EXISTS: Record<string, string> = {
  products: `#graphql
    query ImportRedirectTargetProduct($q: String!) { products(first: 1, query: $q) { nodes { id } } }`,
  collections: `#graphql
    query ImportRedirectTargetCollection($q: String!) { collections(first: 1, query: $q) { nodes { id } } }`,
  pages: `#graphql
    query ImportRedirectTargetPage($q: String!) { pages(first: 1, query: $q) { nodes { id } } }`,
};

/** A warning when a target like /products/<handle> points at something the store doesn't have. */
async function deadTarget(ctx: ImportContext, target: string): Promise<string | null> {
  const m = /^\/(products|collections|pages)\/([^/?#]+)\/?$/.exec(target);
  if (!m) return null;
  const key = `redirectTarget:${target.toLowerCase()}`;
  if (!ctx.cache.has(key)) {
    let found = true;
    try {
      const d = await ctx.gql(TARGET_EXISTS[m[1]], { q: `handle:"${m[2].replace(/["\\]/g, "")}"` });
      found = !!d?.[m[1]]?.nodes?.length;
    } catch {
      found = true; // can't check: no false alarm
    }
    ctx.cache.set(key, found ? null : `the target ${target} doesn't exist in the store, so the redirect would lead to a "not found" page`);
  }
  return ctx.cache.get(key) as string | null;
}

/**
 * Whole-sheet check: Shopify refuses a redirect whose target is itself
 * redirected. Caught here for every row involved (also for loops like
 * /a -> /b -> /a), so a sheet is never half applied.
 */
async function prepareRedirects(ctx: ImportContext, items: Array<{ rows: Row[]; rowIndexes: number[] }>, defaultCommand: Command): Promise<Map<number, string[]>> {
  const blocked = new Map<number, string[]>();
  // Paths this file leaves in place (creates or keeps), with the row they are on; and paths it deletes.
  const inFile = new Map<string, number>();
  const deleted = new Set<string>();
  const parsed = items.map((item) => {
    const row = item.rows[0];
    let command: Command = defaultCommand;
    try {
      command = parseCommand(cell(row, "Command"), defaultCommand);
    } catch {
      // reported per row
    }
    const path = cell(row, "Path") ? normalizePath(cell(row, "Path")!).toLowerCase() : "";
    const target = (cell(row, "Target") ?? "").trim();
    if (path && command === "DELETE") deleted.add(path);
    else if (path && command !== "IGNORE") inFile.set(path, item.rowIndexes[0] + 2);
    return { command, path, target };
  });
  for (const [i, { command, path, target }] of parsed.entries()) {
    if (command === "DELETE" || command === "IGNORE" || !target || /^https?:\/\//i.test(target)) continue;
    const t = normalizePath(target).toLowerCase();
    if (t === path) {
      blocked.set(i, [`The redirect points at itself (${target})`]);
      continue;
    }
    const otherRow = inFile.get(t);
    if (otherRow !== undefined) {
      const loop = parsed.find((x) => x.path === t && normalizePath(x.target || "/").toLowerCase() === path);
      blocked.set(i, [
        loop
          ? `Redirect loop: ${path} → ${t} → ${path} (rows ${items[i].rowIndexes[0] + 2} and ${otherRow}). Neither row is imported.`
          : `The target ${target} is itself redirected by row ${otherRow}, and Shopify doesn't allow a redirect to a redirect. Point this row at the final address.`,
      ]);
      continue;
    }
    if (deleted.has(t)) continue;
    // Already a redirect in the store?
    const existing = await findExact<ExistingRedirect>(
      ctx.gql,
      REDIRECT_BY_PATH,
      { query: searchTerm("path", normalizePath(target)) },
      (d) => d.urlRedirects,
      (r) => normalizePath(r.path).toLowerCase() === t,
      "",
    ).catch(() => null);
    if (existing) {
      blocked.set(i, [`The target ${target} is itself redirected in the store (to ${existing.target}), and Shopify doesn't allow a redirect to a redirect. Use ${existing.target} as the target.`]);
    }
  }
  return blocked;
}

export async function importRedirect(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const row = rows[0];
  const existing = await fetchRedirect(ctx, row);
  const input = redirectInput(row);
  // Preview: what would happen, compared with the redirect as it is now.
  if (ctx.options.dryRun) {
    const creates = !existing && command !== "UPDATE" && command !== "DELETE";
    if (command === "DELETE") {
      if (!existing) return { status: "Failed", command, message: "Redirect not found: no redirect in the store has this path (or ID), so there is nothing to delete" };
      return { status: "OK", command, preview: { action: "delete", changes: [`Deletes the redirect ${existing.path} → ${existing.target}`], warnings: [], deletes: 1 }, seen: { target: existing.target } };
    }
    if (command === "NEW" && existing) return { status: "Failed", command, message: "Redirect already exists" };
    if (!existing && command === "UPDATE") return { status: "Failed", command, message: "Redirect not found: no redirect in the store has this path (or ID). Rows only update redirects that exist; to create this one, set Command to MERGE or NEW" };
    if (creates && (!input.path || !input.target)) return { status: "Failed", command, message: "Path and Target are required to create a redirect" };
    const dead = input.target ? await deadTarget(ctx, input.target) : null;
    const warnings = dead ? [dead[0].toUpperCase() + dead.slice(1)] : [];
    if (creates) return { status: "OK", command, preview: { action: "create", changes: [`New redirect: ${input.path} → ${input.target}`], warnings, creates: 1 }, seen: { exists: "no" } };
    const changes: string[] = [];
    if (input.path && input.path !== existing!.path) changes.push(`Path: ${existing!.path} → ${input.path}`);
    if (input.target && input.target !== existing!.target) changes.push(`Target: ${existing!.target} → ${input.target}`);
    return { status: "OK", command, preview: { action: changes.length ? "update" : "none", changes, warnings: changes.length ? warnings : [] }, seen: { target: existing!.target } };
  }
  return runCommand(command, existing, {
    what: "Redirect",
    idOf: (r) => r.id,
    prepare: async () => {
      if (!input.path || !input.target) throw new ImportError("Path and Target are required to create a redirect");
      return { path: input.path, target: input.target };
    },
    create: async (urlRedirect) => {
      const d = await ctx.gql(REDIRECT_CREATE, { urlRedirect });
      assertNoUserErrors(d.urlRedirectCreate, "Create redirect");
      return { id: d.urlRedirectCreate.urlRedirect.id };
    },
    update: async (r) => {
      const changes: { path?: string; target?: string } = {};
      if (input.path && input.path !== r.path) changes.path = input.path;
      if (input.target && input.target !== r.target) changes.target = input.target;
      if (!Object.keys(changes).length) return { id: r.id, notes: ["No changes"] };
      const d = await ctx.gql(REDIRECT_UPDATE, { id: r.id, urlRedirect: changes });
      assertNoUserErrors(d.urlRedirectUpdate, "Update redirect");
      return { id: r.id };
    },
    remove: async (r) => {
      const d = await ctx.gql(REDIRECT_DELETE, { id: r.id });
      assertNoUserErrors(d.urlRedirectDelete, "Delete redirect");
    },
  });
}

export const redirectsEntity: Entity = {
  key: "redirects",
  sheet: "Redirects",
  aliases: ["redirect", "url redirects", "url redirect"],
  description: "URL redirects (path to target).",
  columns: REDIRECT_COLUMNS,
  supportsQuery: true,
  export: exportRedirects,
  import: { keyColumns: ["ID", "Path"], apply: importRedirect, prepare: prepareRedirects },
};

// Exported for tests.
export const _internal = { normalizePath };
