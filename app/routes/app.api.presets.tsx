import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deletePreset, listPresets, savePreset } from "../lib/jobs/jobs.server";

/** Save or delete an export preset; returns the updated list. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const body = (await request.json()) as { intent: string; id?: string; name?: string; data?: unknown };
  try {
    let savedId: string | undefined;
    if (body.intent === "save") savedId = (await savePreset(session.shop, body.name ?? "", body.data)).id;
    if (body.intent === "delete" && body.id) await deletePreset(session.shop, body.id);
    return { presets: await listPresets(session.shop), savedId };
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};
