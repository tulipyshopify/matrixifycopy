import type { Command, Entity, ExportContext, Gql, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import {
  assertNoUserErrors,
  boolCell,
  buildSearchQuery,
  dateRangeInstants,
  startOfDay,
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

/** Where the buyer came from (group "browser"). Export only. */
const BROWSER_COLUMNS = [
  "Browser: IP",
  "Browser: Width",
  "Browser: Height",
  "Browser: User Agent",
  "Browser: Landing Page",
  "Browser: Referrer",
  "Browser: Referrer Domain",
  "Browser: Search Keywords",
  "Browser: Ad URL",
  "Browser: UTM Source",
  "Browser: UTM Medium",
  "Browser: UTM Campaign",
  "Browser: UTM Term",
  "Browser: UTM Content",
];
/** Only in the REST API, fetched per batch of orders: slower. */
const CLIENT_DETAIL_COLUMNS = ["Browser: Width", "Browser: Height", "Browser: User Agent"];

/** Address columns in the order they appear in the Customer section. */
function ORDER_ADDRESS_COLUMNS(prefix: string): string[] {
  return ["First Name", "Last Name", "Name", "Company", "Phone", "Address 1", "Address 2", "Zip", "City", "Province", "Province Code", "Country", "Country Code"].map(
    (f) => `${prefix}: ${f}`,
  );
}

/** Basic order columns, up to the totals. */
const BASIC_HEAD = [
  "ID",
  "Name",
  "Command",
  "Send Receipt",
  "Send Fulfillment Receipt",
  "Inventory Behaviour",
  "Number",
  "Phone",
  "Email",
  "Note",
  "Tags",
  "Tags Command",
  "Created At",
  "Updated At",
  "Cancelled At",
  "Cancel: Reason",
  "Cancel: Send Receipt",
  "Cancel: Refund",
  "Cancel: Restock",
  "Cancel: Note",
  "Processed At",
  "Closed At",
  "Currency",
  "Source",
];

/** Basic order columns after the totals; the plain totals are in the shop's currency. */
const BASIC_TAIL = [
  "Payment: Status",
  "Order Fulfillment Status",
  "Additional Details",
  "Purchase Order Number",
  "Cancel Reason",
  "Financial Status",
  "Fulfillment Status",
  "Subtotal",
  "Total Discounts",
  "Total Shipping",
  "Total Tax",
  "Total Price",
  "Current Total Price",
  "Total Refunded",
  "Discount Codes",
  "Shipping Line: Title",
  "Shipping Line: Code",
  "Shipping Line: Price",
  "Row #",
  "Top Row",
];

const CUSTOMER_COLUMNS = [
  "Customer: ID",
  "Customer: Email",
  "Customer: Phone",
  "Customer: First Name",
  "Customer: Last Name",
  "Customer: Note",
  "Customer: State",
  "Customer: Tags",
  "Customer: Email Marketing Status",
  "Customer: SMS Marketing Status",
  "Customer: Tax Exempt",
  "Customer: Orders Count",
  "Customer: Total Spent",
  ...ORDER_ADDRESS_COLUMNS("Billing"),
  ...ORDER_ADDRESS_COLUMNS("Shipping"),
  ...BROWSER_COLUMNS,
];

/**
 * Order totals in the customer's currency ("Price: X", see "Customer Currency") and the shop's currency
 * ("Price: X (Shop Currency)"). Export only. [label, MoneyBag field on Order]
 */
const PRICE_FIELDS: Array<[string, string]> = [
  ["Total Line Items", ""], // computed from line items
  ["Current Subtotal", "currentSubtotalPriceSet"],
  ["Subtotal", "subtotalPriceSet"],
  ["Total Discount", "totalDiscountsSet"],
  ["Current Total Shipping", "currentShippingPriceSet"],
  ["Total Shipping", "totalShippingPriceSet"],
  ["Current Total Duties", "currentTotalDutiesSet"],
  ["Total Duties", "originalTotalDutiesSet"],
  ["Current Total Fees", "currentTotalAdditionalFeesSet"],
  ["Total Fees", "originalTotalAdditionalFeesSet"],
  ["Total Refund", "totalRefundedSet"],
  ["Total Outstanding", "totalOutstandingSet"],
  ["Current Total", "currentTotalPriceSet"],
  ["Total", "totalPriceSet"],
];
const priceColumns = (fields: Array<[string, string]>) => fields.flatMap(([label]) => [`Price: ${label}`, `Price: ${label} (Shop Currency)`]);
/** The subtotals come before the tax columns, the other totals after. */
const PRICE_COLUMNS_A = priceColumns(PRICE_FIELDS.slice(0, 3));
const PRICE_COLUMNS_B = priceColumns(PRICE_FIELDS.slice(3));

/** Tax lines exported as numbered column sets, then the tax totals. */
const MAX_TAX_LINES = 5;
const TAX_COLUMNS = [
  ...Array.from({ length: MAX_TAX_LINES }, (_, i) => {
    const t = `Tax ${i + 1}:`;
    return [`${t} Title`, `${t} Rate`, `${t} Price`, `${t} Price (Shop Currency)`, `${t} Channel Liable`];
  }).flat(),
  "Tax: Included",
  "Tax: Total",
  "Tax: Total (Shop Currency)",
];

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

/** One row per refund, beside the line rows (group "refunds"). Export only. */
const REFUND_COLUMNS = ["Refund: ID", "Refund: Created At", "Refund: Note", "Refund: Amount"];

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

const VISIT = "{ landingPage referrerUrl utmParameters { source medium campaign term content } }";
const BROWSER_SELECTION = `clientIp customerJourneySummary { firstVisit ${VISIT} lastVisit ${VISIT} }`;

const WEIGHT_UNIT_CELL: Record<string, string> = { GRAMS: "g", KILOGRAMS: "kg", OUNCES: "oz", POUNDS: "lb" };
const BOTH = "{ shopMoney { amount } presentmentMoney { amount } }";

const LINE_TAXES = 3;
const SHOP = " (Shop Currency)";
/** Line item columns. Money is in the order's currency; "(Shop Currency)" columns in the shop's. */
const ORDER_LINE_COLUMNS = [
  "Line: Type",
  "Line: ID",
  "Line: Command",
  "Line: Product ID",
  "Line: Product Handle",
  "Line: Title",
  "Line: Name",
  "Line: Variant ID",
  "Line: Variant Title",
  "Line: SKU",
  "Line: Quantity",
  "Line: Current Quantity",
  "Line: Refundable Quantity",
  ...["Line: Price", "Line: Discount", "Line: Discount Allocation", "Line: Discount per Item", "Line: Total"].flatMap((c) => [c, c + SHOP]),
  "Line: Grams",
  "Line: Requires Shipping",
  "Line: Vendor",
  "Line: Gift Card",
  "Line: Force Gift Card",
  "Line: Taxable",
  "Line: Tax Total",
  "Line: Tax Total" + SHOP,
  ...Array.from({ length: LINE_TAXES }, (_, i) => {
    const t = `Line: Tax ${i + 1}`;
    return [`${t} Title`, `${t} Rate`, `${t} Price`, `${t} Price${SHOP}`, `${t} Channel Liable`];
  }).flat(),
  "Line: Fulfillable Quantity",
  "Line: Fulfillment Status",
];

const GRAMS_PER: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237 };
const amount = (v: unknown) => (v === null || v === undefined || v === "" ? "" : String(Math.round(Number(v) * 100) / 100));
const sumBags = (bags: any[], k: "shopMoney" | "presentmentMoney") => bags.reduce((n, b) => n + Number(b?.[k]?.amount ?? b?.shopMoney?.amount ?? 0), 0);

/** The order-specific Line: cells (the common ones come from lineToRow). */
function orderLineToRow(row: Row, li: any) {
  const qty = Number(li.quantity) || 0;
  const taxes: any[] = li.taxLines ?? [];
  const allocations = (li.discountAllocations ?? []).map((d: any) => d.allocatedAmountSet);
  const both = (col: string, bag: any) => {
    row[col] = bag?.presentmentMoney?.amount ?? bag?.shopMoney?.amount ?? "";
    row[col + SHOP] = bag?.shopMoney?.amount ?? "";
  };
  const bothSum = (col: string, bags: any[]) => {
    row[col] = amount(sumBags(bags, "presentmentMoney"));
    row[col + SHOP] = amount(sumBags(bags, "shopMoney"));
  };
  Object.assign(row, {
    "Line: Command": "DEFAULT",
    "Line: Product Handle": li.product?.handle ?? "",
    "Line: Name": li.name ?? "",
    "Line: Current Quantity": str(li.currentQuantity),
    "Line: Refundable Quantity": str(li.refundableQuantity),
    "Line: Grams": li.weight?.value != null ? amount(Number(li.weight.value) * (GRAMS_PER[li.weight.unit] ?? 1)) : "",
    "Line: Gift Card": boolCell(!!li.isGiftCard),
    "Line: Force Gift Card": "No",
    "Line: Fulfillable Quantity": str(li.unfulfilledQuantity),
    "Line: Fulfillment Status": Number(li.unfulfilledQuantity) === 0 ? "fulfilled" : Number(li.unfulfilledQuantity) < qty ? "partial" : "",
  });
  both("Line: Price", li.originalUnitPriceSet);
  both("Line: Discount", li.totalDiscountSet);
  bothSum("Line: Discount Allocation", allocations);
  for (const [col, k] of [["Line: Discount per Item", "presentmentMoney"], ["Line: Discount per Item" + SHOP, "shopMoney"]] as const) {
    const d = li.totalDiscountSet?.[k]?.amount ?? li.totalDiscountSet?.shopMoney?.amount;
    row[col] = qty && d != null ? amount(Number(d) / qty) : "";
  }
  both("Line: Total", li.discountedTotalSet);
  bothSum("Line: Tax Total", taxes.map((t) => t.priceSet));
  taxes.slice(0, LINE_TAXES).forEach((t, i) => {
    const c = `Line: Tax ${i + 1}`;
    row[`${c} Title`] = t.title ?? "";
    row[`${c} Rate`] = str(t.rate);
    both(`${c} Price`, t.priceSet);
    row[`${c} Channel Liable`] = t.channelLiable === null || t.channelLiable === undefined ? "" : boolCell(t.channelLiable);
  });
}

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

export function ordersBulkQuery(search: string, groups: Set<string>, extras: Set<string> = new Set()): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  const metafields = `metafields { edges { node { id namespace key type value } } }`;
  const transactions = `transactions { id kind gateway status processedAt amountSet { shopMoney { amount currencyCode } } }`;
  const lineItems = `lineItems { edges { node {
      id title name variantTitle sku quantity currentQuantity refundableQuantity unfulfilledQuantity vendor requiresShipping taxable isGiftCard
      weight { value unit }
      originalUnitPriceSet ${BOTH}
      totalDiscountSet ${BOTH}
      discountedTotalSet ${BOTH}
      discountAllocations { allocatedAmountSet ${BOTH} }
      taxLines { title rate channelLiable priceSet ${BOTH} }
      variant { id ${extras.has("line_inventory") && !groups.has("line_product_data") ? "inventoryQuantity" : ""} ${
        groups.has("line_product_data")
          ? `sku barcode price compareAtPrice inventoryQuantity inventoryItem {
              unitCost { amount } countryCodeOfOrigin provinceCodeOfOrigin harmonizedSystemCode
              measurement { weight { value unit } } }`
          : ""
      } }
      product { id handle ${groups.has("line_product_data") ? "productType tags" : ""} }
  } } }`;
  // fulfillments is a plain list (not a connection), so it comes inline.
  const fulfillments = `fulfillments { id status displayStatus createdAt updatedAt location { name } trackingInfo { company number url } }`;
  return `{
    orders${args} { edges { node {
      id name number email phone createdAt updatedAt processedAt cancelledAt cancelReason cancellation { staffNote } closedAt currencyCode taxesIncluded
      displayFinancialStatus displayFulfillmentStatus tags note sourceName discountCodes
      subtotalPriceSet ${MONEY}
      totalTaxSet ${BOTH}
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
      taxLines { title rate channelLiable priceSet ${BOTH} }
      ${groups.has("fulfillments") ? fulfillments : ""}
      ${groups.has("refunds") || extras.has("refunds") ? `refunds { id createdAt note totalRefundedSet ${MONEY} }` : ""}

      ${groups.has("transactions") ? transactions : ""}
      ${groups.has("metafields") ? metafields : ""}
      ${groups.has("line_items") ? lineItems : ""}
    } } }
  }`;
}

