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
  findByExactName,
  LINE_COLUMNS,
  type LineSpec,
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
 * how draftOrderUpdate works: `lineItems` replaces the whole list and every
 * line is rebuilt). To keep MERGE of an exported sheet lossless:
 * - export writes every line field draftOrderUpdate would otherwise drop
 *   (custom attributes, price override, weight, discount title/description),
 *   and import re-sends them;
 * - a line row whose Line: ID matches a current line takes absent columns
 *   from that line, so partial sheets keep the rest;
 * - lineItems are only sent when the sheet's lines differ from the draft's
 *   current lines (both normalized to DraftOrderLineItemInput), so an
 *   unchanged round-trip does not rebuild (and re-price) the lines.
 * Line: Price only applies to custom lines;
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

const DRAFT_LINE_COLUMNS = [
  ...LINE_COLUMNS,
  "Line: Custom",
  "Line: Applied Discount: Value Type",
  "Line: Applied Discount: Value",
  "Line: Applied Discount: Title",
  "Line: Applied Discount: Description",
  "Line: Price Override",
  "Line: Weight",
  "Line: Weight Unit",
  "Line: Custom Attributes",
];

const WEIGHT_UNITS: Record<string, string> = {
  GRAMS: "GRAMS",
  G: "GRAMS",
  KILOGRAMS: "KILOGRAMS",
  KG: "KILOGRAMS",
  OUNCES: "OUNCES",
  OZ: "OUNCES",
  POUNDS: "POUNDS",
  LB: "POUNDS",
  LBS: "POUNDS",
};

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
      appliedDiscount { title description value valueType }
      customAttributes { key value }
      priceOverride { amount }
      weight { unit value }
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
      row["Line: Applied Discount: Title"] = li.appliedDiscount?.title ?? "";
      row["Line: Applied Discount: Description"] = li.appliedDiscount?.description ?? "";
      row["Line: Price Override"] = li.priceOverride?.amount ?? "";
      row["Line: Weight"] = str(li.weight?.value);
      row["Line: Weight Unit"] = enumToCell(li.weight?.unit);
      row["Line: Custom Attributes"] = attributesToCell(li.customAttributes);
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
  query ImportDraftOrderByName($query: String!, $after: String) {
    draftOrders(first: 250, after: $after, query: $query) { nodes { id name status } pageInfo { hasNextPage endCursor } }
  }
