#!/usr/bin/env node
// Bulkport command line. Needs Node 18 or newer; no packages to install.
//
//   node bulkport.mjs login https://your-app-address bp_yourkey
//   node bulkport.mjs export Products --columns "ID,Title,Tags" -o products.csv
//   node bulkport.mjs import products.csv            (preview: changes nothing)
//   node bulkport.mjs import products.csv --apply    (runs for real)
//
// Run "node bulkport.mjs help" for everything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG = path.join(os.homedir(), ".bulkport.json");
const HELP = `Bulkport command line

Set up (once):
  bulkport login <app address> <access key>     saved in ${CONFIG}
  (or set BULKPORT_URL and BULKPORT_KEY)

Look around:
  bulkport sheets                 what can be exported and imported
  bulkport sheets <sheet>         columns, groups and filters of one sheet
  bulkport jobs                   recent jobs
  bulkport status <job>           one job

Export:
  bulkport export <sheet> [options]
    --columns "ID,Title,Tags"     columns to include, in order
    --groups variants,metafields  extra column groups
    --filter "vendor is Acme"     repeatable; operators: is, is_not, any_of, contains,
                                  not_contains, starts_with, starts_with_any, gt, gte, lt, lte
    --last 7d                     created in the last 30m / 12h / 7d / 3mo
    --date-field updated_at       date that --last looks at (default created_at)
    --limit 100                   stop after this many items
    --format xlsx                 csv (default) or xlsx
    -o, --out <file>              where to save (default: the file's own name)
    --no-wait                     start it and return the job id

Import:
  bulkport import <file or link> [options]
    Without --apply this is a PREVIEW: it is checked against the store and
    nothing is changed. It prints what each row would do.
    --apply                       run for real (the key must allow imports)
    --command MERGE               for rows without a Command column. The default, UPDATE,
                                  only changes existing items; MERGE also creates new ones
    --batch                       batch mode: sheets of only ID + Metafield columns go to
                                  Shopify as one bulk job (much faster for thousands of rows)
    --threads 8                   items sent at once, 1-8 (default 4)
    --no-wait
  bulkport apply <job>            run a finished preview for real
    --confirm-deletes             needed when the preview deletes anything
    --confirm-warnings            apply rows the preview flagged (warnings, emptied fields) too
    --skip-warnings               apply the rest and leave flagged rows out
  bulkport preview <job>          show a preview again

Other:
  bulkport download <job> [-o file]
  bulkport cancel <job>
  --json                          print raw JSON (any command)

Exit code: 0 = fine, 1 = failed, 2 = finished but some rows had problems.`;

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = { filter: [] };
  const rest = [];
  const takesValue = new Set(["columns", "groups", "filter", "last", "date-field", "limit", "format", "out", "command", "threads"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") flags.out = argv[++i];
    else if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split(/=(.*)/s);
      if (takesValue.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) fail(`--${name} needs a value`);
        if (name === "filter") flags.filter.push(value);
        else flags[name] = value;
      } else flags[name] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function settings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    // not logged in yet
  }
  const url = (process.env.BULKPORT_URL || saved.url || "").replace(/\/+$/, "");
  const key = process.env.BULKPORT_KEY || saved.key || "";
  if (!url || !key) fail('Not set up yet. Run: bulkport login <app address> <access key>');
  return { url, key };
}

async function api(method, p, body) {
  const { url, key } = settings();
  const init = { method, headers: { Authorization: `Bearer ${key}` } };
  if (body instanceof FormData) init.body = body;
  else if (body) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${url}/api/v1/${p}`, init);
  } catch (e) {
    fail(`Can't reach ${url} (${e.cause?.code || e.message})`);
  }
  if (res.headers.get("content-type")?.includes("json")) {
    const data = await res.json();
    if (!res.ok) fail(data.error || `HTTP ${res.status}`);
    return data;
  }
  if (!res.ok) fail(`HTTP ${res.status}`);
  return res;
}

const FILTER_OPS = ["is_not", "is", "any_of", "not_contains", "contains", "starts_with_any", "starts_with", "gte", "gt", "lte", "lt"];
function parseFilter(text) {
  const m = new RegExp(`^\\s*(\\S+)\\s+(${FILTER_OPS.join("|")})\\s+(.+?)\\s*$`).exec(text);
  if (!m) fail(`Can't read filter "${text}". Write it as: field operator value, e.g. "vendor is Acme"`);
  return { field: m[1], op: m[2], value: m[3] };
}

