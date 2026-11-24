# Bulkport: handover

Written 24 November 2026 for whoever (person or assistant) picks this project up
without the earlier conversations. `README.md` describes the app, `DEPLOY.md` the
server setup, `CHANGELOG.md` the releases. This file holds what those don't: the
working rules, where things run, how changes are checked, and what is still open.

## What it is

An original Shopify embedded app for bulk import and export of store data
(products, collections, customers, discounts, pages, redirects and more), with
previews before anything is changed, undo, backups, scheduled jobs, an API, a
command-line tool and a connector for AI assistants.

## Standing rules

These were set by the owner and are not to be relaxed without asking.

- **Original work only.** The app does a similar job to Matrixify. Never copy its
  code, branding, wording or preset names.
- **All new work goes to the `staging` branch.** The live copies run `v2` and are
  moved only with the owner's explicit approval, given for that move.
- **No secrets in the repository or in chat.** Shopify client secrets, the
  Anthropic key, SMTP and Google credentials are typed in by the owner on the
  server (`.env.production` in each instance folder). Never ask for them to be
  pasted anywhere else.
- **The staging app is installed on a live shop.** Test with previews, exports and
  clearly named throwaway records only; change real shop data only on the owner's
  go-ahead.
- **Permanent export links are public.** Anyone with the link can download the
  file. Keep the warnings, and keep the link off by default.
- **The owner prefers action to questions.** Take the most sensible reading, do
  the work, and say what was assumed.
- **Plain English in the app.** Messages say what happened and what to do next,
  without jargon or server details.

## Where things are

| What | Where |
|---|---|
| Repository (current) | `Simple-Profit/bulkportnew` |
| Repository (previous) | `tulipyshopify/matrixifycopy` (same history up to 24 Nov 2026) |
| Test app "Bulk v2" | branch `staging`, server folder `/opt/bulkport-staging`, `bulk-v2.tulipy.app` |
| Live copies | branch `v2`, server folder `/opt/bulkport` (plus instances, see `DEPLOY.md`) |
| Original release | branches `main` and `release-v1.0` (same commit) |

The servers were still pulling from the previous repository when this was written.
Switching one is a change of remote on the server, and because the new repository
is private the server then needs its own read access (a deploy key or token).

Deploying staging, on the server:

```
cd /opt/bulkport-staging && git pull && docker compose up -d --build
```

Database migrations run by themselves when the container starts
(`prisma migrate deploy` in `docker-start`). The worker runs inside the web
process, so a deploy also restarts the job queue.

## Layout of the code

- `app/lib/core/`: the engine. `sheets.ts` reads and writes files (own .xlsx and
  .ods readers, CSV, ZIP), `importer.ts` runs imports and previews, `exporter.ts`
  exports, `layouts.ts` matches other people's column names to ours, `registry.ts`
  works out what a sheet holds, `images.ts` handles image files sent with a sheet.
- `app/lib/entities/`: one file per data type (`products.ts` is by far the
  largest). `_content_helpers.ts` holds what pages, blog posts, metaobjects,
  redirects, files and menus share, including the field-by-field preview.
- `app/lib/jobs/`: the job queue (`worker.server.ts`), running a job
  (`runner.server.ts`), schedules, backups, undo, saved column matchings, change
  history, share links.
- `app/lib/api/`: access keys, the REST API, the MCP server for AI assistants,
  OAuth sign-in for them. Every way in goes through `service.server.ts`.
- `app/routes/`: the pages. `app.*.tsx` are inside the Shopify admin; `api.*` is
  the API.
- `app/components/`: shared UI, built on Shopify's Polaris web components
  (`s-page`, `s-button` …).
- `prisma/`: SQLite schema and hand-written migrations.
- `test/`: Vitest. `test/helpers/fake_store.ts` stands in for a shop.

## How changes are checked

```
npx tsc --noEmit -p .
npx vitest run
npm run build
```

- After adding a migration, apply it to the test database before running tests:
  `DATABASE_URL="file:dev.sqlite" npx prisma migrate deploy`.
- `test/schema.test.ts` checks GraphQL against Shopify's Admin API schema
  (version 2026-10). It only sees queries written as
  ``const NAME = `#graphql … ` `` so write them that way.
  `node scripts/schema-inspect.mjs` looks a type up.
- Each round of the owner's test reports has a test file that replays it
  (`round2`, `round_a`, `retest_nov20`, `full_report`, `supplier_files` …). Add
  to these rather than loosening them; when behaviour changes on purpose, change
  the test and say why in the commit.
- A page that was rebuilt is looked at in a browser before it is committed: a
  temporary route with a mocked loader, the dev server, and a screenshot. The
  temporary route is deleted afterwards.

## How imports behave (the rules people rely on)

- Every import starts as a preview. Risky rows start on Skip.
- A blank cell leaves its field alone; `[clear]` in a cell empties it.
- Rows without a Command only update what exists (default UPDATE through the API).
- Applying a preview re-checks each item: anything changed in the shop since the
  preview is left alone and reported.
- Undo is recorded for products and the types in `SNAPSHOT_TYPES`; undoing a
  delete creates the item again with a new ID.
- A supplier's file is read through a saved column matching ("Match columns"):
  header row found or chosen, stock per location, stock written in words,
  products not in the shop skipped rather than failed.

## Open at the time of writing

From the owner's test report of 23 November 2026, part B, after commit `4ef443b`:

- **Job queue stall (B32):** fixed from reading the code, not confirmed on the
  server. The likely cause was a job freeing a different lane from the one it
  took. If it stalls again, the server log now prints a `STALLED` line; ask for
  `docker compose logs --tail 300`.
- **Email alerts (B4):** the "send a test" button exists; sending needs `SMTP_URL`
  set on the server by the owner.
- **Small exports wait behind a big one (B24):** not fixed. Probably Shopify
  running one bulk read per shop at a time; unconfirmed.
- **Share-link approvals (B19):** shown as "name not verified". Verifying by email
  code needs the mail account.
- **Image thumbnails in previews (B10):** not built.
- **Restore from a backup (B20):** needs a test on a development shop.
- **Access keys (B30):** built; the owner still has to switch on "who can create
  full keys" and run the products-only key test.
- **An AI step that reads a supplier's file and asks about unclear columns**, and
  connector access to Match columns: proposed in the report, not built.
- **Old `.xls` files:** refused with instructions to save as `.xlsx`.
- **Discount imports:** an older note says every layout failed on the live shop;
  never traced to a cause.
- **The app's name** (Bulkport or Bulk v2) is undecided.
- **The premium look** from the Home page has not been carried to Export, Backups,
  Catalogue health, Settings and Help.
- **Moving `staging` to the live copies** waits for the owner's approval.

## Commits

Short, plain subject lines saying what changed for the person using the app. No
secrets, no personal details, and nothing about which tool or model wrote the
change in code comments.
