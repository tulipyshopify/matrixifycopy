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
  // Access from outside ends with the app: keys, assistant connections and the Drive link.
  await db.apiKey.updateMany({ where: { shop, revokedAt: null }, data: { revokedAt: new Date() } });
  await db.oAuthGrant.deleteMany({ where: { shop } });
  await db.shopSetting.updateMany({ where: { shop }, data: { driveToken: null, driveFolder: null, alertWebhook: null } });

  return new Response();
};
