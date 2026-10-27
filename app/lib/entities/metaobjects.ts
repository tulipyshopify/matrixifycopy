import type { Command, Entity, ExportContext, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import { paginate } from "../core/gql";
import {
  assertNoUserErrors,
  buildSearchQuery,
  cell,
  cellToMetafieldValue,
  gidToId,
  gqlString,
  metafieldToCell,
  parseCommand,
  toGid,
} from "../core/util";
import { cachedPromise, runCommand } from "./_content_helpers";

// --- Columns --------------------------------------------------------------------

const METAOBJECT_COLUMNS = [
  "ID",
  "Handle",
  "Command",
  "Definition: Type",
  "Definition: Name",
  "Display Name",
  "Status",
  "Updated At",
];

const FIELD_PREFIX = "Field: ";

interface DefinitionInfo {
  id: string;
  type: string;
  name: string;
  fieldDefinitions: Array<{ key: string; name: string; type: { name: string } }>;
  capabilities: { publishable: { enabled: boolean } };
}

function titleCase(s: string | null | undefined) {
  return s ? s[0] + s.slice(1).toLowerCase() : "";
}

// --- Export -------------------------------------------------------------------------

const DEFINITIONS = `#graphql
  query MetaobjectDefinitionsList($after: String) {
    metaobjectDefinitions(first: 50, after: $after) {
      nodes {
        id type name
        fieldDefinitions { key name type { name } }
        capabilities { publishable { enabled } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Bulk query for all metaobjects of one definition type. */
export function metaobjectsBulkQuery(type: string, search: string): string {
  const args = `type: ${gqlString(type)}${search ? `, query: ${gqlString(search)}` : ""}`;
  return `{
    metaobjects(${args}) { edges { node {
      id handle type displayName updatedAt
      capabilities { publishable { status } }
      fields { key type value }
    } } }
  }`;
}

export function metaobjectToRow(m: any, def: DefinitionInfo): Row {
  const row: Row = {
    ID: gidToId(m.id),
    Handle: m.handle ?? "",
    Command: "MERGE",
    "Definition: Type": def.type,
    "Definition: Name": def.name,
    "Display Name": m.displayName ?? "",
    Status: titleCase(m.capabilities?.publishable?.status),
    "Updated At": m.updatedAt ?? "",
  };
  // Every defined field gets a column (blank when unset), in definition order.
  const byKey = new Map<string, any>((m.fields ?? []).map((f: any) => [f.key, f]));
  for (const fd of def.fieldDefinitions) {
    const f = byKey.get(fd.key);
    row[FIELD_PREFIX + fd.key] = f ? metafieldToCell(f.type ?? fd.type.name, f.value) : "";
  }
  return row;
}

async function exportMetaobjects(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const search = buildSearchQuery(ctx.options);
  const defs: DefinitionInfo[] = [];
  for await (const d of paginate<DefinitionInfo>(ctx.gql, DEFINITIONS, {}, (data) => data.metaobjectDefinitions)) defs.push(d);
  let n = 0;
  for (const def of defs) {
    ctx.log(`Metaobjects: exporting ${def.name} (${def.type})`);
    for await (const m of ctx.bulk(metaobjectsBulkQuery(def.type, search))) {
      await emit([metaobjectToRow(m, def)]);
      ctx.progress(++n);
      if (ctx.options.limit && n >= ctx.options.limit) return;
    }
  }
}

// --- Import ---------------------------------------------------------------------

const DEFINITION_BY_TYPE = `#graphql
  query ImportMetaobjectDefinition($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id type name
      fieldDefinitions { key name type { name } }
      capabilities { publishable { enabled } }
    }
  }
`;

const METAOBJECT_BY_ID = `#graphql
  query ImportMetaobjectById($id: ID!) {
    metaobject(id: $id) { id handle type }
  }
`;

const METAOBJECT_BY_HANDLE = `#graphql
  query ImportMetaobjectByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) { id handle type }
  }
`;

const METAOBJECT_UPSERT = `#graphql
  mutation ImportMetaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code elementKey }
    }
  }
`;

const METAOBJECT_CREATE = `#graphql
  mutation ImportMetaobjectCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code elementKey }
    }
  }
`;

const METAOBJECT_UPDATE = `#graphql
  mutation ImportMetaobjectUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code elementKey }
    }
  }
