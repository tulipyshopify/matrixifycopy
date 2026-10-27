import type { Command, Entity, ExportContext, Gql, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import {
  assertNoUserErrors,
  boolCell,
  buildSearchQuery,
  cell,
  gidToId,
  gqlString,
  metafieldsFromRow,
  metafieldsToRow,
  toGid,
} from "../core/util";
import { writeMetafields } from "../core/lookups";
import { findExact, publishFields, runCommand, searchTerm } from "./_content_helpers";

// --- Columns --------------------------------------------------------------------

// Pages have no author in the Admin GraphQL API, so there is no Author column.
const PAGE_COLUMNS = [
  "ID",
  "Handle",
  "Command",
  "Title",
  "Body HTML",
  "Template Suffix",
  "Published",
  "Published At",
  "Created At",
  "Updated At",
];

// --- Export -------------------------------------------------------------------------

export function pagesBulkQuery(search: string, groups: Set<string>): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  const metafields = `metafields { edges { node { id namespace key type value } } }`;
  return `{
    pages${args} { edges { node {
      id handle title body templateSuffix isPublished publishedAt createdAt updatedAt
      ${groups.has("metafields") ? metafields : ""}
    } } }
  }`;
}

export function pageToRow(p: any, groups: Set<string>): Row {
  const row: Row = {
    ID: gidToId(p.id),
    Handle: p.handle ?? "",
    Command: "MERGE",
    Title: p.title ?? "",
    "Body HTML": p.body ?? "",
    "Template Suffix": p.templateSuffix ?? "",
    Published: boolCell(p.isPublished),
    "Published At": p.publishedAt ?? "",
    "Created At": p.createdAt ?? "",
    "Updated At": p.updatedAt ?? "",
  };
  if (groups.has("metafields")) metafieldsToRow(row, p.metafields);
  return row;
}

async function exportPages(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? pagesEntity.groups!.filter((g) => g.default).map((g) => g.key));
  const search = buildSearchQuery(ctx.options);
  let n = 0;
  for await (const p of ctx.bulk(pagesBulkQuery(search, groups))) {
    await emit([pageToRow(p, groups)]);
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import ---------------------------------------------------------------------

const PAGE_BY_ID = `#graphql
  query ImportPageById($id: ID!) {
    page(id: $id) { id handle title }
  }
`;

const PAGE_BY_HANDLE = `#graphql
  query ImportPageByHandle($query: String!, $after: String) {
    pages(first: 50, after: $after, query: $query) {
      nodes { id handle title }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PAGE_CREATE = `#graphql
  mutation ImportPageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id handle }
      userErrors { field message code }
    }
  }
`;

const PAGE_UPDATE = `#graphql
  mutation ImportPageUpdate($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page { id handle }
      userErrors { field message code }
    }
  }
`;

const PAGE_DELETE = `#graphql
  mutation ImportPageDelete($id: ID!) {
    pageDelete(id: $id) {
      deletedPageId
      userErrors { field message code }
    }
  }
`;

interface ExistingPage {
  id: string;
  handle: string;
  title: string;
}

async function fetchPage(gql: Gql, by: { id?: string; handle?: string }): Promise<ExistingPage | null> {
  if (by.id) {
    const p = (await gql(PAGE_BY_ID, { id: by.id })).page;
    if (p) return p;
  }
  if (by.handle) {
    const handle = by.handle;
    // Search is prefix / fuzzy; only an exact handle counts, on any page.
    return findExact<ExistingPage>(
      gql,
      PAGE_BY_HANDLE,
      { query: searchTerm("handle", handle) },
      (d) => d.pages,
      (p) => p.handle === handle,
      `Several pages have handle "${handle}"; use the ID column`,
    );
  }
  return null;
}

function pageFields(row: Row): Record<string, any> {
  const f: Record<string, any> = {};
  const title = cell(row, "Title");
  if (title) f.title = title;
  const body = cell(row, "Body HTML");
  if (body !== undefined) f.body = body;
  const handle = cell(row, "Handle");
  if (handle) f.handle = handle;
  const tpl = cell(row, "Template Suffix");
  if (tpl !== undefined) f.templateSuffix = tpl || null;
  Object.assign(f, publishFields(row));
  return f;
}

/** Validated PageCreateInput; throws before anything is written. */
function pageCreateInput(row: Row): Record<string, any> {
  const page = pageFields(row);
  if (!page.title) throw new ImportError("Title is required to create a page");
  const mf = metafieldsFromRow(row).set;
  if (mf.length) page.metafields = mf;
  return page;
}

async function createPage(ctx: ImportContext, page: Record<string, any>): Promise<string> {
  const d = await ctx.gql(PAGE_CREATE, { page });
  assertNoUserErrors(d.pageCreate, "Create page");
  return d.pageCreate.page.id;
}

async function updatePage(ctx: ImportContext, existing: ExistingPage, row: Row) {
  const page = pageFields(row);
  if (page.handle === existing.handle) delete page.handle;
  else if (page.handle) page.redirectNewHandle = true;
  if (Object.keys(page).length) {
    const d = await ctx.gql(PAGE_UPDATE, { id: existing.id, page });
    assertNoUserErrors(d.pageUpdate, "Update page");
  }
  const mf = metafieldsFromRow(row);
  await writeMetafields(ctx.gql, existing.id, mf.set, mf.blank);
}

export async function importPage(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const top = rows[0];
  const id = toGid("Page", cell(top, "ID"));
  const handle = cell(top, "Handle");
  const existing = id || handle ? await fetchPage(ctx.gql, { id, handle }) : null;
  return runCommand(command, existing, {
    what: "Page",
    idOf: (p) => p.id,
    prepare: async () => pageCreateInput(top),
    create: async (page) => ({ id: await createPage(ctx, page) }),
    update: async (p) => {
      await updatePage(ctx, p, top);
      return { id: p.id };
    },
    remove: async (p) => {
      const d = await ctx.gql(PAGE_DELETE, { id: p.id });
      assertNoUserErrors(d.pageDelete, "Delete page");
    },
  });
}

export const pagesEntity: Entity = {
  key: "pages",
  sheet: "Pages",
  aliases: ["page"],
  description: "Online store pages with body HTML, publishing and metafields.",
  columns: PAGE_COLUMNS,
  supportsQuery: true,
  groups: [{ key: "metafields", label: "Metafields", default: true }],
  export: exportPages,
  import: { keyColumns: ["ID", "Handle"], apply: importPage },
};

// Exported for tests.
export const _internal = { pageFields, fetchPage };
