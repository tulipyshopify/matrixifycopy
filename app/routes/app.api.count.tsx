import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createGql } from "../lib/core/gql";
import { shopTimezone } from "../lib/core/lookups";
import { parseExportConfig } from "../lib/jobs/jobs.server";
import { countItems } from "../lib/jobs/counts.server";

/** Live item total for one export panel, using its current filters. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const body = (await request.json()) as { entity: string; options: unknown };
  try {
    const { entities } = parseExportConfig({ entities: [{ entity: body.entity, options: body.options }] });
    const gql = createGql(async (query, variables) => (await admin.graphql(query, { variables })).json(), () => {}, 2);
    const options = { ...entities[0].options, timezone: await shopTimezone(gql) };
    return { result: await countItems(gql, entities[0].entity, options) };
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};