`;

const METAOBJECT_DELETE = `#graphql
  mutation ImportMetaobjectDelete($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message code }
    }
  }
`;

interface ExistingMetaobject {
  id: string;
  handle: string;
  type: string;
}

function definitionFor(ctx: ImportContext, type: string): Promise<DefinitionInfo> {
  return cachedPromise(ctx.cache, `metaobjectDefinition:${type}`, async () => {
    const def = (await ctx.gql(DEFINITION_BY_TYPE, { type })).metaobjectDefinitionByType;
    if (!def) throw new ImportError(`Metaobject definition "${type}" not found`);
    return def as DefinitionInfo;
  });
}

/**
 * Field inputs from "Field: <key>" columns. Blank cells clear the field on
 * update and are skipped on create. Values use the definition's field type
 * (list values one per line, as exported). A sheet with several definitions
 * has every definition's columns on every row: blank cells of fields that are
 * not on this row's definition are ignored, filled ones are an error.
 */
function fieldInputs(row: Row, def: DefinitionInfo, creating: boolean): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const header of Object.keys(row)) {
    if (!header.startsWith(FIELD_PREFIX)) continue;
    const key = header.slice(FIELD_PREFIX.length).trim();
    const fd = def.fieldDefinitions.find((f) => f.key === key);
    const v = (row[header] ?? "").trim();
    if (!fd) {
      if (v === "") continue;
      throw new ImportError(`Field "${key}" is not defined on metaobject type "${def.type}"`);
    }
    if (v === "") {
      if (!creating) out.push({ key, value: "" });
      continue;
    }
    out.push({ key, value: cellToMetafieldValue(fd.type.name, v) });
  }
  return out;
}

function capabilities(row: Row, def: DefinitionInfo, notes: string[]): Record<string, any> | undefined {
  const status = cell(row, "Status");
  if (!status) return undefined;
  const s = status.toUpperCase();
  if (s !== "ACTIVE" && s !== "DRAFT") throw new ImportError(`Status must be Active or Draft`);
  if (!def.capabilities.publishable.enabled) {
    notes.push(`Status ignored: "${def.type}" does not have the publishable capability`);
    return undefined;
  }
  return { publishable: { status: s } };
}

async function importOne(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const row = rows[0];
  const id = toGid("Metaobject", cell(row, "ID"));
  const handle = cell(row, "Handle");
  const typeCell = cell(row, "Definition: Type");

  let existing: ExistingMetaobject | null = null;
  if (id) existing = (await ctx.gql(METAOBJECT_BY_ID, { id })).metaobject;
  if (existing && typeCell && existing.type !== typeCell) {
    throw new ImportError(`Metaobject ${gidToId(existing.id)} is of type "${existing.type}", not "${typeCell}"`);
  }
  if (!existing && handle && typeCell) {
    existing = (await ctx.gql(METAOBJECT_BY_HANDLE, { handle: { type: typeCell, handle } })).metaobjectByHandle;
  }
  const type = existing?.type ?? typeCell;
  const needsType = async () => {
    if (!type) throw new ImportError("Definition: Type is required");
    return definitionFor(ctx, type);
  };

  return runCommand(command, existing, {
    what: "Metaobject",
    idOf: (m) => m.id,
    prepare: async () => {
      const def = await needsType();
      const notes: string[] = [];
      const metaobject: Record<string, any> = { fields: fieldInputs(row, def, true) };
      const caps = capabilities(row, def, notes);
      if (caps) metaobject.capabilities = caps;
      return { def, notes, metaobject };
    },
    create: async ({ def, notes, metaobject }) => {
      let created: { id: string; handle: string };
      if (handle) {
        // Upsert by type + handle: safe if another row created it meanwhile.
        const d = await ctx.gql(METAOBJECT_UPSERT, { handle: { type: def.type, handle }, metaobject });
        assertNoUserErrors(d.metaobjectUpsert, "Create metaobject");
        created = d.metaobjectUpsert.metaobject;
      } else {
        const d = await ctx.gql(METAOBJECT_CREATE, { metaobject: { type: def.type, ...metaobject } });
        assertNoUserErrors(d.metaobjectCreate, "Create metaobject");
        created = d.metaobjectCreate.metaobject;
      }
      return { id: created.id, notes, rowPatches: [{ Handle: created.handle }] };
    },
    update: async (m) => {
      const def = await needsType();
      const notes: string[] = [];
      const metaobject: Record<string, any> = {};
      const fields = fieldInputs(row, def, false);
      if (fields.length) metaobject.fields = fields;
      const caps = capabilities(row, def, notes);
      if (caps) metaobject.capabilities = caps;
      if (handle && handle !== m.handle) metaobject.handle = handle;
      if (!Object.keys(metaobject).length) return { id: m.id, notes: ["No changes"] };
      const d = await ctx.gql(METAOBJECT_UPDATE, { id: m.id, metaobject });
      assertNoUserErrors(d.metaobjectUpdate, "Update metaobject");
      return { id: m.id, notes, rowPatches: [{ Handle: d.metaobjectUpdate.metaobject.handle }] };
    },
    remove: async (m) => {
      const d = await ctx.gql(METAOBJECT_DELETE, { id: m.id });
      assertNoUserErrors(d.metaobjectDelete, "Delete metaobject");
    },
  });
}

/**
 * Splits a core item into one group per metaobject. Core groups rows by the
 * first non-empty key column (ID, then Handle) only, so the same handle in two
 * definitions ("red" in `color` and `swatch`) arrives as one item; handles are
 * only unique per type. Rows without ID and Handle continue the previous group.
 */
function splitByType(rows: Row[]): number[][] {
  const groups = new Map<string, number[]>();
  let current: number[] | null = null;
  rows.forEach((row, i) => {
    if (!cell(row, "ID") && !cell(row, "Handle") && current) {
      current.push(i);
      return;
    }
    const key = (cell(row, "Definition: Type") ?? "").toLowerCase();
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(i);
    current = g;
  });
  return [...groups.values()];
}

export async function importMetaobject(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const groups = splitByType(rows);
  if (groups.length === 1) return importOne(ctx, rows, command);

  // Several metaobjects in one item: run each with its own Command cell and
  // combine the results; each group's first row gets its own ID back.
  const fallback = ctx.options.defaultCommand ?? "MERGE";
  const rowPatches: Array<Row | undefined> = new Array(rows.length).fill(undefined);
  const messages: string[] = [];
  const statuses: ItemResult["status"][] = [];
  let firstId: string | undefined;
  for (const [gi, idx] of groups.entries()) {
    const sub = idx.map((i) => rows[i]);
    const label = `${cell(sub[0], "Definition: Type") || "?"}/${cell(sub[0], "Handle") || cell(sub[0], "ID") || ""}`;
    let r: ItemResult;
    try {
      const cmd = gi === 0 ? command : parseCommand(cell(sub[0], "Command"), fallback);
      r = cmd === "IGNORE" ? { status: "Skipped", command: cmd, message: "Command IGNORE" } : await importOne(ctx, sub, cmd);
    } catch (e: any) {
      r = { status: "Failed", command, message: e instanceof ImportError ? e.message : `Error: ${e?.message ?? e}` };
    }
    statuses.push(r.status);
    messages.push(`${label}: ${r.status}${r.message ? ` (${r.message})` : ""}`);
    if (gi === 0) firstId = r.id;
    idx.forEach((ri, j) => {
      const patch: Row = { ...(r.rowPatches?.[j] ?? {}) };
      if (j === 0 && gi > 0 && r.id) patch.ID = gidToId(r.id);
      if (Object.keys(patch).length) rowPatches[ri] = patch;
    });
  }
  const status = statuses.includes("Failed") ? "Failed" : statuses.includes("OK") ? "OK" : "Skipped";
  return { status, command, id: firstId, message: messages.join("; "), rowPatches };
}

export const metaobjectsEntity: Entity = {
  key: "metaobjects",
  sheet: "Metaobjects",
  aliases: ["metaobject"],
  description:
    "Metaobject entries of every definition, one row each, with a \"Field: <key>\" column per field. Definitions are export-only.",
  columns: METAOBJECT_COLUMNS,
  supportsQuery: true,
  export: exportMetaobjects,
  import: { keyColumns: ["ID", "Handle"], apply: importMetaobject },
};

// Exported for tests.
export const _internal = { fieldInputs, splitByType };
