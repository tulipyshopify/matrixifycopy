import path from "node:path";
import type { Entity, ExportContext, ExportOptions, Gql, BulkRunner, Logger } from "./types";
import { RowSpool, type WorkbookOut } from "./sheets";

export interface ExportRequest {
  entity: Entity;
  options: ExportOptions;
}

export interface ExportSummary {
  entity: string;
  rows: number;
  items: number;
}

export interface RunExportArgs {
  gql: Gql;
  rest?: (path: string) => Promise<any>;
  bulk: BulkRunner;
  requests: ExportRequest[];
  out: WorkbookOut;
  tmpDir: string;
  log: Logger;
  progress?: (entity: string, items: number) => void;
  /** Called before each entity's export starts. */
  onStart?: (entity: string) => void;
  isCancelled?: () => boolean | Promise<boolean>;
}

/**
 * Applies the column choice (key columns such as ID are optional too, though a
 * file without them can't be imported back); dynamic columns (metafields, inventory per
 * location) are controlled by column groups instead.
 */
/** "Inventory Available: Shop", "Inventory On Hand: Shop"… → the location name. */
export const INVENTORY_COLUMN = /^Inventory (?:Available|On Hand|Committed|Reserved|Damaged|Safety Stock|Quality Control|Incoming): (.+)$/;

