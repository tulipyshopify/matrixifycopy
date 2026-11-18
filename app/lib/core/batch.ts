import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { Command, Entity, Gql, ItemResult, Logger } from "./types";
import type { ImportItem } from "./importer";
import { cell, metafieldsFromRow, parseCommand, parseMetafieldColumn, sleep, toGid } from "./util";

/**
 * Batch mode: instead of one API call per row, the whole sheet is handed to
 * Shopify as one bulk operation, which runs without rate limits. Much faster
 * for thousands of rows.
 *
 * It is deliberately narrow. A sheet qualifies only when every row is an
 * existing item (by ID) and the only thing being written is metafields - the
 * one kind of change that is a single, self-contained Shopify call per row.
 * Anything else runs the normal way, and the log says why.
 */

/** Data types whose metafields can be written in batch, with their Shopify ID type. */
export const BATCH_OWNER_TYPES: Record<string, string> = {
  products: "Product",
  orders: "Order",
  customers: "Customer",
  smart_collections: "Collection",
  custom_collections: "Collection",
  draft_orders: "DraftOrder",
  pages: "Page",
  blog_posts: "Article",
  companies: "Company",
};

/** Below this, the normal way is as fast (a bulk operation takes a while to start). */
export const BATCH_MIN_ITEMS = Number(process.env.BATCH_MIN_ITEMS ?? 50);

const IGNORED_COLUMNS = new Set(["ID", "Command", "Import Result", "Import Comment"]);

export interface BatchLine {
  /** Index into the sheet's items. */
  item: number;
  variables: Record<string, unknown>;
}

export interface BatchPlan {
  set: BatchLine[];
  del: BatchLine[];
  /** Command of each item (for the results file). */
  commands: Command[];
}

/** Works out whether a sheet can run in batch mode; if not, says why in plain words. */
export function planBatch(entity: Entity, headers: string[], items: ImportItem[], defaultCommand: Command): BatchPlan | { reason: string } {
  const type = BATCH_OWNER_TYPES[entity.key];
  if (!type) return { reason: `${entity.sheet} can't be imported in batch mode` };
  const other = headers.filter((h) => !IGNORED_COLUMNS.has(h) && !parseMetafieldColumn(h));
  if (other.length) {
    return { reason: `batch mode only writes metafields, and this sheet also has ${other.slice(0, 4).map((h) => `"${h}"`).join(", ")}${other.length > 4 ? "…" : ""}. Keep only ID and Metafield columns to use it` };
  }
  if (!headers.some((h) => parseMetafieldColumn(h))) return { reason: "there are no Metafield columns" };
  if (items.length < BATCH_MIN_ITEMS) return { reason: `fewer than ${BATCH_MIN_ITEMS} rows, so the normal way is just as fast` };

  const plan: BatchPlan = { set: [], del: [], commands: [] };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const row = item.rows[0];
    const where = `row ${item.rowIndexes[0] + 2}`;
    if (item.rows.length > 1) return { reason: `${where}: the same ID is on more than one row` };
    let ownerId: string | undefined;
    let command: Command;
    try {
      ownerId = toGid(type, cell(row, "ID"));
      command = parseCommand(cell(row, "Command"), defaultCommand);
    } catch (e: any) {
      return { reason: `${where}: ${e.message}` };
    }
    if (!ownerId) return { reason: `${where} has no ID` };
    if (command !== "MERGE" && command !== "UPDATE") return { reason: `${where} uses command ${command}; batch mode handles MERGE and UPDATE` };
    plan.commands.push(command);
    const mf = metafieldsFromRow(row);
    for (let k = 0; k < mf.set.length; k += 25) {
      plan.set.push({ item: i, variables: { metafields: mf.set.slice(k, k + 25).map((m) => ({ ...m, ownerId })) } });
    }
    // A blank cell clears the metafield, as in a normal import.
    for (let k = 0; k < mf.blank.length; k += 25) {
      plan.del.push({ item: i, variables: { metafields: mf.blank.slice(k, k + 25).map((m) => ({ ownerId, namespace: m.namespace, key: m.key })) } });
    }
  }
  return plan;
}

