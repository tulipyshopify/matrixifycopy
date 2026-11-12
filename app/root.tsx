import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        {/* Centred content column with wide side margins that shrink on small screens. */}
        <style>{`.bp-column{max-width:920px;margin-inline:auto;padding-inline:clamp(0px,4vw,48px);display:flex;flex-direction:column;gap:16px}
.bp-chips{display:flex;flex-wrap:wrap;gap:6px}
.bp-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 6px;border-radius:8px;background:#f1f1f1;font-size:13px;line-height:20px;cursor:grab;user-select:none;border:1px solid transparent}
.bp-chip:focus-visible{outline:2px solid #005bd3;outline-offset:1px}
.bp-chip-dragging{opacity:.4}
.bp-chip-over{border-color:#303030;background:#e3e3e3}
.bp-grip{color:#8a8a8a;font-size:12px}`}</style>
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
