import type { LoaderFunctionArgs } from "react-router";
import { OAuthError, startAuthorization } from "../lib/api/oauth.server";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Bulkport</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:10vh auto;padding:0 20px;color:#202223">${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } },
  );

/**
 * The consent page of the assistant sign-in. It shows a code; the merchant
 * approves that code in the app (Settings), and this page then sends the
 * browser back to the assistant.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const r = await startAuthorization(new URL(request.url).searchParams);
    return html(`
<h1 style="font-size:22px">Connect ${esc(r.clientName)} to Bulkport</h1>
<p>To let it export your store's data and prepare import previews (it can never change the store by itself), approve this code in your Shopify admin:</p>
<p style="font:600 34px/1 ui-monospace,monospace;letter-spacing:3px;background:#f1f1f1;border-radius:12px;padding:22px;text-align:center">${esc(r.userCode)}</p>
<ol><li>Open your Shopify admin and the <b>Bulkport</b> app.</li><li>Go to <b>Settings</b>, find <b>Approve a connection</b>.</li><li>Type the code and press Approve.</li></ol>
<p id="s" style="color:#616161">Waiting for your approval… this page continues by itself. The code works for ${r.minutes} minutes.</p>
<script>
(function poll(){fetch("/oauth/status?id=${esc(r.id)}").then(function(x){return x.json()}).then(function(d){
if(d.status==="approved"){document.getElementById("s").textContent="Approved. Taking you back…";location.replace(d.redirect)}
else if(d.status==="expired"){document.getElementById("s").textContent="This code has expired. Start the connection again from the assistant."}
else setTimeout(poll,2000)}).catch(function(){setTimeout(poll,4000)})})();
</script>`);
  } catch (e) {
    const message = e instanceof OAuthError ? e.message : "Something went wrong.";
    return html(`<h1 style="font-size:22px;color:#8e1f0b">This connection can't be started</h1><p>${esc(message)}</p>`, 400);
  }
};
