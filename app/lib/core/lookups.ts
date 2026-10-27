import type { Gql } from "./types";
import { ImportError } from "./types";
import { paginate } from "./gql";

/** Shared, cached lookups used by several entities during one job. */

async function cached<T>(cache: Map<string, unknown>, key: string, load: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key) as Promise<T>;
}

export interface LocationInfo {
  id: string;
  name: string;
  isActive: boolean;
}

const LOCATIONS = `#graphql
  query Locations($after: String) {
    locations(first: 250, after: $after, includeInactive: true) {
      nodes { id name isActive }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export function getLocations(gql: Gql, cache: Map<string, unknown>): Promise<LocationInfo[]> {
  return cached(cache, "locations", async () => {
    const out: LocationInfo[] = [];
    for await (const l of paginate<LocationInfo>(gql, LOCATIONS, {}, (d) => d.locations)) out.push(l);
    return out;
  });
}

export async function locationByName(gql: Gql, cache: Map<string, unknown>, name: string): Promise<LocationInfo> {
  const locations = await getLocations(gql, cache);
  const loc =
    locations.find((l) => l.name === name) ?? locations.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
  if (!loc) throw new ImportError(`Location "${name}" not found`);
  return loc;
}

const PUBLICATIONS = `#graphql
  query Publications {
    publications(first: 100) {
      nodes { id name catalog { title } }
    }
  }
`;

/** ID of the Online Store sales channel publication, or null if not installed. */
export function onlineStorePublicationId(gql: Gql, cache: Map<string, unknown>): Promise<string | null> {
  return cached(cache, "onlineStorePublication", async () => {
    const data = await gql(PUBLICATIONS);
    const pubs: any[] = data.publications.nodes;
    const p = pubs.find((x) => (x.catalog?.title ?? x.name) === "Online Store") ?? pubs.find((x) => x.name === "Online Store");
    return p?.id ?? null;
  });
}

const PUBLISH = `#graphql
  mutation Publish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { field message } }
  }
`;

const UNPUBLISH = `#graphql
  mutation Unpublish($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) { userErrors { field message } }
  }
`;

/** Publishes or unpublishes a resource on the Online Store. */
export async function setOnlineStorePublished(
  gql: Gql,
  cache: Map<string, unknown>,
  id: string,
  published: boolean,
  publishDate?: string,
) {
  const pub = await onlineStorePublicationId(gql, cache);
  if (!pub) throw new ImportError("Online Store sales channel not found; cannot change Published");
  const input = [{ publicationId: pub, ...(publishDate ? { publishDate } : {}) }];
  const data = await gql(published ? PUBLISH : UNPUBLISH, { id, input });
  const payload = published ? data.publishablePublish : data.publishableUnpublish;
  if (payload.userErrors?.length) {
    throw new ImportError(`Publishing: ${payload.userErrors.map((e: any) => e.message).join("; ")}`);
  }
}

const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

const METAFIELDS_DELETE = `#graphql
  mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

/** Upserts metafields on any owner (25 per call) and deletes blank ones. */
export async function writeMetafields(
  gql: Gql,
  ownerId: string,
  set: Array<{ namespace: string; key: string; type: string; value: string }>,
  del: Array<{ namespace: string; key: string }> = [],
) {
  for (let i = 0; i < set.length; i += 25) {
    const batch = set.slice(i, i + 25).map((m) => ({ ...m, ownerId }));
    const data = await gql(METAFIELDS_SET, { metafields: batch });
    const errs = data.metafieldsSet.userErrors;
    if (errs?.length) throw new ImportError(`Metafields: ${errs.map((e: any) => e.message).join("; ")}`);
  }
  if (del.length) {
    const data = await gql(METAFIELDS_DELETE, {
      metafields: del.map((m) => ({ ownerId, namespace: m.namespace, key: m.key })),
    });
    const errs = data.metafieldsDelete.userErrors;
    if (errs?.length) throw new ImportError(`Metafields: ${errs.map((e: any) => e.message).join("; ")}`);
  }
}

const TAGS_ADD = `#graphql
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

const TAGS_REMOVE = `#graphql
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

export async function addTags(gql: Gql, id: string, tags: string[]) {
  if (!tags.length) return;
  const d = await gql(TAGS_ADD, { id, tags });
  if (d.tagsAdd.userErrors?.length) throw new ImportError(`Tags: ${d.tagsAdd.userErrors[0].message}`);
}

export async function removeTags(gql: Gql, id: string, tags: string[]) {
  if (!tags.length) return;
  const d = await gql(TAGS_REMOVE, { id, tags });
  if (d.tagsRemove.userErrors?.length) throw new ImportError(`Tags: ${d.tagsRemove.userErrors[0].message}`);
}
