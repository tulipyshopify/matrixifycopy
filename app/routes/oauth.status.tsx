import type { LoaderFunctionArgs } from "react-router";
import { authorizationStatus } from "../lib/api/oauth.server";

/** Polled by the consent page while it waits for the merchant's approval. */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  new Response(JSON.stringify(await authorizationStatus(new URL(request.url).searchParams.get("id") ?? "")), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
