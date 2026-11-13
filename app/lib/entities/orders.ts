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
  lineToRow,
  moneyBagInput,
  parseLines,
  parseMoney,
  rowCurrency,
  variantIdBySku,
} from "./order_common";

/**
 * Orders. One line item per row: order fields on the top row, ID and Name on
 * every row so rows can be sorted/filtered and still group correctly. Order
 * transactions share the rows (transaction N sits on row N next to line N).
 *
 * Import creates orders with orderCreate (store migrations). Existing orders
 * can only have their editable fields changed (email, phone, note, tags,
 * shipping address, metafields): editing line items requires the order
 * editing flow (orderEditBegin/...Commit) and is out of scope.
 */

// --- Columns --------------------------------------------------------------------

const ORDER_COLUMNS = [
  "ID",
  "Name",
  "Command",
  "Email",
  "Phone",
  "Created At",
  "Updated At",
  "Processed At",
  "Cancelled At",
  "Cancel Reason",
  "Closed At",
  "Currency",
  "Financial Status",
  "Fulfillment Status",
  "Subtotal",
  "Total Discounts",
  "Total Shipping",
  "Total Tax",
  "Total Price",
  "Current Total Price",
  "Total Refunded",
  "Tags",
  "Tags Command",
  "Note",
  "Source",
  "Customer: ID",
  "Customer: Email",
  "Customer: First Name",
  "Customer: Last Name",
  "Customer: Phone",
  "Customer: Note",
  "Customer: State",
  "Customer: Tags",
  "Customer: Email Marketing Status",
  "Customer: SMS Marketing Status",
  "Customer: Tax Exempt",
  "Customer: Orders Count",
  "Customer: Total Spent",
  "Discount Codes",
  "Shipping Line: Title",
  "Shipping Line: Code",
  "Shipping Line: Price",
  "Send Receipt",
  "Send Fulfillment Receipt",
  "Inventory Behaviour",
  "Row #",
  "Top Row",
];

/**
 * Order totals in the customer's currency ("Price: X", see "Customer Currency") and the shop's currency
 * ("Price: X (Shop Currency)"). Export only. [label, MoneyBag field on Order]
 */
const PRICE_FIELDS: Array<[string, string]> = [
  ["Total Line Items", ""], // computed from line items
  ["Current Subtotal", "currentSubtotalPriceSet"],
  ["Subtotal", "subtotalPriceSet"],
  ["Current Total Duties", "currentTotalDutiesSet"],
  ["Total Duties", "originalTotalDutiesSet"],
  ["Current Total Fees", "currentTotalAdditionalFeesSet"],
  ["Total Fees", "originalTotalAdditionalFeesSet"],
  ["Total Refund", "totalRefundedSet"],
  ["Total Outstanding", "totalOutstandingSet"],
  ["Current Total", "currentTotalPriceSet"],
  ["Total", "totalPriceSet"],
];
const PRICE_COLUMNS = PRICE_FIELDS.flatMap(([label]) => [`Price: ${label}`, `Price: ${label} (Shop Currency)`]);

/** Tax lines exported as numbered column triplets. */
const MAX_TAX_LINES = 5;
const TAX_COLUMNS = Array.from({ length: MAX_TAX_LINES }, (_, i) => [`Tax ${i + 1}: Title`, `Tax ${i + 1}: Rate`, `Tax ${i + 1}: Price`]).flat();

/** Extra order details. Export only. */
const DETAIL_COLUMNS = [
  "Customer Currency",
  "Source Identifier",
  "Source URL",
  "Physical Location",
  "Cart Token",
  "Token",
  "Order Status URL",
  "Weight Total",
  "Additional Details",
  "Purchase Order Number",
];

/** Current product/variant data of each line item (group line_product_data). Export only. */
const LINE_PRODUCT_COLUMNS = [
  "Line: Product Type",
  "Line: Product Tags",
  "Line: Variant SKU",
  "Line: Variant Barcode",
  "Line: Variant Weight",
  "Line: Variant Weight Unit",
  "Line: Variant Inventory Qty",
  "Line: Variant Cost",
  "Line: Variant Price",
  "Line: Variant Compare At Price",
  "Line: Variant Country of Origin",
  "Line: Variant Province of Origin",
  "Line: Variant HS Code",
];

const FULFILLMENT_COLUMNS = [
  "Fulfillment: ID",
  "Fulfillment: Status",
  "Fulfillment: Created At",
  "Fulfillment: Updated At",
  "Fulfillment: Tracking Company",
  "Fulfillment: Location",
  "Fulfillment: Shipment Status",
  "Fulfillment: Tracking Number",
  "Fulfillment: Tracking URL",
];

