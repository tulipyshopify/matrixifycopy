import type { Command, Entity, ExportContext, Gql, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import {
  assertNoUserErrors,
  boolCell,
  buildSearchQuery,
  cell,
  gidToId,
  gqlString,
  joinTags,
  metafieldsFromRow,
  metafieldsToRow,
  parseBool,
  parseNumber,
  parseSubCommand,
  splitTags,
  str,
  toGid,
} from "../core/util";
import { addTags, removeTags, writeMetafields } from "../core/lookups";
import {
  ADDRESS_SELECTION,
  addressColumns,
  addressFromRow,
  addressToRow,
  bagAmount,
  enumCell,
  enumToCell,
  LINE_COLUMNS,
  lineToRow,
  moneyInput,
  parseLines,
  parseMoney,
  rowCurrency,
  variantIdBySku,
} from "./order_common";

/**
 * Draft orders. Same layout as Orders: one line item per row, draft fields on
 * the top row, ID and Name on every row.
 *
 * Import creates/updates with draftOrderCreate/draftOrderUpdate. When line
 * rows are present on update, they REPLACE the draft's line items (that is
 * how draftOrderUpdate works). Line: Price only applies to custom lines;
 * variant lines use the variant's current price unless an applied discount
 * is given. Completing drafts and sending invoices are out of scope.
 */

// --- Columns --------------------------------------------------------------------

const DRAFT_COLUMNS = [
  "ID",
  "Name",
  "Command",
  "Status",
  "Email",
  "Phone",
  "Created At",
  "Updated At",
  "Completed At",
  "Invoice URL",
  "Invoice Sent At",
  "Reserve Inventory Until",
  "Order: ID",
  "Currency",
  "Subtotal",
  "Total Discounts",
  "Total Shipping",
  "Total Tax",
  "Total Price",
  "Taxes Included",
  "Tax Exempt",
  "Tags",
  "Tags Command",
  "Note",
  "Customer: ID",
  "Customer: Email",
  "Discount Codes",
  "Applied Discount: Title",
  "Applied Discount: Description",
  "Applied Discount: Value Type",
  "Applied Discount: Value",
  "Applied Discount: Amount",
  "Shipping Line: Title",
  "Shipping Line: Price",
  "Row #",
  "Top Row",
];

const DRAFT_LINE_COLUMNS = [...LINE_COLUMNS, "Line: Custom", "Line: Applied Discount: Value Type", "Line: Applied Discount: Value"];

const DISCOUNT_TYPES: Record<string, string> = {
  PERCENTAGE: "PERCENTAGE",
  FIXED_AMOUNT: "FIXED_AMOUNT",
  FIXED: "FIXED_AMOUNT",
  AMOUNT: "FIXED_AMOUNT",
};

// --- Export -------------------------------------------------------------------------

const MONEY = "{ shopMoney { amount } }";

export function draftOrdersBulkQuery(search: string, groups: Set<string>): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  const metafields = `metafields { edges { node { id namespace key type value } } }`;
  const lineItems = `lineItems { edges { node {
      id title variantTitle sku quantity vendor requiresShipping taxable custom
      originalUnitPriceSet ${MONEY}
      totalDiscountSet ${MONEY}
      appliedDiscount { value valueType }
      variant { id }
      product { id }
  } } }`;
  return `{
    draftOrders${args} { edges { node {
      id name status email phone createdAt updatedAt completedAt invoiceUrl invoiceSentAt reserveInventoryUntil
      currencyCode taxesIncluded taxExempt tags note2 discountCodes
      order { id }
      subtotalPriceSet ${MONEY}
      totalDiscountsSet ${MONEY}
      totalShippingPriceSet ${MONEY}
      totalTaxSet ${MONEY}
      totalPriceSet ${MONEY}
      appliedDiscount { title description value valueType amountSet ${MONEY} }
      customer { id defaultEmailAddress { emailAddress } }
      billingAddress { ${ADDRESS_SELECTION} }
      shippingAddress { ${ADDRESS_SELECTION} }
      shippingLine { title originalPriceSet ${MONEY} }
      ${groups.has("metafields") ? metafields : ""}
      ${groups.has("line_items") ? lineItems : ""}
    } } }
  }`;
}

