import type { ExportOptions, Gql } from "../core/types";
import { buildSearchQuery } from "../core/util";

const PRODUCTS = `#graphql
  query CountProducts($query: String) { productsCount(query: $query, limit: null) { count precision } }
`;
const COLLECTIONS = `#graphql
  query CountCollections($query: String) { collectionsCount(query: $query, limit: null) { count precision } }
`;
const CUSTOMERS = `#graphql
  query CountCustomers($query: String) { customersCount(query: $query, limit: null) { count precision } }
`;
const ORDERS = `#graphql
  query CountOrders($query: String) { ordersCount(query: $query, limit: null) { count precision } }
`;
const DRAFT_ORDERS = `#graphql
  query CountDraftOrders($query: String) { draftOrdersCount(query: $query, limit: null) { count precision } }
`;
const DISCOUNTS = `#graphql
  query CountDiscounts($query: String) { discountNodesCount(query: $query, limit: null) { count precision } }
`;
const REDIRECTS = `#graphql
  query CountRedirects($query: String) { urlRedirectsCount(query: $query, limit: null) { count precision } }
`;
const PAGES = `#graphql
  query CountPages { pagesCount(limit: null) { count precision } }
`;
const COMPANIES = `#graphql
  query CountCompanies { companiesCount(limit: null) { count precision } }
`;

/** [query, extra search terms, supports filters] per entity. */
const COUNTS: Record<string, [string, string, boolean]> = {
  products: [PRODUCTS, "", true],
  smart_collections: [COLLECTIONS, "collection_type:smart", true],
  custom_collections: [COLLECTIONS, "collection_type:custom", true],
  customers: [CUSTOMERS, "", true],
  orders: [ORDERS, "", true],
  draft_orders: [DRAFT_ORDERS, "", true],
  discounts: [DISCOUNTS, "", true],
  redirects: [REDIRECTS, "", true],
  pages: [PAGES, "", false],
  companies: [COMPANIES, "", false],
};

export interface CountResult {
  count: number;
  /** "EXACT" or "AT_LEAST". */
  precision: string;
  /** True when filters were ignored because Shopify can only count everything. */
  unfiltered?: boolean;
}

/** Counts the items an export would include, or null when Shopify has no count. */
export async function countItems(gql: Gql, entity: string, options: ExportOptions): Promise<CountResult | null> {
  const spec = COUNTS[entity];
  if (!spec) return null;
  const [query, extra, filterable] = spec;
  // Checked item by item during the export: Shopify can't count it.
  if (options.dateRange?.searchBy || options.filters?.some((f) => f.local)) return null;
  const search = [extra, buildSearchQuery(options)].filter(Boolean).join(" AND ");
  const data = await gql(query, filterable ? { query: search || null } : {});
  const c = Object.values(data)[0] as { count: number; precision: string };
  return { ...c, ...(!filterable && search ? { unfiltered: true } : {}) };
}
