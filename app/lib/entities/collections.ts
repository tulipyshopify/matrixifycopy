import type { Command, Entity, ExportContext, Gql, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import {
  assertNoUserErrors,
  boolCell,
  buildSearchQuery,
  cell,
  chunk,
  gidToId,
  gqlString,
  metafieldsFromRow,
  metafieldsToRow,
  parseBool,
  parseInt10,
  parseSubCommand,
  str,
  toGid,
} from "../core/util";
import { setOnlineStorePublished, writeMetafields } from "../core/lookups";
import { paginate } from "../core/gql";
import { imageKey } from "./products";

/*
 * Smart and Custom Collections share one implementation; `kind` switches the
 * sub-rows (rules vs. products) and the export filter.
 *
 * API choice: in 2026-10 `Collection.ruleSet`, `CollectionInput` (the `input:`
 * argument of collectionCreate/collectionUpdate) and collectionAddProducts /
 * collectionRemoveProducts are deprecated in favour of the "sources" model
 * (`collection: CollectionCreateInput` with `sources`, `sourcesToUpdate`,
 * inclusion conditions/selections). That model splits rules into ~20 typed
 * condition inputs with their own relation enums and needs the source ID of an
 * existing collection to change its rules or product selections, which does
 * not map onto Matrixify's flat "column / relation / condition" rows. The
 * deprecated path is still fully supported and maps 1:1 onto the sheet, so we
 * use it: `ruleSet` for smart collections, `products` on create and
 * collectionAddProducts / collectionRemoveProducts for custom collections.
 */

type Kind = "smart" | "custom";

// --- Columns --------------------------------------------------------------------

const COLLECTION_COLUMNS = [
  "ID",
  "Handle",
  "Command",
  "Title",
  "Body HTML",
  "Sort Order",
  "Template Suffix",
  "Updated At",
  "Published",
  "Published At",
  "Image Src",
  "Image Alt Text",
  "SEO Title",
  "SEO Description",
  "Products Count",
];

const RULE_COLUMNS = ["Must Match", "Rule: Product Column", "Rule: Relation", "Rule: Condition", "Rule: Condition Object ID"];

const PRODUCT_COLUMNS = ["Product: ID", "Product: Handle", "Product: Position", "Product Command"];

/** Sheet values are Matrixify's lowercase-with-dashes form, e.g. "best-selling". */
const SORT_ORDERS = [
  "ALPHA_ASC",
  "ALPHA_DESC",
  "BEST_SELLING",
  "CREATED",
  "CREATED_DESC",
  "MANUAL",
  "MOST_RELEVANT",
  "PRICE_ASC",
  "PRICE_DESC",
];

const RULE_COLUMN_VALUES = [
  "IS_PRICE_REDUCED",
  "PRODUCT_CATEGORY_ID",
  "PRODUCT_CATEGORY_ID_WITH_DESCENDANTS",
  "PRODUCT_METAFIELD_DEFINITION",
  "PRODUCT_TAXONOMY_NODE_ID",
  "TAG",
  "TITLE",
  "TYPE",
  "VARIANT_COMPARE_AT_PRICE",
  "VARIANT_INVENTORY",
  "VARIANT_METAFIELD_DEFINITION",
  "VARIANT_PRICE",
  "VARIANT_TITLE",
  "VARIANT_WEIGHT",
  "VENDOR",
];

const RULE_RELATIONS = [
  "CONTAINS",
  "ENDS_WITH",
  "EQUALS",
  "GREATER_THAN",
  "IS_NOT_SET",
  "IS_SET",
  "LESS_THAN",
  "NOT_CONTAINS",
  "NOT_EQUALS",
  "STARTS_WITH",
];

function enumCell(v: string | null | undefined, dashes = false): string {
  if (!v) return "";
  const s = v.toLowerCase();
  return dashes ? s.replace(/_/g, "-") : s;
}

function parseEnum(v: string, allowed: string[], col: string): string {
  const s = v.trim().toUpperCase().replace(/[-\s]+/g, "_");
  if (!allowed.includes(s)) {
    throw new ImportError(`${col} "${v}" is not valid, expected one of ${allowed.map((a) => a.toLowerCase()).join(", ")}`);
  }
  return s;
}

function mustMatchCell(disjunctive: boolean | null | undefined): string {
  if (disjunctive === null || disjunctive === undefined) return "";
  return disjunctive ? "any condition" : "all conditions";
}

/** "any condition" -> true (disjunctive), "all conditions" -> false. */
function parseMustMatch(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (s.startsWith("any")) return true;
  if (s.startsWith("all")) return false;
  throw new ImportError(`Must Match must be "all conditions" or "any condition", got "${v}"`);
}

// --- Export ---------------------------------------------------------------------------

export function collectionsBulkQuery(kind: Kind, search: string, groups: Set<string>): string {
  const filter = [`collection_type:${kind}`, search ? `(${search})` : ""].filter(Boolean).join(" AND ");
  const metafields = `metafields { edges { node { id namespace key type value } } }`;
  // ResourcePublicationV2 has no `id`, so __typename is needed for bulk.ts to file it under `publications`.
  const publications = `resourcePublicationsV2 { edges { node { __typename isPublished publishDate publication { id catalog { title } } } } }`;
  const ruleSet = `ruleSet {
      appliedDisjunctively
      rules { column relation condition conditionObject { ... on CollectionRuleMetafieldCondition { metafieldDefinition { id } } } }
    }`;
  const products = `products { edges { node { id handle } } }`;
  return `{
    collections(query: ${gqlString(filter)}) { edges { node {
      id handle title descriptionHtml sortOrder templateSuffix updatedAt
      image { url altText }
      seo { title description }
      productsCount { count }
      ${kind === "smart" ? ruleSet : ""}
      ${publications}
      ${groups.has("metafields") ? metafields : ""}
      ${kind === "custom" && groups.has("products") ? products : ""}
    } } }
  }`;
}

function onlineStorePublication(c: any): any | undefined {
  return (c.publications ?? []).find((p: any) => p.publication?.catalog?.title === "Online Store");
}

export function collectionToRows(c: any, kind: Kind, groups: Set<string>): Row[] {
  const rules: any[] = kind === "smart" ? (c.ruleSet?.rules ?? []) : [];
  const products: any[] = kind === "custom" ? (c.products ?? []) : [];
  const count = Math.max(1, rules.length, products.length);
  const pub = onlineStorePublication(c);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const row: Row = { ID: gidToId(c.id), Handle: c.handle };
    if (i === 0) {
      Object.assign(row, {
        Command: "MERGE",
        Title: c.title ?? "",
        "Body HTML": c.descriptionHtml ?? "",
        "Sort Order": enumCell(c.sortOrder, true),
        "Template Suffix": c.templateSuffix ?? "",
        "Updated At": c.updatedAt ?? "",
        Published: boolCell(!!pub?.isPublished),
        "Published At": pub?.isPublished ? (pub.publishDate ?? "") : "",
        "Image Src": c.image?.url ?? "",
        "Image Alt Text": c.image?.altText ?? "",
        "Products Count": str(c.productsCount?.count),
      });
      if (groups.has("seo")) {
        row["SEO Title"] = c.seo?.title ?? "";
        row["SEO Description"] = c.seo?.description ?? "";
      }
      if (kind === "smart") row["Must Match"] = mustMatchCell(c.ruleSet?.appliedDisjunctively);
      if (groups.has("metafields")) metafieldsToRow(row, c.metafields);
    }
    const r = rules[i];
    if (r) {
      Object.assign(row, {
        "Rule: Product Column": enumCell(r.column),
        "Rule: Relation": enumCell(r.relation),
        "Rule: Condition": r.condition ?? "",
        "Rule: Condition Object ID": r.conditionObject?.metafieldDefinition?.id
          ? gidToId(r.conditionObject.metafieldDefinition.id)
          : "",
      });
    }
    const p = products[i];
    if (p) {
      Object.assign(row, {
        "Product: ID": gidToId(p.id),
        "Product: Handle": p.handle ?? "",
        "Product: Position": String(i + 1),
        "Product Command": "MERGE",
      });
    }
    rows.push(row);
  }
  return rows;
}

