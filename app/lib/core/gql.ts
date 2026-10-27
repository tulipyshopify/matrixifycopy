import type { Gql, Logger } from "./types";
import { sleep } from "./util";

export interface RawResponse {
  data?: any;
  errors?: any;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };
    };
  };
}

/** Executes one GraphQL request. May throw; thrown errors may carry `body`. */
export type RawExecutor = (query: string, variables?: Record<string, unknown>) => Promise<RawResponse>;

export class GraphqlError extends Error {
  constructor(
    message: string,
    public errors?: unknown,
  ) {
    super(message);
  }
}

function errorsOf(e: any): any[] {
  const errs = e?.body?.errors ?? e?.errors ?? e?.response?.errors;
  if (!errs) return [];
  if (Array.isArray(errs)) return errs;
  if (Array.isArray(errs.graphQLErrors)) return errs.graphQLErrors;
  return [errs];
}

function isThrottled(errs: any[]): boolean {
  return errs.some((e) => e?.extensions?.code === "THROTTLED" || /throttled/i.test(e?.message ?? ""));
}

function isTransient(e: any): boolean {
  const status = e?.response?.status ?? e?.status;
  return (
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(String(e?.message ?? e))
  );
}

/**
 * Wraps a raw executor with throttle-aware retries. Shopify uses a leaky bucket
 * of query cost points; when the bucket runs low we wait for it to refill
 * instead of hammering the API and getting THROTTLED.
 */
export function createGql(exec: RawExecutor, log: Logger = () => {}, maxRetries = 8): Gql {
  let available = Infinity;
  let restoreRate = 50;
  let maximum = 1000;

  return async function gql(query, variables) {
    for (let attempt = 0; ; attempt++) {
      // Proactively wait if the bucket is nearly empty.
      if (available < Math.min(200, maximum * 0.1)) {
        const waitMs = Math.ceil(((Math.min(400, maximum * 0.3) - available) / restoreRate) * 1000);
        if (waitMs > 0) await sleep(waitMs);
        available = Infinity;
      }

      let res: RawResponse;
      try {
        res = await exec(query, variables);
      } catch (e: any) {
        const errs = errorsOf(e);
        if ((isThrottled(errs) || isTransient(e)) && attempt < maxRetries) {
          const wait = Math.min(30000, 1000 * 2 ** attempt);
          log(`API busy (${isThrottled(errs) ? "throttled" : e?.message}), retrying in ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
        if (errs.length) {
          throw new GraphqlError(errs.map((x) => x?.message ?? String(x)).join("; "), errs);
        }
        throw e;
      }

      const ts = res.extensions?.cost?.throttleStatus;
      if (ts) {
        available = ts.currentlyAvailable;
        restoreRate = ts.restoreRate || restoreRate;
        maximum = ts.maximumAvailable || maximum;
      }

      const errs = errorsOf(res);
      if (errs.length) {
        if (isThrottled(errs) && attempt < maxRetries) {
          const cost = res.extensions?.cost?.requestedQueryCost ?? 100;
          await sleep(Math.ceil((cost / restoreRate) * 1000) + 500);
          continue;
        }
        throw new GraphqlError(errs.map((x) => x?.message ?? String(x)).join("; "), errs);
      }
      return res.data;
    }
  };
}

/** Pages through a connection with cursor pagination. */
export async function* paginate<T = any>(
  gql: Gql,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: any) => { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } },
): AsyncGenerator<T> {
  let after: string | null = null;
  do {
    const data = await gql(query, { ...variables, after });
    const conn = pick(data);
    for (const n of conn.nodes) yield n;
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
}