/** Applies the location and metafield choices to dynamic column headers. */
function keepDynamic(options: ExportOptions, h: string): boolean {
  const inv = options.locations ? INVENTORY_COLUMN.exec(h) : null;
  if (inv) return options.locations!.some((l) => l.toLowerCase() === inv[1].trim().toLowerCase());
  for (const [prefix, list] of [
    ["Variant Metafield: ", options.variantMetafields],
    ["Metafield: ", options.metafields],
  ] as const) {
    if (list && h.startsWith(prefix)) {
      const key = h.slice(prefix.length).replace(/\s*\[.*$/, "").trim().toLowerCase();
      return list.some((m) => m.toLowerCase() === key);
    }
  }
  return true;
}

/** Which metafields each data type exports: [data group, column prefix, Shopify owner type]. */
const METAFIELD_OWNERS: Record<string, Array<[string, string, string]>> = {
  products: [
    ["metafields", "Metafield", "PRODUCT"],
    ["variant_metafields", "Variant Metafield", "PRODUCTVARIANT"],
  ],
  smart_collections: [["metafields", "Metafield", "COLLECTION"]],
  custom_collections: [["metafields", "Metafield", "COLLECTION"]],
  customers: [["metafields", "Metafield", "CUSTOMER"]],
  companies: [["metafields", "Metafield", "COMPANY"]],
  orders: [["metafields", "Metafield", "ORDER"]],
  draft_orders: [["metafields", "Metafield", "DRAFTORDER"]],
  discounts: [["metafields", "Metafield", "DISCOUNT"]],
  pages: [["metafields", "Metafield", "PAGE"]],
  blog_posts: [["metafields", "Metafield", "ARTICLE"]],
  shop: [["metafields", "Metafield", "SHOP"]],
};

const METAFIELD_DEFINITIONS = `#graphql
  query ExportMetafieldDefinitions($ownerType: MetafieldOwnerType!, $after: String) {
    metafieldDefinitions(ownerType: $ownerType, first: 250, after: $after) {
      nodes { namespace key type { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Metafield columns that no exported item has a value for: every metafield
 * defined in the store, and every one named in the export, so the file shows
 * them (empty) and they can be filled in and imported.
 */
export async function emptyMetafieldColumns(gql: Gql, entity: Entity, options: ExportOptions, existing: string[], log: Logger): Promise<string[]> {
  const groups = new Set(options.groups ?? (entity.groups ?? []).filter((g) => g.default).map((g) => g.key));
  const bare = (h: string) => h.replace(/\s*\[.*$/, "").trim().toLowerCase();
  const have = new Set(existing.map(bare));
  const out: string[] = [];
  const add = (header: string) => {
    if (have.has(bare(header))) return;
    have.add(bare(header));
    out.push(header);
  };
  for (const [group, prefix, ownerType] of METAFIELD_OWNERS[entity.key] ?? []) {
    if (!groups.has(group)) continue;
    try {
      let after: string | null = null;
      for (let page = 0; page < 20; page++) {
        const d: any = await gql(METAFIELD_DEFINITIONS, { ownerType, after });
        for (const def of d.metafieldDefinitions.nodes) add(`${prefix}: ${def.namespace}.${def.key} [${def.type.name}]`);
        if (!d.metafieldDefinitions.pageInfo.hasNextPage) break;
        after = d.metafieldDefinitions.pageInfo.endCursor;
      }
    } catch (e: any) {
      log(`Could not read the ${prefix.toLowerCase()} definitions (${e?.message ?? e}); only metafields with values are listed`);
    }
    // Named in the export but not defined in the store: an empty text column.
    const named = prefix === "Metafield" ? options.metafields : options.variantMetafields;
    for (const m of named ?? []) add(`${prefix}: ${m} [single_line_text_field]`);
  }
  return out;
}

export function selectColumns(entity: Entity, options: ExportOptions, headers: string[]): string[] {
  headers = headers.filter((h) => keepDynamic(options, h));
  if (!options.columns) return headers;
  // Chosen columns come out in the order given (the export form lets people
  // arrange them), followed by the dynamic columns.
  // When stock columns are listed, only the listed ones are written (the form
  // lists them all unless some were taken out).
  if (options.columns.some((c) => INVENTORY_COLUMN.test(c))) {
    const listed = new Set(options.columns.map((c) => c.toLowerCase()));
    headers = headers.filter((h) => !INVENTORY_COLUMN.test(h) || listed.has(h.toLowerCase()));
  }
  const present = new Set(headers);
  const known = new Set(entity.columns);
  const out: string[] = [];
  const placed = new Set<string>();
  for (const c of options.columns) {
    if (present.has(c)) {
      out.push(c);
      placed.add(c);
    } else if (/^(Variant )?Metafield: /.test(c)) {
      // A named metafield placed among the columns; its header also carries the type.
      const want = c.toLowerCase();
      for (const h of headers) {
        if (!placed.has(h) && !known.has(h) && h.replace(/\s*\[.*$/, "").trim().toLowerCase() === want) {
          out.push(h);
          placed.add(h);
        }
      }
    }
  }
  return [...out, ...headers.filter((h) => !known.has(h) && !placed.has(h))];
}

export async function runExport(args: RunExportArgs): Promise<ExportSummary[]> {
  const { gql, bulk, requests, out, tmpDir, log } = args;
  const summaries: ExportSummary[] = [];
  const cache = new Map<string, unknown>();

  for (const { entity, options } of requests) {
    if (!entity.export) {
      log(`${entity.sheet}: export not supported, skipped`);
      continue;
    }
    log(`${entity.sheet}: export started`);
    const spool = new RowSpool(path.join(tmpDir, `${entity.key}-${Date.now()}.jsonl`));
    let items = 0;
    const ctx: ExportContext = {
      gql,
      bulk,
      rest: args.rest,
      options,
      log: (m) => log(`${entity.sheet}: ${m}`),
      cache,
      progress: (n) => {
        items = n;
        args.progress?.(entity.key, n);
      },
    };
    args.onStart?.(entity.key);
    let batches = 0;
    try {
      await entity.export(ctx, async (rows) => {
        // Stop promptly when the job is cancelled while rows are being written.
        if (++batches % 100 === 0 && args.isCancelled && (await args.isCancelled())) throw new Error("Cancelled");
        for (const r of rows) await spool.push(r);
      });
      await spool.finish();
      for (const h of await emptyMetafieldColumns(gql, entity, options, spool.allHeaders(), ctx.log)) spool.addHeader(h);
      await out.addSheet(entity.sheet, selectColumns(entity, options, spool.headers(entity.columns)), spool.rows());
      summaries.push({ entity: entity.key, rows: spool.count, items });
      log(`${entity.sheet}: exported ${items} items in ${spool.count} rows`);
    } finally {
      await spool.dispose();
    }
  }
  return summaries;
}
