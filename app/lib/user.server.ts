/**
 * The staff member making a request to an embedded page, from Shopify's
 * session token; "" when it can't be told (then per-person things fall back
 * to the store-wide ones).
 */
export function userOf(auth: unknown): string {
  const sub = (auth as { sessionToken?: { sub?: unknown } } | null)?.sessionToken?.sub;
  return typeof sub === "string" || typeof sub === "number" ? String(sub) : "";
}