/** Where the buyer came from (group "browser"). Export only. */
const BROWSER_COLUMNS = [
  "Browser: IP",
  "Browser: Landing Page",
  "Browser: Referrer",
  "Browser: Referrer Domain",
  "Browser: UTM Source",
  "Browser: UTM Medium",
  "Browser: UTM Campaign",
  "Browser: UTM Term",
  "Browser: UTM Content",
];
const VISIT = "{ landingPage referrerUrl utmParameters { source medium campaign term content } }";
const BROWSER_SELECTION = `clientIp customerJourneySummary { firstVisit ${VISIT} lastVisit ${VISIT} }`;

const WEIGHT_UNIT_CELL: Record<string, string> = { GRAMS: "g", KILOGRAMS: "kg", OUNCES: "oz", POUNDS: "lb" };
const BOTH = "{ shopMoney { amount } presentmentMoney { amount } }";

const ORDER_LINE_COLUMNS = ["Line: Type", ...LINE_COLUMNS, "Line: Fulfillable Quantity"];

const TRANSACTION_COLUMNS = [
  "Transaction: ID",
  "Transaction: Kind",
  "Transaction: Gateway",
  "Transaction: Status",
  "Transaction: Amount",
  "Transaction: Processed At",
];

const TRANSACTION_KINDS = ["AUTHORIZATION", "CAPTURE", "CHANGE", "EMV_AUTHORIZATION", "REFUND", "SALE", "SUGGESTED_REFUND", "VOID"];
const TRANSACTION_STATUSES = ["AWAITING_RESPONSE", "ERROR", "FAILURE", "PENDING", "SUCCESS", "UNKNOWN"];
const FINANCIAL_STATUSES = ["AUTHORIZED", "EXPIRED", "PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "PENDING", "REFUNDED", "VOIDED"];
const INVENTORY_BEHAVIOURS = ["BYPASS", "DECREMENT_IGNORING_POLICY", "DECREMENT_OBEYING_POLICY"];

/**
 * Fulfillment Status cell -> OrderCreateFulfillmentStatus. Export writes
 * OrderDisplayFulfillmentStatus, which has more states than orderCreate
 * accepts (FULFILLED, PARTIAL, RESTOCKED). Every exported value is accepted:
 * - fulfilled / partial(ly_fulfilled) / restocked map directly;
 * - unfulfilled / open / pending_fulfillment: created unfulfilled (omitted);
 * - in_progress / on_hold / scheduled / request_declined: states of
 *   fulfillment orders that orderCreate cannot set; nothing is fulfilled yet,
 *   so the order is created unfulfilled (omitted) with a note;
 * - fulfillment_not_required: nothing to fulfil; omitted with a note (the
 *   status follows from lines with Line: Requires Shipping = FALSE).
 * `noteIfOmitted` marks values whose state is not reproduced exactly.
 */
const FULFILLMENT_STATUS_IN: Record<string, { status: string | null; noteIfOmitted?: boolean }> = {
  FULFILLED: { status: "FULFILLED" },
  PARTIAL: { status: "PARTIAL" },
  PARTIALLY_FULFILLED: { status: "PARTIAL" },
  RESTOCKED: { status: "RESTOCKED" },
  UNFULFILLED: { status: null },
  OPEN: { status: null },
  PENDING_FULFILLMENT: { status: null },
  IN_PROGRESS: { status: null, noteIfOmitted: true },
  ON_HOLD: { status: null, noteIfOmitted: true },
  SCHEDULED: { status: null, noteIfOmitted: true },
  REQUEST_DECLINED: { status: null, noteIfOmitted: true },
  FULFILLMENT_NOT_REQUIRED: { status: null, noteIfOmitted: true },
};

// --- Export -------------------------------------------------------------------------

const MONEY = "{ shopMoney { amount } }";

export function ordersBulkQuery(search: string, groups: Set<string>): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  const metafields = `metafields { edges { node { id namespace key type value } } }`;
  const transactions = `transactions { id kind gateway status processedAt amountSet { shopMoney { amount currencyCode } } }`;
  const lineItems = `lineItems { edges { node {
      id title variantTitle sku quantity unfulfilledQuantity vendor requiresShipping taxable
      originalUnitPriceSet ${MONEY}
      totalDiscountSet ${MONEY}
      variant { id ${
        groups.has("line_product_data")
          ? `sku barcode price compareAtPrice inventoryQuantity inventoryItem {
              unitCost { amount } countryCodeOfOrigin provinceCodeOfOrigin harmonizedSystemCode
              measurement { weight { value unit } } }`
          : ""
      } }
      product { id ${groups.has("line_product_data") ? "productType tags" : ""} }
  } } }`;
  // fulfillments is a plain list (not a connection), so it comes inline.
  const fulfillments = `fulfillments { id status displayStatus createdAt updatedAt location { name } trackingInfo { company number url } }`;
  return `{
    orders${args} { edges { node {
      id name email phone createdAt updatedAt processedAt cancelledAt cancelReason closedAt currencyCode
      displayFinancialStatus displayFulfillmentStatus tags note sourceName discountCodes
      subtotalPriceSet ${MONEY}
      totalDiscountsSet ${MONEY}
      totalShippingPriceSet ${MONEY}
      totalTaxSet ${MONEY}
      totalPriceSet ${MONEY}
      totalRefundedSet ${MONEY}
      customer {
        id firstName lastName note state tags taxExempt numberOfOrders amountSpent { amount }
        defaultEmailAddress { emailAddress marketingState }
        defaultPhoneNumber { phoneNumber smsMarketingConsent { state } }
      }
      billingAddress { name ${ADDRESS_SELECTION} }
      shippingAddress { name ${ADDRESS_SELECTION} }
      ${groups.has("browser") ? BROWSER_SELECTION : ""}
      shippingLine { title code originalPriceSet ${MONEY} }
      presentmentCurrencyCode sourceIdentifier registeredSourceUrl cartToken checkoutToken statusPageUrl
      totalWeight poNumber retailLocation { name } customAttributes { key value }
      ${PRICE_FIELDS.filter(([, f]) => f).map(([, f]) => `${f} ${BOTH}`).join("\n      ")}
      taxLines { title rate priceSet ${BOTH} }
      ${groups.has("fulfillments") ? fulfillments : ""}

      ${groups.has("transactions") ? transactions : ""}
      ${groups.has("metafields") ? metafields : ""}
      ${groups.has("line_items") ? lineItems : ""}
    } } }
  }`;
}