function exporter(kind: Kind) {
  return async function exportCollections(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
    const entity = kind === "smart" ? smartCollectionsEntity : customCollectionsEntity;
    const groups = new Set(ctx.options.groups ?? entity.groups!.filter((g) => g.default).map((g) => g.key));
    const search = buildSearchQuery(ctx.options);
    let n = 0;
    for await (const c of ctx.bulk(collectionsBulkQuery(kind, search, groups))) {
      await emit(collectionToRows(c, kind, groups));
      ctx.progress(++n);
      if (ctx.options.limit && n >= ctx.options.limit) break;
    }
  };
}

// --- Import: fetching existing collections -------------------------------------------

const COLLECTION_FIELDS = `#graphql
  fragment ImportCollection on Collection {
    id handle title sortOrder
    image { id url altText }
    ruleSet {
      appliedDisjunctively
      rules { column relation condition conditionObject { ... on CollectionRuleMetafieldCondition { metafieldDefinition { id } } } }
    }
  }
`;

const COLLECTION_BY_ID = `#graphql
  query ImportCollectionById($id: ID!) { collection(id: $id) { ...ImportCollection } }
  ${COLLECTION_FIELDS}
`;

const COLLECTION_BY_HANDLE = `#graphql
  query ImportCollectionByHandle($handle: String!) {
    collectionByIdentifier(identifier: { handle: $handle }) { ...ImportCollection }
  }
  ${COLLECTION_FIELDS}
`;

