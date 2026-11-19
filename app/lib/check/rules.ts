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
  /** Category attributes filled in (Shopify's standard "shopify.*" metafields: colour, material, size…). */
  attributes: number;
}

/** True for a GTIN-8, UPC-12, EAN-13 or GTIN-14 with a correct check digit. */
export function validGtin(code: string): boolean {
  const d = code.replace(/[\s-]/g, "");
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(d)) return false;
  const digits = [...d].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((n, x, i) => n + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
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
  {
    key: "short_description",
    title: "Description under 150 characters",
    severity: "recommended",
    why: "Shopify's catalogue sends the description to ChatGPT, Copilot and other agents. A couple of sentences on what it is, who it's for and what it's made of gives them something to match.",
    fixColumns: ["Handle", "Body HTML"],
    test: (p) => {
      const n = text(p.top["Body HTML"]).length;
      return n >= 50 && n < 150;
    },
  },
  {
    key: "no_attributes",
    title: "Category set, but no attributes (colour, material, size…)",
    severity: "recommended",
    why: "Attributes are how an agent answers \"a green wooden planter under £50\". They come with the product category and are filled in on the product page.",
    fixColumns: ["Handle", "Category: Name"],
    test: (p) => has(p.top["Category: Name"]) && p.attributes === 0,
  },
  {
    key: "bad_gtin",
    title: "A barcode that isn't a valid GTIN",
    severity: "recommended",
    why: "The catalogue groups identical products across shops by GTIN. A mistyped one (wrong length or check digit) is ignored, or matches the wrong product.",
    fixColumns: ["Handle", "Variant ID", "Variant SKU", "Variant Barcode"],
    test: (p) => p.variants.some((v) => has(v["Variant Barcode"]) && !validGtin(v["Variant Barcode"])),
  },
  {
    key: "one_image",
    title: "Only one image",
    severity: "recommended",
    why: "Agents show several pictures when they have them; one image looks thin next to competitors.",
    fixColumns: ["Handle", "Image Src", "Image Alt Text"],
    test: (p) => p.images.length === 1,
  },
  {
    key: "out_of_stock",
    title: "Active but out of stock",
    severity: "recommended",
    why: "Availability is sent live to the agents: a product with nothing to sell is not offered. Restock it, allow overselling, or set it to draft.",
    fixColumns: ["Handle", "Variant ID", "Variant SKU", "Variant Inventory Qty", "Variant Inventory Policy"],
    test: (p) =>
      p.variants.length > 0 &&
      p.variants.every((v) => has(v["Variant Inventory Tracker"]) && (v["Variant Inventory Policy"] ?? "").toLowerCase() !== "continue" && !(Number(v["Variant Inventory Qty"]) > 0)),
  },
  {
    key: "not_published",
    title: "Active but not on the Online Store",
    severity: "recommended",
    why: "Agents send shoppers to the product page. A product that isn't published to the Online Store has no page to send them to.",
    fixColumns: ["Handle", "Published"],
    test: (p) => /^false$/i.test(p.top.Published ?? ""),
  },
  {
    key: "compare_at",
    title: "Compare-at price not above the price",
    severity: "recommended",
    why: "Agents can show the compare-at price struck through as the list price. One that is equal or lower shows no saving, or a confusing one.",
    fixColumns: ["Handle", "Variant ID", "Variant SKU", "Variant Price", "Variant Compare At Price"],
    test: (p) => p.variants.some((v) => has(v["Variant Compare At Price"]) && Number(v["Variant Compare At Price"]) > 0 && Number(v["Variant Compare At Price"]) <= Number(v["Variant Price"])),
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
/** A product's export rows, in the shape the rules read. */
export function toProductRows(rows: Row[], top: Row = rows.find((r) => /^true$/i.test(r["Top Row"] ?? "")) ?? rows[0]): ProductRows {
  const attributes = Object.keys(top ?? {}).filter((k) => /^Metafield: shopify\./.test(k) && has(top[k])).length;
  return { top, variants: rows.filter((r) => has(r["Variant ID"])), images: rows.filter((r) => has(r["Image Src"])), attributes };
}

/** Column groups a products export must fetch for the rules to be checked. */
export const CHECK_GROUPS = ["variants", "images", "seo", "metafields"];

export function createChecker() {
  const results = new Map<string, RuleResult>(ALL_RULES.map((r) => [r.key, { key: r.key, count: 0, examples: [], ids: [] }]));
  const skuOwner = new Map<string, { id: string; title: string; flagged: boolean }>();
  const notReady = new Set<string>();
  let products = 0;
  // If no product at all shows attributes, the store's attributes can't be read: don't flag every product.
  let sawAttributes = false;
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
      const p = toProductRows(rows, top);
      if (p.attributes) sawAttributes = true;
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
      const rules = ALL_RULES.map((r) => (r.key === "no_attributes" && !sawAttributes ? { key: r.key, count: 0, examples: [], ids: [] } : results.get(r.key)!));
      const weight = (k: string) => (ALL_RULES.find((r) => r.key === k)!.severity === "critical" ? 3 : 1);
      const worst = ALL_RULES.reduce((n, r) => n + weight(r.key), 0) * products;
      const lost = rules.reduce((n, r) => n + weight(r.key) * Math.min(r.count, products), 0);
      return { products, ready: products - notReady.size, score: products ? Math.round(100 * (1 - lost / worst)) : 100, rules };
    },
  };
}

