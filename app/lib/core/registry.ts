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
  const byHeaders = scoreByHeaders(sheet.headers ?? [], entities);
  if (byHeaders.confident) return byHeaders.confident;
  let best: { e: Entity; len: number } | null = null;
  for (const e of entities) {
    for (const n of namesOf(e)) {
      if (n && name.includes(n) && (!best || n.length > best.len)) best = { e, len: n.length };
    }
  }
  return best?.e ?? byHeaders.guess;
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
