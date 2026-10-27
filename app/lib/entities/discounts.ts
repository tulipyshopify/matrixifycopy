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
  parseNumber,
  str,
  toGid,
} from "../core/util";
import { writeMetafields } from "../core/lookups";

/**
 * Discounts of every kind via `discountNodes` (code and automatic). One code
 * per row in the "Code" column, the first code on the top row; discount
 * fields on the top row and the ID on every row.
 *
 * Import supports Basic (amount off order/products) and Free Shipping
 * discounts with both Code and Automatic methods. Buy X Get Y and App
 * discounts are export-only (they can still be deleted). Extra codes are
 * added with discountRedeemCodeBulkAdd (asynchronous); codes are never
 * removed by import.
 */

// --- Columns --------------------------------------------------------------------

const DISCOUNT_COLUMNS = [
  "ID",
  "Command",
  "Title",
  "Type",
  "Method",
  "Status",
  "Code",
  "Starts At",
  "Ends At",
  "Created At",
  "Updated At",
  "Usage Limit",
  "Once Per Customer",
  "Used Count",
  "Combines With",
  "Value Type",
  "Value",
  "Applies On Each Item",
  "Minimum Requirement",
  "Minimum Requirement Value",
  "Applies To",
  "Applies To: Product IDs",
  "Applies To: Variant IDs",
  "Applies To: Collection IDs",
  "Customer Selection",
  "Customer Selection: Customer IDs",
  "Customer Selection: Segment IDs",
  "Shipping Countries",
  "Maximum Shipping Price",
  "Summary",
  "Row #",
  "Top Row",
];

type DiscountType = "Basic" | "BxGy" | "Free Shipping" | "App";
type Method = "Code" | "Automatic";

/** __typename -> Type / Method columns. */
const TYPENAMES: Record<string, { type: DiscountType; method: Method }> = {
  DiscountCodeBasic: { type: "Basic", method: "Code" },
  DiscountAutomaticBasic: { type: "Basic", method: "Automatic" },
  DiscountCodeBxgy: { type: "BxGy", method: "Code" },
  DiscountAutomaticBxgy: { type: "BxGy", method: "Automatic" },
  DiscountCodeFreeShipping: { type: "Free Shipping", method: "Code" },
  DiscountAutomaticFreeShipping: { type: "Free Shipping", method: "Automatic" },
  DiscountCodeApp: { type: "App", method: "Code" },
  DiscountAutomaticApp: { type: "App", method: "Automatic" },
};

function parseType(v: string | undefined): DiscountType | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase().replace(/[^a-z]/g, "");
  if (["basic", "amountoff", "amountoffproducts", "amountofforder", "percentage", "fixedamount"].includes(s)) return "Basic";
  if (["freeshipping", "shipping"].includes(s)) return "Free Shipping";
  if (["bxgy", "buyxgety"].includes(s)) return "BxGy";
  if (s === "app") return "App";
  throw new ImportError(`Type "${v}" must be Basic, Free Shipping, BxGy or App`);
}

function parseMethod(v: string | undefined): Method | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "code") return "Code";
  if (s === "automatic") return "Automatic";
  throw new ImportError(`Method "${v}" must be Code or Automatic`);
}

const ids = (list: any[] | undefined) => (list ?? []).map((x) => gidToId(x.id)).join(", ");

// --- Export -------------------------------------------------------------------------

const COMBINES = "combinesWith { orderDiscounts productDiscounts shippingDiscounts }";
const CONTEXT = `context { __typename
  ... on DiscountBuyerSelectionAll { all }
  ... on DiscountCustomers { customers { id } }
  ... on DiscountCustomerSegments { segments { id } }
}`;
const MINIMUM = `minimumRequirement { __typename
  ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
  ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
}`;
const GETS = `customerGets {
  value { __typename
    ... on DiscountPercentage { percentage }
    ... on DiscountAmount { amount { amount } appliesOnEachItem }
    ... on DiscountOnQuantity { quantity { quantity } effect { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount } } } }
  }
  items { __typename ... on AllDiscountItems { allItems } }
}`;
const DESTINATION = `destinationSelection { __typename
  ... on DiscountCountries { countries }
  ... on DiscountCountryAll { allCountries }
}
maximumShippingPrice { amount }`;
const COMMON = `title status startsAt endsAt createdAt updatedAt asyncUsageCount ${COMBINES} ${CONTEXT}`;

