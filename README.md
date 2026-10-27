# Bulkport

Bulk import and export for Shopify stores, as an embedded Shopify app. Export store data to Excel or CSV, edit it in a
spreadsheet, and import it back to create, update or delete items in bulk. Built to work like Matrixify: same sheet
layout ideas, the same `Command` column semantics, import result files, scheduled jobs and URL/FTP sources.

Built on Shopify's official [React Router app template](https://github.com/Shopify/shopify-app-template-react-router),
Admin GraphQL API **2026-10**, Polaris web components and Prisma.

## What it does

| Sheet | Export | Import |
| --- | --- | --- |
| Products (variants, options, images, metafields, inventory per location, publishing) | ✅ | ✅ |
| Smart Collections (rules) | ✅ | ✅ |
| Custom Collections (product membership) | ✅ | ✅ |
| Customers (addresses, marketing consent, metafields) | ✅ | ✅ |
| Companies (B2B: locations, contacts) | ✅ | ✅ |
| Discounts (basic & free shipping; codes) | ✅ | ✅ (BxGy/app discounts export only) |
| Draft Orders | ✅ | ✅ |
| Orders | ✅ | ✅ create (migrations) + update editable fields |
| Payouts (Shopify Payments) | ✅ | — |
| Pages | ✅ | ✅ |
| Blog Posts | ✅ | ✅ |
| Redirects | ✅ | ✅ |
| Files | ✅ | ✅ |
| Metaobjects | ✅ | ✅ |
| Menus | ✅ | ✅ |
| Shop (details + shop metafields) | ✅ | ✅ metafields only |

The **Sheet reference** page in the app lists every column for every sheet.

### Files

* **Excel (.xlsx)**: one sheet per data type. Sheets over Excel's 1,048,576 row limit continue in "Products (2)" etc.
* **CSV**: one file per data type; several data types are zipped. CSV keeps text over Excel's 32,767 character cell
  limit (long Body HTML), which XLSX truncates with a warning.
* Imports accept `.xlsx`, `.csv` or `.zip`. The sheet name (or CSV file name, e.g. `Products.csv` or
  `Export_2026-10-27_Products.csv`) decides the data type.
* Google Sheets, Google Drive and Dropbox share links are converted to direct downloads automatically.

### Import rules

* **Command** column per item: `MERGE` (default: update or create), `UPDATE`, `NEW`, `REPLACE`, `DELETE`, `IGNORE`.
  Sub-commands per row: `Variant Command`, `Image Command`, `Tags Command`, `Address Command`, `Product Command`…
* Items are matched by key columns (e.g. Products: `ID`, then `Handle`). Rows with the same key belong to one item;
  rows with every key blank continue the item above. Item-level columns are read from its first row.
* Missing columns are not touched. A blank cell in a present column clears the value (blank metafield cells delete
  the metafield). Prices and titles are never cleared by blanks.
* Metafields: `Metafield: namespace.key [type]` columns (`Variant Metafield:` for variants). Lists go one value per line.
* Inventory: `Inventory Available: <Location name>` columns set stock per location. `Variant Inventory Qty` (a total)
  is only applied in single-location stores, so re-importing an export can't pile stock into one location.
* Every import produces a result file: the original rows plus `Import Result` (OK / Failed / Skipped) and
  `Import Comment`, with new IDs filled in. **Dry run** checks the file without changing the store.

### Jobs and schedules

Jobs run in the background (exports use Bulk Operations; imports call the Admin API with throttle-aware retries and
4 items in parallel). Jobs show live progress and logs and can be cancelled. Exports can repeat hourly/daily/weekly and
optionally upload to FTP/FTPS; imports can repeat from a URL or FTP file.

## Running it

Prerequisites: Node 22.12+, the [Shopify CLI](https://shopify.dev/docs/apps/tools/cli) and a Shopify Partner account
with a development store.

```shell
npm install
npm run setup            # prisma generate + migrate
shopify app config link  # create/link the app in your Partner account (fills client_id)
shopify app dev          # tunnel + install on your dev store
```

Then open the app from the store admin.

### Access scopes

Set in `shopify.app.toml`. The app asks for every scope it needs for all sheets; remove the ones for sheets you don't
use. `read_all_orders` (orders older than 60 days) and `read_shopify_payments_payouts` need Shopify's approval for
public apps.

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `STORAGE_DIR` | `./storage` | Where job files are kept. Use a persistent volume in production. |
| `FILE_RETENTION_DAYS` | `30` | Job folders older than this are deleted. |
| `WORKER_ENABLED` | `true` | Set `false` on extra web replicas so only one instance runs jobs. |
| `WORKER_CONCURRENCY` | `3` | Jobs running at once (always max one per shop). |
| `MAX_UPLOAD_MB` | `200` | Upload size limit. |
| `ALLOW_PRIVATE_SOURCES` | `false` | Allow URL/FTP sources on private networks (blocked by default against SSRF). |

### Deploying

The worker runs inside the web process, and job files live on local disk, so run **one** instance with a persistent
volume (or set `WORKER_ENABLED=false` on all but one replica and share `STORAGE_DIR`). For production, switch Prisma
from SQLite to Postgres/MySQL. See Shopify's [deployment docs](https://shopify.dev/docs/apps/launch/deployment).

## Development

```shell
npm test                 # unit + behaviour tests (Shopify API mocked)
npm run schema:fetch     # download the Admin API schema once…
npm test                 # …then tests also validate every GraphQL operation against it
npm run schema:inspect -- Product Mutation.productSet --sdl ProductSetInput
npm run typecheck
```

Code map:

* `app/lib/core/` — the engine: spreadsheet I/O (`sheets.ts`), throttled GraphQL client (`gql.ts`), bulk operations
  (`bulk.ts`), import/export pipelines (`importer.ts`, `exporter.ts`), shared lookups and helpers.
* `app/lib/entities/` — one module per sheet. Each defines its columns, export (row mapping) and import (`apply`).
  Register new ones in `entities/index.ts`.
* `app/lib/jobs/` — job queue, worker, schedules, file storage, signed downloads, URL/FTP sources.
* `app/routes/` — admin UI pages, download route, webhooks.

## Known limitations

* Smart collection rules use the `ruleSet` API, which 2026-10 deprecates in favour of collection `sources`.
* Changing a product's option names requires `REPLACE`; image reordering by `Image Position` is not applied on merge.
* Editing line items of existing orders is not supported (Shopify order editing is a separate flow). Orders created
  by import keep one discount code; Fulfillment Statuses like `on_hold` can't be set on create (order is created
  unfulfilled, with a note).
* Draft orders: when a sheet's lines differ from the draft, all lines are re-sent (Shopify replaces the line list).
* Menus: when item columns are present, the item rows are the menu's complete new item tree.
* Discounts: Buy X Get Y and app discounts are export-only; codes are added, never removed. Extra codes go in the
  `Additional Code` column on continuation rows.
* REPLACE always validates the whole row before deleting anything. Products are re-created before the old one is
  deleted (so images on Shopify's CDN can be copied); Files refuse REPLACE from the file's own CDN URL.
* Not tested against a live store yet: tests use a mocked Admin API plus schema validation.
