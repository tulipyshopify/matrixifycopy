import type { ActionFunctionArgs } from "react-router";
import { CORS, exchangeToken, oauthFail, oauthJson } from "../lib/api/oauth.server";

export const loader = () => new Response(null, { status: 405, headers: CORS });
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const type = request.headers.get("content-type") ?? "";
    const form = type.includes("json") ? new URLSearchParams(Object.entries((await request.json()) as Record<string, string>)) : new URLSearchParams(await request.text());
    return oauthJson(await exchangeToken(form));
  } catch (e) {
    return oauthFail(e);
  }
};
