import type { ExportOptions } from "../core/types";

/**
 * Ready-made export set-ups offered as one-click starting points. Each opens
 * in the export form, where it can be adjusted before running.
 */
export interface ExportTemplate {
  key: string;
  title: string;
  description: string;
  /** Polaris icon name. */
  icon: string;
  entities: Array<{ entity: string; options: ExportOptions }>;
}

export const EXPORT_TEMPLATES: ExportTemplate[] = [
  {
    key: "products",
    title: "All products",
    description: "Every product with variants, prices and images, ready to edit and import back.",
    icon: "product",
    entities: [{ entity: "products", options: { groups: ["variants", "images"] } }],
  },
  {
    key: "stock",
    title: "Stock by location",
    description: "SKU and available stock per location. The quickest file for a stock update.",
    icon: "inventory",
    entities: [
      {
        entity: "products",
        options: { groups: ["variants", "inventory"], columns: ["ID", "Handle", "Title", "Variant ID", "Variant SKU", "Variant Inventory Qty"] },
      },
    ],
  },
  {
    key: "prices",
    title: "Prices",
    description: "SKU, price, compare-at price and cost for a price change.",
    icon: "money",
    entities: [
      {
        entity: "products",
        options: { groups: ["variants"], columns: ["ID", "Handle", "Title", "Variant ID", "Variant SKU", "Variant Price", "Variant Compare At Price", "Variant Cost"] },
      },
    ],
  },
  {
    key: "orders-month",
    title: "Orders, last 30 days",
    description: "Orders with line items, customer and shipping details for reports.",
    icon: "order",
    entities: [{ entity: "orders", options: { groups: ["line_items", "shipping_lines", "fulfillments"], dateRange: { field: "created_at", preset: "last_30_days" } } }],
  },
  {
    key: "unfulfilled",
    title: "Unfulfilled orders",
    description: "Open orders still to ship, with line items and addresses.",
    icon: "delivery",
    entities: [{ entity: "orders", options: { groups: ["line_items", "shipping_lines"], filters: [{ field: "fulfillment_status", op: "is", value: "unfulfilled" }, { field: "status", op: "is", value: "open" }] } }],
  },
  {
    key: "customers",
    title: "Customers",
    description: "Every customer with addresses, tags and marketing status.",
    icon: "person",
    entities: [{ entity: "customers", options: {} }],
  },
];

export const getTemplate = (key: string | null | undefined) => EXPORT_TEMPLATES.find((t) => t.key === key) ?? null;