`;

/** Current applied discount and lines, to default absent columns and diff lines on update. */
const DRAFT_DETAIL = `#graphql
  query ImportDraftOrderDetail($id: ID!, $after: String) {
    draftOrder(id: $id) {
      id
      appliedDiscount { title description value valueType }
      lineItems(first: 250, after: $after) {
        nodes {
          id title sku quantity requiresShipping taxable custom
          originalUnitPriceWithCurrency { amount }
          appliedDiscount { title description value valueType }
          customAttributes { key value }
          priceOverride { amount }
          weight { unit value }
          variant { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
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
  if (by.name) return findByExactName<ExistingDraft>(gql, DRAFT_BY_NAME, (d) => d.draftOrders, by.name, "draft order");
  return null;
}

interface DraftDetail {
  appliedDiscount: any;
  lineItems: any[];
}

async function fetchDraftDetail(gql: Gql, id: string): Promise<DraftDetail> {
  const lineItems: any[] = [];
  let appliedDiscount: any = null;
  let after: string | null = null;
  do {
    const d: any = (await gql(DRAFT_DETAIL, { id, after })).draftOrder;
    if (!d) throw new ImportError("Draft order not found");
    appliedDiscount = d.appliedDiscount ?? null;
    lineItems.push(...(d.lineItems?.nodes ?? []));
    after = d.lineItems?.pageInfo?.hasNextPage ? d.lineItems.pageInfo.endCursor : null;
  } while (after);
  return { appliedDiscount, lineItems };
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

/** Current applied discount (draft or line) -> DraftOrderAppliedDiscountInput. */
function discountToInput(ad: any, currency: string): Record<string, any> | null {
  if (!ad) return null;
  const value = Number(ad.value);
  const out: Record<string, any> = { value, valueType: ad.valueType };
  if (ad.valueType === "FIXED_AMOUNT") out.amountWithCurrency = moneyInput(String(value), currency);
  if (ad.title) out.title = ad.title;
  if (ad.description) out.description = ad.description;
  return out;
}

/**
 * Applied discount from the `${prefix}: ...` columns: undefined when the Value
 * column is absent (unchanged), null when blank (removed). Absent/blank Value
 * Type and absent Title/Description default to `prev` (the current discount),
 * so a partial sheet does not change them.
 */
function appliedDiscountFromRow(row: Row, prefix: string, currency: string, prev?: any): Record<string, any> | null | undefined {
  const valueCell = cell(row, `${prefix}: Value`);
  if (valueCell === undefined) return undefined;
  if (valueCell === "") return null; // blank removes the discount
  const value = Math.abs(parseNumber(valueCell)!);
  const typeCell = cell(row, `${prefix}: Value Type`);
  const valueType = typeCell ? DISCOUNT_TYPES[enumCell(typeCell)] : (prev?.valueType ?? "FIXED_AMOUNT");
  if (!valueType) throw new ImportError(`${prefix}: Value Type must be percentage or fixed_amount`);
  const out: Record<string, any> = { value, valueType };
  if (valueType === "FIXED_AMOUNT") out.amountWithCurrency = moneyInput(String(value), currency);
  const titleCell = cell(row, `${prefix}: Title`);
  const title = titleCell ?? prev?.title ?? "";
  if (title) out.title = title;
  const descCell = cell(row, `${prefix}: Description`);
  const desc = descCell ?? prev?.description ?? "";
  if (desc) out.description = desc;
  return out;
}

/** Custom attributes as one `key: value` per line. */
function attributesToCell(attrs: any[] | null | undefined): string {
  return (attrs ?? []).map((a) => `${a.key}: ${a.value ?? ""}`).join("\n");
}

function attributesFromCell(v: string): Array<{ key: string; value: string }> {
  return v
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const i = line.indexOf(": ");
      if (i > 0) return { key: line.slice(0, i).trim(), value: line.slice(i + 2) };
      const t = line.trim();
      if (t.endsWith(":") && t.length > 1) return { key: t.slice(0, -1).trim(), value: "" };
      throw new ImportError(`Line: Custom Attributes "${t}" must be "key: value" (one per line)`);
    });
}

/**
 * DraftOrderLineItemInput for one line row. `prev` is the draft's current line
 * with the same Line: ID (update only): columns absent from the sheet take its
 * values, since draftOrderUpdate rebuilds every line. With an empty row this
 * turns a current line into the input that would recreate it.
 */
async function lineInput(
  ctx: ImportContext,
  l: LineSpec,
  row: Row,
  currency: string,
  prev?: any,
): Promise<Record<string, any>> {
  const absent = (col: string) => cell(row, col) === undefined;
  const li: Record<string, any> = { quantity: l.quantity };
  const custom = parseBool(cell(row, "Line: Custom")) ?? (prev ? Boolean(prev.custom) : undefined);
  let variantId = l.variantId;
  if (!variantId && l.sku && custom !== true) variantId = (await variantIdBySku(ctx.gql, ctx.cache, l.sku)) ?? undefined;
  if (!variantId && prev && !prev.custom && custom !== true && absent("Line: Variant ID")) variantId = prev.variant?.id ?? undefined;
  if (variantId && custom !== true) li.variantId = variantId;
  else {
    const title = l.title ?? (absent("Line: Title") ? prev?.title || undefined : undefined);
    const prevPrice = prev?.originalUnitPriceWithCurrency?.amount ?? prev?.originalUnitPriceSet?.shopMoney?.amount;
    const price = l.price ?? (absent("Line: Price") && prevPrice != null ? String(Number(prevPrice)) : undefined);
    if (!title) throw new ImportError(`Line on row ${l.rowIndex + 1}: variant not found; Line: Title and Line: Price are needed for a custom line`);
    if (price === undefined) throw new ImportError(`Line on row ${l.rowIndex + 1}: Line: Price is required for a custom line`);
    li.title = title;
    li.originalUnitPriceWithCurrency = moneyInput(price, currency);
    const sku = l.sku ?? (absent("Line: SKU") ? prev?.sku || undefined : undefined);
    if (sku) li.sku = sku;
    const requiresShipping = l.requiresShipping ?? (absent("Line: Requires Shipping") ? prev?.requiresShipping : undefined);
    if (requiresShipping !== undefined && requiresShipping !== null) li.requiresShipping = requiresShipping;
    const taxable = l.taxable ?? (absent("Line: Taxable") ? prev?.taxable : undefined);
    if (taxable !== undefined && taxable !== null) li.taxable = taxable;
    // Weight only applies to custom lines (variant lines use the variant's weight).
    const weight = weightFromRow(row, prev?.weight);
    if (weight) li.weight = weight;
  }
  const ad = appliedDiscountFromRow(row, "Line: Applied Discount", currency, prev?.appliedDiscount);
  const discount = ad === undefined ? discountToInput(prev?.appliedDiscount, currency) : ad;
  if (discount) li.appliedDiscount = discount;
  const attrsCell = cell(row, "Line: Custom Attributes");
  const attrs =
    attrsCell === undefined
      ? (prev?.customAttributes ?? []).map((a: any) => ({ key: a.key, value: a.value ?? "" }))
      : attributesFromCell(attrsCell);
  if (attrs.length) li.customAttributes = attrs;
  const overrideCell = cell(row, "Line: Price Override");
  const override =
    overrideCell === undefined
      ? prev?.priceOverride?.amount != null
        ? String(Number(prev.priceOverride.amount))
        : undefined
      : parseMoney(overrideCell, "Line: Price Override");
  if (override !== undefined) li.priceOverride = moneyInput(override, currency);
  return li;
}

function weightFromRow(row: Row, prev: any): Record<string, any> | undefined {
  const valueCell = cell(row, "Line: Weight");
  const unitCell = cell(row, "Line: Weight Unit");
  if (valueCell === undefined) return prev ? { unit: prev.unit, value: Number(prev.value) } : undefined;
  const value = parseNumber(valueCell);
  if (value === undefined) return undefined;
  if (value < 0) throw new ImportError("Line: Weight cannot be negative");
  const unit = unitCell ? WEIGHT_UNITS[enumCell(unitCell)] : prev?.unit;
  if (!unit) throw new ImportError("Line: Weight Unit must be grams, kilograms, ounces or pounds");
  return { unit, value };
}

/** Canonical form of a DraftOrderLineItemInput, to tell whether lines changed. */
function lineKey(li: Record<string, any>): string {
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  const ad = li.appliedDiscount
    ? [num(li.appliedDiscount.value), li.appliedDiscount.valueType, li.appliedDiscount.title ?? "", li.appliedDiscount.description ?? ""]
    : null;
  const base = {
    quantity: li.quantity,
    ad,
    attrs: (li.customAttributes ?? []).map((a: any) => [a.key, a.value ?? ""]),
    priceOverride: num(li.priceOverride?.amount),
  };
  if (li.variantId) return JSON.stringify({ ...base, variantId: li.variantId });
  return JSON.stringify({
    ...base,
    title: li.title ?? "",
    price: num(li.originalUnitPriceWithCurrency?.amount),
    sku: li.sku ?? "",
    requiresShipping: li.requiresShipping ?? true,
    taxable: li.taxable ?? true,
    weight: li.weight ? [li.weight.unit, num(li.weight.value)] : null,
  });
}

/**
 * DraftOrderInput from the item's rows. Only columns present in the sheet are
 * sent, so partial sheets update partially. `current` (update only) is the
 * draft's current state: absent columns default to it and lineItems are left
 * out when the sheet's lines equal the current lines.
 */
export async function draftOrderInput(
  ctx: ImportContext,
  rows: Row[],
  creating: boolean,
  current?: DraftDetail,
): Promise<{ input: Record<string, any>; lineRows: number[]; notes: string[] }> {
  const top = rows[0];
  const notes: string[] = [];
  const currency = await rowCurrency(ctx.gql, ctx.cache, top);
  const input: Record<string, any> = {};

  const lines = parseLines(rows);
  if (creating && !lines.length) throw new ImportError("At least one line item is required to create a draft order");
  if (lines.length) {
    const byId = new Map((current?.lineItems ?? []).map((li) => [gidToId(li.id), li]));
    input.lineItems = [];
    for (const l of lines) {
      const row = rows[l.rowIndex];
      const lineId = cell(row, "Line: ID");
      input.lineItems.push(await lineInput(ctx, l, row, currency, lineId ? byId.get(lineId) : undefined));
    }
    if (current) {
      const now: Record<string, any>[] = [];
      for (const li of current.lineItems) now.push(await lineInput(ctx, { rowIndex: -1, quantity: li.quantity }, {}, currency, li));
      const same = now.length === input.lineItems.length && now.every((li, i) => lineKey(li) === lineKey(input.lineItems[i]));
      if (same) delete input.lineItems;
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

  const ad = appliedDiscountFromRow(top, "Applied Discount", currency, current?.appliedDiscount);
  if (ad !== undefined && (ad || !creating)) input.appliedDiscount = ad;

  if (creating) {
    const tags = cell(top, "Tags");
    if (tags) input.tags = splitTags(tags);
    const mf = metafieldsFromRow(top).set;
    if (mf.length) input.metafields = mf;
  }
  return { input, lineRows: input.lineItems ? lines.map((l) => l.rowIndex) : [], notes };
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

type DraftInputBuilt = Awaited<ReturnType<typeof draftOrderInput>>;

async function createDraft(ctx: ImportContext, rows: Row[], built?: DraftInputBuilt) {
  const { input, lineRows, notes } = built ?? (await draftOrderInput(ctx, rows, true));
  const d = await ctx.gql(DRAFT_CREATE, { input });
  assertNoUserErrors(d.draftOrderCreate, "Create draft order");
  const draft = d.draftOrderCreate.draftOrder;
  return { id: draft.id as string, rowPatches: patches(rows, draft, lineRows), notes };
}

async function updateDraft(ctx: ImportContext, existing: ExistingDraft, rows: Row[]) {
  if (existing.status === "COMPLETED") throw new ImportError(`Draft order ${existing.name} is completed and cannot be changed`);
  const top = rows[0];
  // The current state is only needed to diff lines / default the discount.
  const needsCurrent = parseLines(rows).length > 0 || Boolean(cell(top, "Applied Discount: Value"));
  const current = needsCurrent ? await fetchDraftDetail(ctx.gql, existing.id) : undefined;
  const { input, lineRows, notes } = await draftOrderInput(ctx, rows, false, current);
  const tagsCell = cell(top, "Tags");
  const tagsCommand = parseSubCommand(cell(top, "Tags Command"), ["REPLACE", "MERGE", "DELETE"] as const, "REPLACE");
  if (tagsCell !== undefined && tagsCommand === "REPLACE") input.tags = splitTags(tagsCell);

  let rowPatches: Array<Row | undefined> = [];
  if (Object.keys(input).length) {
    const d = await ctx.gql(DRAFT_UPDATE, { id: existing.id, input });
    assertNoUserErrors(d.draftOrderUpdate, "Update draft order");
    rowPatches = patches(rows, d.draftOrderUpdate.draftOrder, lineRows);
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

  const created = async (message: string, built?: DraftInputBuilt): Promise<ItemResult> => {
    const r = await createDraft(ctx, rows, built);
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
      // Build and validate the full create input (lines, SKU and customer
      // lookups...) before deleting, so a bad sheet never loses the draft.
      const built = await draftOrderInput(ctx, rows, true);
      if (existing) await deleteDraft(ctx.gql, existing.id);
      return created(existing ? "Replaced" : "Created", built);
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
