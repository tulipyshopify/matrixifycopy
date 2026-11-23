import type { Entity } from "./types";
import type { Sheet } from "./sheets";

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(\d+\)$/, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds the data type a sheet holds.
 *
 * 1. A sheet named exactly after a data type ("Products") is that type.
 * 2. Otherwise the columns decide, when they clearly point at one type, so a
 *    file can be called anything ("stock update.csv", "Sheet1").
 * 3. Otherwise a data type's name inside the file name ("Export_Products_2026.csv").
 * 4. Otherwise the best guess from the columns, if there is a single one.
 */
export function detectEntity(sheet: Pick<Sheet, "name"> & { headers?: string[] }, entities: Entity[]): Entity | null {
  const name = norm(sheet.name);
  const namesOf = (e: Entity) => [norm(e.sheet), norm(e.key), ...(e.aliases ?? []).map(norm)];
  for (const e of entities) if (namesOf(e).includes(name)) return e;
  // A guess from the columns only stands if the sheet has a column that says which item each row is
  // (a supplier's "Item Description" is not a menu's "Item: Title").
  const hasKey = (e: Entity | null | undefined) => !!e && (!e.import || e.import.keyColumns.some((k) => (sheet.headers ?? []).includes(k)));
  const scored = scoreByHeaders(sheet.headers ?? [], entities);
  const byHeaders = { confident: hasKey(scored.confident) ? scored.confident : null, guess: hasKey(scored.guess) ? scored.guess : null };
  if (byHeaders.confident && !(byHeaders.confident.key === "discounts" && looksLikePriceList(sheet.headers ?? []))) return byHeaders.confident;
  // A supplier's price or stock list (a code or barcode beside a price, a description or stock) is products,
  // whatever one of its columns happens to be called ("Code" is also a discount's column).
  if (looksLikePriceList(sheet.headers ?? [])) {
    const products = entities.find((e) => e.key === "products");
    if (products) return products;
  }
  let best: { e: Entity; len: number } | null = null;
  for (const e of entities) {
    for (const n of namesOf(e)) {
      if (n && name.includes(n) && (!best || n.length > best.len)) best = { e, len: n.length };
    }
  }
  return best?.e ?? byHeaders.guess;
}

/** True for the columns of a supplier's list: something that names the product, and something about it. */
export function looksLikePriceList(headers: string[]): boolean {
  const h = headers.map((x) => x.toLowerCase().replace(/[\s_]+/g, " ").replace(/[^a-z0-9 ]/g, "").trim());
  // A discount sheet says so in columns no price list has.
  if (h.some((x) => /^(value type|method|starts at|ends at|usage limit|once per customer|combines with|applies to|minimum requirement|additional code)$/.test(x))) return false;
  const names = h.some((x) => /^(code|sku|barcode|ean|ean13|gtin|upc|item no|item number|item code|product code|stock code|part no|part number|model|mpn)$/.test(x) || /\b(sku|barcode|ean|product code|item code|stock code)\b/.test(x));
  const about = h.some((x) => /\b(price|rrp|cost|trade|description|product name|qty|quantity|stock|availability|pack size|carton)\b/.test(x));
  return names && about;
}

/** Columns too common to tell data types apart. */
const GENERIC = new Set(["ID", "Handle", "Command", "Title", "Tags", "Tags Command", "Created At", "Updated At", "Row #", "Top Row", "Name", "Email", "Phone", "Note", "Status"]);

/** Columns added to result files, and other headers that say nothing about the data type. */
const IGNORED = /^(Import Result|Import Comment)$/i;

/** Dynamic columns ("Variant Metafield: …", "Inventory Available: …") and the fixed column that proves the type has them. */
const DYNAMIC: Array<[RegExp, string]> = [
  [/^Variant Metafield: /, "Variant ID"],
  [/^Inventory [A-Za-z ]+: /, "Variant Inventory Qty"],
  [/^(Variant|Line|Address|Rule|Item|Field) /, ""],
];

/**
 * Scores each importable data type by how many of the sheet's columns it
 * knows. `confident`: one type clearly ahead on distinctive columns, and it
 * knows most of them. `guess`: a single best match, even on common columns.
 */
