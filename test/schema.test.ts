/**
 * Validates every GraphQL operation in app/lib against the Shopify Admin
 * schema. Run `npm run schema:fetch` first; the test is skipped otherwise.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate, type GraphQLSchema } from "graphql";
import { describe, expect, it } from "vitest";
import { ENTITIES } from "../app/lib/entities";
import type { ExportContext } from "../app/lib/core/types";

const SCHEMA_FILE = path.resolve(".cache/schema/admin_2026-10.json.gz");
const hasSchema = fs.existsSync(SCHEMA_FILE);

function loadSchema(): GraphQLSchema {
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString("utf8"));
  return buildClientSchema(json.data ?? json);
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Extracts `const NAME = \`#graphql ...\`` blocks, resolving ${FRAGMENT} references. */
function staticOperations(file: string): Array<{ name: string; source: string }> {
  const text = fs.readFileSync(file, "utf8");
  const blocks = new Map<string, string>();
  const re = /const\s+([A-Z0-9_]+)\s*=\s*`#graphql([\s\S]*?)`;/g;
  for (let m; (m = re.exec(text)); ) blocks.set(m[1], m[2]);
  const resolve = (s: string, depth = 0): string =>
    depth > 5 ? s : s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => resolve(blocks.get(n) ?? `#missing ${n}`, depth + 1));
  return [...blocks.entries()]
    .map(([name, body]) => ({ name, source: resolve(body) }))
    .filter((b) => /^\s*(query|mutation)\b/m.test(b.source));
}

/** Counts connection fields (those selecting `edges`) and their deepest nesting. */
function connectionStats(query: string): { total: number; depth: number } {
  let total = 0;
  let depth = 0;
  const walk = (node: any, level: number) => {
    for (const sel of node.selectionSet?.selections ?? []) {
      const isConnection = sel.selectionSet?.selections?.some((x: any) => x.name?.value === "edges");
      if (isConnection) {
        total++;
        depth = Math.max(depth, level + 1);
      }
      walk(sel, level + (isConnection ? 1 : 0));
    }
  };
  for (const def of parse(query).definitions) walk(def, 0);
  return { total, depth };
}

describe.skipIf(!hasSchema)("GraphQL operations match the Admin API schema", () => {
  const schema = hasSchema ? loadSchema() : (null as any);

  for (const file of walk(path.resolve("app/lib"))) {
    for (const op of staticOperations(file)) {
      it(`${path.relative(".", file)} ${op.name}`, () => {
        const errors = validate(schema, parse(op.source));
        expect(errors.map((e) => e.message)).toEqual([]);
      });
    }
  }

  for (const entity of ENTITIES) {
    if (!entity.export) continue;
    it(`bulk export query: ${entity.key}`, async () => {
      const queries: string[] = [];
      const ctx: ExportContext = {
        gql: (async (q: string) => {
          // The discounts export counts codes before it starts its bulk query.
          if (/query DiscountCodeCounts/.test(q)) return { discountNodes: { nodes: [], pageInfo: { hasNextPage: false } } };
          throw new Error("STOP");
        }) as any,
        bulk: (q) => {
          queries.push(q);
          return (async function* () {})();
        },
        options: { groups: entity.groups?.map((g) => g.key), query: "title:x", updatedAfter: "2026-01-01" },
        log: () => {},
        cache: new Map(),
        progress: () => {},
      };
      await entity.export!(ctx, async () => {}).catch((e) => {
        if (e.message !== "STOP") throw e;
      });
      for (const q of queries) {
        const errors = validate(schema, parse(q));
        expect(errors.map((e) => e.message), q).toEqual([]);
      }
      // Shopify bulk operation limits: at most 5 connections in a query and
      // nested connections at most 2 levels below the top-level one.
      for (const q of queries) {
        const { total, depth } = connectionStats(q);
        expect(total, `connections in ${entity.key} bulk query`).toBeLessThanOrEqual(5);
        expect(depth, `nested connection depth in ${entity.key} bulk query`).toBeLessThanOrEqual(3);
      }
    });
  }
});
