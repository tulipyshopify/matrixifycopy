import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const OWNERS = new Set(["PRODUCT", "PRODUCTVARIANT", "COLLECTION", "CUSTOMER", "COMPANY", "ORDER", "DRAFTORDER", "PAGE", "ARTICLE", "SHOP"]);

const DEFINITIONS = `#graphql
  query ExportMetafieldDefinitions($ownerType: MetafieldOwnerType!, $after: String) {
    metafieldDefinitions(ownerType: $ownerType, first: 250, after: $after) {
      nodes { namespace key name type { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** The store's metafield definitions for one kind of item, to pick export columns from. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const owner = new URL(request.url).searchParams.get("owner") ?? "";
  if (!OWNERS.has(owner)) return { definitions: [] };
  const definitions: Array<{ key: string; name: string; type: string }> = [];
  let after: string | null = null;
  try {
    do {
      const res: any = await (await admin.graphql(DEFINITIONS, { variables: { ownerType: owner, after } })).json();
      const page = res?.data?.metafieldDefinitions;
      for (const d of page?.nodes ?? []) definitions.push({ key: `${d.namespace}.${d.key}`, name: d.name ?? "", type: d.type?.name ?? "" });
      after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after && definitions.length < 1000);
  } catch {
    // No access to this kind of definition: the form falls back to typing the names.
  }
  return { definitions: definitions.sort((a, b) => a.key.localeCompare(b.key)) };
};