function scoreByHeaders(headers: string[], entities: Entity[]): { confident: Entity | null; guess: Entity | null; candidates: Entity[] } {
  const all = headers.map((h) => h.trim()).filter((h) => h && !IGNORED.test(h) && !/^Metafield: /.test(h));
  const distinctive = all.filter((h) => !GENERIC.has(h));
  if (!all.length) return { confident: null, guess: null, candidates: [] };
  const scored = entities
    .filter((e) => e.import)
    .map((e) => {
      const cols = new Set(e.columns);
      const prefixes = new Set(e.columns.map((c) => c.split(/[ :]/)[0]));
      const knows = (h: string) => {
        if (cols.has(h)) return true;
        for (const [re, proof] of DYNAMIC) {
          if (re.test(h)) return proof ? cols.has(proof) : prefixes.has(h.split(" ")[0]);
        }
        return false;
      };
      return { e, score: distinctive.filter(knows).length, total: all.filter(knows).length };
    });
  const top = [...scored].sort((a, b) => b.score - a.score || b.total - a.total);
  const [first, second] = top;
  if (!first || first.total === 0) return { confident: null, guess: null, candidates: [] };
  const ahead = first.score > (second?.score ?? 0);
  // Tied on distinctive columns: the common ones (Handle, Tags, Email…) may still single one out.
  const aheadOverall = ahead || (first.score === second?.score && first.total > second.total);
  const confident = ahead && first.score >= 2 && first.score >= distinctive.length * 0.6 ? first.e : ahead && distinctive.length === 1 && first.total >= 2 ? first.e : null;
  const guess = aheadOverall && (first.score > 0 || first.total >= 2) ? first.e : null;
  // Every type that knows all of the sheet's columns could be the one.
  const candidates = scored.filter((x) => x.total === all.length).map((x) => x.e);
  return { confident, guess, candidates };
}

/** Shopify object type behind each data type's ID column. */
const ID_TYPES: Record<string, string> = {
  products: "Product",
  smart_collections: "Collection",
  custom_collections: "Collection",
  customers: "Customer",
  companies: "Company",
  orders: "Order",
  draft_orders: "DraftOrder",
  pages: "Page",
  blog_posts: "Article",
  redirects: "UrlRedirect",
  metaobjects: "Metaobject",
  menus: "Menu",
};

const RECOGNISE_BY_ID = `#graphql
  query ImportRecogniseById($ids: [ID!]!) {
    nodes(ids: $ids) { __typename id ... on Collection { ruleSet { appliedDisjunctively } } }
  }
`;

/**
 * For a sheet whose columns fit several data types (say just ID and Tags):
 * looks its first IDs up in the store and returns the type they belong to.
 */
export async function detectEntityByIds(
  gql: (query: string, variables?: Record<string, unknown>) => Promise<any>,
  sheet: { headers?: string[]; rows: Array<Record<string, string>> },
  entities: Entity[],
): Promise<Entity | null> {
  const ids = [...new Set(sheet.rows.map((r) => (r.ID ?? "").trim()).filter((v) => /^\d+$/.test(v)))].slice(0, 3);
  if (!ids.length) return null;
  const { candidates } = scoreByHeaders(sheet.headers ?? [], entities);
  const found = new Set<Entity>();
  for (const type of new Set(candidates.map((e) => ID_TYPES[e.key]).filter(Boolean))) {
    try {
      const d = await gql(RECOGNISE_BY_ID, { ids: ids.map((id) => `gid://shopify/${type}/${id}`) });
      for (const node of d?.nodes ?? []) {
        if (!node) continue;
        const key = type === "Collection" ? (node.ruleSet ? "smart_collections" : "custom_collections") : candidates.find((e) => ID_TYPES[e.key] === type)?.key;
        const e = candidates.find((c) => c.key === key);
        if (e) found.add(e);
      }
    } catch {
      // No access to this type, or it can't be looked up: not this one.
    }
  }
  // An ID number can exist under two types by coincidence; only a single answer counts.
  return found.size === 1 ? [...found][0] : null;
}

/** Shopify owner type of each data type's "Metafield: …" columns. */
const METAFIELD_OWNERS: Record<string, string> = {
  products: "PRODUCT",
  customers: "CUSTOMER",
  companies: "COMPANY",
  orders: "ORDER",
  draft_orders: "DRAFTORDER",
  pages: "PAGE",
  blog_posts: "ARTICLE",
};

const RECOGNISE_BY_METAFIELD = `#graphql
  query ImportRecogniseByMetafield($ownerType: MetafieldOwnerType!, $namespace: String!, $key: String!) {
    metafieldDefinitions(ownerType: $ownerType, namespace: $namespace, key: $key, first: 1) { nodes { id } }
  }
`;

/**
 * For a sheet with "Metafield: namespace.key" columns that could be several
 * data types: the type whose metafield definitions in the store include those
 * metafields (e.g. custom.courier is defined for orders only).
 */
