import type { ActionFunctionArgs } from "react-router";
import { CORS, oauthFail, oauthJson, registerClient } from "../lib/api/oauth.server";

export const loader = () => new Response(null, { status: 405, headers: CORS });
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    return oauthJson(await registerClient(await request.json().catch(() => ({}))), 201);
  } catch (e) {
    return oauthFail(e);
  }
};