export function draftOrderToRows(d: any, groups: Set<string>): Row[] {
  const lines: any[] = d.lineItems ?? [];
  const count = Math.max(1, lines.length);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const row: Row = { ID: gidToId(d.id), Name: d.name ?? "", "Row #": String(i + 1), "Top Row": boolCell(i === 0) };
    if (i === 0) {
      const ad = d.appliedDiscount;
      Object.assign(row, {
        Command: "MERGE",
        Status: enumToCell(d.status),
        Email: d.email ?? "",
        Phone: d.phone ?? "",
        "Created At": d.createdAt ?? "",
        "Updated At": d.updatedAt ?? "",
        "Completed At": d.completedAt ?? "",
        "Invoice URL": d.invoiceUrl ?? "",
        "Invoice Sent At": d.invoiceSentAt ?? "",
        "Reserve Inventory Until": d.reserveInventoryUntil ?? "",
        "Order: ID": gidToId(d.order?.id),
        Currency: d.currencyCode ?? "",
        Subtotal: bagAmount(d.subtotalPriceSet),
        "Total Discounts": bagAmount(d.totalDiscountsSet),
        "Total Shipping": bagAmount(d.totalShippingPriceSet),
        "Total Tax": bagAmount(d.totalTaxSet),
        "Total Price": bagAmount(d.totalPriceSet),
        "Taxes Included": boolCell(d.taxesIncluded),
        "Tax Exempt": boolCell(d.taxExempt),
        Tags: joinTags(d.tags),
        "Tags Command": "REPLACE",
        Note: d.note2 ?? "",
        "Customer: ID": gidToId(d.customer?.id),
        "Customer: Email": d.customer?.defaultEmailAddress?.emailAddress ?? "",
        "Discount Codes": (d.discountCodes ?? []).join(", "),
        "Applied Discount: Title": ad?.title ?? "",
        "Applied Discount: Description": ad?.description ?? "",
        "Applied Discount: Value Type": enumToCell(ad?.valueType),
        "Applied Discount: Value": str(ad?.value),
        "Applied Discount: Amount": bagAmount(ad?.amountSet),
        "Shipping Line: Title": d.shippingLine?.title ?? "",
        "Shipping Line: Price": bagAmount(d.shippingLine?.originalPriceSet),
      });
      addressToRow(row, "Billing", d.billingAddress);
      addressToRow(row, "Shipping", d.shippingAddress);
      if (groups.has("metafields")) metafieldsToRow(row, d.metafields);
    }
    const li = lines[i];
    if (li) {
      lineToRow(row, li);
      row["Line: Custom"] = boolCell(li.custom);
      row["Line: Applied Discount: Value Type"] = enumToCell(li.appliedDiscount?.valueType);
      row["Line: Applied Discount: Value"] = str(li.appliedDiscount?.value);
    }
    rows.push(row);
  }
  return rows;
}

