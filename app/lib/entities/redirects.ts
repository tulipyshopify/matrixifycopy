import type { Command, Entity, ExportContext, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import { assertNoUserErrors, buildSearchQuery, cell, gidToId, gqlString, toGid } from "../core/util";
import { runCommand, searchTerm } from "./_content_helpers";

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
  query ImportRedirectByPath($query: String!) {
    urlRedirects(first: 25, query: $query) { nodes { id path target } }
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
  const nodes: ExistingRedirect[] = (await ctx.gql(REDIRECT_BY_PATH, { query: searchTerm("path", normalizePath(path)) })).urlRedirects.nodes;
  return nodes.find((r) => normalizePath(r.path).toLowerCase() === wanted) ?? null;
}

function redirectInput(row: Row): { path?: string; target?: string } {
  const input: { path?: string; target?: string } = {};
  const path = cell(row, "Path");
  if (path) input.path = normalizePath(path);
  const target = cell(row, "Target");
  if (target) input.target = target.trim();
  return input;
}

export async function importRedirect(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const row = rows[0];
  const existing = await fetchRedirect(ctx, row);
  const input = redirectInput(row);
  return runCommand(command, existing, {
    what: "Redirect",
    idOf: (r) => r.id,
    create: async () => {
      if (!input.path || !input.target) throw new ImportError("Path and Target are required to create a redirect");
      const d = await ctx.gql(REDIRECT_CREATE, { urlRedirect: input });
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
  import: { keyColumns: ["ID", "Path"], apply: importRedirect },
};

// Exported for tests.
export const _internal = { normalizePath };
