/**
 * Test helpers for the content entity tests (pages, blog posts, redirects,
 * files, metaobjects, menus, shop): a mocked `gql` keyed by operation name and
 * schema validation of the queries an export issues.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate, type GraphQLSchema } from "graphql";
import type { Entity, ExportContext, ExportOptions, ImportContext, Row } from "../app/lib/core/types";

export interface Call {
  op: string;
  query: string;
  vars: Record<string, any>;
}

type Handler = (vars: Record<string, any>, call: Call) => any;

export function opName(query: string): string {
  return /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
}

/** gql mock: looks up a handler by operation name and records every call. */
export function mockGql(handlers: Record<string, Handler | any>) {
  const calls: Call[] = [];
  const gql = async (query: string, vars: Record<string, unknown> = {}) => {
    const call: Call = { op: opName(query), query, vars: vars as any };
    calls.push(call);
    const h = handlers[call.op];
    if (h === undefined) throw new Error(`Unexpected operation ${call.op}`);
    return typeof h === "function" ? h(call.vars, call) : h;
  };
  return { gql: gql as any, calls, ops: () => calls.map((c) => c.op), call: (op: string) => calls.find((c) => c.op === op) };
}

export function importCtx(gql: any): ImportContext {
  return { gql, options: {}, log: () => {}, cache: new Map() };
}

export function exportCtx(gql: any, bulkResults: any[] | ((q: string) => any[]) = [], options: ExportOptions = {}) {
  const bulkQueries: string[] = [];
  const ctx: ExportContext = {
    gql,
    bulk: (q) => {
      bulkQueries.push(q);
      const items = typeof bulkResults === "function" ? bulkResults(q) : bulkResults;
      return (async function* () {
        for (const i of items) yield i;
      })();
    },
    options,
    log: () => {},
    cache: new Map(),
    progress: () => {},
  };
  return { ctx, bulkQueries };
}

/** Runs an export and collects the emitted rows. */
export async function runExport(entity: Entity, ctx: ExportContext): Promise<Row[]> {
  const rows: Row[] = [];
  await entity.export!(ctx, async (r) => {
    rows.push(...r);
  });
  return rows;
}

const SCHEMA_FILE = path.resolve(".cache/schema/admin_2026-10.json.gz");
export const hasSchema = fs.existsSync(SCHEMA_FILE);
let schema: GraphQLSchema | null = null;

export function loadSchema(): GraphQLSchema {
  if (!schema) {
    const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString("utf8"));
    schema = buildClientSchema(json.data ?? json);
  }
  return schema;
}

/** Validation errors of a GraphQL document against the Admin schema. */
export function schemaErrors(query: string): string[] {
  return validate(loadSchema(), parse(query)).map((e) => e.message);
}
