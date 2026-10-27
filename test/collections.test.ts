import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { collectionToRows, customCollectionsEntity, smartCollectionsEntity } from "../app/lib/entities/collections";
import type { Entity, ExportContext, ImportContext } from "../app/lib/core/types";

// --- Mock gql: answers by operation name and records every call. ---------------

type Handler = (vars: any) => any;

function mockGql(handlers: Record<string, Handler>) {
  const calls: Array<{ op: string; vars: any }> = [];
  const gql = async (query: string, vars?: any) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    calls.push({ op, vars });
    const h = handlers[op];
    if (!h) throw new Error(`Unexpected operation ${op}`);
    return h(vars ?? {});
  };
  const ctx: ImportContext = { gql: gql as any, options: {}, log: () => {}, cache: new Map() };
  const of = (op: string) => calls.filter((c) => c.op === op);
  return { ctx, calls, of };
}

const ok = { userErrors: [] };
const publications = () => ({ publications: { nodes: [{ id: "gid://shopify/Publication/9", name: "Online Store", catalog: { title: "Online Store" } }] } });

// --- Export --------------------------------------------------------------------------

describe("collections export", () => {
  const groups = new Set(["metafields", "seo", "products"]);

  it("maps a smart collection to one row per rule", () => {
    const rows = collectionToRows(
      {
        id: "gid://shopify/Collection/11",
        handle: "sale",
        title: "Sale",
        descriptionHtml: "<p>Hi</p>",
        sortOrder: "BEST_SELLING",
        templateSuffix: null,
        updatedAt: "2026-01-01T00:00:00Z",
        image: { url: "https://cdn/x.jpg", altText: "alt" },
        seo: { title: "S", description: "D" },
        productsCount: { count: 4 },
        ruleSet: {
          appliedDisjunctively: true,
          rules: [
            { column: "TAG", relation: "EQUALS", condition: "sale" },
            { column: "VARIANT_PRICE", relation: "LESS_THAN", condition: "10" },
          ],
        },
        publications: [{ isPublished: true, publishDate: "2026-01-02T00:00:00Z", publication: { id: "p", catalog: { title: "Online Store" } } }],
        metafields: [{ namespace: "custom", key: "color", type: "single_line_text_field", value: "red" }],
      },
      "smart",
      groups,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ID: "11",
      Handle: "sale",
      Command: "MERGE",
      Title: "Sale",
      "Sort Order": "best-selling",
      Published: "TRUE",
      "Published At": "2026-01-02T00:00:00Z",
      "Image Src": "https://cdn/x.jpg",
      "Image Alt Text": "alt",
      "SEO Title": "S",
      "Products Count": "4",
      "Must Match": "any condition",
      "Rule: Product Column": "tag",
      "Rule: Relation": "equals",
      "Rule: Condition": "sale",
      "Metafield: custom.color [single_line_text_field]": "red",
    });
    expect(rows[1]).toEqual({
      ID: "11",
      Handle: "sale",
      "Rule: Product Column": "variant_price",
      "Rule: Relation": "less_than",
      "Rule: Condition": "10",
      "Rule: Condition Object ID": "",
    });
  });

  it("maps a custom collection to one row per product", () => {
    const rows = collectionToRows(
      {
        id: "gid://shopify/Collection/12",
        handle: "picks",
        title: "Picks",
        sortOrder: "MANUAL",
        productsCount: { count: 2 },
        products: [
          { id: "gid://shopify/Product/1", handle: "a" },
          { id: "gid://shopify/Product/2", handle: "b" },
        ],
      },
      "custom",
      groups,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ID: "12", Published: "FALSE", "Sort Order": "manual", "Product: ID": "1", "Product: Position": "1" });
    expect(rows[1]).toEqual({ ID: "12", Handle: "picks", "Product: ID": "2", "Product: Handle": "b", "Product: Position": "2", "Product Command": "MERGE" });
  });

  it("filters by collection type in the bulk query", async () => {
    const queries: string[] = [];
    const ctx: ExportContext = {
      gql: (async () => ({})) as any,
      bulk: (q) => {
        queries.push(q);
        return (async function* () {})();
      },
      options: { query: "title:x" },
      log: () => {},
      cache: new Map(),
      progress: () => {},
    };
    await smartCollectionsEntity.export!(ctx, async () => {});
    await customCollectionsEntity.export!(ctx, async () => {});
    expect(queries[0]).toContain(`"collection_type:smart AND ((title:x))"`);
    expect(queries[0]).toContain("ruleSet");
    expect(queries[1]).toContain("collection_type:custom");
    expect(queries[1]).toContain("products { edges");
  });
});

// --- Import ---------------------------------------------------------------------------