export function orderToRows(o: any, groups: Set<string>): Row[] {
  const lines: any[] = o.lineItems ?? [];
  const transactions: any[] = o.transactions ?? [];
  const fulfillments: any[] = groups.has("fulfillments") ? (o.fulfillments ?? []) : [];
  // Shipping lines follow the line items as rows of their own ("Line: Type").
  const shipping: any[] = groups.has("shipping_lines") ? (o.shippingLines ?? []).filter((l: any) => !l.isRemoved) : [];
  const count = Math.max(1, lines.length + shipping.length, transactions.length, fulfillments.length);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const row: Row = { ID: gidToId(o.id), Name: o.name ?? "", "Row #": String(i + 1), "Top Row": boolCell(i === 0) };
    if (i === 0) {
      Object.assign(row, {
        Command: "MERGE",
        Email: o.email ?? "",
        Phone: o.phone ?? "",
        "Created At": o.createdAt ?? "",
        "Updated At": o.updatedAt ?? "",
        "Processed At": o.processedAt ?? "",
        "Cancelled At": o.cancelledAt ?? "",
        "Cancel Reason": enumToCell(o.cancelReason),
        "Closed At": o.closedAt ?? "",
        Currency: o.currencyCode ?? "",
        "Financial Status": enumToCell(o.displayFinancialStatus),
        "Fulfillment Status": enumToCell(o.displayFulfillmentStatus),
        Subtotal: bagAmount(o.subtotalPriceSet),
        "Total Discounts": bagAmount(o.totalDiscountsSet),
        "Total Shipping": bagAmount(o.totalShippingPriceSet),
        "Total Tax": bagAmount(o.totalTaxSet),
        "Total Price": bagAmount(o.totalPriceSet),
        // After refunds, returns and order edits (Total Price stays as first paid). Export only.
        "Current Total Price": bagAmount(o.currentTotalPriceSet),
        "Total Refunded": bagAmount(o.totalRefundedSet),
        Tags: joinTags(o.tags),
        "Tags Command": "REPLACE",
        Note: o.note ?? "",
        Source: o.sourceName ?? "",
        "Customer: ID": gidToId(o.customer?.id),
        "Customer: Email": o.customer?.defaultEmailAddress?.emailAddress ?? "",
        "Customer: First Name": o.customer?.firstName ?? "",
        "Customer: Last Name": o.customer?.lastName ?? "",
        "Customer: Phone": o.customer?.defaultPhoneNumber?.phoneNumber ?? "",
        "Customer: Note": o.customer?.note ?? "",
        "Customer: State": enumToCell(o.customer?.state),
        "Customer: Tags": joinTags(o.customer?.tags),
        "Customer: Email Marketing Status": enumToCell(o.customer?.defaultEmailAddress?.marketingState),
        "Customer: SMS Marketing Status": enumToCell(o.customer?.defaultPhoneNumber?.smsMarketingConsent?.state),
        "Customer: Tax Exempt": o.customer ? boolCell(o.customer.taxExempt) : "",
        "Customer: Orders Count": str(o.customer?.numberOfOrders),
        "Customer: Total Spent": o.customer?.amountSpent?.amount ?? "",
        "Billing: Name": o.billingAddress?.name ?? "",
        "Shipping: Name": o.shippingAddress?.name ?? "",
        "Discount Codes": (o.discountCodes ?? []).join(", "),
        "Shipping Line: Title": o.shippingLine?.title ?? "",
        "Shipping Line: Code": o.shippingLine?.code ?? "",
        "Shipping Line: Price": bagAmount(o.shippingLine?.originalPriceSet),
      });
      Object.assign(row, {
        "Customer Currency": o.presentmentCurrencyCode ?? "",
        "Source Identifier": o.sourceIdentifier ?? "",
        "Source URL": o.registeredSourceUrl ?? "",
        "Physical Location": o.retailLocation?.name ?? "",
        "Cart Token": o.cartToken ?? "",
        Token: o.checkoutToken ?? "",
        "Order Status URL": o.statusPageUrl ?? "",
        "Weight Total": str(o.totalWeight),
        "Additional Details": (o.customAttributes ?? []).map((a: any) => `${a.key}: ${a.value ?? ""}`).join("\n"),
        "Purchase Order Number": o.poNumber ?? "",
      });
      for (const [label, field] of PRICE_FIELDS) {
        // "Total Line Items" has no API field: price x quantity over the lines.
        const bag = field
          ? o[field]
          : lines.length
            ? {
                shopMoney: { amount: sumLines(lines, "shopMoney") },
                presentmentMoney: { amount: sumLines(lines, "presentmentMoney") },
              }
            : null;
        row[`Price: ${label}`] = bag?.presentmentMoney?.amount ?? "";
        row[`Price: ${label} (Shop Currency)`] = bag?.shopMoney?.amount ?? "";
      }
      (o.taxLines ?? []).slice(0, MAX_TAX_LINES).forEach((t: any, n: number) => {
        row[`Tax ${n + 1}: Title`] = t.title ?? "";
        row[`Tax ${n + 1}: Rate`] = str(t.rate);
        row[`Tax ${n + 1}: Price`] = t.priceSet?.presentmentMoney?.amount ?? "";
      });
      if (groups.has("browser")) {
        // The visit that led to the order (the last one before checkout).
        const visit = o.customerJourneySummary?.lastVisit ?? o.customerJourneySummary?.firstVisit;
        let referrerDomain = "";
        try {
          if (visit?.referrerUrl) referrerDomain = new URL(visit.referrerUrl).hostname;
        } catch {
          // not a URL
        }
        Object.assign(row, {
          "Browser: IP": o.clientIp ?? "",
          "Browser: Landing Page": visit?.landingPage ?? "",
          "Browser: Referrer": visit?.referrerUrl ?? "",
          "Browser: Referrer Domain": referrerDomain,
          "Browser: UTM Source": visit?.utmParameters?.source ?? "",
          "Browser: UTM Medium": visit?.utmParameters?.medium ?? "",
          "Browser: UTM Campaign": visit?.utmParameters?.campaign ?? "",
          "Browser: UTM Term": visit?.utmParameters?.term ?? "",
          "Browser: UTM Content": visit?.utmParameters?.content ?? "",
        });
      }
      addressToRow(row, "Billing", o.billingAddress);
      addressToRow(row, "Shipping", o.shippingAddress);
      if (groups.has("metafields")) metafieldsToRow(row, o.metafields);
    }
    const li = lines[i];
    const ship = li ? undefined : shipping[i - lines.length];
    if (ship) {
      Object.assign(row, {
        "Line: Type": "Shipping Line",
        "Line: Title": ship.title ?? "",
        "Line: SKU": ship.code ?? "",
        "Line: Price": bagAmount(ship.originalPriceSet),
      });
    }
    if (li) {
      row["Line: Type"] = "Line Item";
      lineToRow(row, li);
      row["Line: Fulfillable Quantity"] = str(li.unfulfilledQuantity);
      if (groups.has("line_product_data")) {
        const v = li.variant ?? {};
        const inv = v.inventoryItem ?? {};
        Object.assign(row, {
          "Line: Product Type": li.product?.productType ?? "",
          "Line: Product Tags": joinTags(li.product?.tags),
          "Line: Variant SKU": v.sku ?? "",
          "Line: Variant Barcode": v.barcode ?? "",
          "Line: Variant Weight": str(inv.measurement?.weight?.value),
          "Line: Variant Weight Unit": WEIGHT_UNIT_CELL[inv.measurement?.weight?.unit] ?? "",
          "Line: Variant Inventory Qty": str(v.inventoryQuantity),
          "Line: Variant Cost": inv.unitCost?.amount ?? "",
          "Line: Variant Price": v.price ?? "",
          "Line: Variant Compare At Price": v.compareAtPrice ?? "",
          "Line: Variant Country of Origin": inv.countryCodeOfOrigin ?? "",
          "Line: Variant Province of Origin": inv.provinceCodeOfOrigin ?? "",
          "Line: Variant HS Code": inv.harmonizedSystemCode ?? "",
        });
      }
    }
    const f = fulfillments[i];
    if (f) {
      const tracking: any[] = f.trackingInfo ?? [];
      Object.assign(row, {
        "Fulfillment: ID": gidToId(f.id),
        "Fulfillment: Status": enumToCell(f.status),
        "Fulfillment: Created At": f.createdAt ?? "",
        "Fulfillment: Updated At": f.updatedAt ?? "",
        "Fulfillment: Tracking Company": tracking.map((t) => t.company).filter(Boolean).join(", "),
        "Fulfillment: Location": f.location?.name ?? "",
        "Fulfillment: Shipment Status": enumToCell(f.displayStatus),
        "Fulfillment: Tracking Number": tracking.map((t) => t.number).filter(Boolean).join(", "),
        "Fulfillment: Tracking URL": tracking.map((t) => t.url).filter(Boolean).join(", "),
      });
    }
    const t = transactions[i];
    if (t) {
      Object.assign(row, {
        "Transaction: ID": gidToId(t.id),
        "Transaction: Kind": enumToCell(t.kind),
        "Transaction: Gateway": t.gateway ?? "",
        "Transaction: Status": enumToCell(t.status),
        "Transaction: Amount": t.amountSet?.shopMoney?.amount ?? "",
        "Transaction: Processed At": t.processedAt ?? "",
      });
    }
    rows.push(row);
  }
  return rows;
}