const SET = `mutation call($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } } }`;
const DELETE = `mutation call($metafields: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } } }`;

const STAGE = `#graphql
  mutation BatchStage($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url parameters { name value } }
      userErrors { field message }
    }
  }
`;

const RUN = `#graphql
  mutation BatchRun($mutation: String!, $path: String!) {
    bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
      bulkOperation { id status }
      userErrors { field message code }
    }
  }
`;

const POLL = `#graphql
  query BatchPoll($id: ID!) {
    bulkOperation(id: $id) { id status errorCode objectCount url partialDataUrl }
  }
`;

const CANCEL = `#graphql
  mutation BatchCancel($id: ID!) {
    bulkOperationCancel(id: $id) { userErrors { field message } }
  }
`;

export interface BatchIo {
  /** Sends the variables file to the staged upload target (tests replace this). */
  upload?: (url: string, parameters: Array<{ name: string; value: string }>, jsonl: string) => Promise<void>;
  /** Reads the result file line by line (tests replace this). */
  fetchLines?: (url: string) => AsyncIterable<string>;
  pollIntervalMs?: number;
}

async function httpUpload(url: string, parameters: Array<{ name: string; value: string }>, jsonl: string) {
  const form = new FormData();
  for (const p of parameters) form.set(p.name, p.value);
  form.set("file", new Blob([jsonl], { type: "text/jsonl" }), "bulk_op_vars");
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Uploading the batch to Shopify failed: HTTP ${res.status}`);
}

async function* httpLines(url: string): AsyncIterable<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Downloading the batch results failed: HTTP ${res.status}`);
  const rl = createInterface({ input: Readable.fromWeb(res.body as any), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield line;
}

export class BatchCancelled extends Error {}

/**
 * Runs one mutation once per line of variables, as a Shopify bulk operation.
 * Returns each line's result by line number. `complete` is false when Shopify
 * stopped early (lines without a result were then not run, or not reported).
 */
export async function runBulkMutation(
  gql: Gql,
  mutation: string,
  lines: Array<Record<string, unknown>>,
  opts: BatchIo & { log?: Logger; isCancelled?: () => boolean | Promise<boolean>; onProgress?: (done: number) => void } = {},
): Promise<{ results: Map<number, any>; complete: boolean; status: string }> {
  const log = opts.log ?? (() => {});
  const staged = (await gql(STAGE, { input: [{ resource: "BULK_MUTATION_VARIABLES", filename: "bulk_op_vars", mimeType: "text/jsonl", httpMethod: "POST" }] })).stagedUploadsCreate;
  if (staged.userErrors?.length) throw new Error(`Batch upload: ${staged.userErrors.map((e: any) => e.message).join("; ")}`);
  const target = staged.stagedTargets[0];
  const key = target.parameters.find((p: any) => p.name === "key")?.value;
  if (!key) throw new Error("Batch upload: Shopify gave no upload path");
  await (opts.upload ?? httpUpload)(target.url, target.parameters, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  let started: any;
  for (let attempt = 0; ; attempt++) {
    started = (await gql(RUN, { mutation, path: key })).bulkOperationRunMutation;
    const errs = started.userErrors ?? [];
    // The store's limit of bulk operations running at once: wait for a free slot.
    if (errs.some((e: any) => e.code === "OPERATION_IN_PROGRESS" || e.code === "LIMIT_REACHED") && attempt < 120) {
      if (attempt === 0) log("Waiting for another bulk operation to finish…");
      await sleep(opts.pollIntervalMs ?? 5000);
      continue;
    }
    if (errs.length) throw new Error(`Batch could not start: ${errs.map((e: any) => e.message).join("; ")}`);
    break;
  }
  const id: string = started.bulkOperation.id;

  let op: any;
  let interval = opts.pollIntervalMs ?? 1000;
  while (true) {
    await sleep(interval);
    interval = Math.min(interval * 1.5, opts.pollIntervalMs ?? 10_000);
    if (opts.isCancelled && (await opts.isCancelled())) {
      await gql(CANCEL, { id }).catch(() => {});
      throw new BatchCancelled("Cancelled");
    }
    op = (await gql(POLL, { id })).bulkOperation;
    opts.onProgress?.(Math.min(lines.length, Number(op.objectCount ?? 0)));
    if (["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(op.status)) break;
  }
  const results = new Map<number, any>();
  const url = op.url ?? op.partialDataUrl;
  if (url) {
    for await (const line of (opts.fetchLines ?? httpLines)(url)) {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed?.__lineNumber === "number") results.set(parsed.__lineNumber, parsed);
    }
  }
  if (op.status !== "COMPLETED") log(`Shopify stopped the batch early (${op.status.toLowerCase()}${op.errorCode ? `: ${op.errorCode}` : ""}).`);
  return { results, complete: op.status === "COMPLETED", status: op.status };
}

/** Problems reported for one line of a batch, or "" when it went through. */
function lineError(result: any, field: string): string {
  if (!result) return "Shopify returned no result for this row. Nothing may have been written; import the row again.";
  const top = (result.errors ?? []).map((e: any) => e.message);
  const user = (result.data?.[field]?.userErrors ?? []).map((e: any) => e.message);
  const all = [...top, ...user].filter(Boolean);
  if (all.length) return `Metafields: ${[...new Set(all)].join("; ")}`;
  if (!result.data?.[field]) return "Shopify returned no result for this row. Import the row again.";
  return "";
}

/** Runs a planned batch and returns one result per item, in item order. */
export async function runBatch(
  gql: Gql,
  plan: BatchPlan,
  opts: BatchIo & { log?: Logger; isCancelled?: () => boolean | Promise<boolean>; onProgress?: (itemsDone: number) => void } = {},
): Promise<ItemResult[]> {
  const errors: string[][] = plan.commands.map(() => []);
  const cancelled = plan.commands.map(() => false);
  const steps: Array<{ lines: BatchLine[]; mutation: string; field: string; what: string }> = [
    { lines: plan.set, mutation: SET, field: "metafieldsSet", what: "setting metafields" },
    { lines: plan.del, mutation: DELETE, field: "metafieldsDelete", what: "clearing blank metafields" },
  ];
  let stopped = false;
  for (const step of steps) {
    if (!step.lines.length) continue;
    if (stopped) {
      for (const l of step.lines) cancelled[l.item] = true;
      continue;
    }
    opts.log?.(`Batch mode: ${step.what} in one Shopify bulk operation (${step.lines.length.toLocaleString("en")} calls)`);
    try {
      const { results } = await runBulkMutation(gql, step.mutation, step.lines.map((l) => l.variables), {
        ...opts,
        // Progress counts items; the first step is the bulk of the work.
        onProgress: step === steps[0] ? (n) => opts.onProgress?.(step.lines[Math.max(0, n - 1)]?.item ?? 0) : undefined,
      });
      step.lines.forEach((l, n) => {
        const err = lineError(results.get(n), step.field);
        if (err) errors[l.item].push(err);
      });
    } catch (e) {
      if (!(e instanceof BatchCancelled)) throw e;
      stopped = true;
      for (const l of step.lines) cancelled[l.item] = true;
    }
  }
  return plan.commands.map((command, i) => {
    if (errors[i].length) return { status: "Failed", command, message: [...new Set(errors[i])].join("; ") };
    if (cancelled[i]) return { status: "Skipped", command, message: "Job cancelled. Shopify may already have written some rows of the batch; export to check." };
    return { status: "OK", command, message: "Metafields updated (batch mode)" };
  });
}