function parseLast(text, field) {
  const m = /^(\d+)\s*(m|min|h|d|mo)$/i.exec(String(text));
  if (!m) fail('--last takes a number and a unit: 30m, 12h, 7d or 3mo');
  const unit = { m: "minutes", min: "minutes", h: "hours", d: "days", mo: "months" }[m[2].toLowerCase()];
  return { field, preset: "last_n", amount: Number(m[1]), unit };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DONE = new Set(["finished", "failed", "cancelled"]);

async function waitFor(job, quiet) {
  let last = "";
  while (!DONE.has(job.status)) {
    const line = job.status === "queued" ? "queued" : `${job.progress.toLocaleString("en")}${job.total ? ` of ${job.total.toLocaleString("en")}` : ""}`;
    if (!quiet && line !== last && process.stderr.isTTY) process.stderr.write(`\r  ${line}          `);
    last = line;
    await sleep(1500);
    job = await api("GET", `jobs/${job.id}`);
  }
  if (!quiet && process.stderr.isTTY) process.stderr.write("\r                              \r");
  return job;
}

function describe(job) {
  const kind = job.preview ? "Import preview" : job.type === "import" ? "Import" : "Export";
  const lines = [`${kind} ${job.id}: ${job.outcome}`];
  for (const s of job.sheets || []) {
    if (job.type === "export") lines.push(`  ${s.entity}: ${s.items} items, ${s.rows} rows`);
    else if (s.entity === null) lines.push(`  ${s.sheet}: not imported${s.message ? ` (${s.message})` : ""}`);
    else lines.push(`  ${s.sheet || s.entity}: ${s.items} items, ${s.ok ?? 0} ok, ${s.failed ?? 0} failed, ${s.skipped ?? 0} skipped`);
  }
  if (job.summary) lines.push(`  ${job.summary}`);
  if (job.error && job.error !== job.summary) lines.push(`  ${job.error}`);
  return lines.join("\n");
}

function exitFor(job) {
  if (job.status !== "finished") process.exit(1);
  if (job.problems > 0) process.exit(2);
}

async function download(job, out) {
  const res = await api("GET", `jobs/${job.id}/result`);
  const name = out || /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || `${job.id}.csv`;
  fs.writeFileSync(name, Buffer.from(await res.arrayBuffer()));
  return name;
}

async function showPreview(id) {
  const { sheets } = await api("GET", `jobs/${id}/preview?limit=20`);
  for (const s of sheets) {
    console.log(`\n${s.sheet}${s.recognised_as ? ` (${s.recognised_as})` : ""}`);
    for (const it of s.items) {
      console.log(`  row ${it.row}  ${it.action.padEnd(7)} ${it.item}${it.message ? `  - ${it.message}` : ""}`);
      for (const c of it.changes.slice(0, 8)) console.log(`      ${c}`);
      for (const e of it.errors ?? []) console.log(`      ! ${e}`);
      for (const w of it.warnings ?? []) console.log(`      warning: ${w}`);
    }
  }
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const [cmd, a, b] = rest;
  const print = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);

  if (!cmd || cmd === "help" || flags.help) return console.log(HELP);

  if (cmd === "login") {
    if (!a || !b) fail("Usage: bulkport login <app address> <access key>");
    if (!/^https?:\/\//.test(a)) fail("The app address starts with https://");
    fs.writeFileSync(CONFIG, JSON.stringify({ url: a.replace(/\/+$/, ""), key: b }, null, 2), { mode: 0o600 });
    fs.chmodSync(CONFIG, 0o600);
    await api("GET", "jobs?limit=1");
    return console.log(`Signed in. Settings saved in ${CONFIG}`);
  }

  if (cmd === "sheets") {
    const data = await api("GET", a ? `sheets/${encodeURIComponent(a)}` : "sheets");
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    if (!a) return data.sheets.forEach((s) => console.log(`${s.sheet.padEnd(22)} ${[s.can_export && "export", s.can_import && "import"].filter(Boolean).join(", ")}`));
    console.log(`${data.sheet}: ${data.description}`);
    if (data.groups.length) console.log(`\nGroups: ${data.groups.map((g) => g.key).join(", ")}`);
    if (data.filters.length) console.log(`\nFilters: ${data.filters.map((f) => f.field).join(", ")}`);
    return console.log(`\nColumns:\n  ${data.columns.join("\n  ")}`);
  }

  if (cmd === "jobs") {
    const { jobs } = await api("GET", "jobs?limit=20");
    return print(jobs, jobs.map((j) => `${j.id}  ${j.created_at.slice(0, 16).replace("T", " ")}  ${(j.preview ? "preview" : j.type).padEnd(7)} ${j.outcome}${j.name ? `  ${j.name}` : ""}`).join("\n") || "No jobs yet");
  }

  if (cmd === "status") {
    if (!a) fail("Usage: bulkport status <job>");
    const job = await api("GET", `jobs/${a}`);
    print(job, describe(job));
    return DONE.has(job.status) ? exitFor(job) : undefined;
  }

  if (cmd === "export") {
    if (!a) fail("Usage: bulkport export <sheet> [options]. See: bulkport help");
    const sheet = { sheet: a };
    if (flags.columns) sheet.columns = flags.columns.split(",").map((c) => c.trim()).filter(Boolean);
    if (flags.groups) sheet.groups = flags.groups.split(",").map((c) => c.trim()).filter(Boolean);
    if (flags.filter.length) sheet.filters = flags.filter.map(parseFilter);
    if (flags.last) sheet.dateRange = parseLast(flags.last, flags["date-field"] || "created_at");
    if (flags.limit) sheet.limit = Number(flags.limit);
    let job = await api("POST", "exports", { sheets: [sheet], format: flags.format || "csv" });
    if (flags["no-wait"]) return print(job, job.id);
    job = await waitFor(job, flags.json);
    if (job.status === "finished") {
      const file = await download(job, flags.out);
      print({ ...job, file }, `${describe(job)}\nSaved ${file}`);
    } else print(job, describe(job));
    return exitFor(job);
  }

  if (cmd === "import") {
    if (!a) fail("Usage: bulkport import <file or link> [--apply]. See: bulkport help");
    let job;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) {
      job = await api("POST", "imports", { url: a, command: flags.command, apply: !!flags.apply, batch: !!flags.batch, concurrency: flags.threads ? Number(flags.threads) : undefined });
    } else {
      if (!fs.existsSync(a)) fail(`No such file: ${a}`);
      const form = new FormData();
      form.set("file", new Blob([fs.readFileSync(a)]), path.basename(a));
      if (flags.command) form.set("command", flags.command);
      if (flags.apply) form.set("apply", "true");
      if (flags.batch) form.set("batch", "true");
      if (flags.threads) form.set("concurrency", String(flags.threads));
      job = await api("POST", "imports", form);
    }
    if (flags["no-wait"]) return print(job, job.id);
    job = await waitFor(job, flags.json);
    print(job, describe(job));
    if (job.preview && job.status === "finished" && !flags.json) {
      await showPreview(job.id);
      const w = job.would;
      if (w) console.log(`\nWould create ${w.creates}, update ${w.updates}, delete ${w.deletes}; ${w.unchanged} unchanged; ${w.failing} would fail${w.warned ? `; ${w.warned} with warnings` : ""}${w.clearing ? `; ${w.clearing} would have fields emptied` : ""}.`);
      console.log(`Nothing was changed. To run it for real: bulkport apply ${job.id}${w?.deletes ? " --confirm-deletes" : ""}`);
    }
    return exitFor(job);
  }

  if (cmd === "preview") {
    if (!a) fail("Usage: bulkport preview <job>");
    if (flags.json) return console.log(JSON.stringify(await api("GET", `jobs/${a}/preview?limit=200`), null, 2));
    return showPreview(a);
  }

  if (cmd === "apply") {
    if (!a) fail("Usage: bulkport apply <job>");
    let job = await api("POST", `jobs/${a}/apply`, { confirm_deletes: !!flags["confirm-deletes"], confirm_warnings: !!flags["confirm-warnings"], skip_warnings: !!flags["skip-warnings"] });
    if (flags["no-wait"]) return print(job, job.id);
    job = await waitFor(job, flags.json);
    print(job, describe(job));
    return exitFor(job);
  }

  if (cmd === "download") {
    if (!a) fail("Usage: bulkport download <job> [-o file]");
    return console.log(`Saved ${await download({ id: a }, flags.out)}`);
  }

  if (cmd === "cancel") {
    if (!a) fail("Usage: bulkport cancel <job>");
    const job = await api("POST", `jobs/${a}/cancel`);
    return print(job, describe(job));
  }

  fail(`Unknown command "${cmd}". Run: bulkport help`);
}

main().catch((e) => fail(e.message));