const COLLECTION_PRODUCT_IDS = `#graphql
  query ImportCollectionProductIds($id: ID!, $after: String) {
    collection(id: $id) {
      products(first: 250, after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const COLLECTION_PRODUCT_BY_HANDLE = `#graphql
  query ImportCollectionProductByHandle($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) { id }
  }
`;

interface RuleInput {
  column: string;
  relation: string;
  condition: string;
  conditionObjectId?: string;
}

interface ExistingCollection {
  id: string;
  handle: string;
  title: string;
  sortOrder: string;
  image: { id: string; url: string; altText: string | null } | null;
  ruleSet: { appliedDisjunctively: boolean; rules: any[] } | null;
}

async function fetchCollection(gql: Gql, by: { id?: string; handle?: string }): Promise<ExistingCollection | null> {
  let c: any = null;
  if (by.id) c = (await gql(COLLECTION_BY_ID, { id: by.id })).collection;
  if (!c && by.handle) c = (await gql(COLLECTION_BY_HANDLE, { handle: by.handle })).collectionByIdentifier;
  return c ?? null;
}

async function fetchProductIds(gql: Gql, id: string): Promise<string[]> {
  const out: string[] = [];
  for await (const p of paginate<{ id: string }>(gql, COLLECTION_PRODUCT_IDS, { id }, (d) => d.collection.products)) {
    out.push(p.id);
  }
  return out;
}

async function productIdByHandle(ctx: ImportContext, handle: string): Promise<string | null> {
  const key = `productByHandle:${handle.toLowerCase()}`;
  if (!ctx.cache.has(key)) {
    ctx.cache.set(
      key,
      ctx.gql(COLLECTION_PRODUCT_BY_HANDLE, { handle }).then((d: any) => d.productByIdentifier?.id ?? null),
    );
  }
  return ctx.cache.get(key) as Promise<string | null>;
}

// --- Import: parsing rows ---------------------------------------------------------------

function parseRules(rows: Row[]): RuleInput[] {
  const rules: RuleInput[] = [];
  for (const row of rows) {
    const column = cell(row, "Rule: Product Column");
    if (!column) continue;
    const relation = cell(row, "Rule: Relation");
    if (!relation) throw new ImportError(`Rule "${column}" is missing Rule: Relation`);
    const rule: RuleInput = {
      column: parseEnum(column, RULE_COLUMN_VALUES, "Rule: Product Column"),
      relation: parseEnum(relation, RULE_RELATIONS, "Rule: Relation"),
      condition: cell(row, "Rule: Condition") ?? "",
    };
    const obj = cell(row, "Rule: Condition Object ID");
    if (obj) rule.conditionObjectId = toGid("MetafieldDefinition", obj);
    rules.push(rule);
  }
  return rules;
}

function existingRules(ex: ExistingCollection): RuleInput[] {
  return (ex.ruleSet?.rules ?? []).map((r: any) => ({
    column: r.column,
    relation: r.relation,
    condition: r.condition,
    ...(r.conditionObject?.metafieldDefinition?.id ? { conditionObjectId: r.conditionObject.metafieldDefinition.id } : {}),
  }));
}

interface ProductSpec {
  rowIndex: number;
  id?: string;
  handle?: string;
  position?: number;
  command: "MERGE" | "DELETE" | "REPLACE";
}

function parseProducts(rows: Row[]): ProductSpec[] {
  const specs: ProductSpec[] = [];
  rows.forEach((row, rowIndex) => {
    const id = cell(row, "Product: ID");
    const handle = cell(row, "Product: Handle");
    if (!id && !handle) return;
    specs.push({
      rowIndex,
      id: toGid("Product", id),
      handle: handle || undefined,
      position: parseInt10(cell(row, "Product: Position")),
      command: parseSubCommand(cell(row, "Product Command"), ["MERGE", "DELETE", "REPLACE"] as const, "MERGE"),
    });
  });
  return specs;
}

async function resolveProducts(ctx: ImportContext, specs: ProductSpec[]): Promise<Array<ProductSpec & { gid: string }>> {
  const out: Array<ProductSpec & { gid: string }> = [];
  for (const s of specs) {
    const gid = s.id ?? (s.handle ? await productIdByHandle(ctx, s.handle) : null);
    if (!gid) {
      if (s.command === "DELETE") continue; // nothing to remove
      throw new ImportError(`Product "${s.handle ?? s.id}" on row ${s.rowIndex + 1} not found`);
    }
    out.push({ ...s, gid });
  }
  return out;
}

/** CollectionInput fields from the top row, excluding rules/products/metafields. */
function collectionFields(row: Row): Record<string, any> {
  const f: Record<string, any> = {};
  const title = cell(row, "Title");
  if (title) f.title = title;
  const body = cell(row, "Body HTML");
  if (body !== undefined) f.descriptionHtml = body;
  const handle = cell(row, "Handle");
  if (handle) f.handle = handle;
  const sort = cell(row, "Sort Order");
  if (sort) f.sortOrder = parseEnum(sort, SORT_ORDERS, "Sort Order");
  const tpl = cell(row, "Template Suffix");
  if (tpl !== undefined) f.templateSuffix = tpl || null;
  const seoTitle = cell(row, "SEO Title");
  const seoDesc = cell(row, "SEO Description");
  if (seoTitle !== undefined || seoDesc !== undefined) {
    f.seo = {};
    if (seoTitle !== undefined) f.seo.title = seoTitle;
    if (seoDesc !== undefined) f.seo.description = seoDesc;
  }
  return f;
}

// --- Import: mutations ----------------------------------------------------------------

const COLLECTION_CREATE = `#graphql
  mutation ImportCollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id handle }
      userErrors { field message }
    }
  }
