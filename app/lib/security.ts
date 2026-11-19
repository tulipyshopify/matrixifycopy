/**
 * Headers every response of the app carries: HTTPS only, no guessing of file
 * types, and (where Shopify's own policy isn't already set) framing only by
 * the Shopify admin.
 */
export function addSecurityHeaders(headers: Headers, opts: { frame?: boolean } = {}): Headers {
  if (!headers.has("Strict-Transport-Security")) headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (!headers.has("X-Content-Type-Options")) headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (opts.frame !== false && !headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", "frame-ancestors https://admin.shopify.com https://*.myshopify.com;");
  }
  return headers;
}
