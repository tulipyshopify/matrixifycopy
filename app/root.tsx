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
.bp-hist{grid-template-columns:minmax(160px,1fr) minmax(220px,2fr) auto}
@media (max-width:640px){.bp-hist{grid-template-columns:1fr}.bp-hist .bp-row-what,.bp-hist .bp-row-do{grid-column:1}}
.bp-share{max-width:900px;margin:0 auto;padding:24px 16px 64px;font:14px/1.5 Inter,system-ui,sans-serif;color:#202223}
.bp-share h1{font-size:22px;margin:4px 0 8px}
.bp-share h2{font-size:16px;margin:24px 0 8px}
.bp-share header small{color:#616161}
.bp-share section{background:#fff;border:1px solid #e3e3e3;border-radius:12px;margin-top:16px;overflow:hidden}
.bp-share section>h2,.bp-share section>p{padding:0 16px}
.bp-share-totals{display:flex;flex-wrap:wrap;gap:8px 20px;list-style:none;padding:0;margin:12px 0 0}
.bp-share-totals b{font-size:18px}
.bp-share-bad{color:#8e1f0b}
.bp-share-warn{color:#8a6116}
.bp-share-ok{color:#0c5132;font-weight:600}
.bp-share-tag{display:inline-block;padding:2px 8px;border-radius:8px;font-size:12px;background:#e0f0ff;color:#00527c;white-space:nowrap}
.bp-share-create{background:#fff1b8;color:#5e4200}
.bp-share-delete,.bp-share-replace,.bp-share-failed{background:#fedad9;color:#8e1f0b}
.bp-share-answer{padding:0 16px 16px}
.bp-share-answer h2{padding:0!important}
.bp-share-answer form{display:flex;flex-direction:column;gap:12px;max-width:520px}
.bp-share-answer label{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:13px}
.bp-share-answer input,.bp-share-answer textarea{font:inherit;padding:8px 10px;border:1px solid #8a8a8a;border-radius:8px}
.bp-share-buttons{display:flex;gap:8px;flex-wrap:wrap}
.bp-share-buttons button{font:inherit;font-weight:600;padding:9px 14px;border-radius:8px;border:1px solid #8a8a8a;background:#fff;cursor:pointer}
.bp-share-buttons .bp-share-yes{background:#202223;color:#fff;border-color:#202223}
.bp-share-buttons button:disabled{opacity:.6}
.bp-grid-wrap{overflow:auto;max-height:68vh;border-top:1px solid #e3e3e3}
.bp-grid{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}
.bp-grid th,.bp-grid td{border-bottom:1px solid #ebebeb;border-right:1px solid #f1f1f1;padding:0;text-align:left;vertical-align:middle;height:34px}
.bp-grid thead th{position:sticky;top:0;z-index:2;background:#f7f7f7;font-weight:600;font-size:12px;color:#4a4a4a;padding:8px 10px;white-space:nowrap}
.bp-grid thead th.bp-grid-colon{background:var(--bp-brand-soft);color:var(--bp-brand-dark)}
.bp-grid .bp-grid-name{position:sticky;left:0;z-index:1;background:#fff;min-width:220px;max-width:320px;padding:5px 10px;font-weight:400;box-shadow:1px 0 0 #e3e3e3}
.bp-grid thead .bp-grid-name{z-index:3;background:#f7f7f7}
.bp-grid-name b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bp-grid-name span{display:block;color:#616161;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bp-grid tr.bp-grid-top>*{border-top:1px solid #d4d4d4}
.bp-grid td{min-width:110px;max-width:280px;cursor:cell}
.bp-grid td>span{display:block;padding:7px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:20px}
.bp-grid td:hover{background:#f6f9ff}
.bp-grid td.bp-grid-na{background:repeating-linear-gradient(135deg,#fafafa,#fafafa 6px,#f3f3f3 6px,#f3f3f3 12px);cursor:default}
.bp-grid td.bp-grid-changed{background:#fff8db;font-weight:600}
.bp-grid td.bp-grid-on{outline:2px solid var(--bp-brand);outline-offset:-2px;background:#fff}
.bp-grid td input{width:100%;box-sizing:border-box;border:0;outline:0;background:transparent;font:inherit;font-weight:inherit;padding:7px 10px;color:#202223}
.bp-grid-fill{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px}
.bp-grid-fill label{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bp-grid-fill input{font:inherit;padding:6px 9px;border:1px solid #8a8a8a;border-radius:8px;min-width:180px}
.bp-hero{border-radius:16px;padding:22px 22px 18px;color:#fff;background:radial-gradient(120% 140% at 0% 0%,#2f62e8 0%,var(--bp-brand) 38%,var(--bp-brand-dark) 100%);box-shadow:0 1px 2px rgba(16,24,64,.12),0 8px 24px -12px rgba(29,78,216,.55);display:flex;flex-direction:column;gap:16px}
.bp-hero h1{margin:0;font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.01em}
.bp-hero p{margin:4px 0 0;font-size:14px;color:rgba(255,255,255,.82)}
.bp-acts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.bp-act{display:flex;align-items:center;gap:10px;padding:12px;border-radius:12px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);color:#fff;text-decoration:none;transition:background .15s,transform .15s,box-shadow .15s;min-width:0}
.bp-act:hover{background:rgba(255,255,255,.18);transform:translateY(-1px)}
.bp-act:focus-visible{outline:2px solid var(--bp-accent);outline-offset:2px}
.bp-act-primary{background:#fff;color:#16213e;border-color:#fff;box-shadow:0 6px 16px -8px rgba(0,0,0,.45)}
.bp-act-primary:hover{background:#fff}
.bp-act-icon{flex:0 0 36px;height:36px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.16)}
.bp-act-primary .bp-act-icon{background:var(--bp-brand-soft);color:var(--bp-brand)}
.bp-act-text{display:flex;flex-direction:column;min-width:0;flex:1;font-size:12px;line-height:1.35;color:rgba(255,255,255,.8)}
.bp-act-text b{font-size:14px;color:#fff;font-weight:650}
.bp-act-primary .bp-act-text{color:#5c6270}.bp-act-primary .bp-act-text b{color:#16213e}
.bp-act-go{opacity:.55;display:inline-flex;transition:transform .15s,opacity .15s}
.bp-act:hover .bp-act-go{opacity:1;transform:translateX(2px)}
@media (max-width:980px){.bp-acts{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:520px){.bp-acts{grid-template-columns:1fr}.bp-hero{padding:18px 16px}.bp-hero h1{font-size:19px}}
.bp-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.bp-stat{display:flex;gap:12px;align-items:flex-start;padding:14px;border-radius:12px;background:#fff;text-decoration:none;color:#202223;box-shadow:0 0 0 1px #e3e3e3,0 1px 2px rgba(0,0,0,.04);transition:box-shadow .15s,transform .15s}
.bp-stat:hover{box-shadow:0 0 0 1px #c9c9c9,0 6px 16px -10px rgba(0,0,0,.3);transform:translateY(-1px)}
.bp-stat:focus-visible{outline:2px solid var(--bp-brand);outline-offset:2px}
.bp-stat-icon{flex:0 0 34px;height:34px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;background:#f1f1f1;color:#616161}
.bp-stat-ok .bp-stat-icon{background:#e3f4ec;color:#0c6b47}.bp-stat-warn .bp-stat-icon{background:#fff3d1;color:#8a6116}.bp-stat-bad .bp-stat-icon{background:#fde3e0;color:#b3261e}
.bp-stat-body{display:flex;flex-direction:column;min-width:0}
.bp-stat-label{font-size:12px;color:#616161}
.bp-stat-value{font-size:17px;line-height:1.3;font-weight:650;font-variant-numeric:tabular-nums}
.bp-stat-bad .bp-stat-value{color:#b3261e}
.bp-stat-note{font-size:12px;color:#616161;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-start{background:#fff;border-radius:12px;padding:16px;box-shadow:0 0 0 1px #c3d3f8,0 1px 2px rgba(0,0,0,.04);font-size:13px}
.bp-start>b{font-size:14px}
.bp-start ol{list-style:none;margin:12px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.bp-start li{display:flex;gap:10px;align-items:flex-start;color:#4a4a4a;line-height:1.4}
.bp-start li>span{flex:0 0 24px;height:24px;border-radius:50%;background:var(--bp-brand);color:#fff;font-weight:650;font-size:12px;display:inline-flex;align-items:center;justify-content:center}
.bp-start li b{display:block;color:#202223}
s-page>.bp-seg{margin-bottom:12px}
s-page>.bp-done{margin-bottom:16px}
.bp-hints{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12.5px;line-height:1.45;color:#616161}
.bp-hints li{padding-left:14px;position:relative}
.bp-hints li:before{content:"";position:absolute;left:0;top:.6em;width:5px;height:5px;border-radius:50%;background:#b5b5b5}
.bp-hints b{color:#303030;font-weight:600}
.bp-seg{display:inline-flex;padding:3px;border-radius:10px;background:#ebebeb;gap:2px;align-self:flex-start}
.bp-seg a{padding:6px 14px;border-radius:8px;font-size:13px;font-weight:550;color:#4a4a4a;text-decoration:none;transition:background .12s}
.bp-seg a:hover{background:rgba(255,255,255,.6)}
.bp-seg a.bp-seg-on{background:#fff;color:#202223;box-shadow:0 1px 2px rgba(0,0,0,.14)}
.bp-seg a:focus-visible{outline:2px solid var(--bp-brand);outline-offset:1px}
.bp-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:28px 20px 32px;color:#616161;font-size:13px;line-height:1.45}
.bp-empty b{color:#202223;font-size:14px}
.bp-empty>div{max-width:46ch}
.bp-empty-icon{width:52px;height:52px;border-radius:16px;display:inline-flex;align-items:center;justify-content:center;background:var(--bp-brand-soft);color:var(--bp-brand);margin-bottom:4px}
.bp-done{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:18px;border-radius:14px;background:linear-gradient(180deg,#eefaf3,#fff 75%);box-shadow:0 0 0 1px #b7e2cb,0 1px 2px rgba(0,0,0,.04)}
.bp-done-warn{background:linear-gradient(180deg,#fff7e0,#fff 75%);box-shadow:0 0 0 1px #f0d48a,0 1px 2px rgba(0,0,0,.04)}
.bp-done-icon{flex:0 0 46px;height:46px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:#0c6b47;color:#fff}
.bp-done-warn .bp-done-icon{background:#b87503}
.bp-done-text{flex:1;min-width:220px;display:flex;flex-direction:column;gap:2px;font-size:13px;color:#4a4a4a}
.bp-done-text b{font-size:17px;color:#202223}
.bp-done-nums{display:flex;gap:18px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
.bp-done-nums span b{font-size:20px;display:block;line-height:1.15}
.bp-done-nums span{font-size:12px;color:#616161}
.bp-done-actions{display:flex;gap:8px;flex-wrap:wrap}
@media (prefers-reduced-motion:reduce){.bp-act,.bp-stat,.bp-act-go{transition:none}.bp-act:hover,.bp-stat:hover{transform:none}}
.bp-match{border-top:1px solid #ebebeb;font-size:13px}
.bp-match-head,.bp-match-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(140px,1.4fr) minmax(170px,1.1fr);gap:12px;align-items:center;padding:8px 16px;border-bottom:1px solid #ebebeb}
.bp-match-head{font-size:12px;font-weight:600;color:#616161;background:#fafafa}
.bp-match-row b{overflow-wrap:anywhere}
.bp-match-sample{color:#616161;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-match-off b{color:#8a8a8a;font-weight:500}
.bp-match-row select{width:100%;font:inherit;padding:6px 8px;border:1px solid #8a8a8a;border-radius:8px;background:#fff;color:#202223}
.bp-match-off select{color:#8a8a8a;border-color:#c9c9c9}
.bp-match-row select.bp-match-bad{border-color:#c5280c;background:#fff6f5}
.bp-match-row small{color:#8e1f0b}
@media (max-width:640px){.bp-match-head{display:none}.bp-match-row{grid-template-columns:1fr 1fr}.bp-match-sample{grid-column:1/-1;order:3}}
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
