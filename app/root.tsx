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
        <style>{`:root{--bp-brand:#1D4ED8;--bp-brand-dark:#1E3A8A;--bp-brand-soft:#E8EFFD;--bp-accent:#FACC15}
.bp-column{max-width:920px;margin-inline:auto;padding-inline:clamp(0px,4vw,48px);display:flex;flex-direction:column;gap:16px}
.bp-chips{display:flex;flex-wrap:wrap;gap:6px}
.bp-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 6px;border-radius:8px;background:#f1f1f1;font-size:13px;line-height:20px;cursor:grab;user-select:none;border:1px solid transparent}
.bp-chip:focus-visible{outline:2px solid #005bd3;outline-offset:1px}
.bp-chip-x{all:unset;cursor:pointer;color:#616161;font-size:15px;line-height:16px;width:16px;height:16px;text-align:center;border-radius:4px}
.bp-chip-x:hover{background:#d4d4d4;color:#303030}
.bp-chip-static{cursor:default;padding-left:10px}
.bp-chip-dragging{opacity:.4}
.bp-chip-over{background:#e3e3e3;box-shadow:-4px 0 0 #005bd3}
.bp-chip-picked{background:#eaf4ff;border-color:#005bd3}
.bp-chip-n{color:#8a8a8a;font-size:11px;min-width:14px;text-align:right;font-variant-numeric:tabular-nums}
.bp-chip-endmark{width:4px;align-self:stretch;min-height:28px;background:#005bd3;border-radius:2px}
.bp-chips{min-height:36px;padding-bottom:10px}
.bp-movebar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;background:#f6f6f7;position:sticky;top:0;z-index:2}
.bp-movepos{width:84px}
.bp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:12px}
.bp-tile{display:flex;flex-direction:column;gap:2px;padding:14px 16px;border-radius:12px;background:#fff;box-shadow:0 0 0 1px #e3e3e3,0 1px 2px rgba(0,0,0,.05);min-height:86px}
.bp-tile-label{font-size:12px;color:#616161}
.bp-tile-value{font-size:24px;line-height:30px;font-weight:650;color:#303030;font-variant-numeric:tabular-nums}
.bp-tile-note{font-size:12px;color:#616161}
.bp-tile-critical .bp-tile-value{color:#8e0b21}
.bp-tile-critical{box-shadow:0 0 0 1px #f4b6bd,0 1px 2px rgba(0,0,0,.05);background:#fff6f6}
.bp-tile-ok .bp-tile-value{color:#0c5132}
.bp-tile-warn .bp-tile-note{color:#8a6116}
.bp-templates{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.bp-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
.bp-step{display:flex;gap:12px;align-items:flex-start}
.bp-step-n{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--bp-brand);color:#fff;font-weight:650;font-size:13px}
.bp-diff-label{color:#616161}
.bp-diff-old{color:#8a6116;text-decoration:line-through;text-decoration-color:rgba(138,97,22,.45)}
.bp-diff-new{font-weight:600}
.bp-code{display:flex;gap:8px;align-items:flex-start;background:#f6f6f7;border:1px solid #e3e3e3;border-radius:8px;padding:8px 10px;margin:6px 0}
.bp-code pre{margin:0;flex:1;min-width:0;overflow-x:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
.bp-rule{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;padding-top:12px;border-top:1px solid #ebebeb}
.bp-rule-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.bp-rule-side{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex:none}
.bp-tile-warn .bp-tile-value{color:#8a6116}
.bp-ask{border-radius:14px;padding:2px;background:linear-gradient(120deg,var(--bp-brand-dark),var(--bp-brand) 55%,var(--bp-accent))}
.bp-ask-head{display:flex;align-items:center;gap:8px;color:var(--bp-brand-dark);font-weight:650}
.bp-ask-mark{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:var(--bp-brand-soft);color:var(--bp-brand)}
.bp-tile-brand{box-shadow:0 0 0 1px #c3d3f8,0 1px 2px rgba(0,0,0,.05);background:linear-gradient(180deg,var(--bp-brand-soft),#fff 70%)}
.bp-tile-brand .bp-tile-value{color:var(--bp-brand)}
.bp-tile-brand .bp-tile-label{color:var(--bp-brand-dark)}
.bp-actionbar{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;margin-top:4px;border-radius:12px;background:#fff;box-shadow:0 -1px 0 #e3e3e3,0 4px 18px rgba(0,0,0,.12)}
.bp-actionbar s-text{min-width:0}
@media (max-width:600px){.bp-actionbar{flex-direction:column;align-items:stretch}}
.bp-grip{color:#8a8a8a;font-size:12px}
.bp-job{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;padding:14px 16px;border-top:1px solid #ebebeb}
.bp-job:first-child{border-top:0}
.bp-job-main,.bp-job-side{display:flex;flex-direction:column;gap:6px;min-width:0}
.bp-job-side{align-items:flex-end;flex-shrink:0;max-width:45%}
.bp-job-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.bp-job-end{justify-content:flex-end}
.bp-job-meta{color:#616161;font-size:13px;gap:14px}
.bp-kind{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;font-size:13px;font-weight:650}
.bp-kind-export{background:#e0f0ff;color:#00527c}
.bp-kind-import{background:#e3f5e1;color:#0c5132}
.bp-url-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}
@media (max-width:600px){.bp-job{flex-direction:column}.bp-job-side{align-items:flex-start;max-width:none}.bp-job-end{justify-content:flex-start}.bp-url-row{grid-template-columns:1fr}}`}</style>
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