/**
 * Bulk query over discountNodes. Bulk operations allow 5 connections: four go
 * to `codes` (one per code discount type) and one to metafields, so product/
 * collection lists of "Applies To" are fetched per discount afterwards.
 */
export function discountsBulkQuery(search: string, groups: Set<string>): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  const codes = groups.has("codes") ? `codes { edges { node { id code asyncUsageCount } } }` : "";
  const metafields = groups.has("metafields") ? `metafields { edges { node { id namespace key type value } } }` : "";
  return `{
    discountNodes${args} { edges { node {
      id
      discount { __typename
        ... on DiscountCodeBasic { ${COMMON} summary usageLimit appliesOncePerCustomer ${MINIMUM} ${GETS} ${codes} }
        ... on DiscountAutomaticBasic { ${COMMON} summary ${MINIMUM} ${GETS} }
        ... on DiscountCodeFreeShipping { ${COMMON} summary usageLimit appliesOncePerCustomer ${MINIMUM} ${DESTINATION} ${codes} }
        ... on DiscountAutomaticFreeShipping { ${COMMON} summary ${MINIMUM} ${DESTINATION} }
        ... on DiscountCodeBxgy { ${COMMON} summary usageLimit appliesOncePerCustomer ${GETS} ${codes} }
        ... on DiscountAutomaticBxgy { ${COMMON} summary ${GETS} }
        ... on DiscountCodeApp { ${COMMON} usageLimit appliesOncePerCustomer appDiscountType { title } ${codes} }
        ... on DiscountAutomaticApp { ${COMMON} appDiscountType { title } }
      }
      ${metafields}
    } } }
  }`;
}

const ITEMS_FRAGMENT = `#graphql
  fragment DiscountItemIds on DiscountItems {
    __typename
    ... on AllDiscountItems { allItems }
    ... on DiscountProducts { products(first: 250) { nodes { id } } productVariants(first: 250) { nodes { id } } }
    ... on DiscountCollections { collections(first: 250) { nodes { id } } }
  }
`;

const CONTEXT_FRAGMENT = `#graphql
  fragment DiscountContextIds on DiscountContext {
    __typename
    ... on DiscountBuyerSelectionAll { all }
    ... on DiscountCustomers { customers { id } }
    ... on DiscountCustomerSegments { segments { id } }
  }
`;

/** Details needed for export (item lists) and for import (diffs, codes). */
const DISCOUNT_DETAIL = `#graphql
  query DiscountDetail($id: ID!) {
    discountNode(id: $id) {
      id
      discount {
        __typename
        ... on DiscountCodeBasic {
          title
          customerGets { items { ...DiscountItemIds } }
          context { ...DiscountContextIds }
          codes(first: 250) { nodes { code } }
        }
        ... on DiscountAutomaticBasic {
          title
          customerGets { items { ...DiscountItemIds } }
          context { ...DiscountContextIds }
        }
        ... on DiscountCodeFreeShipping {
          title
          context { ...DiscountContextIds }
          destinationSelection { __typename ... on DiscountCountries { countries } }
          codes(first: 250) { nodes { code } }
        }
        ... on DiscountAutomaticFreeShipping {
          title
          context { ...DiscountContextIds }
          destinationSelection { __typename ... on DiscountCountries { countries } }
        }
        ... on DiscountCodeBxgy { title customerGets { items { ...DiscountItemIds } } codes(first: 250) { nodes { code } } }
        ... on DiscountAutomaticBxgy { title customerGets { items { ...DiscountItemIds } } }
        ... on DiscountCodeApp { title codes(first: 250) { nodes { code } } }
        ... on DiscountAutomaticApp { title }
      }
    }
  }
  ${ITEMS_FRAGMENT}
  ${CONTEXT_FRAGMENT}
`;