`;

const COLLECTION_UPDATE = `#graphql
  mutation ImportCollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id handle sortOrder }
      userErrors { field message }
    }
  }
`;

const COLLECTION_DELETE = `#graphql
  mutation ImportCollectionDelete($id: ID!) {
    collectionDelete(input: { id: $id }) {
      deletedCollectionId
      userErrors { field message }
    }
  }
`;

const COLLECTION_ADD_PRODUCTS = `#graphql
  mutation ImportCollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      userErrors { field message }
    }
  }
`;

const COLLECTION_REMOVE_PRODUCTS = `#graphql
  mutation ImportCollectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      job { id }
      userErrors { field message }
    }
  }
`;

const COLLECTION_REORDER = `#graphql
  mutation ImportCollectionReorder($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job { id }
      userErrors { field message }
    }
  }
`;

async function createCollection(ctx: ImportContext, kind: Kind, rows: Row[], top: Row): Promise<{ id: string; notes: string[] }> {
  const notes: string[] = [];
  const input: Record<string, any> = collectionFields(top);
  if (!input.title) throw new ImportError("Title is required to create a collection");
  const src = cell(top, "Image Src");
  if (src) input.image = { src, altText: cell(top, "Image Alt Text") || undefined };
  const mf = metafieldsFromRow(top).set;
  if (mf.length) input.metafields = mf;

  if (kind === "smart") {
    const rules = parseRules(rows);
    if (!rules.length) throw new ImportError("A smart collection needs at least one rule (Rule: Product Column)");
    const mm = rows.map((r) => cell(r, "Must Match")).find(Boolean);
    input.ruleSet = { appliedDisjunctively: mm ? parseMustMatch(mm) : false, rules };
  } else {
    // NEW / REPLACE: the sheet is the exact product list, in position order.
    const specs = await resolveProducts(ctx, parseProducts(rows).filter((p) => p.command !== "DELETE"));
    specs.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.rowIndex - b.rowIndex);
    const ids = [...new Set(specs.map((s) => s.gid))];
    if (ids.length) input.products = ids;
  }

  const d = await ctx.gql(COLLECTION_CREATE, { input });
  assertNoUserErrors(d.collectionCreate, "Create collection");
  const id: string = d.collectionCreate.collection.id;

  const published = parseBool(cell(top, "Published"));
  if (published) await setOnlineStorePublished(ctx.gql, ctx.cache, id, true, cell(top, "Published At") || undefined);
  return { id, notes };
}

async function updateCollection(
  ctx: ImportContext,
  kind: Kind,
  existing: ExistingCollection,
  rows: Row[],
  top: Row,
): Promise<string[]> {
  const notes: string[] = [];
  const id = existing.id;
  const fields = collectionFields(top);
  if (fields.handle === existing.handle) delete fields.handle;

  // Image: only re-upload when the file changed; alt text alone updates in place.
  const src = cell(top, "Image Src");
  const alt = cell(top, "Image Alt Text");
  if (src) {
    if (existing.image && imageKey(existing.image.url) === imageKey(src)) {
      if (alt !== undefined && alt !== (existing.image.altText ?? "")) fields.image = { id: existing.image.id, altText: alt };
    } else {
      fields.image = { src, altText: alt || undefined };
    }
  }

  if (kind === "smart") {
    // Rules in the sheet replace the whole rule set (Matrixify behaviour).
    const rules = parseRules(rows);
    const mm = rows.map((r) => cell(r, "Must Match")).find(Boolean);
    if (rules.length || mm) {
      fields.ruleSet = {
        appliedDisjunctively: mm ? parseMustMatch(mm) : !!existing.ruleSet?.appliedDisjunctively,
        rules: rules.length ? rules : existingRules(existing),
      };
    }
  }

  let sortOrder = existing.sortOrder;
  if (Object.keys(fields).length) {
    const d = await ctx.gql(COLLECTION_UPDATE, { input: { id, ...fields } });
    assertNoUserErrors(d.collectionUpdate, "Update collection");
    sortOrder = d.collectionUpdate.collection?.sortOrder ?? fields.sortOrder ?? sortOrder;
  }

  const mf = metafieldsFromRow(top);
  await writeMetafields(ctx.gql, id, mf.set, mf.blank);

  const published = parseBool(cell(top, "Published"));
  if (published !== undefined) {
    await setOnlineStorePublished(ctx.gql, ctx.cache, id, published, cell(top, "Published At") || undefined);
  }

  if (kind === "custom") notes.push(...(await updateMembership(ctx, id, sortOrder, rows)));
  return notes;
}

/** Applies "Product Command" rows to an existing custom collection. */
async function updateMembership(ctx: ImportContext, id: string, sortOrder: string, rows: Row[]): Promise<string[]> {
  const notes: string[] = [];
  const parsed = parseProducts(rows);
  if (!parsed.length) return notes;
  const specs = await resolveProducts(ctx, parsed);
  const current = new Set(await fetchProductIds(ctx.gql, id));
  const keep = specs.filter((s) => s.command !== "DELETE");
  const exact = specs.some((s) => s.command === "REPLACE");

  const toAdd = [...new Set(keep.map((s) => s.gid).filter((g) => !current.has(g)))];
  const toRemove = new Set(specs.filter((s) => s.command === "DELETE" && current.has(s.gid)).map((s) => s.gid));
  if (exact) {
    const wanted = new Set(keep.map((s) => s.gid));
    for (const g of current) if (!wanted.has(g)) toRemove.add(g);
  }

  for (const ids of chunk([...toRemove], 250)) {
    const d = await ctx.gql(COLLECTION_REMOVE_PRODUCTS, { id, productIds: ids });
    assertNoUserErrors(d.collectionRemoveProducts, "Remove products");
  }
  for (const ids of chunk(toAdd, 250)) {
    const d = await ctx.gql(COLLECTION_ADD_PRODUCTS, { id, productIds: ids });
    assertNoUserErrors(d.collectionAddProducts, "Add products");
  }

  const moves = keep
    .filter((s) => s.position !== undefined)
    .sort((a, b) => a.position! - b.position!)
    .map((s) => ({ id: s.gid, newPosition: String(Math.max(0, s.position! - 1)) }));
  if (moves.length) {
    if (sortOrder !== "MANUAL") {
      notes.push("Product: Position ignored because Sort Order is not manual");
    } else {
      for (const batch of chunk(moves, 250)) {
        const d = await ctx.gql(COLLECTION_REORDER, { id, moves: batch });
        assertNoUserErrors(d.collectionReorderProducts, "Reorder products");
      }
    }
  }
  if (toAdd.length) notes.push(`${toAdd.length} products added`);
  if (toRemove.size) notes.push(`${toRemove.size} products removed`);
  return notes;
}

async function deleteCollection(gql: Gql, id: string) {
  const d = await gql(COLLECTION_DELETE, { id });
  assertNoUserErrors(d.collectionDelete, "Delete collection");
}

function importer(kind: Kind) {
  const label = kind === "smart" ? "Smart collection" : "Custom collection";
  return async function importCollection(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
    const top = rows[0];
    const id = toGid("Collection", cell(top, "ID"));
    const handle = cell(top, "Handle");
    const existing = id || handle ? await fetchCollection(ctx.gql, { id, handle }) : null;
    const existingKind: Kind | null = existing ? (existing.ruleSet ? "smart" : "custom") : null;
    const wrongKind = existing && existingKind !== kind;

    switch (command) {
      case "DELETE": {
        if (!existing) return { status: "Failed", command, message: `${label} not found` };
        if (wrongKind) return { status: "Failed", command, id: existing.id, message: `Collection is a ${existingKind} collection` };
        await deleteCollection(ctx.gql, existing.id);
        return { status: "OK", command, id: existing.id, message: "Deleted" };
      }
      case "NEW": {
        if (existing) return { status: "Failed", command, id: existing.id, message: `Collection with handle "${existing.handle}" already exists` };
        const r = await createCollection(ctx, kind, rows, top);
        return { status: "OK", command, id: r.id, message: ["Created", ...r.notes].join("; ") };
      }
      case "REPLACE": {
        if (existing) await deleteCollection(ctx.gql, existing.id);
        const r = await createCollection(ctx, kind, rows, top);
        return { status: "OK", command, id: r.id, message: [existing ? "Replaced" : "Created", ...r.notes].join("; ") };
      }
      case "UPDATE":
      case "MERGE": {
        if (!existing) {
          if (command === "UPDATE") return { status: "Failed", command, message: `${label} not found` };
          const r = await createCollection(ctx, kind, rows, top);
          return { status: "OK", command, id: r.id, message: ["Created", ...r.notes].join("; ") };
        }
        if (wrongKind) {
          return {
            status: "Failed",
            command,
            id: existing.id,
            message: `Collection is a ${existingKind} collection; use command REPLACE to convert it`,
          };
        }
        const notes = await updateCollection(ctx, kind, existing, rows, top);
        return { status: "OK", command, id: existing.id, message: ["Updated", ...notes].join("; ") };
      }
      default:
        return { status: "Skipped", command };
    }
  };
}

const GROUPS = [
  { key: "metafields", label: "Metafields", default: true },
  { key: "seo", label: "SEO", default: true },
];

export const smartCollectionsEntity: Entity = {
  key: "smart_collections",
  sheet: "Smart Collections",
  aliases: ["smart collections", "smart collection", "smart_collections"],
  description: "Automated collections with their rules, image, SEO, publishing and metafields.",
  columns: [...COLLECTION_COLUMNS, ...RULE_COLUMNS],
  supportsQuery: true,
  groups: GROUPS,
  export: exporter("smart"),
  import: { keyColumns: ["ID", "Handle"], apply: importer("smart") },
};

export const customCollectionsEntity: Entity = {
  key: "custom_collections",
  sheet: "Custom Collections",
  aliases: ["custom collections", "custom collection", "custom_collections"],
  description: "Manual collections with their products (one per row), image, SEO, publishing and metafields.",
  columns: [...COLLECTION_COLUMNS, ...PRODUCT_COLUMNS],
  supportsQuery: true,
  groups: [...GROUPS, { key: "products", label: "Products in collection", default: true }],
  export: exporter("custom"),
  import: { keyColumns: ["ID", "Handle"], apply: importer("custom") },
};

// Exported for tests.
export const _internal = { parseRules, parseProducts, collectionFields };