async function exportDraftOrders(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? draftOrdersEntity.groups!.filter((g) => g.default).map((g) => g.key));
  const search = buildSearchQuery(ctx.options);
  let n = 0;
  for await (const d of ctx.bulk(draftOrdersBulkQuery(search, groups))) {
    await emit(draftOrderToRows(d, groups));
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import: lookups --------------------------------------------------------------------

const DRAFT_BY_ID = `#graphql
  query ImportDraftOrderById($id: ID!) { draftOrder(id: $id) { id name status } }
`;

const DRAFT_BY_NAME = `#graphql
  query ImportDraftOrderByName($query: String!) {
    draftOrders(first: 5, query: $query) { nodes { id name status } }
  }
`;

const CUSTOMER_BY_EMAIL = `#graphql
  query ImportDraftOrderCustomer($email: String!) {
    customerByIdentifier(identifier: { emailAddress: $email }) { id }
  }
`;

interface ExistingDraft {
  id: string;
  name: string;
  status: string;
}

async function fetchDraft(gql: Gql, by: { id?: string; name?: string }): Promise<ExistingDraft | null> {
  if (by.id) {
    const d = (await gql(DRAFT_BY_ID, { id: by.id })).draftOrder;
    if (d) return d;
  }
  if (by.name) {
    const data = await gql(DRAFT_BY_NAME, { query: `name:${JSON.stringify(by.name)}` });
    const want = by.name.toLowerCase();
    return (data.draftOrders.nodes as ExistingDraft[]).find((d) => d.name.toLowerCase() === want) ?? null;
  }
  return null;
}

// --- Import: mutations ----------------------------------------------------------------

const DRAFT_CREATE = `#graphql
  mutation ImportDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name invoiceUrl lineItems(first: 250) { nodes { id } } }
      userErrors { field message }
    }
  }
`;

const DRAFT_UPDATE = `#graphql
  mutation ImportDraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { id name invoiceUrl lineItems(first: 250) { nodes { id } } }
      userErrors { field message }
    }
  }
`;

const DRAFT_DELETE = `#graphql
  mutation ImportDraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`;

function appliedDiscountFromRow(row: Row, prefix: string, currency: string): Record<string, any> | null | undefined {
  const valueCell = cell(row, `${prefix}: Value`);
  if (valueCell === undefined) return undefined;
  if (valueCell === "") return null; // blank removes the discount
  const value = Math.abs(parseNumber(valueCell)!);
  const typeCell = cell(row, `${prefix}: Value Type`) || "fixed_amount";
  const valueType = DISCOUNT_TYPES[enumCell(typeCell)];
  if (!valueType) throw new ImportError(`${prefix}: Value Type must be percentage or fixed_amount`);
  const out: Record<string, any> = { value, valueType };
  if (valueType === "FIXED_AMOUNT") out.amountWithCurrency = moneyInput(String(value), currency);
  const title = cell(row, `${prefix}: Title`);
  if (title) out.title = title;
  const desc = cell(row, `${prefix}: Description`);
  if (desc) out.description = desc;
  return out;
}

/**
 * DraftOrderInput from the item's rows. Only columns present in the sheet are
 * sent, so partial sheets update partially.
 */
export async function draftOrderInput(
  ctx: ImportContext,
  rows: Row[],
  creating: boolean,
): Promise<{ input: Record<string, any>; lineRows: number[]; notes: string[] }> {
  const top = rows[0];
  const notes: string[] = [];
  const currency = await rowCurrency(ctx.gql, ctx.cache, top);
  const input: Record<string, any> = {};

  const lines = parseLines(rows);
  if (creating && !lines.length) throw new ImportError("At least one line item is required to create a draft order");
  if (lines.length) {
    input.lineItems = [];
    for (const l of lines) {
      const row = rows[l.rowIndex];
      const li: Record<string, any> = { quantity: l.quantity };
      let variantId = l.variantId;
      const custom = parseBool(cell(row, "Line: Custom"));
      if (!variantId && l.sku && custom !== true) variantId = (await variantIdBySku(ctx.gql, ctx.cache, l.sku)) ?? undefined;
      if (variantId && custom !== true) li.variantId = variantId;
      else {
        if (!l.title) throw new ImportError(`Line on row ${l.rowIndex + 1}: variant not found; Line: Title and Line: Price are needed for a custom line`);
        if (l.price === undefined) throw new ImportError(`Line on row ${l.rowIndex + 1}: Line: Price is required for a custom line`);
        li.title = l.title;
        li.originalUnitPriceWithCurrency = moneyInput(l.price, currency);
        if (l.sku) li.sku = l.sku;
        if (l.requiresShipping !== undefined) li.requiresShipping = l.requiresShipping;
        if (l.taxable !== undefined) li.taxable = l.taxable;
      }
      const ad = appliedDiscountFromRow(row, "Line: Applied Discount", currency);
      if (ad) li.appliedDiscount = ad;
      input.lineItems.push(li);
    }
  }

  for (const [col, key] of [
    ["Email", "email"],
    ["Phone", "phone"],
    ["Note", "note"],
  ] as const) {
    const v = cell(top, col);
    if (v !== undefined && (v || (key === "note" && !creating))) input[key] = v;
  }
  const taxExempt = parseBool(cell(top, "Tax Exempt"));
  if (taxExempt !== undefined) input.taxExempt = taxExempt;
  const reserve = cell(top, "Reserve Inventory Until");
  if (reserve !== undefined && (reserve || !creating)) input.reserveInventoryUntil = reserve || null;
  const codes = cell(top, "Discount Codes");
  if (codes !== undefined && (codes || !creating)) input.discountCodes = splitTags(codes);

  const billing = addressFromRow(top, "Billing");
  if (billing) input.billingAddress = billing;
  const shipping = addressFromRow(top, "Shipping");
  if (shipping) input.shippingAddress = shipping;

  const customerId = toGid("Customer", cell(top, "Customer: ID"));
  const customerEmail = cell(top, "Customer: Email");
  if (customerId) input.purchasingEntity = { customerId };
  else if (customerEmail) {
    const c = (await ctx.gql(CUSTOMER_BY_EMAIL, { email: customerEmail })).customerByIdentifier;
    if (c) input.purchasingEntity = { customerId: c.id };
    else {
      notes.push(`Customer ${customerEmail} not found; email set on the draft only`);
      input.email ??= customerEmail;
    }
  }

  const shipTitle = cell(top, "Shipping Line: Title");
  if (shipTitle) {
    const price = parseMoney(cell(top, "Shipping Line: Price"), "Shipping Line: Price") ?? "0";
    input.shippingLine = { title: shipTitle, priceWithCurrency: moneyInput(price, currency) };
  }

  const ad = appliedDiscountFromRow(top, "Applied Discount", currency);
  if (ad !== undefined && (ad || !creating)) input.appliedDiscount = ad;

  if (creating) {
    const tags = cell(top, "Tags");
    if (tags) input.tags = splitTags(tags);
    const mf = metafieldsFromRow(top).set;
    if (mf.length) input.metafields = mf;
  }
  return { input, lineRows: lines.map((l) => l.rowIndex), notes };
}

function patches(rows: Row[], draft: any, lineRows: number[]): Array<Row | undefined> {
  const out: Array<Row | undefined> = rows.map(() => ({ ID: gidToId(draft.id), Name: draft.name }));
  out[0] = { ...out[0], "Invoice URL": draft.invoiceUrl ?? "" };
  (draft.lineItems?.nodes ?? []).forEach((li: any, i: number) => {
    const r = lineRows[i];
    if (r !== undefined) out[r] = { ...out[r], "Line: ID": gidToId(li.id) };
  });
  return out;
}

async function createDraft(ctx: ImportContext, rows: Row[]) {
  const { input, lineRows, notes } = await draftOrderInput(ctx, rows, true);
  const d = await ctx.gql(DRAFT_CREATE, { input });
  assertNoUserErrors(d.draftOrderCreate, "Create draft order");
  const draft = d.draftOrderCreate.draftOrder;
  return { id: draft.id as string, rowPatches: patches(rows, draft, lineRows), notes };
}

async function updateDraft(ctx: ImportContext, existing: ExistingDraft, rows: Row[]) {
  if (existing.status === "COMPLETED") throw new ImportError(`Draft order ${existing.name} is completed and cannot be changed`);
  const top = rows[0];
  const { input, lineRows, notes } = await draftOrderInput(ctx, rows, false);
  const tagsCell = cell(top, "Tags");
  const tagsCommand = parseSubCommand(cell(top, "Tags Command"), ["REPLACE", "MERGE", "DELETE"] as const, "REPLACE");
  if (tagsCell !== undefined && tagsCommand === "REPLACE") input.tags = splitTags(tagsCell);

  let rowPatches: Array<Row | undefined> = [];
  if (Object.keys(input).length) {
    const d = await ctx.gql(DRAFT_UPDATE, { id: existing.id, input });
    assertNoUserErrors(d.draftOrderUpdate, "Update draft order");
    rowPatches = patches(rows, d.draftOrderUpdate.draftOrder, input.lineItems ? lineRows : []);
  }
  if (tagsCell && tagsCommand === "MERGE") await addTags(ctx.gql, existing.id, splitTags(tagsCell));
  if (tagsCell && tagsCommand === "DELETE") await removeTags(ctx.gql, existing.id, splitTags(tagsCell));
  const mf = metafieldsFromRow(top);
  await writeMetafields(ctx.gql, existing.id, mf.set, mf.blank);
  return { rowPatches, notes };
}

async function deleteDraft(gql: Gql, id: string) {
  const d = await gql(DRAFT_DELETE, { input: { id } });
  assertNoUserErrors(d.draftOrderDelete, "Delete draft order");
}

export async function importDraftOrder(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const top = rows[0];
  const id = toGid("DraftOrder", cell(top, "ID"));
  const name = cell(top, "Name");
  const existing = id || name ? await fetchDraft(ctx.gql, { id, name }) : null;

  const created = async (message: string): Promise<ItemResult> => {
    const r = await createDraft(ctx, rows);
    return { status: "OK", command, id: r.id, message: [message, ...r.notes].join("; "), rowPatches: r.rowPatches };
  };

  switch (command) {
    case "DELETE": {
      if (!existing) return { status: "Failed", command, message: "Draft order not found" };
      await deleteDraft(ctx.gql, existing.id);
      return { status: "OK", command, id: existing.id, message: "Deleted" };
    }
    case "NEW": {
      if (existing) return { status: "Failed", command, id: existing.id, message: `Draft order ${existing.name} already exists` };
      return created("Created");
    }
    case "REPLACE": {
      if (existing) await deleteDraft(ctx.gql, existing.id);
      return created(existing ? "Replaced" : "Created");
    }
    case "UPDATE":
    case "MERGE": {
      if (!existing) {
        if (command === "UPDATE") return { status: "Failed", command, message: "Draft order not found" };
        return created("Created");
      }
      const r = await updateDraft(ctx, existing, rows);
      return { status: "OK", command, id: existing.id, message: ["Updated", ...r.notes].join("; "), rowPatches: r.rowPatches };
    }
    default:
      return { status: "Skipped", command };
  }
}

export const draftOrdersEntity: Entity = {
  key: "draft_orders",
  sheet: "Draft Orders",
  aliases: ["draft order", "draftorders", "drafts"],
  description: "Draft orders with line items, addresses, applied discounts and metafields.",
  columns: [...DRAFT_COLUMNS, ...addressColumns("Billing"), ...addressColumns("Shipping"), ...DRAFT_LINE_COLUMNS],
  supportsQuery: true,
  groups: [
    { key: "line_items", label: "Line items", default: true },
    { key: "metafields", label: "Draft order metafields", default: true },
  ],
  export: exportDraftOrders,
  import: { keyColumns: ["ID", "Name"], apply: importDraftOrder },
};
