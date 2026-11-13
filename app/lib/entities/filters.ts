import type { FilterField } from "../core/types";

/**
 * Export filters per entity. Keys are Shopify search syntax fields documented
 * for each query in Admin API 2026-10 (products, orders, customers, ...).
 */

const opts = (...values: string[]) =>
  values.map((v) => ({ value: v, label: v.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) }));

const created: FilterField = { key: "created_at", label: "Created", type: "date" };
const updated: FilterField = { key: "updated_at", label: "Updated", type: "date" };
const publishedAt: FilterField = { key: "published_at", label: "Published", type: "date" };
const tag: FilterField = { key: "tag", label: "Tag", type: "text" };
const title: FilterField = { key: "title", label: "Title", type: "text" };
const handle: FilterField = { key: "handle", label: "Handle", type: "text" };
const onlineStore: FilterField = {
  key: "published_status",
  label: "Online Store visibility",
  type: "enum",
  options: [
    { value: "published", label: "Published" },
    { value: "unpublished", label: "Not published" },
  ],
};

export const FILTERS: Record<string, FilterField[]> = {
  products: [
    title,
    handle,
    { key: "vendor", label: "Vendor", type: "text" },
    { key: "product_type", label: "Product type", type: "text" },
    tag,
    { key: "status", label: "Status", type: "enum", options: opts("active", "draft", "archived", "unlisted") },
    onlineStore,
    { key: "sku", label: "Variant SKU", type: "text" },
    { key: "barcode", label: "Variant barcode", type: "text" },
    { key: "variant_title", label: "Variant title", type: "text" },
    { key: "price", label: "Variant price", type: "number" },
    { key: "inventory_total", label: "Total inventory", type: "number" },
    { key: "is_price_reduced", label: "On sale (compare-at price set)", type: "boolean" },
    { key: "out_of_stock_somewhere", label: "Out of stock at a location", type: "boolean" },
    { key: "tracks_inventory", label: "Tracks inventory", type: "boolean" },
    { key: "has_only_default_variant", label: "Has no variants", type: "boolean" },
    { key: "gift_card", label: "Gift card", type: "boolean" },
    { key: "collection_id", label: "In collection (ID)", type: "id" },
    { key: "category_id", label: "Category ID", type: "text", help: "e.g. aa-1-13" },
    { key: "id", label: "Product ID", type: "id" },
    created,
    updated,
    publishedAt,
  ],
  smart_collections: [title, handle, onlineStore, { key: "product_id", label: "Contains product (ID)", type: "id" }, publishedAt, updated],
  custom_collections: [title, handle, onlineStore, { key: "product_id", label: "Contains product (ID)", type: "id" }, publishedAt, updated],
  customers: [
    { key: "email", label: "Email", type: "text" },
    { key: "first_name", label: "First name", type: "text" },
    { key: "last_name", label: "Last name", type: "text" },
    { key: "phone", label: "Phone", type: "text" },
    { key: "country", label: "Country", type: "text", help: "Country name, e.g. United Kingdom" },
    tag,
    { key: "accepts_marketing", label: "Accepts email marketing", type: "boolean" },
    { key: "orders_count", label: "Number of orders", type: "number" },
    { key: "total_spent", label: "Total spent", type: "number" },
    {
      key: "state",
      label: "Account state",
      type: "enum",
      options: opts("ENABLED", "INVITED", "DISABLED", "DECLINED"),
      help: "Classic customer accounts only",
    },
    { key: "customer_date", label: "Customer since", type: "date" },
    { key: "order_date", label: "Order date", type: "date" },
    { key: "last_abandoned_order_date", label: "Last abandoned checkout", type: "date" },
    updated,
  ],
  companies: [
    { key: "name", label: "Name", type: "text" },
    { key: "external_id", label: "External ID", type: "text" },
    { key: "active_customers_count", label: "Active customers", type: "number" },
    { key: "since_date", label: "Customer since", type: "date" },
    created,
    updated,
  ],
  discounts: [
    title,
    { key: "code", label: "Code", type: "text" },
    { key: "status", label: "Status", type: "enum", options: opts("active", "scheduled", "expired") },
    { key: "method", label: "Method", type: "enum", options: opts("code", "automatic") },
    {
      key: "type",
      label: "Type",
      type: "enum",
      options: opts("percentage", "fixed_amount", "free_shipping", "bxgy", "app"),
    },
    { key: "discount_class", label: "Applies to", type: "enum", options: opts("order", "product", "shipping") },
    { key: "times_used", label: "Times used", type: "number" },
    { key: "starts_at", label: "Starts", type: "date" },
    { key: "ends_at", label: "Ends", type: "date" },
    created,
    updated,
  ],
  draft_orders: [
    { key: "status", label: "Status", type: "enum", options: opts("open", "invoice_sent", "completed") },
    tag,
    { key: "customer_id", label: "Customer ID", type: "id" },
    { key: "source", label: "Source", type: "text" },
    created,
    updated,
  ],
  orders: [
    { key: "id", label: "ID", type: "id" },
    { key: "name", label: "Order name", type: "text", help: "e.g. #1001" },
    { key: "email", label: "Customer email", type: "text" },
    {
      key: "financial_status",
      label: "Payment status",
      type: "enum",
      options: opts("paid", "pending", "authorized", "partially_paid", "partially_refunded", "refunded", "voided", "expired"),
    },
    {
      key: "fulfillment_status",
      label: "Fulfillment status",
      type: "enum",
      options: opts("unfulfilled", "partial", "fulfilled", "unshipped", "shipped", "scheduled", "on_hold", "request_declined"),
    },
    { key: "status", label: "Order status", type: "enum", options: opts("open", "closed", "cancelled", "not_closed") },
    tag,
    { key: "sku", label: "Line: SKU", type: "text" },
    { key: "metafield", label: "Metafield", type: "text", help: "namespace.key=value, e.g. custom.batch=A12" },
    { key: "discount_code", label: "Discount code", type: "text" },
    { key: "gateway", label: "Payment gateway", type: "text" },
    { key: "sales_channel", label: "Sales channel", type: "text" },
    { key: "source_name", label: "Source", type: "text" },
    { key: "current_total_price", label: "Order total", type: "number" },
    { key: "risk_level", label: "Risk level", type: "enum", options: opts("high", "medium", "low", "none", "pending") },
    {
      key: "return_status",
      label: "Return status",
      type: "enum",
      options: opts("return_requested", "in_progress", "inspection_complete", "returned", "return_failed", "no_return"),
    },
    {
      key: "chargeback_status",
      label: "Chargeback status",
      type: "enum",
      options: opts("accepted", "charge_refunded", "lost", "needs_response", "prevented", "under_review", "won"),
    },
    { key: "test", label: "Test order", type: "boolean" },
    { key: "po_number", label: "PO number", type: "text" },
    { key: "customer_id", label: "Customer ID", type: "id" },
    created,
    { key: "processed_at", label: "Processed", type: "date" },
    updated,
    // Below: not searchable in Shopify, so the export checks each order itself.
    // Dates are narrowed by updated_at first (a fulfillment or refund updates its order).
    { key: "fulfillment_created_at", label: "Fulfillment: Created At", type: "date", local: true, searchBy: "updated_at" },
    { key: "fulfillment_updated_at", label: "Fulfillment: Updated At", type: "date", local: true, searchBy: "updated_at" },
    { key: "refund_created_at", label: "Refund: Created At", type: "date", local: true, searchBy: "updated_at" },
    { key: "customer_tax_exempt", label: "Customer: Tax Exempt", type: "boolean", local: true },
    { key: "billing_country_code", label: "Billing: Country Code", type: "text", local: true, help: "e.g. GB" },
    { key: "shipping_country_code", label: "Shipping: Country Code", type: "text", local: true, help: "e.g. GB" },
    { key: "line_type", label: "Line: Type", type: "enum", local: true, options: [{ value: "Line Item", label: "Line Item" }, { value: "Shipping Line", label: "Shipping Line" }] },
    { key: "line_product_handle", label: "Line: Product Handle", type: "text", local: true },
    { key: "line_title", label: "Line: Title", type: "text", local: true },
    { key: "line_name", label: "Line: Name", type: "text", local: true, help: "Title and variant, e.g. Shirt - Blue / M" },
    { key: "line_variant_id", label: "Line: Variant ID", type: "id", local: true },
    { key: "line_variant_title", label: "Line: Variant Title", type: "text", local: true },
    { key: "line_vendor", label: "Line: Vendor", type: "text", local: true },
    { key: "line_variant_inventory_qty", label: "Line: Variant Inventory Qty", type: "number", local: true },
  ],
  files: [
    { key: "filename", label: "File name", type: "text" },
    {
      key: "media_type",
      label: "Type",
      type: "enum",
      options: opts("IMAGE", "VIDEO", "MODEL_3D", "EXTERNAL_VIDEO", "GENERIC_FILE"),
    },
    { key: "status", label: "Status", type: "enum", options: opts("READY", "PROCESSING", "UPLOADED", "FAILED") },
    { key: "product_id", label: "Used by product (ID)", type: "id" },
    created,
    updated,
  ],
  metaobjects: [handle, { key: "display_name", label: "Display name", type: "text" }, created, updated],
  pages: [title, handle, onlineStore, created, updated, publishedAt],
  blog_posts: [
    title,
    handle,
    { key: "author", label: "Author", type: "text" },
    { key: "blog_title", label: "Blog title", type: "text" },
    tag,
    onlineStore,
    created,
    updated,
    publishedAt,
  ],
  redirects: [
    { key: "path", label: "Redirect from (path)", type: "text" },
    { key: "target", label: "Redirect to (target)", type: "text" },
    created,
  ],
  menus: [title, created],
};
