import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { purgeShop } from "../lib/jobs/jobs.server";

/**
 * Mandatory privacy webhooks. Job files can contain customer data, so a shop
 * redact request removes every job and file for the shop. Customer-level
 * requests are covered by the file retention period (FILE_RETENTION_DAYS).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  if (topic === "SHOP_REDACT") await purgeShop(shop);
  return new Response();
};
