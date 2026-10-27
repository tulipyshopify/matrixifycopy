import { describe, expect, it } from "vitest";
import { metaobjectsEntity } from "../app/lib/entities/metaobjects";
import { exportCtx, hasSchema, importCtx, mockGql, runExport, schemaErrors } from "./_content_test_helpers";

const ok = { userErrors: [] };
const DEF = {
  id: "gid://shopify/MetaobjectDefinition/1",
  type: "designer",
  name: "Designer",
  fieldDefinitions: [
    { key: "name", name: "Name", type: { name: "single_line_text_field" } },
    { key: "skills", name: "Skills", type: { name: "list.single_line_text_field" } },
    { key: "age", name: "Age", type: { name: "number_integer" } },
  ],
  capabilities: { publishable: { enabled: true } },
};
const MO = {
  id: "gid://shopify/Metaobject/40",
  handle: "ada",
  type: "designer",
  displayName: "Ada",
  updatedAt: "2026-02-01T00:00:00Z",
  capabilities: { publishable: { status: "ACTIVE" } },
  fields: [
    { key: "name", type: "single_line_text_field", value: "Ada" },
    { key: "skills", type: "list.single_line_text_field", value: '["math","code"]' },
    { key: "age", type: "number_integer", value: null },
  ],
};
const defs = { metaobjectDefinitions: { nodes: [DEF], pageInfo: { hasNextPage: false, endCursor: null } } };

describe("metaobjects export", () => {
  it("exports every definition's metaobjects, one column per field", async () => {
    const m = mockGql({ MetaobjectDefinitionsList: defs });
    const { ctx, bulkQueries } = exportCtx(m.gql, [MO]);
    const rows = await runExport(metaobjectsEntity, ctx);
    expect(bulkQueries[0]).toContain('metaobjects(type: "designer")');
    expect(rows).toEqual([
      {
        ID: "40",
        Handle: "ada",
        Command: "MERGE",
        "Definition: Type": "designer",
        "Definition: Name": "Designer",
        "Display Name": "Ada",
        Status: "Active",
        "Updated At": "2026-02-01T00:00:00Z",
        "Field: name": "Ada",
        "Field: skills": "math\ncode",
        "Field: age": "",
      },
    ]);
  });

  it.skipIf(!hasSchema)("export queries match the schema", async () => {
    const m = mockGql({ MetaobjectDefinitionsList: defs });
    const { ctx, bulkQueries } = exportCtx(m.gql, [], { query: "display_name:x", updatedAfter: "2026-01-01" });
    await runExport(metaobjectsEntity, ctx);
    const queries = [...m.calls.map((c) => c.query), ...bulkQueries];
    expect(bulkQueries.length).toBe(1);
    for (const q of queries) expect(schemaErrors(q), q).toEqual([]);
  });
});

describe("metaobjects import", () => {
  const handlers = {
    ImportMetaobjectDefinition: { metaobjectDefinitionByType: DEF },
    ImportMetaobjectById: (v: any) => ({ metaobject: v.id === MO.id ? { id: MO.id, handle: "ada", type: "designer" } : null }),
    ImportMetaobjectByHandle: (v: any) => ({ metaobjectByHandle: v.handle.handle === "ada" ? { id: MO.id, handle: "ada", type: "designer" } : null }),
  };

  it("creates via upsert (type + handle), converting list cells", async () => {
    const m = mockGql({
      ...handlers,
      ImportMetaobjectUpsert: { metaobjectUpsert: { ...ok, metaobject: { id: "gid://shopify/Metaobject/41", handle: "grace" } } },
    });
    const r = await metaobjectsEntity.import!.apply(
      importCtx(m.gql),
      [{ Handle: "grace", "Definition: Type": "designer", Status: "Draft", "Field: name": "Grace", "Field: skills": "navy\ncobol", "Field: age": "" }],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Metaobject/41", message: "Created" });
    expect(m.call("ImportMetaobjectUpsert")!.vars).toEqual({
      handle: { type: "designer", handle: "grace" },
      metaobject: {
        fields: [
          { key: "name", value: "Grace" },
          { key: "skills", value: '["navy","cobol"]' },
        ],
        capabilities: { publishable: { status: "DRAFT" } },
      },
    });
  });

  it("creates without handle via metaobjectCreate", async () => {
    const m = mockGql({
      ...handlers,
      ImportMetaobjectCreate: { metaobjectCreate: { ...ok, metaobject: { id: "gid://shopify/Metaobject/42", handle: "designer-x" } } },
    });
    const r = await metaobjectsEntity.import!.apply(importCtx(m.gql), [{ "Definition: Type": "designer", "Field: name": "X" }], "NEW");
    expect(r.rowPatches).toEqual([{ Handle: "designer-x" }]);
    expect(m.call("ImportMetaobjectCreate")!.vars).toEqual({ metaobject: { type: "designer", fields: [{ key: "name", value: "X" }] } });
  });

  it("updates by ID: blank cells clear fields, handle renamed", async () => {
    const m = mockGql({
      ...handlers,
      ImportMetaobjectUpdate: { metaobjectUpdate: { ...ok, metaobject: { id: MO.id, handle: "ada-l" } } },
    });
    const r = await metaobjectsEntity.import!.apply(
      importCtx(m.gql),
      [{ ID: "40", Handle: "ada-l", "Field: age": "36", "Field: skills": "" }],
      "UPDATE",
    );
    expect(r).toMatchObject({ status: "OK", message: "Updated" });
    expect(m.call("ImportMetaobjectUpdate")!.vars).toEqual({
      id: MO.id,
      metaobject: { fields: [{ key: "age", value: "36" }, { key: "skills", value: "" }], handle: "ada-l" },
    });
  });

  it("rejects unknown fields", async () => {
    const m = mockGql(handlers);
    await expect(
      metaobjectsEntity.import!.apply(importCtx(m.gql), [{ Handle: "ada", "Definition: Type": "designer", "Field: nope": "1" }], "MERGE"),
    ).rejects.toThrow(/nope/);
  });

  it("deletes by type + handle", async () => {
    const m = mockGql({ ...handlers, ImportMetaobjectDelete: { metaobjectDelete: { ...ok, deletedId: MO.id } } });
    const r = await metaobjectsEntity.import!.apply(importCtx(m.gql), [{ Handle: "ada", "Definition: Type": "designer" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted", id: MO.id });
    expect(m.call("ImportMetaobjectByHandle")!.vars).toEqual({ handle: { type: "designer", handle: "ada" } });
    expect(m.call("ImportMetaobjectDelete")!.vars).toEqual({ id: MO.id });
  });
});
