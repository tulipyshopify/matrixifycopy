import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createGql } from "../lib/core/gql";
import { getLocations } from "../lib/core/lookups";

/** Active inventory locations, for choosing which stock columns to export. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const gql = createGql(async (query, variables) => (await admin.graphql(query, { variables })).json(), () => {}, 2);
  const locations = await getLocations(gql, new Map());
  return { locations: locations.filter((l) => l.isActive).map((l) => l.name) };
};