// --- Scores per channel -------------------------------------------------------

/**
 * How much each rule matters to a channel (0 = not at all, 3 = a listing is
 * usually refused or hidden without it). The weights are a judgement from the
 * channels' published product-data requirements, stated on the page so the
 * score can be argued with.
 */
export const CHANNELS: Array<{ key: string; label: string; note: string; weights: Record<string, number> }> = [
  {
    key: "google",
    label: "Google Shopping",
    note: "Needs an image, a price, a brand and a valid GTIN; titles and categories decide where a product shows.",
    weights: { no_image: 3, no_price: 3, no_barcode: 3, bad_gtin: 3, no_vendor: 2, no_description: 2, no_category: 2, title_length: 2, short_description: 1, one_image: 1, out_of_stock: 1, compare_at: 1 },
  },
  {
    key: "social",
    label: "Meta and TikTok",
    note: "Image-led: products need good pictures, a price, stock and a product page to send people to.",
    weights: { no_image: 3, no_price: 3, one_image: 2, no_description: 2, title_length: 2, out_of_stock: 2, not_published: 2, no_category: 1, no_vendor: 1, compare_at: 1 },
  },
  {
    key: "ai",
    label: "AI shopping agents",
    note: "Agents answer from structured data: description, category and attributes matter most, then identifiers.",
    weights: { no_description: 3, no_category: 3, no_price: 3, short_description: 2, no_attributes: 2, no_image: 2, no_sku: 2, duplicate_sku: 2, not_published: 2, no_alt: 1, no_seo: 1, no_barcode: 1, bad_gtin: 1, out_of_stock: 1 },
  },
];

/** A 0–100 score per channel from a report: each rule counts by its weight and by the share of products that pass it. */
export function channelScores(report: Pick<CheckReport, "products" | "rules">): Array<{ key: string; label: string; note: string; score: number; worst: Array<{ rule: string; title: string; count: number; weight: number }> }> {
  return CHANNELS.map((c) => {
    let total = 0;
    let lost = 0;
    const hits: Array<{ rule: string; title: string; count: number; weight: number; cost: number }> = [];
    for (const [rule, weight] of Object.entries(c.weights)) {
      const count = Math.min(report.rules.find((r) => r.key === rule)?.count ?? 0, report.products);
      total += weight;
      const cost = report.products ? (weight * count) / report.products : 0;
      lost += cost;
      if (count) hits.push({ rule, title: ALL_RULES.find((r) => r.key === rule)?.title ?? rule, count, weight, cost });
    }
    return {
      key: c.key,
      label: c.label,
      note: c.note,
      score: total ? Math.round(100 * (1 - lost / total)) : 100,
      // What costs this channel's score the most, biggest first.
      worst: hits.sort((a, b) => b.cost - a.cost).slice(0, 3).map(({ cost: _c, ...h }) => h),
    };
  });
}