function valueCells(value: any): { type: string; value: string; eachItem: string } {
  if (!value) return { type: "", value: "", eachItem: "" };
  const v = value.__typename === "DiscountOnQuantity" ? value.effect : value;
  if (v?.percentage !== undefined && v?.percentage !== null) {
    return { type: "percentage", value: str(Math.round(v.percentage * 100 * 1e6) / 1e6), eachItem: "" };
  }
  if (v?.amount) return { type: "fixed_amount", value: v.amount.amount, eachItem: boolCell(v.appliesOnEachItem) };
  return { type: "", value: "", eachItem: "" };
}

function appliesTo(items: any): Row {
  switch (items?.__typename) {
    case "AllDiscountItems":
      return { "Applies To": "all" };
    case "DiscountProducts":
      return {
        "Applies To": "products",
        "Applies To: Product IDs": ids(items.products?.nodes ?? items.products),
        "Applies To: Variant IDs": ids(items.productVariants?.nodes ?? items.productVariants),
      };
    case "DiscountCollections":
      return { "Applies To": "collections", "Applies To: Collection IDs": ids(items.collections?.nodes ?? items.collections) };
    default:
      return {};
  }
}

function customerSelection(ctxSel: any): Row {
  switch (ctxSel?.__typename) {
    case "DiscountBuyerSelectionAll":
      return { "Customer Selection": "all" };
    case "DiscountCustomers":
      return { "Customer Selection": "customers", "Customer Selection: Customer IDs": ids(ctxSel.customers) };
    case "DiscountCustomerSegments":
      return { "Customer Selection": "segments", "Customer Selection: Segment IDs": ids(ctxSel.segments) };
    case "DiscountMarkets":
      return { "Customer Selection": "markets" };
    default:
      return {};
  }
}

/** Maps a reassembled discount node to rows. `items` overrides customerGets.items (fetched separately). */
export function discountToRows(node: any, groups: Set<string>, items?: any): Row[] {
  const d = node.discount ?? {};
  const kind = TYPENAMES[d.__typename] ?? { type: "", method: "" };
  // Codes are children of the node in bulk output (DiscountRedeemCode -> `codes`).
  const codes: any[] = node.codes ?? d.codes?.nodes ?? [];
  const count = Math.max(1, codes.length);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const row: Row = { ID: gidToId(node.id), "Row #": String(i + 1), "Top Row": boolCell(i === 0) };
    if (i === 0) {
      const value = valueCells(d.customerGets?.value);
      const min = d.minimumRequirement;
      Object.assign(row, {
        Command: "MERGE",
        Title: d.title ?? "",
        Type: kind.type,
        Method: kind.method,
        Status: (d.status ?? "").toLowerCase(),
        "Starts At": d.startsAt ?? "",
        "Ends At": d.endsAt ?? "",
        "Created At": d.createdAt ?? "",
        "Updated At": d.updatedAt ?? "",
        "Usage Limit": str(d.usageLimit),
        "Once Per Customer": kind.method === "Code" ? boolCell(d.appliesOncePerCustomer) : "",
        "Used Count": str(d.asyncUsageCount),
        "Combines With": [
          d.combinesWith?.orderDiscounts && "Order",
          d.combinesWith?.productDiscounts && "Product",
          d.combinesWith?.shippingDiscounts && "Shipping",
        ]
          .filter(Boolean)
          .join(", "),
        "Value Type": value.type,
        Value: value.value,
        "Applies On Each Item": value.eachItem,
        "Minimum Requirement":
          min?.__typename === "DiscountMinimumSubtotal" ? "subtotal" : min?.__typename === "DiscountMinimumQuantity" ? "quantity" : "",
        "Minimum Requirement Value":
          min?.__typename === "DiscountMinimumSubtotal"
            ? (min.greaterThanOrEqualToSubtotal?.amount ?? "")
            : str(min?.greaterThanOrEqualToQuantity),
        Summary: d.summary ?? d.appDiscountType?.title ?? "",
        ...appliesTo(items ?? d.customerGets?.items),
        ...customerSelection(d.context),
      });
      if (kind.type === "Free Shipping") {
        const dest = d.destinationSelection;
        row["Shipping Countries"] = dest?.__typename === "DiscountCountries" ? (dest.countries ?? []).join(", ") : "all";
        row["Maximum Shipping Price"] = d.maximumShippingPrice?.amount ?? "";
      }
      if (groups.has("metafields")) metafieldsToRow(row, node.metafields);
    }
    if (codes[i]) row.Code = codes[i].code ?? "";
    rows.push(row);
  }
  return rows;
}