export async function detectEntityByMetafields(
  gql: (query: string, variables?: Record<string, unknown>) => Promise<any>,
  sheet: { headers?: string[] },
  entities: Entity[],
): Promise<Entity | null> {
  const fields = (sheet.headers ?? [])
    .map((h) => /^Metafield:\s*([^.\s]+)\.([^\s\[]+)/.exec(h.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .slice(0, 3);
  if (!fields.length) return null;
  const { candidates } = scoreByHeaders(sheet.headers ?? [], entities);
  const scores: Array<{ e: Entity; n: number }> = [];
  for (const e of candidates) {
    const ownerType = METAFIELD_OWNERS[e.key];
    if (!ownerType) continue;
    let n = 0;
    for (const m of fields) {
      try {
        const d = await gql(RECOGNISE_BY_METAFIELD, { ownerType, namespace: m[1], key: m[2] });
        if (d?.metafieldDefinitions?.nodes?.length) n++;
      } catch {
        // No access to this type's definitions: not counted.
      }
    }
    scores.push({ e, n });
  }
  scores.sort((a, b) => b.n - a.n);
  const [first, second] = scores;
  return first && first.n > 0 && first.n > (second?.n ?? 0) ? first.e : null;
}

// --- Columns the data type doesn't have ---------------------------------------

/** Headers every sheet may carry, whatever the data type. */
const ALWAYS_KNOWN = /^(ID|Command|Row #|Top Row|Import Result|Import Comment)$/i;
/** Columns made from the store's own data (metafields, locations…): any name after the prefix is fine. */
const OPEN_ENDED = /^((Variant )?Metafield: \S|Inventory [A-Za-z ]+: \S|Option[123] (Name|Value)$)/;
/** Data types whose columns are a fixed list apart from the open-ended ones above. */
const CLOSED_COLUMNS = new Set(["products", "redirects", "pages", "custom_collections", "smart_collections"]);

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = keep;
    }
  }
  return prev[b.length];
}

/**
 * Headers the data type would silently ignore, each with the column it most
 * resembles. For data types with free-form columns only near-misses are
 * returned, so a legitimate extra column never raises a false alarm.
 */
export function unknownColumns(entity: Entity, headers: string[]): Array<{ header: string; suggestion: string | null }> {
  const cols = new Set(entity.columns);
  const lower = new Map(entity.columns.map((c) => [c.toLowerCase().replace(/\s+/g, " "), c]));
  const out: Array<{ header: string; suggestion: string | null }> = [];
  for (const raw of headers) {
    const h = raw.replace(/ \(\d+\)$/, "").trim();
    if (!h || cols.has(h) || ALWAYS_KNOWN.test(h) || OPEN_ENDED.test(h)) continue;
    const same = lower.get(h.toLowerCase().replace(/\s+/g, " "));
    let suggestion: string | null = same ?? null;
    if (!suggestion) {
      let best = 3;
      for (const c of entity.columns) {
        if (Math.abs(c.length - h.length) > 2) continue;
        const d = editDistance(c.toLowerCase(), h.toLowerCase());
        if (d < best) {
          best = d;
          suggestion = c;
        }
      }
    }
    // A header that only differs in capitals or spacing is still read by nobody: flag it too.
    if (suggestion || CLOSED_COLUMNS.has(entity.key)) out.push({ header: raw, suggestion });
  }
  return out;
}

// --- Recognising a sheet by its handles ---------------------------------------

const HANDLE_LOOKUPS: Array<{ keys: string[]; query: string; pick: (d: any) => string | null }> = [
  {
    keys: ["products"],
    query: `#graphql
      query ImportRecogniseProductHandle($q: String!) { products(first: 1, query: $q) { nodes { id } } }`,
    pick: (d) => (d?.products?.nodes?.length ? "products" : null),
  },
  {
    keys: ["smart_collections", "custom_collections"],
    query: `#graphql
      query ImportRecogniseCollectionHandle($q: String!) { collections(first: 1, query: $q) { nodes { id ruleSet { appliedDisjunctively } } } }`,
    pick: (d) => (d?.collections?.nodes?.length ? (d.collections.nodes[0].ruleSet ? "smart_collections" : "custom_collections") : null),
  },
  {
    keys: ["pages"],
    query: `#graphql
      query ImportRecognisePageHandle($q: String!) { pages(first: 1, query: $q) { nodes { id } } }`,
    pick: (d) => (d?.pages?.nodes?.length ? "pages" : null),
  },
];

/**
 * For a sheet with little more than a Handle column (say Handle + Command, to
 * delete; or Handle + Tags): looks its first handles up among products,
 * collections and pages, and returns the data type if exactly one has them.
 */
export async function detectEntityByHandles(
  gql: (query: string, variables?: Record<string, unknown>) => Promise<any>,
  sheet: { headers?: string[]; rows: Array<Record<string, string>> },
  entities: Entity[],
): Promise<Entity | null> {
  if (!(sheet.headers ?? []).includes("Handle")) return null;
  const handles = [...new Set(sheet.rows.map((r) => (r.Handle ?? "").trim().toLowerCase()).filter((h) => /^[^\s"\\]+$/.test(h)))].slice(0, 3);
  if (!handles.length) return null;
  const { candidates } = scoreByHeaders(sheet.headers ?? [], entities);
  const found = new Set<string>();
  for (const lookup of HANDLE_LOOKUPS) {
    if (!lookup.keys.some((k) => candidates.some((c) => c.key === k))) continue;
    for (const handle of handles) {
      try {
        const key = lookup.pick(await gql(lookup.query, { q: `handle:"${handle}"` }));
        if (key) found.add(key);
      } catch {
        // No access to this data type: not this one.
      }
    }
  }
  if (found.size !== 1) return null;
  return candidates.find((c) => c.key === [...found][0]) ?? null;
}

// --- Column names from other layouts --------------------------------------------

/** Column names of Shopify's own CSV exports, and the column here that holds the same thing. */
const COLUMN_ALIASES: Record<string, Record<string, string>> = {
  products: {
    "body (html)": "Body HTML",
    "cost per item": "Variant Cost",
    "variant grams": "Variant Weight",
    "seo title": "SEO Title",
    "seo description": "SEO Description",
    // The plain names nearly every supplier and system uses for what identifies a product.
    sku: "Variant SKU",
    barcode: "Variant Barcode",
  },
  customers: {
    "customer id": "ID",
    "total orders": "Orders Count",
    "default address company": "Address Company",
    "default address address1": "Address Line 1",
    "default address address2": "Address Line 2",
    "default address city": "Address City",
    "default address province code": "Address Province Code",
    "default address country code": "Address Country Code",
    "default address zip": "Address Zip",
    "default address phone": "Address Phone",
  },
};

/** Shopify export columns with no column here: what to use instead. */
const COLUMN_HINTS: Record<string, Record<string, string>> = {
  products: {
    "product category": 'Use "Category: ID" (the category\'s ID from an export of this app) to set the category.',
    "variant fulfillment service": "Fulfilment services are set in Shopify, not by import.",
    "variant inventory qty": "",
  },
};

/**
 * Renames columns that use Shopify's own export names to the names used here,
 * in place. Returns what was renamed, for the import's notes.
 */
export function applyColumnAliases(entity: Entity, sheet: { headers: string[]; rows: Array<Record<string, string>> }): string[] {
  const aliases = COLUMN_ALIASES[entity.key];
  if (!aliases) return [];
  const have = new Set(sheet.headers);
  const rename = new Map<string, string>();
  for (const h of sheet.headers) {
    const to = aliases[h.toLowerCase().replace(/\s+/g, " ").trim()];
    if (to && to !== h && !have.has(to) && ![...rename.values()].includes(to)) rename.set(h, to);
  }
  if (!rename.size) return [];
  // Shopify's product CSV gives weights in grams, with no unit column.
  const grams = [...rename.entries()].some(([from, to]) => to === "Variant Weight" && /grams/i.test(from)) && !have.has("Variant Weight Unit");
  const headers = sheet.headers.map((h) => rename.get(h) ?? h);
  if (grams) headers.push("Variant Weight Unit");
  sheet.rows = sheet.rows.map((r) => {
    const out: Record<string, string> = {};
    for (const h of sheet.headers) out[rename.get(h) ?? h] = r[h] ?? "";
    if (grams) out["Variant Weight Unit"] = out["Variant Weight"] ? "g" : "";
    return out;
  });
  sheet.headers = headers;
  return [...rename.entries()].map(([from, to]) => `"${from}" is read as "${to}"${to === "Variant Weight" && grams ? " (in grams)" : ""}`);
}

/** What to say about a column that is ignored but known from Shopify's own exports. */
export function columnHint(entity: Entity, header: string): string | null {
  return COLUMN_HINTS[entity.key]?.[header.toLowerCase().replace(/\s+/g, " ").trim()] || null;
}
