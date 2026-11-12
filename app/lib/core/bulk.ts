import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { BulkRunner, Gql, Logger } from "./types";
import { assertNoUserErrors, gidType, sleep } from "./util";

const RUN = `#graphql
  mutation BulkRun($query: String!) {
    bulkOperationRunQuery(query: $query, groupObjects: true) {
      bulkOperation { id status }
      userErrors { field message code }
    }
  }
`;

const POLL = `#graphql
  query BulkPoll($id: ID!) {
    bulkOperation(id: $id) {
      id status errorCode objectCount rootObjectCount url partialDataUrl
    }
  }
`;

const CANCEL = `#graphql
  mutation BulkCancel($id: ID!) {
    bulkOperationCancel(id: $id) { userErrors { field message } }
  }
`;

/** Default mapping of child object types to the parent field they belong in. */
export const DEFAULT_CHILD_KEYS: Record<string, string> = {
  ProductVariant: "variants",
  Metafield: "metafields",
  MediaImage: "media",
  Video: "media",
  ExternalVideo: "media",
  Model3d: "media",
  InventoryLevel: "inventoryLevels",
  Collection: "collections",
  Product: "products",
  MailingAddress: "addresses",
  LineItem: "lineItems",
  DraftOrderLineItem: "lineItems",
  Fulfillment: "fulfillments",
  OrderTransaction: "transactions",
  Refund: "refunds",
  CompanyLocation: "locations",
  CompanyContact: "contacts",
  DiscountRedeemCode: "codes",
  Article: "articles",
  Comment: "comments",
  Metaobject: "metaobjects",
  ShopifyPaymentsBalanceTransaction: "transactions",
  ResourcePublicationV2: "publications",
  ResourcePublication: "publications",
};

export interface BulkOptions {
  log?: Logger;
  isCancelled?: () => boolean | Promise<boolean>;
  /** Called while Shopify prepares the data, with the number of root items so far. */
  onRoots?: (rootObjectCount: number) => void;
  childKeys?: Record<string, string>;
  /** Override for downloading the result file (tests). */
  fetchLines?: (url: string) => AsyncIterable<string>;
  pollIntervalMs?: number;
}

async function* httpLines(url: string): AsyncIterable<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to download bulk results: HTTP ${res.status}`);
  const rl = createInterface({ input: Readable.fromWeb(res.body as any), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield line;
}

/**
 * Reassembles JSONL lines (with __parentId references) into nested objects.
 * Requires groupObjects:true so that descendants follow their root.
 */
/**
 * Most child records kept in memory for one root item. A discount can hold
 * millions of codes; without a cap one such item exhausts the server's memory.
 */
export const MAX_CHILDREN_PER_ROOT = Number(process.env.MAX_CHILDREN_PER_ROOT ?? 50_000);

/** Indexes an object and any nested objects that have an id (e.g. a variant's inventoryItem). */
function indexObject(index: Map<string, any>, obj: any, depth = 0) {
  if (obj.id) index.set(obj.id, obj);
  if (depth >= 3) return;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) indexObject(index, v, depth + 1);
  }
}

export async function* assemble(
  lines: AsyncIterable<string>,
  childKeys: Record<string, string> = DEFAULT_CHILD_KEYS,
  onTruncated?: (rootId: string, dropped: number) => void,
  maxChildren = MAX_CHILDREN_PER_ROOT,
): AsyncGenerator<any> {
  let root: any = null;
  let index = new Map<string, any>();
  let kept = 0;
  let dropped = 0;
  const finish = () => {
    if (dropped) onTruncated?.(root.id ?? "", dropped);
    kept = 0;
    dropped = 0;
    return root;
  };
  for await (const line of lines) {
    const obj = JSON.parse(line);
    const parentId: string | undefined = obj.__parentId;
    if (!parentId) {
      if (root) yield finish();
      root = obj;
      index = new Map();
      indexObject(index, obj);
      continue;
    }
    if (kept >= maxChildren) {
      dropped++;
      continue;
    }
    kept++;
    delete obj.__parentId;
    const parent = index.get(parentId);
    if (!parent) continue; // orphan (should not happen with groupObjects)
    const type = obj.__typename ?? (obj.id ? gidType(obj.id) : "");
    const key = childKeys[type] ?? DEFAULT_CHILD_KEYS[type] ?? (type ? type[0].toLowerCase() + type.slice(1) + "s" : "children");
    (parent[key] ??= []).push(obj);
    indexObject(index, obj);
  }
  if (root) yield finish();
}

export function createBulkRunner(gql: Gql, opts: BulkOptions = {}): BulkRunner {
  const log = opts.log ?? (() => {});
  return async function* run(query: string) {
    let started: any;
    for (let attempt = 0; ; attempt++) {
      started = await gql(RUN, { query });
      const errs = started.bulkOperationRunQuery.userErrors ?? [];
      // Another bulk query is running for this app+shop: wait for our turn.
      if (errs.some((e: any) => e.code === "OPERATION_IN_PROGRESS" || /already in progress/i.test(e.message)) && attempt < 120) {
        if (attempt === 0) log("Waiting for another bulk operation to finish…");
        await sleep(5000);
        continue;
      }
      assertNoUserErrors(started.bulkOperationRunQuery, "Bulk export");
      break;
    }
    const id: string = started.bulkOperationRunQuery.bulkOperation.id;

    let op: any;
    let interval = opts.pollIntervalMs ?? 1000;
    let lastCount = -1;
    while (true) {
      await sleep(interval);
      interval = Math.min(interval * 1.5, opts.pollIntervalMs ? opts.pollIntervalMs : 10000);
      if (opts.isCancelled && (await opts.isCancelled())) {
        await gql(CANCEL, { id }).catch(() => {});
        throw new Error("Cancelled");
      }
      op = (await gql(POLL, { id })).bulkOperation;
      opts.onRoots?.(Number(op.rootObjectCount ?? 0));
      if (op.objectCount !== lastCount) {
        lastCount = op.objectCount;
        log(`Shopify is preparing data: ${op.objectCount} objects so far`);
      }
      if (["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(op.status)) break;
    }
    if (op.status !== "COMPLETED") {
      throw new Error(`Bulk operation ${op.status.toLowerCase()}${op.errorCode ? `: ${op.errorCode}` : ""}`);
    }
    if (!op.url) return; // no results
    const lines = (opts.fetchLines ?? httpLines)(op.url);
    yield* assemble(lines, opts.childKeys, (rootId, dropped) =>
      log(
        `Warning: ${rootId} has more than ${MAX_CHILDREN_PER_ROOT.toLocaleString()} linked records; ${dropped.toLocaleString()} were left out to protect the server.`,
      ),
    );
  };
}