/** Sum of unit price x quantity over line items, to 2 decimals. */
function sumLines(lines: any[], money: "shopMoney" | "presentmentMoney"): string {
  const total = lines.reduce((n, li) => n + Number(li.originalUnitPriceSet?.[money]?.amount ?? 0) * Number(li.quantity ?? 0), 0);
  return total.toFixed(2);
}

const ORDER_SHIPPING_LINES = `#graphql
  query OrderShippingLines($id: ID!) {
    order(id: $id) {
      shippingLines(first: 50) { nodes { title code isRemoved originalPriceSet { shopMoney { amount } } } }
    }
  }
`;

/**
 * Shipping lines of one order. Shipping lines have no ID, so Shopify's bulk
 * export can't link them to their order; the order's main shipping line
 * (already in the bulk data) is used instead. Only when the order's shipping
 * total doesn't match that one line (several shipping lines, a removed one, a
 * shipping discount) are the lines fetched for that order.
 */
async function shippingLinesFor(ctx: ExportContext, o: any): Promise<any[]> {
  const main = o.shippingLine;
  const total = Number(o.totalShippingPriceSet?.shopMoney?.amount ?? 0);
  const mainPrice = Number(main?.originalPriceSet?.shopMoney?.amount ?? 0);
  if (Math.abs(total - mainPrice) < 0.005) return main ? [main] : [];
  try {
    const d = await ctx.gql(ORDER_SHIPPING_LINES, { id: o.id });
    const lines = d.order?.shippingLines?.nodes;
    if (Array.isArray(lines)) return lines;
  } catch {
    // fall back to the main line below
  }
  return main ? [main] : [];
}