async function exportDiscounts(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? discountsEntity.groups!.filter((g) => g.default).map((g) => g.key));
  const search = buildSearchQuery(ctx.options);
  let n = 0;
  for await (const node of ctx.bulk(discountsBulkQuery(search, groups))) {
    let items: any;
    const t = node.discount?.customerGets?.items?.__typename;
    if (t === "DiscountProducts" || t === "DiscountCollections") {
      // Product/collection lists cannot be in the bulk query (connection limit).
      const detail = (await ctx.gql(DISCOUNT_DETAIL, { id: node.id })).discountNode;
      items = detail?.discount?.customerGets?.items;
    }
    await emit(discountToRows(node, groups, items));
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import: lookups --------------------------------------------------------------------

const DISCOUNT_BY_CODE = `#graphql
  query ImportDiscountByCode($code: String!) { codeDiscountNodeByCode(code: $code) { id } }
`;

const DISCOUNTS_BY_TITLE = `#graphql
  query ImportDiscountsByTitle($query: String!) {
    discountNodes(first: 25, query: $query) {
      nodes {
        id
        discount {
          __typename
          ... on DiscountAutomaticBasic { title }
          ... on DiscountAutomaticBxgy { title }
          ... on DiscountAutomaticFreeShipping { title }
          ... on DiscountAutomaticApp { title }
        }
      }
    }
  }
`;

interface ExistingDiscount {
  id: string;
  typename: string;
  type: DiscountType;
  method: Method;
  discount: any;
  codes: string[];
}

async function fetchDetail(gql: Gql, id: string): Promise<ExistingDiscount | null> {
  const node = (await gql(DISCOUNT_DETAIL, { id })).discountNode;
  if (!node?.discount) return null;
  const kind = TYPENAMES[node.discount.__typename];
  if (!kind) return null;
  return {
    id: node.id,
    typename: node.discount.__typename,
    ...kind,
    discount: node.discount,
    codes: (node.discount.codes?.nodes ?? []).map((c: any) => c.code),
  };
}

/**
 * Lookup order: ID (as a code or automatic node, guided by Method), then the
 * first Code (code discounts), then exact Title (automatic discounts only, as
 * they have no code).
 */
async function findDiscount(gql: Gql, idCell: string | undefined, method: Method | undefined, code: string | undefined, title: string | undefined) {
  if (idCell) {
    const candidates = idCell.startsWith("gid://")
      ? [idCell]
      : method === "Automatic"
        ? [toGid("DiscountAutomaticNode", idCell)!]
        : method === "Code"
          ? [toGid("DiscountCodeNode", idCell)!]
          : [toGid("DiscountCodeNode", idCell)!, toGid("DiscountAutomaticNode", idCell)!];
    for (const id of candidates) {
      const d = await fetchDetail(gql, id);
      if (d) return d;
    }
  }
  if (code) {
    const node = (await gql(DISCOUNT_BY_CODE, { code })).codeDiscountNodeByCode;
    if (node) return fetchDetail(gql, node.id);
  }
  if (title && method !== "Code" && !code) {
    const data = await gql(DISCOUNTS_BY_TITLE, { query: `title:${JSON.stringify(title)}` });
    const hits = (data.discountNodes.nodes as any[]).filter(
      (n) => TYPENAMES[n.discount?.__typename]?.method === "Automatic" && n.discount.title === title,
    );
    if (hits.length > 1) throw new ImportError(`Several automatic discounts are titled "${title}"; use the ID column`);
    if (hits.length) return fetchDetail(gql, hits[0].id);
  }
  return null;
}

// --- Import: mutations ----------------------------------------------------------------

const CODE_BASIC_CREATE = `#graphql
  mutation ImportDiscountCodeBasicCreate($input: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message code } }
  }
`;
const CODE_BASIC_UPDATE = `#graphql
  mutation ImportDiscountCodeBasicUpdate($id: ID!, $input: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message code } }
  }
`;
const AUTO_BASIC_CREATE = `#graphql
  mutation ImportDiscountAutomaticBasicCreate($input: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $input) { automaticDiscountNode { id } userErrors { field message code } }
  }
`;
const AUTO_BASIC_UPDATE = `#graphql
  mutation ImportDiscountAutomaticBasicUpdate($id: ID!, $input: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $input) { automaticDiscountNode { id } userErrors { field message code } }
  }
`;
const CODE_SHIPPING_CREATE = `#graphql
  mutation ImportDiscountCodeFreeShippingCreate($input: DiscountCodeFreeShippingInput!) {
    discountCodeFreeShippingCreate(freeShippingCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message code } }
  }
`;
const CODE_SHIPPING_UPDATE = `#graphql
  mutation ImportDiscountCodeFreeShippingUpdate($id: ID!, $input: DiscountCodeFreeShippingInput!) {
    discountCodeFreeShippingUpdate(id: $id, freeShippingCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message code } }
  }
`;
const AUTO_SHIPPING_CREATE = `#graphql
  mutation ImportDiscountAutomaticFreeShippingCreate($input: DiscountAutomaticFreeShippingInput!) {
    discountAutomaticFreeShippingCreate(freeShippingAutomaticDiscount: $input) { automaticDiscountNode { id } userErrors { field message code } }
  }
`;
const AUTO_SHIPPING_UPDATE = `#graphql
  mutation ImportDiscountAutomaticFreeShippingUpdate($id: ID!, $input: DiscountAutomaticFreeShippingInput!) {
    discountAutomaticFreeShippingUpdate(id: $id, freeShippingAutomaticDiscount: $input) { automaticDiscountNode { id } userErrors { field message code } }
  }
`;
const CODE_DELETE = `#graphql
  mutation ImportDiscountCodeDelete($id: ID!) {
    discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message code } }
  }
`;
const AUTO_DELETE = `#graphql
  mutation ImportDiscountAutomaticDelete($id: ID!) {
    discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field message code } }
  }
`;
const CODES_ADD = `#graphql
  mutation ImportDiscountCodesAdd($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
    discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
      bulkCreation { id }
      userErrors { field message code }
    }
  }
`;

const MUTATIONS: Record<string, { create: string; update: string; field: { create: string; update: string } }> = {
  "Basic/Code": {
    create: CODE_BASIC_CREATE,
    update: CODE_BASIC_UPDATE,
    field: { create: "discountCodeBasicCreate", update: "discountCodeBasicUpdate" },
  },
  "Basic/Automatic": {
    create: AUTO_BASIC_CREATE,
    update: AUTO_BASIC_UPDATE,
    field: { create: "discountAutomaticBasicCreate", update: "discountAutomaticBasicUpdate" },
  },
  "Free Shipping/Code": {
    create: CODE_SHIPPING_CREATE,
    update: CODE_SHIPPING_UPDATE,
    field: { create: "discountCodeFreeShippingCreate", update: "discountCodeFreeShippingUpdate" },
  },
  "Free Shipping/Automatic": {
    create: AUTO_SHIPPING_CREATE,
    update: AUTO_SHIPPING_UPDATE,
    field: { create: "discountAutomaticFreeShippingCreate", update: "discountAutomaticFreeShippingUpdate" },
  },
};

/** Comma/newline separated IDs -> GIDs of the given type. */
function idList(v: string | undefined, type: string): string[] {
  return (v ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => toGid(type, s)!);
}

const existingIds = (list: any[] | undefined) => (list ?? []).map((x: any) => x.id as string);
const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

function combinesWith(v: string): Record<string, boolean> {
  const parts = v.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  for (const p of parts) {
    if (!["order", "product", "shipping"].includes(p)) throw new ImportError(`Combines With "${p}" must be Order, Product or Shipping`);
  }
  return { orderDiscounts: parts.includes("order"), productDiscounts: parts.includes("product"), shippingDiscounts: parts.includes("shipping") };
}

function contextInput(top: Row, existing: ExistingDiscount | null): Record<string, any> | undefined {
  const sel = cell(top, "Customer Selection");
  if (!sel) return undefined;
  const ctx = existing?.discount?.context;
  switch (sel.toLowerCase()) {
    case "all":
      return { all: "ALL" };
    case "customers": {
      const want = idList(cell(top, "Customer Selection: Customer IDs"), "Customer");
      if (!want.length) throw new ImportError("Customer Selection: Customer IDs is required for customers");
      const had = ctx?.__typename === "DiscountCustomers" ? existingIds(ctx.customers) : [];
      return { customers: { add: minus(want, had), ...(had.length ? { remove: minus(had, want) } : {}) } };
    }
    case "segments": {
      const want = idList(cell(top, "Customer Selection: Segment IDs"), "Segment");
      if (!want.length) throw new ImportError("Customer Selection: Segment IDs is required for segments");
      const had = ctx?.__typename === "DiscountCustomerSegments" ? existingIds(ctx.segments) : [];
      return { customerSegments: { add: minus(want, had), ...(had.length ? { remove: minus(had, want) } : {}) } };
    }
    default:
      throw new ImportError(`Customer Selection "${sel}" must be all, customers or segments`);
  }
}

function minimumInput(top: Row, creating: boolean): Record<string, any> | undefined {
  const kind = cell(top, "Minimum Requirement");
  if (kind === undefined) return undefined;
  const value = cell(top, "Minimum Requirement Value");
  switch (kind.toLowerCase()) {
    case "":
    case "none":
      // Removing a requirement: both set to null.
      return creating
        ? undefined
        : { quantity: { greaterThanOrEqualToQuantity: null }, subtotal: { greaterThanOrEqualToSubtotal: null } };
    case "subtotal": {
      const n = parseNumber(value);
      if (n === undefined) throw new ImportError("Minimum Requirement Value is required");
      return { subtotal: { greaterThanOrEqualToSubtotal: String(n) } };
    }
    case "quantity": {
      const n = parseInt10(value);
      if (n === undefined) throw new ImportError("Minimum Requirement Value is required");
      return { quantity: { greaterThanOrEqualToQuantity: String(n) } };
    }
    default:
      throw new ImportError(`Minimum Requirement "${kind}" must be subtotal, quantity or none`);
  }
}

function customerGetsInput(top: Row, existing: ExistingDiscount | null, creating: boolean): Record<string, any> | undefined {
  const out: Record<string, any> = {};
  const valueCell = cell(top, "Value");
  if (valueCell) {
    const n = Math.abs(parseNumber(valueCell)!);
    const vt = (cell(top, "Value Type") || "percentage").toLowerCase().replace(/[\s-]+/g, "_");
    if (vt === "percentage") {
      if (n > 100) throw new ImportError("Value must be between 0 and 100 for a percentage");
      out.value = { percentage: n / 100 };
    } else if (vt === "fixed_amount" || vt === "amount") {
      out.value = { discountAmount: { amount: String(n), appliesOnEachItem: parseBool(cell(top, "Applies On Each Item")) ?? false } };
    } else throw new ImportError(`Value Type "${vt}" must be percentage or fixed_amount`);
  } else if (creating) throw new ImportError("Value is required for a Basic discount");

  const applies = cell(top, "Applies To");
  const items = existing?.discount?.customerGets?.items;
  if (applies) {
    switch (applies.toLowerCase()) {
      case "all":
        out.items = { all: true };
        break;
      case "products": {
        const products = idList(cell(top, "Applies To: Product IDs"), "Product");
        const variants = idList(cell(top, "Applies To: Variant IDs"), "ProductVariant");
        if (!products.length && !variants.length) throw new ImportError("Applies To: Product IDs or Variant IDs is required for products");
        const hadP = items?.__typename === "DiscountProducts" ? existingIds(items.products?.nodes) : [];
        const hadV = items?.__typename === "DiscountProducts" ? existingIds(items.productVariants?.nodes) : [];
        out.items = {
          products: {
            productsToAdd: minus(products, hadP),
            productVariantsToAdd: minus(variants, hadV),
            ...(hadP.length || hadV.length ? { productsToRemove: minus(hadP, products), productVariantsToRemove: minus(hadV, variants) } : {}),
          },
        };
        break;
      }
      case "collections": {
        const want = idList(cell(top, "Applies To: Collection IDs"), "Collection");
        if (!want.length) throw new ImportError("Applies To: Collection IDs is required for collections");
        const had = items?.__typename === "DiscountCollections" ? existingIds(items.collections?.nodes) : [];
        out.items = { collections: { add: minus(want, had), ...(had.length ? { remove: minus(had, want) } : {}) } };
        break;
      }
      default:
        throw new ImportError(`Applies To "${applies}" must be all, products or collections`);
    }
  } else if (creating) out.items = { all: true };
  return Object.keys(out).length ? out : undefined;
}

function destinationInput(top: Row, existing: ExistingDiscount | null): Record<string, any> | undefined {
  const v = cell(top, "Shipping Countries");
  if (v === undefined) return undefined;
  if (v === "" || v.toLowerCase() === "all") return { all: true };
  const want = v.split(/[\s,;]+/).filter(Boolean).map((c) => c.toUpperCase());
  const dest = existing?.discount?.destinationSelection;
  const had: string[] = dest?.__typename === "DiscountCountries" ? dest.countries : [];
  return { countries: { add: minus(want, had), ...(had.length ? { remove: minus(had, want) } : {}) } };
}

/** Builds the Discount{Code,Automatic}{Basic,FreeShipping}Input from the top row. */
export function discountInput(
  top: Row,
  type: DiscountType,
  method: Method,
  existing: ExistingDiscount | null,
  firstCode: string | undefined,
): Record<string, any> {
  const creating = !existing;
  const input: Record<string, any> = {};
  const title = cell(top, "Title");
  if (title) input.title = title;
  else if (creating) throw new ImportError("Title is required to create a discount");
  const starts = cell(top, "Starts At");
  if (starts) input.startsAt = starts;
  else if (creating) input.startsAt = new Date().toISOString();
  const ends = cell(top, "Ends At");
  if (ends !== undefined && (ends || !creating)) input.endsAt = ends || null;
  const combines = cell(top, "Combines With");
  if (combines !== undefined) input.combinesWith = combinesWith(combines);
  const context = contextInput(top, existing);
  if (context) input.context = context;
  const minimum = minimumInput(top, creating);
  if (minimum) input.minimumRequirement = minimum;

  if (method === "Code") {
    if (creating) {
      if (!firstCode) throw new ImportError("Code is required to create a code discount");
      input.code = firstCode;
    }
    const limit = cell(top, "Usage Limit");
    if (limit !== undefined && (limit || !creating)) input.usageLimit = limit ? parseInt10(limit) : null;
    const once = parseBool(cell(top, "Once Per Customer"));
    if (once !== undefined) input.appliesOncePerCustomer = once;
  }

  if (type === "Basic") {
    const gets = customerGetsInput(top, existing, creating);
    if (gets) input.customerGets = gets;
  } else {
    const dest = destinationInput(top, existing);
    if (dest) input.destination = dest;
    else if (creating) input.destination = { all: true };
    const max = cell(top, "Maximum Shipping Price");
    if (max !== undefined && (max || !creating)) input.maximumShippingPrice = max ? String(parseNumber(max)) : null;
  }
  return input;
}

async function addCodes(gql: Gql, discountId: string, codes: string[]): Promise<number> {
  for (const batch of chunk(codes, 250)) {
    const d = await gql(CODES_ADD, { discountId, codes: batch.map((code) => ({ code })) });
    assertNoUserErrors(d.discountRedeemCodeBulkAdd, "Add codes");
  }
  return codes.length;
}

async function deleteDiscount(gql: Gql, existing: ExistingDiscount) {
  if (existing.method === "Code") {
    const d = await gql(CODE_DELETE, { id: existing.id });
    assertNoUserErrors(d.discountCodeDelete, "Delete discount");
  } else {
    const d = await gql(AUTO_DELETE, { id: existing.id });
    assertNoUserErrors(d.discountAutomaticDelete, "Delete discount");
  }
}

async function saveDiscount(
  ctx: ImportContext,
  rows: Row[],
  type: DiscountType,
  method: Method,
  existing: ExistingDiscount | null,
  codes: string[],
): Promise<{ id: string; notes: string[] }> {
  const top = rows[0];
  const notes: string[] = [];
  const m = MUTATIONS[`${type}/${method}`];
  const input = discountInput(top, type, method, existing, codes[0]);
  let id: string;
  if (existing) {
    const d = await ctx.gql(m.update, { id: existing.id, input });
    const payload = d[m.field.update];
    assertNoUserErrors(payload, "Update discount");
    id = existing.id;
  } else {
    const d = await ctx.gql(m.create, { input });
    const payload = d[m.field.create];
    assertNoUserErrors(payload, "Create discount");
    id = (payload.codeDiscountNode ?? payload.automaticDiscountNode).id;
  }

  if (method === "Code") {
    const known = new Set((existing ? existing.codes : codes.slice(0, 1)).map((c) => c.toLowerCase()));
    const toAdd = [...new Set(codes)].filter((c) => !known.has(c.toLowerCase()));
    if (toAdd.length) notes.push(`${await addCodes(ctx.gql, id, toAdd)} codes queued`);
  } else if (codes.length) notes.push("Codes ignored for an automatic discount");

  const mf = metafieldsFromRow(top);
  if (mf.set.length || (existing && mf.blank.length)) await writeMetafields(ctx.gql, id, mf.set, existing ? mf.blank : []);
  return { id, notes };
}

export async function importDiscount(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const top = rows[0];
  const codes = rows.map((r) => cell(r, "Code") ?? "").filter(Boolean);
  const method = parseMethod(cell(top, "Method"));
  const sheetType = parseType(cell(top, "Type"));
  const existing = await findDiscount(ctx.gql, cell(top, "ID"), method, codes[0], cell(top, "Title"));
  const patches = (id: string) => rows.map(() => ({ ID: gidToId(id) }));

  if (command === "DELETE") {
    if (!existing) return { status: "Failed", command, message: "Discount not found" };
    await deleteDiscount(ctx.gql, existing);
    return { status: "OK", command, id: existing.id, message: "Deleted" };
  }
  if (command !== "NEW" && command !== "MERGE" && command !== "UPDATE" && command !== "REPLACE") {
    return { status: "Skipped", command };
  }

  const type = sheetType ?? existing?.type ?? "Basic";
  const effMethod: Method = method ?? existing?.method ?? (codes.length ? "Code" : "Automatic");
  if (type === "BxGy" || type === "App") {
    return {
      status: "Skipped",
      command,
      id: existing?.id,
      message: `${type === "BxGy" ? "Buy X Get Y" : "App"} discounts are export-only; only DELETE is supported`,
    };
  }

  if (command === "NEW" && existing) return { status: "Failed", command, id: existing.id, message: "Discount already exists" };
  if (command === "UPDATE" && !existing) return { status: "Failed", command, message: "Discount not found" };

  let target = existing;
  if (command === "REPLACE" && existing) {
    await deleteDiscount(ctx.gql, existing);
    target = null;
  }
  if (target && (target.type !== type || target.method !== effMethod)) {
    return {
      status: "Failed",
      command,
      id: target.id,
      message: `Existing discount is ${target.type} (${target.method}); use REPLACE to change it to ${type} (${effMethod})`,
    };
  }
  const r = await saveDiscount(ctx, rows, type, effMethod, target, codes);
  const verb = target ? "Updated" : command === "REPLACE" && existing ? "Replaced" : "Created";
  return { status: "OK", command, id: r.id, message: [verb, ...r.notes].join("; "), rowPatches: patches(r.id) };
}

/**
 * Key columns: Matrixify identifies discounts by ID, then Code. Here Code
 * cannot group rows because every row of a discount carries a different
 * code, so rows are grouped by ID (exported on every row), then by Title (on
 * the top row of new discounts; code-only continuation rows have both blank).
 * Matching an existing discount still follows Matrixify: ID, then first
 * Code, then Title for automatic discounts.
 */
export const discountsEntity: Entity = {
  key: "discounts",
  sheet: "Discounts",
  aliases: ["discount", "discount codes", "price rules"],
  description: "Code and automatic discounts (Basic, Free Shipping, Buy X Get Y, App) with their codes. BxGy and App are export-only.",
  columns: DISCOUNT_COLUMNS,
  supportsQuery: true,
  groups: [
    { key: "codes", label: "Discount codes", default: true },
    { key: "metafields", label: "Discount metafields", default: true },
  ],
  export: exportDiscounts,
  import: { keyColumns: ["ID", "Title"], apply: importDiscount },
};
