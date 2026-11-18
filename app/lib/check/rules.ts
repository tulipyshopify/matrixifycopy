import type { Row } from "../core/types";

/**
 * Product data check: is the catalogue complete enough for AI shopping
 * agents (ChatGPT, Gemini, Copilot, Shopify's agentic channels) and product
 * feeds to find, understand and recommend each product? They read structured
 * data, not the storefront design, so gaps here mean a product is skipped or
 * described wrongly. Rules are plain checks, the same every run.
 */

export type Severity = "critical" | "recommended";

export interface Rule {
  key: string;
  title: string;
  severity: Severity;
  /** Why it matters, for the merchant. */
  why: string;
  /** Columns to export for fixing it (ID and Title are added). */
  fixColumns: string[];
  /** True when the product (its export rows) has the problem. */
  test: (p: ProductRows) => boolean;
}

export interface ProductRows {
  top: Row;
  variants: Row[];
  images: Row[];
}

const text = (html: string | undefined) => (html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const has = (v: string | undefined) => (v ?? "").trim() !== "";

export const RULES: Rule[] = [
  {
    key: "no_description",
    title: "No description, or a very short one",
    severity: "critical",
    why: "Agents answer questions from the description. Under 50 characters gives them nothing to match a shopper's request with.",
    fixColumns: ["Handle", "Body HTML"],
    test: (p) => text(p.top["Body HTML"]).length < 50,
  },
  {
    key: "no_image",
    title: "No image",
    severity: "critical",
    why: "Products without an image are usually left out of AI and shopping results.",
    fixColumns: ["Handle", "Image Src", "Image Alt Text"],
    test: (p) => p.images.length === 0,
  },
  {
    key: "no_category",
    title: "No product category",
    severity: "critical",
    why: "The standard category tells an agent what the product is, and unlocks its attributes (size, material, colour).",
    fixColumns: ["Handle", "Category: Name", "Type"],
    test: (p) => !has(p.top["Category: Name"]),
  },
  {
    key: "no_price",
    title: "A variant with no price",
    severity: "critical",
    why: "A zero price is read as an error and the product is dropped from results.",
    fixColumns: ["Handle", "Variant ID", "Variant SKU", "Variant Price"],
    test: (p) => p.variants.some((v) => !(Number(v["Variant Price"]) > 0)),
  },
  {
    key: "no_sku",
    title: "A variant without a SKU",
    severity: "critical",
    why: "The SKU is how an order placed through an agent is matched to the right item.",
    fixColumns: ["Handle", "Variant ID", "Option1 Value", "Variant SKU"],
    test: (p) => p.variants.some((v) => !has(v["Variant SKU"])),
  },
  {
    key: "no_barcode",
    title: "A variant without a barcode (GTIN)",
    severity: "recommended",
    why: "A GTIN lets agents and marketplaces recognise the exact product and compare it across shops.",
    fixColumns: ["Handle", "Variant ID", "Variant SKU", "Variant Barcode"],
    test: (p) => p.variants.some((v) => !has(v["Variant Barcode"])),
  },
  {
    key: "no_alt",
    title: "Images without alt text",
    severity: "recommended",
    why: "Alt text is how an agent knows what a picture shows.",
    fixColumns: ["Handle", "Image Src", "Image Alt Text"],
    test: (p) => p.images.some((i) => !has(i["Image Alt Text"])),
  },
  {
    key: "title_length",
    title: "Title too short or too long",
    severity: "recommended",
    why: "Under 15 characters says too little; over 150 gets cut off.",
    fixColumns: ["Handle"],
    test: (p) => {
      const n = (p.top.Title ?? "").trim().length;
      return n < 15 || n > 150;
    },
  },
  {
    key: "no_vendor",
    title: "No vendor (brand)",
    severity: "recommended",
    why: "Shoppers ask agents for brands by name.",
    fixColumns: ["Handle", "Vendor"],
    test: (p) => !has(p.top.Vendor),
  },
  {
    key: "no_type",
    title: "No product type",
    severity: "recommended",
    why: "Your own product type helps group and filter the catalogue.",
    fixColumns: ["Handle", "Type"],
    test: (p) => !has(p.top.Type),
  },
  {
    key: "no_seo",
    title: "No search title or description",
    severity: "recommended",
    why: "These are the short summary search engines and agents show first.",
    fixColumns: ["Handle", "SEO Title", "SEO Description"],
    test: (p) => !has(p.top["SEO Title"]) || !has(p.top["SEO Description"]),
  },
  {
    key: "no_weight",
    title: "A shipped variant with no weight",
    severity: "recommended",
    why: "Without a weight, shipping cost can't be worked out when an agent builds the order.",
    fixColumns: ["Handle", "Variant ID", "Variant SKU", "Variant Weight", "Variant Weight Unit"],
    test: (p) => p.variants.some((v) => /^true$/i.test(v["Variant Requires Shipping"] ?? "") && !(Number(v["Variant Weight"]) > 0)),
  },
];

/** Added by the checker itself: the same SKU on more than one product. */
export const DUPLICATE_SKU: Omit<Rule, "test"> = {
  key: "duplicate_sku",
  title: "The same SKU on more than one product",
  severity: "critical",
  why: "Two products with one SKU can't be told apart when an order comes in.",
  fixColumns: ["Handle", "Variant ID", "Variant SKU"],
};

export const ALL_RULES: Array<Omit<Rule, "test">> = [...RULES.slice(0, 5), DUPLICATE_SKU, ...RULES.slice(5)];

/** IDs kept per rule, for "export these to fix". */
export const MAX_IDS_PER_RULE = 250;

export interface RuleResult {
  key: string;
  count: number;
  /** First affected products. */
  examples: Array<{ id: string; title: string }>;
  /** Up to MAX_IDS_PER_RULE affected product IDs. */
  ids: string[];
}

export interface CheckReport {
  products: number;
  /** Products with no critical problem. */
  ready: number;
  /** 0-100: critical problems weigh three times a recommended one. */
  score: number;
  rules: RuleResult[];
}

/** Collects results product by product, so a large catalogue never sits in memory. */
export function createChecker() {
  const results = new Map<string, RuleResult>(ALL_RULES.map((r) => [r.key, { key: r.key, count: 0, examples: [], ids: [] }]));
  const skuOwner = new Map<string, { id: string; title: string; flagged: boolean }>();
  const notReady = new Set<string>();
  let products = 0;
  const hit = (key: string, id: string, title: string, critical: boolean) => {
    const r = results.get(key)!;
    r.count++;
    if (r.examples.length < 5) r.examples.push({ id, title });
    if (r.ids.length < MAX_IDS_PER_RULE) r.ids.push(id);
    if (critical) notReady.add(id);
  };
  return {
    /** One product's export rows (top row first). Returns the titles of the problems found. */
    add(rows: Row[]): string[] {
      const top = rows.find((r) => /^true$/i.test(r["Top Row"] ?? "")) ?? rows[0];
      if (!top?.ID) return [];
      products++;
      const p: ProductRows = { top, variants: rows.filter((r) => has(r["Variant ID"])), images: rows.filter((r) => has(r["Image Src"])) };
      const id = top.ID;
      const title = top.Title ?? "";
      const found: string[] = [];
      for (const rule of RULES) {
        if (!rule.test(p)) continue;
        hit(rule.key, id, title, rule.severity === "critical");
        found.push(rule.title);
      }
      for (const sku of new Set(p.variants.map((v) => (v["Variant SKU"] ?? "").trim().toLowerCase()).filter(Boolean))) {
        const owner = skuOwner.get(sku);
        if (!owner) skuOwner.set(sku, { id, title, flagged: false });
        else if (owner.id !== id) {
          if (!owner.flagged) {
            owner.flagged = true;
            hit(DUPLICATE_SKU.key, owner.id, owner.title, true);
          }
          hit(DUPLICATE_SKU.key, id, title, true);
          if (!found.includes(DUPLICATE_SKU.title)) found.push(DUPLICATE_SKU.title);
        }
      }
      return found;
    },
    report(): CheckReport {
      const rules = ALL_RULES.map((r) => results.get(r.key)!);
      const weight = (k: string) => (ALL_RULES.find((r) => r.key === k)!.severity === "critical" ? 3 : 1);
      const worst = ALL_RULES.reduce((n, r) => n + weight(r.key), 0) * products;
      const lost = rules.reduce((n, r) => n + weight(r.key) * Math.min(r.count, products), 0);
      return { products, ready: products - notReady.size, score: products ? Math.round(100 * (1 - lost / worst)) : 100, rules };
    },
  };
}
