/**
 * Checks the variables an entity sends with a GraphQL operation against the
 * Admin schema (types, required fields, enum values). The mocked API in tests
 * accepts anything, so this catches inputs Shopify would reject outright.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildClientSchema, parse, type GraphQLSchema } from "graphql";
import { getVariableValues } from "graphql/execution/values";

const SCHEMA_FILE = path.resolve(".cache/schema/admin_2026-10.json.gz");
export const hasSchema = fs.existsSync(SCHEMA_FILE);
let schema: GraphQLSchema | null = null;

export function variableErrors(query: string, variables: Record<string, unknown> = {}): string[] {
  if (!hasSchema) return [];
  schema ??= buildClientSchema(((j) => j.data ?? j)(JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString("utf8"))));
  const op = parse(query).definitions.find((d: any) => d.kind === "OperationDefinition") as any;
  const result = getVariableValues(schema, op.variableDefinitions ?? [], variables);
  return "errors" in result && result.errors ? result.errors.map((e) => e.message) : [];
}
