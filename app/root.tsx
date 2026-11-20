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
.bp-diff-gone{color:#8e1f0b}
.bp-stepper{display:flex;background:#fff;border:1px solid #e3e3e3;border-radius:12px;overflow:hidden;margin-bottom:4px}
.bp-stp{flex:1;display:flex;align-items:center;gap:8px;padding:12px 16px;color:#616161;font-size:13px;border-bottom:2px solid transparent}
.bp-stp-on{color:#202223;font-weight:600;border-bottom-color:#202223;background:#fafafa}
.bp-stp-n{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#e3e3e3;font-size:12px;font-weight:600;flex:none}
.bp-stp-on .bp-stp-n{background:#202223;color:#fff}
.bp-stp-done .bp-stp-n{background:#047b5d;color:#fff}
.bp-bar{display:flex;height:40px;border-radius:8px;overflow:hidden;gap:2px}
.bp-bar-seg{border:0;cursor:pointer;color:#fff;font-weight:600;font-size:13px;min-width:34px;padding:0 8px;flex-basis:0}
.bp-bar-seg.bp-bar-on{box-shadow:inset 0 0 0 3px rgba(0,0,0,.35)}
.bp-kind-none{background:#e9e9e9;color:#4a4a4a}
.bp-kind-update{background:var(--bp-brand)}
.bp-kind-look{background:#e8833a}
.bp-kind-create{background:#e6b422;color:#3d2c00}
.bp-kind-delete{background:#8e1f0b}
.bp-kind-failed{background:#c5280c}
.bp-legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:#4a4a4a}
.bp-dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px}
.bp-tabs{display:flex;gap:2px;border:1px solid #d4d4d4;border-radius:8px;padding:2px;overflow-x:auto;max-width:100%}
.bp-tab{border:0;background:none;padding:5px 12px;border-radius:6px;font-size:13px;cursor:pointer;white-space:nowrap;color:#303030}
.bp-tab-on{background:#202223;color:#fff}
.bp-rows{border-top:1px solid #ebebeb}
.bp-row{display:grid;grid-template-columns:52px minmax(160px,1.1fr) minmax(220px,2fr) auto;gap:12px;align-items:start;padding:12px 16px 12px 12px;border-bottom:1px solid #ebebeb;border-left:4px solid transparent}
.bp-row-n{color:#616161;font-variant-numeric:tabular-nums;padding-top:1px}
.bp-row-item,.bp-row-what{display:flex;flex-direction:column;gap:2px;min-width:0;overflow-wrap:anywhere}
.bp-row-do{justify-self:end}
.bp-edit{grid-column:1/-1;display:flex;flex-direction:column;gap:10px;margin:4px 0 2px;padding:14px;border:1px solid #d4d4d4;border-radius:10px;background:#fafafa}
.bp-edit-row{display:flex;flex-direction:column;gap:6px}
.bp-edit-row+.bp-edit-row{border-top:1px dashed #d4d4d4;padding-top:10px}
.bp-edit-n{font-size:12px;font-weight:600;color:#616161}
.bp-edit-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.bp-edit-cell{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:12px;color:#616161}
.bp-edit-cell span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-edit-cell input,.bp-edit-cell textarea{font:inherit;font-size:13px;color:#202223;padding:7px 9px;border:1px solid #8a8a8a;border-radius:8px;background:#fff;min-width:0;width:100%;box-sizing:border-box}
.bp-edit-cell textarea{resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.bp-edit-cell input:focus,.bp-edit-cell textarea:focus{outline:2px solid var(--bp-brand);outline-offset:1px}
.bp-edit-wide{grid-column:1/-1}
.bp-edit-flag input,.bp-edit-flag textarea{border-color:#c5280c;background:#fff6f5}
.bp-edit-flag span{color:#8e1f0b;font-weight:600}
.bp-edit-changed input,.bp-edit-changed textarea{border-color:var(--bp-brand);background:#f3f8ff}
.bp-edit-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.bp-row-update{border-left-color:var(--bp-brand)}
.bp-row-look{border-left-color:#e8833a}
.bp-row-create{border-left-color:#e6b422}
.bp-row-delete{border-left-color:#8e1f0b}
.bp-row-failed{border-left-color:#c5280c}
.bp-row-none{opacity:.62}
.bp-row-update.bp-row-off .bp-row-what,.bp-row-update.bp-row-off .bp-row-item{opacity:.5}
.bp-choice{display:inline-flex;border:1px solid #c9c9c9;border-radius:8px;overflow:hidden}
.bp-choice button{border:0;background:#fff;padding:6px 12px;font-size:13px;cursor:pointer;color:#303030}
.bp-choice .bp-choice-on{background:#202223;color:#fff;font-weight:600}
.bp-sum{border:1px solid #e3e3e3;border-radius:10px}
.bp-sum>div{display:grid;grid-template-columns:48px auto 1fr;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid #ebebeb;font-size:13px}
.bp-sum>div:last-child{border-bottom:0}
.bp-sum b{text-align:right;font-size:15px}
.bp-sum span{color:#4a4a4a;min-width:0;overflow-wrap:anywhere}
@media (max-width:640px){.bp-row{grid-template-columns:36px 1fr;}.bp-row-what,.bp-row-do{grid-column:2}.bp-row-do{justify-self:start}.bp-stp{padding:10px 8px;font-size:12px}.bp-stp:not(.bp-stp-on){flex:0 0 auto}.bp-stp:not(.bp-stp-on) {font-size:0;gap:0}}
.bp-strip{display:flex;flex-wrap:wrap;gap:6px 22px;background:#fff;border:1px solid #e3e3e3;border-radius:12px;padding:10px 16px;font-size:13px}
.bp-strip-item{color:#303030;text-decoration:none;white-space:nowrap}
.bp-strip-item:hover{text-decoration:underline}
.bp-dot.bp-ok{background:#047b5d}.bp-dot.bp-warn{background:#e6a100}.bp-dot.bp-bad{background:#c5280c}.bp-dot.bp-idle{background:#b5b5b5}
.bp-strip .bp-dot{border-radius:50%}
.bp-home{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;align-items:start}
.bp-home-import{display:flex;flex-direction:column;gap:16px;min-width:0}
.bp-tasks{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.bp-task{display:flex;flex-direction:column;gap:4px;text-align:left;padding:12px 14px;border:1px solid #c9c9c9;border-radius:10px;background:#fff;cursor:pointer;font:inherit;font-size:13px;color:#303030}
.bp-task span{color:#616161;font-size:12px;line-height:1.35}
.bp-task:hover{border-color:#8a8a8a}
.bp-task-on{border-color:var(--bp-brand);box-shadow:0 0 0 1px var(--bp-brand);background:#f6f9ff}
.bp-task:focus-visible{outline:2px solid var(--bp-brand);outline-offset:2px}
.bp-quick{display:flex;flex-direction:column}
.bp-quick-row{display:flex;align-items:center;gap:8px;padding:10px 0;border-top:1px solid #ebebeb}
.bp-quick-text{display:flex;flex-direction:column;flex:1;min-width:0}
@media (max-width:860px){.bp-home{grid-template-columns:1fr}}
@media (max-width:640px){.bp-column{padding-bottom:72px}.bp-quick-more{display:none}.bp-quick-text s-text[tone="neutral"]{display:none}.bp-actionbar{bottom:68px}}
.bp-job-end s-link{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block}
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