async function exportOrders(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? ordersEntity.groups!.filter((g) => g.default).map((g) => g.key));
  const search = buildSearchQuery(ctx.options);
  let n = 0;
  for await (const o of ctx.bulk(ordersBulkQuery(search, groups))) {
    if (groups.has("shipping_lines")) o.shippingLines = await shippingLinesFor(ctx, o);
    await emit(orderToRows(o, groups));
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import: lookups --------------------------------------------------------------------

const ORDER_BY_ID = `#graphql
  query ImportOrderById($id: ID!) { order(id: $id) { id name } }
`;

const ORDER_BY_NAME = `#graphql
  query ImportOrderByName($query: String!, $after: String) {
    orders(first: 250, after: $after, query: $query) { nodes { id name } pageInfo { hasNextPage endCursor } }
  }
`;

interface ExistingOrder {
  id: string;
  name: string;
}

async function fetchOrder(gql: Gql, by: { id?: string; name?: string }): Promise<ExistingOrder | null> {
  if (by.id) {
    const o = (await gql(ORDER_BY_ID, { id: by.id })).order;
    if (o) return o;
  }
  if (by.name) return findByExactName<ExistingOrder>(gql, ORDER_BY_NAME, (d) => d.orders, by.name, "order");
  return null;
}

// --- Import: mutations ----------------------------------------------------------------

const ORDER_CREATE = `#graphql
  mutation ImportOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id name lineItems(first: 250) { nodes { id } } }
      userErrors { field message code }
    }
  }
`;

const ORDER_UPDATE = `#graphql
  mutation ImportOrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

const ORDER_DELETE = `#graphql
  mutation ImportOrderDelete($orderId: ID!) {
    orderDelete(orderId: $orderId) {
      deletedId
      userErrors { field message code }
    }
  }
`;

function parseEnum(v: string | undefined, allowed: string[], col: string): string | undefined {
  if (!v) return undefined;
  const s = enumCell(v);
  if (!allowed.includes(s)) throw new ImportError(`${col} "${v}" is not one of ${allowed.map((a) => a.toLowerCase()).join(", ")}`);
  return s;
}

function isTransactionRow(row: Row): boolean {
  return ["Transaction: Amount", "Transaction: Kind"].some((c) => (cell(row, c) ?? "") !== "");
}

function parseTransactions(rows: Row[], currency: string) {
  return rows.filter(isTransactionRow).map((row) => {
    const amount = parseMoney(cell(row, "Transaction: Amount"), "Transaction: Amount");
    if (amount === undefined) throw new ImportError("Transaction: Amount is required for each transaction");
    const t: Record<string, any> = {
      amountSet: moneyBagInput(amount, currency),
      kind: parseEnum(cell(row, "Transaction: Kind"), TRANSACTION_KINDS, "Transaction: Kind") ?? "SALE",
      status: parseEnum(cell(row, "Transaction: Status"), TRANSACTION_STATUSES, "Transaction: Status") ?? "SUCCESS",
    };
    const gateway = cell(row, "Transaction: Gateway");
    if (gateway) t.gateway = gateway;
    const at = cell(row, "Transaction: Processed At");
    if (at) t.processedAt = at;
    return t;
  });
}

/** Builds the OrderCreateOrderInput and options from the item's rows. */
export async function orderCreateInput(
  ctx: ImportContext,
  rows: Row[],
): Promise<{ order: Record<string, any>; options: Record<string, any>; lineRows: number[]; notes: string[] }> {
  const top = rows[0];
  const notes: string[] = [];
  const currency = await rowCurrency(ctx.gql, ctx.cache, top);
  const order: Record<string, any> = { currency };

  // Line items: by Variant ID, else SKU lookup, else custom title + price.
  const lines = parseLines(rows);
  if (!lines.length) throw new ImportError("At least one line item (Line: Title / Line: Variant ID / Line: SKU) is required to create an order");
  order.lineItems = [];
  for (const l of lines) {
    const input: Record<string, any> = { quantity: l.quantity };
    let variantId = l.variantId;
    if (!variantId && l.sku) variantId = (await variantIdBySku(ctx.gql, ctx.cache, l.sku)) ?? undefined;
    if (variantId) input.variantId = variantId;
    else {
      if (!l.title) throw new ImportError(`Line on row ${l.rowIndex + 1}: variant not found; Line: Title and Line: Price are needed for a custom line`);
      if (l.price === undefined) throw new ImportError(`Line on row ${l.rowIndex + 1}: Line: Price is required for a custom line`);
      input.title = l.title;
      if (l.variantTitle) input.variantTitle = l.variantTitle;
    }
    if (l.sku) input.sku = l.sku;
    if (l.price !== undefined) input.priceSet = moneyBagInput(l.price, currency);
    if (l.vendor) input.vendor = l.vendor;
    if (l.requiresShipping !== undefined) input.requiresShipping = l.requiresShipping;
    if (l.taxable !== undefined) input.taxable = l.taxable;
    order.lineItems.push(input);
  }
  if (lines.some((l) => cell(rows[l.rowIndex], "Line: Discount"))) {
    notes.push("Line: Discount is not applied on create (use Discount Codes with Total Discounts)");
  }

  const text: Array<[string, string]> = [
    ["Email", "email"],
    ["Phone", "phone"],
    ["Name", "name"],
    ["Note", "note"],
    ["Source", "sourceName"],
  ];
  for (const [col, key] of text) {
    const v = cell(top, col);
    if (v) order[key] = v;
  }
  const tags = cell(top, "Tags");
  if (tags) order.tags = splitTags(tags);
  const processedAt = cell(top, "Processed At") || cell(top, "Created At");
  if (processedAt) order.processedAt = processedAt;
  const closedAt = cell(top, "Closed At");
  if (closedAt) order.closedAt = closedAt;

  const fs = cell(top, "Fulfillment Status");
  if (fs) {
    const mapped = FULFILLMENT_STATUS_IN[enumCell(fs)];
    if (!mapped) {
      throw new ImportError(
        `Fulfillment Status "${fs}" must be one of ${Object.keys(FULFILLMENT_STATUS_IN).map((k) => k.toLowerCase()).join(", ")}`,
      );
    }
    if (mapped.status) order.fulfillmentStatus = mapped.status;
    else if (mapped.noteIfOmitted) notes.push(`Fulfillment Status "${fs}" cannot be set on create; order created unfulfilled`);
  }

  const billing = addressFromRow(top, "Billing");
  if (billing) order.billingAddress = billing;
  const shipping = addressFromRow(top, "Shipping");
  if (shipping) order.shippingAddress = shipping;

  // Customer: by ID, else upserted by email (created if missing).
  const customerId = toGid("Customer", cell(top, "Customer: ID"));
  const customerEmail = cell(top, "Customer: Email");
  if (customerId) order.customer = { toAssociate: { id: customerId } };
  else if (customerEmail) {
    const upsert: Record<string, any> = { email: customerEmail };
    const first = cell(top, "Customer: First Name");
    const last = cell(top, "Customer: Last Name");
    if (first) upsert.firstName = first;
    if (last) upsert.lastName = last;
    order.customer = { toUpsert: upsert };
  }

  const shipTitle = cell(top, "Shipping Line: Title");
  if (shipTitle) {
    const price = parseMoney(cell(top, "Shipping Line: Price"), "Shipping Line: Price") ?? "0";
    const line: Record<string, any> = { title: shipTitle, priceSet: moneyBagInput(price, currency) };
    const code = cell(top, "Shipping Line: Code");
    if (code) line.code = code;
    order.shippingLines = [line];
  }

  // Discount: orderCreate accepts a single code; it is recorded as a fixed
  // amount equal to Total Discounts.
  const codes = splitTags(cell(top, "Discount Codes"));
  if (codes.length) {
    const amount = parseMoney(cell(top, "Total Discounts"), "Total Discounts");
    order.discountCode = {
      itemFixedDiscountCode: { code: codes[0], ...(amount ? { amountSet: moneyBagInput(amount, currency) } : {}) },
    };
    if (codes.length > 1) notes.push(`Only the first discount code (${codes[0]}) can be recorded on create`);
  }

  // Taxes: a single "Tax" line for the total, with the rate derived from the subtotal.
  const tax = parseMoney(cell(top, "Total Tax"), "Total Tax");
  if (tax && Number(tax) > 0) {
    const subtotal = parseNumber(cell(top, "Subtotal"));
    const rate = subtotal ? Math.round((Number(tax) / subtotal) * 10000) / 10000 : 0;
    order.taxLines = [{ title: "Tax", rate: String(rate), priceSet: moneyBagInput(tax, currency) }];
  }

  // Payment: explicit transactions win over a Financial Status.
  const transactions = parseTransactions(rows, currency);
  if (transactions.length) order.transactions = transactions;
  else {
    const fin = parseEnum(cell(top, "Financial Status"), FINANCIAL_STATUSES, "Financial Status");
    if (fin) order.financialStatus = fin;
  }

  const mf = metafieldsFromRow(top).set;
  if (mf.length) order.metafields = mf;

  if (cell(top, "Cancelled At")) notes.push("Orders cannot be created cancelled; Cancelled At ignored");

  const options: Record<string, any> = {
    inventoryBehaviour: parseEnum(cell(top, "Inventory Behaviour"), INVENTORY_BEHAVIOURS, "Inventory Behaviour") ?? "BYPASS",
    sendReceipt: parseBool(cell(top, "Send Receipt")) ?? false,
    sendFulfillmentReceipt: parseBool(cell(top, "Send Fulfillment Receipt")) ?? false,
  };
  return { order, options, lineRows: lines.map((l) => l.rowIndex), notes };
}

type OrderCreateBuilt = Awaited<ReturnType<typeof orderCreateInput>>;

async function createOrder(ctx: ImportContext, rows: Row[], built?: OrderCreateBuilt) {
  const { order, options, lineRows, notes } = built ?? (await orderCreateInput(ctx, rows));
  const d = await ctx.gql(ORDER_CREATE, { order, options });
  assertNoUserErrors(d.orderCreate, "Create order");
  const created = d.orderCreate.order;
  const rowPatches: Array<Row | undefined> = rows.map(() => ({ ID: gidToId(created.id), Name: created.name }));
  (created.lineItems?.nodes ?? []).forEach((li: any, i: number) => {
    const r = lineRows[i];
    if (r !== undefined) rowPatches[r] = { ...rowPatches[r], "Line: ID": gidToId(li.id) };
  });
  return { id: created.id as string, rowPatches, notes };
}

async function updateOrder(ctx: ImportContext, existing: ExistingOrder, rows: Row[]): Promise<string[]> {
  const top = rows[0];
  const notes: string[] = [];
  const input: Record<string, any> = { id: existing.id };
  for (const [col, key] of [
    ["Email", "email"],
    ["Phone", "phone"],
    ["Note", "note"],
  ] as const) {
    const v = cell(top, col);
    // Blank Note clears it; blank Email/Phone are left unchanged (cannot be cleared).
    if (v !== undefined && (v || key === "note")) input[key] = v;
  }
  const tagsCell = cell(top, "Tags");
  const tagsCommand = parseSubCommand(cell(top, "Tags Command"), ["REPLACE", "MERGE", "DELETE"] as const, "REPLACE");
  if (tagsCell !== undefined && tagsCommand === "REPLACE") input.tags = splitTags(tagsCell);
  const shipping = addressFromRow(top, "Shipping");
  if (shipping) input.shippingAddress = shipping;

  if (Object.keys(input).length > 1) {
    const d = await ctx.gql(ORDER_UPDATE, { input });
    assertNoUserErrors(d.orderUpdate, "Update order");
  }
  if (tagsCell && tagsCommand === "MERGE") await addTags(ctx.gql, existing.id, splitTags(tagsCell));
  if (tagsCell && tagsCommand === "DELETE") await removeTags(ctx.gql, existing.id, splitTags(tagsCell));

  const mf = metafieldsFromRow(top);
  await writeMetafields(ctx.gql, existing.id, mf.set, mf.blank);

  if (rows.some((r) => parseLines([r]).length)) notes.push("line items of existing orders are not changed");
  return notes;
}

async function deleteOrder(gql: Gql, id: string) {
  const d = await gql(ORDER_DELETE, { orderId: id });
  assertNoUserErrors(d.orderDelete, "Delete order");
}

export async function importOrder(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const top = rows[0];
  const id = toGid("Order", cell(top, "ID"));
  const name = cell(top, "Name");
  const existing = id || name ? await fetchOrder(ctx.gql, { id, name }) : null;

  const created = async (message: string, built?: OrderCreateBuilt): Promise<ItemResult> => {
    const r = await createOrder(ctx, rows, built);
    return { status: "OK", command, id: r.id, message: [message, ...r.notes].join("; "), rowPatches: r.rowPatches };
  };

  switch (command) {
    case "DELETE": {
      if (!existing) return { status: "Failed", command, message: "Order not found" };
      await deleteOrder(ctx.gql, existing.id);
      return { status: "OK", command, id: existing.id, message: "Deleted" };
    }
    case "NEW": {
      if (existing) return { status: "Failed", command, id: existing.id, message: `Order ${existing.name} already exists` };
      return created("Created");
    }
    case "REPLACE": {
      // Build and validate the whole create input (lines, SKU lookups, enums,
      // money...) before deleting, so a bad sheet never loses the order.
      const built = await orderCreateInput(ctx, rows);
      if (existing) await deleteOrder(ctx.gql, existing.id);
      return created(existing ? "Replaced" : "Created", built);
    }
    case "UPDATE":
    case "MERGE": {
      if (!existing) {
        if (command === "UPDATE") return { status: "Failed", command, message: "Order not found" };
        return created("Created");
      }
      const notes = await updateOrder(ctx, existing, rows);
      return { status: "OK", command, id: existing.id, message: ["Updated", ...notes].join("; ") };
    }
    default:
      return { status: "Skipped", command };
  }
}

export const ordersEntity: Entity = {
  key: "orders",
  sheet: "Orders",
  aliases: ["order"],
  description: "Orders with line items, addresses, transactions and metafields. Import creates orders (migrations) and updates editable fields.",
  columns: [
    ...ORDER_COLUMNS,
    ...DETAIL_COLUMNS,
    ...PRICE_COLUMNS,
    ...TAX_COLUMNS,
    "Billing: Name",
    ...addressColumns("Billing"),
    "Shipping: Name",
    ...addressColumns("Shipping"),
    ...BROWSER_COLUMNS,
    ...ORDER_LINE_COLUMNS,
    ...LINE_PRODUCT_COLUMNS,
    ...FULFILLMENT_COLUMNS,
    ...TRANSACTION_COLUMNS,
  ],
  supportsQuery: true,
  groups: [
    { key: "line_items", label: "Line items", default: true },
    { key: "line_product_data", label: "Line items product data", default: false },
    { key: "browser", label: "Browser", default: false },
    // Standalone: these are extra rows, not the Shipping address columns.
    { key: "shipping_lines", label: "Shipping lines as rows", default: true, standalone: true },
    { key: "fulfillments", label: "Fulfillments", default: true },
    { key: "transactions", label: "Transactions", default: true },
    { key: "metafields", label: "Order metafields", default: true },
  ],
  export: exportOrders,
  import: { keyColumns: ["ID", "Name"], apply: importOrder },
};
