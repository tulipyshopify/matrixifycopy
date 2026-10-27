import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
  // Stop schedules and queued work; files are removed on shop/redact.
  await db.schedule.updateMany({ where: { shop }, data: { enabled: false } });
  await db.job.updateMany({ where: { shop, status: "queued" }, data: { status: "cancelled" } });

  return new Response();
};