const existingSmart = {
  id: "gid://shopify/Collection/11",
  handle: "sale",
  title: "Sale",
  sortOrder: "BEST_SELLING",
  image: null,
  ruleSet: { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "old" }] },
};

const existingCustom = { id: "gid://shopify/Collection/12", handle: "picks", title: "Picks", sortOrder: "MANUAL", image: null, ruleSet: null };

describe("smart collections import", () => {
  it("MERGE creates when missing, with rules", async () => {
    const m = mockGql({
      ImportCollectionByHandle: () => ({ collectionByIdentifier: null }),
      ImportCollectionCreate: () => ({ collectionCreate: { collection: { id: "gid://shopify/Collection/99", handle: "new" }, ...ok } }),
      Publications: publications,
      Publish: () => ({ publishablePublish: ok }),
    });
    const r = await smartCollectionsEntity.import!.apply(
      m.ctx,
      [
        {
          Handle: "new",
          Title: "New",
          "Sort Order": "price-desc",
          "Must Match": "any condition",
          "Rule: Product Column": "tag",
          "Rule: Relation": "equals",
          "Rule: Condition": "a",
          Published: "TRUE",
          "Metafield: custom.x [single_line_text_field]": "y",
        },
        { Handle: "new", "Rule: Product Column": "vendor", "Rule: Relation": "not_equals", "Rule: Condition": "Acme" },
      ],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Collection/99", message: "Created" });
    expect(m.of("ImportCollectionCreate")[0].vars.input).toEqual({
      title: "New",
      handle: "new",
      sortOrder: "PRICE_DESC",
      metafields: [{ namespace: "custom", key: "x", type: "single_line_text_field", value: "y" }],
      ruleSet: {
        appliedDisjunctively: true,
        rules: [
          { column: "TAG", relation: "EQUALS", condition: "a" },
          { column: "VENDOR", relation: "NOT_EQUALS", condition: "Acme" },
        ],
      },
    });
    expect(m.of("Publish")[0].vars).toEqual({ id: "gid://shopify/Collection/99", input: [{ publicationId: "gid://shopify/Publication/9" }] });
  });

  it("MERGE updates an existing collection and replaces rules", async () => {
    const m = mockGql({
      ImportCollectionById: () => ({ collection: existingSmart }),
      ImportCollectionUpdate: () => ({ collectionUpdate: { collection: { id: existingSmart.id, handle: "sale", sortOrder: "BEST_SELLING" }, ...ok } }),
    });
    const r = await smartCollectionsEntity.import!.apply(
      m.ctx,
      [{ ID: "11", Handle: "sale", Title: "Sale 2", "Rule: Product Column": "title", "Rule: Relation": "contains", "Rule: Condition": "shirt" }],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", command: "MERGE", message: "Updated" });
    expect(m.of("ImportCollectionById")[0].vars).toEqual({ id: "gid://shopify/Collection/11" });
    expect(m.of("ImportCollectionUpdate")[0].vars.input).toEqual({
      id: existingSmart.id,
      title: "Sale 2",
      ruleSet: { appliedDisjunctively: false, rules: [{ column: "TITLE", relation: "CONTAINS", condition: "shirt" }] },
    });
  });

  it("Must Match alone keeps the existing rules", async () => {
    const m = mockGql({
      ImportCollectionById: () => ({ collection: existingSmart }),
      ImportCollectionUpdate: () => ({ collectionUpdate: { collection: existingSmart, ...ok } }),
    });
    await smartCollectionsEntity.import!.apply(m.ctx, [{ ID: "11", "Must Match": "any condition" }], "UPDATE");
    expect(m.of("ImportCollectionUpdate")[0].vars.input.ruleSet).toEqual({
      appliedDisjunctively: true,
      rules: [{ column: "TAG", relation: "EQUALS", condition: "old" }],
    });
  });

  it("DELETE removes an existing collection and fails when missing", async () => {
    const m = mockGql({
      ImportCollectionById: (v) => ({ collection: v.id === existingSmart.id ? existingSmart : null }),
      ImportCollectionDelete: () => ({ collectionDelete: { deletedCollectionId: existingSmart.id, ...ok } }),
    });
    const r = await smartCollectionsEntity.import!.apply(m.ctx, [{ ID: "11" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted" });
    expect(m.of("ImportCollectionDelete")[0].vars).toEqual({ id: existingSmart.id });
    const r2 = await smartCollectionsEntity.import!.apply(m.ctx, [{ ID: "5" }], "DELETE");
    expect(r2.status).toBe("Failed");
  });

  it("refuses to MERGE a smart sheet row into a custom collection", async () => {
    const m = mockGql({ ImportCollectionById: () => ({ collection: existingCustom }) });
    const r = await smartCollectionsEntity.import!.apply(m.ctx, [{ ID: "12", Title: "x" }], "MERGE");
    expect(r.status).toBe("Failed");
  });
});

describe("custom collections import", () => {
  it("NEW creates with the exact product list in position order", async () => {
    const m = mockGql({
      ImportCollectionByHandle: () => ({ collectionByIdentifier: null }),
      ImportCollectionProductByHandle: (v) => ({ productByIdentifier: v.handle === "b" ? { id: "gid://shopify/Product/2" } : null }),
      ImportCollectionCreate: () => ({ collectionCreate: { collection: { id: "gid://shopify/Collection/50", handle: "picks" }, ...ok } }),
    });
    const r = await customCollectionsEntity.import!.apply(
      m.ctx,
      [
        { Handle: "picks", Title: "Picks", "Sort Order": "manual", "Product: ID": "1", "Product: Position": "2" },
        { Handle: "picks", "Product: Handle": "b", "Product: Position": "1" },
      ],
      "NEW",
    );
    expect(r.status).toBe("OK");
    expect(m.of("ImportCollectionCreate")[0].vars.input).toEqual({
      title: "Picks",
      handle: "picks",
      sortOrder: "MANUAL",
      products: ["gid://shopify/Product/2", "gid://shopify/Product/1"],
    });
  });

  it("MERGE adds and DELETE removes products on an existing collection", async () => {
    const m = mockGql({
      ImportCollectionById: () => ({ collection: existingCustom }),
      ImportCollectionProductIds: () => ({
        collection: { products: { nodes: [{ id: "gid://shopify/Product/1" }, { id: "gid://shopify/Product/2" }], pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
      ImportCollectionAddProducts: () => ({ collectionAddProducts: ok }),
      ImportCollectionRemoveProducts: () => ({ collectionRemoveProducts: { job: { id: "j" }, ...ok } }),
      ImportCollectionReorder: () => ({ collectionReorderProducts: { job: { id: "j2" }, ...ok } }),
    });
    const r = await customCollectionsEntity.import!.apply(
      m.ctx,
      [
        { ID: "12", "Product: ID": "1", "Product Command": "MERGE" },
        { ID: "12", "Product: ID": "2", "Product Command": "DELETE" },
        { ID: "12", "Product: ID": "3", "Product Command": "MERGE", "Product: Position": "1" },
      ],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", message: "Updated; 1 products added; 1 products removed" });
    expect(m.of("ImportCollectionUpdate")).toHaveLength(0);
    expect(m.of("ImportCollectionRemoveProducts")[0].vars).toEqual({ id: existingCustom.id, productIds: ["gid://shopify/Product/2"] });
    expect(m.of("ImportCollectionAddProducts")[0].vars).toEqual({ id: existingCustom.id, productIds: ["gid://shopify/Product/3"] });
    expect(m.of("ImportCollectionReorder")[0].vars).toEqual({ id: existingCustom.id, moves: [{ id: "gid://shopify/Product/3", newPosition: "0" }] });
  });

  it("Product Command REPLACE removes products not in the sheet", async () => {
    const m = mockGql({
      ImportCollectionById: () => ({ collection: existingCustom }),
      ImportCollectionProductIds: () => ({
        collection: { products: { nodes: [{ id: "gid://shopify/Product/1" }, { id: "gid://shopify/Product/2" }], pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
      ImportCollectionRemoveProducts: () => ({ collectionRemoveProducts: { job: null, ...ok } }),
    });
    await customCollectionsEntity.import!.apply(m.ctx, [{ ID: "12", "Product: ID": "1", "Product Command": "REPLACE" }], "MERGE");
    expect(m.of("ImportCollectionRemoveProducts")[0].vars.productIds).toEqual(["gid://shopify/Product/2"]);
    expect(m.of("ImportCollectionAddProducts")).toHaveLength(0);
  });
});

// --- Schema validation of the bulk export queries ----------------------------------------

const SCHEMA_FILE = path.resolve(".cache/schema/admin_2026-10.json.gz");

describe.skipIf(!fs.existsSync(SCHEMA_FILE))("collections bulk queries match the schema", () => {
  const schema = fs.existsSync(SCHEMA_FILE)
    ? buildClientSchema(((j) => j.data ?? j)(JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString("utf8"))))
    : (null as any);
  const validateExport = async (entity: Entity) => {
    const queries: string[] = [];
    const ctx: ExportContext = {
      gql: async () => {
        throw new Error("STOP");
      },
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
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(validate(schema, parse(q)).map((e) => e.message), q).toEqual([]);
  };
  it("smart", () => validateExport(smartCollectionsEntity));
  it("custom", () => validateExport(customCollectionsEntity));
});