/** What the buyer searched for, when the referrer is a search results page. */
function searchKeywords(referrer: string | null | undefined): string {
  try {
    const p = new URL(referrer ?? "").searchParams;
    return p.get("q") ?? p.get("query") ?? p.get("p") ?? p.get("text") ?? "";
  } catch {
    return "";
  }
}

const AD_CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid", "twclid", "li_fat_id", "epik"];

/** The landing page, when it carries an ad platform's click ID. */
function adUrl(landingPage: string | null | undefined): string {
  try {
    const u = new URL(landingPage ?? "", "https://x.invalid");
    return AD_CLICK_IDS.some((k) => u.searchParams.has(k)) ? (landingPage ?? "") : "";
  } catch {
    return "";
  }
}

export function orderToRows(o: any, groups: Set<string>): Row[] {
  const lines: any[] = o.lineItems ?? [];
  const transactions: any[] = o.transactions ?? [];
  const fulfillments: any[] = groups.has("fulfillments") ? (o.fulfillments ?? []) : [];
  // Shipping lines follow the line items as rows of their own ("Line: Type").
  const shipping: any[] = groups.has("shipping_lines") ? (o.shippingLines ?? []).filter((l: any) => !l.isRemoved) : [];
  const refunds: any[] = groups.has("refunds") ? (o.refunds ?? []) : [];
  const count = Math.max(1, lines.length + shipping.length, transactions.length, fulfillments.length, refunds.length);
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
        Number: str(o.number),
        "Cancel: Reason": enumToCell(o.cancelReason),
        // What a cancellation did isn't recorded by Shopify; these are for the file's layout.
        "Cancel: Send Receipt": o.cancelledAt ? "FALSE" : "",
        "Cancel: Refund": o.cancelledAt ? "FALSE" : "",
        "Cancel: Restock": o.cancelledAt ? "FALSE" : "",
        "Cancel: Note": o.cancellation?.staffNote ?? "",
        "Payment: Status": enumToCell(o.displayFinancialStatus),
        "Order Fulfillment Status": enumToCell(o.displayFulfillmentStatus),
        "Tax: Included": o.taxesIncluded === undefined || o.taxesIncluded === null ? "" : boolCell(o.taxesIncluded),
        "Tax: Total": o.totalTaxSet?.presentmentMoney?.amount ?? o.totalTaxSet?.shopMoney?.amount ?? "",
        "Tax: Total (Shop Currency)": o.totalTaxSet?.shopMoney?.amount ?? "",
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
        row[`Tax ${n + 1}: Price (Shop Currency)`] = t.priceSet?.shopMoney?.amount ?? "";
        row[`Tax ${n + 1}: Channel Liable`] = t.channelLiable === null || t.channelLiable === undefined ? "" : boolCell(t.channelLiable);
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
          "Browser: Width": str(o.clientDetails?.browser_width),
          "Browser: Height": str(o.clientDetails?.browser_height),
          "Browser: User Agent": o.clientDetails?.user_agent ?? "",
          "Browser: Landing Page": visit?.landingPage ?? "",
          "Browser: Referrer": visit?.referrerUrl ?? "",
          "Browser: Referrer Domain": referrerDomain,
          "Browser: Search Keywords": searchKeywords(visit?.referrerUrl),
          "Browser: Ad URL": adUrl(visit?.landingPage),
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
        // Title and price only (no SKU or quantity), so SKU-based comparisons
        // and pivots see product lines only. The rate code is in "Shipping Line: Code".
        "Line: Title": ship.title ?? "",
        "Line: Price": bagAmount(ship.originalPriceSet),
        ["Line: Price" + SHOP]: bagAmount(ship.originalPriceSet),
      });
    }
    if (li) {
      row["Line: Type"] = "Line Item";
      lineToRow(row, li);
      orderLineToRow(row, li);
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
    const refund = refunds[i];
    if (refund) {
      Object.assign(row, {
        "Refund: ID": gidToId(refund.id),
        "Refund: Created At": refund.createdAt ?? "",
        "Refund: Note": refund.note ?? "",
        "Refund: Amount": bagAmount(refund.totalRefundedSet),
      });
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

// --- Filters checked by the export itself -------------------------------------

/** What each such filter reads from an order, and what the bulk query must fetch for it. */
const LOCAL_FILTERS: Record<string, { values: (o: any) => unknown[]; group?: string; extra?: string }> = {
  fulfillment_created_at: { values: (o) => (o.fulfillments ?? []).map((f: any) => f.createdAt), group: "fulfillments" },
  fulfillment_updated_at: { values: (o) => (o.fulfillments ?? []).map((f: any) => f.updatedAt), group: "fulfillments" },
  refund_created_at: { values: (o) => (o.refunds ?? []).map((r: any) => r.createdAt), extra: "refunds" },
  customer_tax_exempt: { values: (o) => [String(!!o.customer?.taxExempt)] },
  billing_country_code: { values: (o) => [o.billingAddress?.countryCodeV2 ?? ""] },
  shipping_country_code: { values: (o) => [o.shippingAddress?.countryCodeV2 ?? ""] },
  line_type: {
    values: (o) => [...((o.lineItems ?? []).length ? ["Line Item"] : []), ...(o.shippingLine ? ["Shipping Line"] : [])],
    group: "line_items",
  },
  line_product_handle: { values: (o) => (o.lineItems ?? []).map((l: any) => l.product?.handle ?? ""), group: "line_items" },
  line_title: { values: (o) => (o.lineItems ?? []).map((l: any) => l.title ?? ""), group: "line_items" },
  line_name: { values: (o) => (o.lineItems ?? []).map((l: any) => l.name ?? ""), group: "line_items" },
  line_variant_id: { values: (o) => (o.lineItems ?? []).map((l: any) => gidToId(l.variant?.id)), group: "line_items" },
  line_variant_title: { values: (o) => (o.lineItems ?? []).map((l: any) => l.variantTitle ?? ""), group: "line_items" },
  line_vendor: { values: (o) => (o.lineItems ?? []).map((l: any) => l.vendor ?? ""), group: "line_items" },
  line_variant_inventory_qty: {
    values: (o) => (o.lineItems ?? []).map((l: any) => l.variant?.inventoryQuantity).filter((q: unknown) => q !== null && q !== undefined),
    group: "line_items",
    extra: "line_inventory",
  },
};

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();

/**
 * The export's own filters as one test. An order passes a condition when any
 * of its lines / fulfillments / refunds matches ("is not": when none does).
 */
export function localOrderFilters(options: ExportContext["options"], now = new Date()) {
  const tz = options.timezone ?? "UTC";
  const groups = new Set<string>();
  const extras = new Set<string>();
  const narrow: string[] = [];
  const tests: Array<(o: any) => boolean> = [];
  const use = (key: string) => {
    const spec = LOCAL_FILTERS[key];
    if (spec?.group) groups.add(spec.group);
    if (spec?.extra) extras.add(spec.extra);
    return spec;
  };
  const inRange = (spec: { values: (o: any) => unknown[] }, from?: Date, to?: Date) => (o: any) =>
    spec.values(o).some((v) => {
      const t = new Date(String(v)).getTime();
      return !Number.isNaN(t) && (!from || t >= from.getTime()) && (!to || t < to.getTime());
    });

  const r = options.dateRange;
  if (r && LOCAL_FILTERS[r.field]) {
    // The search is already narrowed by compileDateRange (searchBy).
    const { from, to } = dateRangeInstants(r, now, tz);
    tests.push(inRange(use(r.field), from, to));
  }
  for (const f of options.filters ?? []) {
    if (!f.local) continue;
    const spec = use(f.field);
    if (!spec) throw new Error(`Unknown filter "${f.field}"`);
    const day = (d: string, plus = 0) => new Date(startOfDay(d, tz, plus));
    if (f.field.endsWith("_at")) {
      // Whole days in the shop's time zone, like the searchable dates.
      const from = f.op === "lte" ? undefined : day(f.value);
      const to = f.op === "gte" ? undefined : day(f.op === "between" ? (f.value2 ?? f.value) : f.value, 1);
      tests.push(inRange(spec, from, to));
      if (from && f.searchBy) narrow.push(`${f.searchBy}:>='${from.toISOString().replace(".000Z", "Z")}'`);
      continue;
    }
    const want = lower(f.value);
    const num = Number(f.value);
    const num2 = Number(f.value2);
    const some = (p: (v: unknown) => boolean) => (o: any) => spec.values(o).some(p);
    switch (f.op) {
      case "is":
        tests.push(some((v) => (typeof v === "number" ? v === num : lower(v) === want)));
        break;
      case "is_not":
        tests.push((o) => !spec.values(o).some((v) => lower(v) === want));
        break;
      case "starts_with":
        tests.push(some((v) => lower(v).startsWith(want)));
        break;
      case "any_of": {
        const set = new Set(f.value.split(",").map(lower).filter(Boolean));
        tests.push(some((v) => set.has(lower(v))));
        break;
      }
      case "gt":
        tests.push(some((v) => Number(v) > num));
        break;
      case "gte":
        tests.push(some((v) => Number(v) >= num));
        break;
      case "lt":
        tests.push(some((v) => Number(v) < num));
        break;
      case "lte":
        tests.push(some((v) => Number(v) <= num));
        break;
      case "between":
        tests.push(some((v) => Number(v) >= num && Number(v) <= num2));
        break;
    }
  }
  return { groups, extras, narrow, test: (o: any) => tests.every((t) => t(o)) };
}

/**
 * Browser size and user agent exist only in the REST API. Fetched for a batch
 * of orders at a time; if the store refuses, the columns are left empty.
 */
async function addClientDetails(ctx: ExportContext, orders: any[]) {
  if (!ctx.rest || !orders.length || ctx.cache.get("orders:clientDetailsOff")) return;
  try {
    const ids = orders.map((o) => gidToId(o.id)).join(",");
    const data = await ctx.rest(`orders.json?status=any&limit=250&fields=id,client_details&ids=${ids}`);
    const byId = new Map<string, any>((data?.orders ?? []).map((x: any) => [String(x.id), x.client_details]));
    for (const o of orders) o.clientDetails = byId.get(gidToId(o.id)) ?? null;
  } catch (e: any) {
    ctx.cache.set("orders:clientDetailsOff", true);
    ctx.log(`Browser width, height and user agent could not be read (${e?.message ?? e}); those columns are left empty`);
  }
}

const CLIENT_DETAILS_BATCH = 100;

async function exportOrders(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? ordersEntity.groups!.filter((g) => g.default).map((g) => g.key));
  // Settings saved before shipping rows existed (old presets, schedules, "Run
  // again") never mention them: include them whenever line items are exported.
  if ((ctx.options.v ?? 1) < 2 && groups.has("line_items")) groups.add("shipping_lines");
  // Browser data is skipped when none of its columns is wanted.
  const wanted = (cols: string[]) => !ctx.options.columns || cols.some((c) => ctx.options.columns!.includes(c));
  if (groups.has("browser") && !wanted(BROWSER_COLUMNS)) groups.delete("browser");
  const clientDetails = groups.has("browser") && wanted(CLIENT_DETAIL_COLUMNS);
  const search = buildSearchQuery(ctx.options);
  let n = 0;
  let batch: any[] = [];
  const flush = async () => {
    if (clientDetails) await addClientDetails(ctx, batch);
    for (const o of batch) {
      await emit(orderToRows(o, groups));
      ctx.progress(++n);
    }
    batch = [];
  };
  // Filters Shopify can't search by are checked here, order by order.
  const local = localOrderFilters(ctx.options);
  const queryGroups = new Set(groups);
  for (const g of local.groups) queryGroups.add(g);
  const fullSearch = [search, ...local.narrow].filter(Boolean).join(" AND ");
  let seen = 0;
  for await (const o of ctx.bulk(ordersBulkQuery(fullSearch, queryGroups, local.extras))) {
    if (!local.test(o)) continue;
    // Fetched only to check a filter, not asked for in the file.
    if (!groups.has("line_items")) delete o.lineItems;
    if (groups.has("shipping_lines")) o.shippingLines = await shippingLinesFor(ctx, o);
    batch.push(o);
    seen++;
    if (batch.length >= (clientDetails ? CLIENT_DETAILS_BATCH : 1)) await flush();
    if (ctx.options.limit && seen >= ctx.options.limit) break;
  }
  await flush();
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
    const phone = cell(top, "Customer: Phone");
    if (phone) upsert.phone = phone;
    const note = cell(top, "Customer: Note");
    if (note) upsert.note = note;
    const tags = splitTags(cell(top, "Customer: Tags"));
    if (tags.length) upsert.tags = tags;
    const exempt = parseBool(cell(top, "Customer: Tax Exempt"));
    if (exempt !== undefined) upsert.taxExempt = exempt;
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
    ...BASIC_HEAD,
    ...DETAIL_COLUMNS,
    ...PRICE_COLUMNS_A,
    ...TAX_COLUMNS,
    ...PRICE_COLUMNS_B,
    ...BASIC_TAIL,
    ...CUSTOMER_COLUMNS,
    ...ORDER_LINE_COLUMNS,
    ...LINE_PRODUCT_COLUMNS,
    ...FULFILLMENT_COLUMNS,
    ...REFUND_COLUMNS,
    ...TRANSACTION_COLUMNS,
  ],
  supportsQuery: true,
  groups: [
    { key: "line_items", label: "Line items", default: true },
    { key: "line_product_data", label: "Line items product data", default: false },
    // No row of its own: its columns sit in the Customer section.
    { key: "browser", label: "Browser", default: false, columnPrefix: "Browser:" },
    // Standalone: these are extra rows, not the Shipping address columns.
    { key: "shipping_lines", label: "Shipping lines as rows", default: true, standalone: true },
    { key: "fulfillments", label: "Fulfillments", default: true },
    { key: "refunds", label: "Refunds", default: true },
    { key: "transactions", label: "Transactions", default: true },
    { key: "metafields", label: "Order metafields", default: true },
  ],
  export: exportOrders,
  import: { keyColumns: ["ID", "Name"], apply: importOrder },
};
