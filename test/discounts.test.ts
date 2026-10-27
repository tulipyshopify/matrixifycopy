import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import type { ExportContext, ImportContext, Row } from "../app/lib/core/types";
import { discountToRows, discountsBulkQuery, discountsEntity, importDiscount } from "../app/lib/entities/discounts";
import { groupRows } from "../app/lib/core/importer";

type Handler = (vars: any) => any;

function mockGql(handlers: Record<string, Handler>) {
  const calls: Array<{ op: string; vars: any }> = [];
  const gql = async (query: string, vars: any = {}) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    calls.push({ op, vars });
    const h = handlers[op];
    if (!h) throw new Error(`Unexpected operation ${op}`);
    return h(vars);
  };
  return { gql: gql as any, calls, ops: () => calls.map((c) => c.op) };
}

const importCtx = (gql: any): ImportContext => ({ gql, options: {}, log: () => {}, cache: new Map() });
const ok = { userErrors: [] };

// Reassembled bulk object: codes and metafields are children of the node.
const codeBasicNode = {
  id: "gid://shopify/DiscountCodeNode/100",
  discount: {
    __typename: "DiscountCodeBasic",
    title: "Spring sale",
    status: "ACTIVE",
    startsAt: "2026-03-01T00:00:00Z",
    endsAt: null,
    createdAt: "2026-02-20T00:00:00Z",
    updatedAt: "2026-02-21T00:00:00Z",
    asyncUsageCount: 12,
    summary: "15% off 2 products",
    usageLimit: 100,
    appliesOncePerCustomer: true,
    combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: true },
    context: { __typename: "DiscountCustomerSegments", segments: [{ id: "gid://shopify/Segment/4" }] },
    minimumRequirement: { __typename: "DiscountMinimumSubtotal", greaterThanOrEqualToSubtotal: { amount: "50.0" } },
    customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.15 }, items: { __typename: "DiscountProducts" } },
  },
  codes: [
    { id: "gid://shopify/DiscountRedeemCode/1", code: "SPRING15", asyncUsageCount: 10 },
    { id: "gid://shopify/DiscountRedeemCode/2", code: "SPRING15B", asyncUsageCount: 2 },
  ],
  metafields: [{ namespace: "custom", key: "campaign", type: "single_line_text_field", value: "spring" }],
};

const autoShippingNode = {
  id: "gid://shopify/DiscountAutomaticNode/200",
  discount: {
    __typename: "DiscountAutomaticFreeShipping",
    title: "Free shipping over 100",
    status: "SCHEDULED",
    startsAt: "2026-05-01T00:00:00Z",
    endsAt: "2026-06-01T00:00:00Z",
    asyncUsageCount: 0,
    summary: "Free shipping",
    combinesWith: { orderDiscounts: true, productDiscounts: false, shippingDiscounts: false },
    context: { __typename: "DiscountBuyerSelectionAll", all: "ALL" },
    minimumRequirement: { __typename: "DiscountMinimumQuantity", greaterThanOrEqualToQuantity: "3" },
    destinationSelection: { __typename: "DiscountCountries", countries: ["US", "CA"] },
    maximumShippingPrice: { amount: "20.0" },
  },
};

describe("discounts export", () => {
  it("maps a code discount with codes one per row", () => {
    const items = { __typename: "DiscountProducts", products: { nodes: [{ id: "gid://shopify/Product/1" }, { id: "gid://shopify/Product/2" }] }, productVariants: { nodes: [] } };
    const rows = discountToRows(codeBasicNode, new Set(["codes", "metafields"]), items);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ID: "100",
      Command: "MERGE",
      Title: "Spring sale",
      Type: "Basic",
      Method: "Code",
      Status: "active",
      Code: "SPRING15",
      "Usage Limit": "100",
      "Once Per Customer": "TRUE",
      "Used Count": "12",
      "Combines With": "Product, Shipping",
      "Value Type": "percentage",
      Value: "15",
      "Minimum Requirement": "subtotal",
      "Minimum Requirement Value": "50.0",
      "Applies To": "products",
      "Applies To: Product IDs": "1, 2",
      "Applies To: Variant IDs": "",
      "Customer Selection": "segments",
      "Customer Selection: Segment IDs": "4",
      "Metafield: custom.campaign [single_line_text_field]": "spring",
    });
    expect(rows[1]).toEqual({ ID: "100", "Row #": "2", "Top Row": "FALSE", "Additional Code": "SPRING15B" });
  });

  it("maps an automatic free shipping discount", () => {
    const [row] = discountToRows(autoShippingNode, new Set());
    expect(row).toMatchObject({
      ID: "200",
      Type: "Free Shipping",
      Method: "Automatic",
      Status: "scheduled",
      "Once Per Customer": "",
      "Combines With": "Order",
      "Minimum Requirement": "quantity",
      "Minimum Requirement Value": "3",
      "Customer Selection": "all",
      "Shipping Countries": "US, CA",
      "Maximum Shipping Price": "20.0",
    });
    expect(row.Code).toBeUndefined();
  });

  it("fetches product lists separately during export", async () => {
    const m = mockGql({
      DiscountDetail: (v) => {
        expect(v.id).toBe("gid://shopify/DiscountCodeNode/100");
        return {
          discountNode: {
            id: v.id,
            discount: {
              __typename: "DiscountCodeBasic",
              customerGets: { items: { __typename: "DiscountProducts", products: { nodes: [{ id: "gid://shopify/Product/9" }] }, productVariants: { nodes: [] } } },
            },
          },
        };
      },
    });
    const out: Row[][] = [];
    const queries: string[] = [];
    const ctx: ExportContext = {
      gql: m.gql,
      bulk: (q) => {
        queries.push(q);
        return (async function* () {
          yield codeBasicNode;
          yield autoShippingNode;
        })();
      },
      options: {},
      log: () => {},
      cache: new Map(),
      progress: () => {},
    };
    await discountsEntity.export!(ctx, async (rows) => {
      out.push(rows);
    });
    expect(m.ops()).toEqual(["DiscountDetail"]);
    expect(out[0][0]["Applies To: Product IDs"]).toBe("9");
    expect(out[1][0].Type).toBe("Free Shipping");
    expect(queries[0]).toContain("discountNodes");
  });

  const SCHEMA_FILE = path.resolve(".cache/schema/admin_2026-10.json.gz");
  it.skipIf(!fs.existsSync(SCHEMA_FILE))("bulk export query matches the Admin API schema", () => {
    const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString("utf8"));
    const schema = buildClientSchema(json.data ?? json);
    const q = discountsBulkQuery("status:active", new Set(discountsEntity.groups!.map((g) => g.key)));
    expect(validate(schema, parse(q)).map((e) => e.message)).toEqual([]);
    expect((q.match(/edges\s*\{/g) ?? []).length).toBeLessThanOrEqual(6); // root + 5 connections
  });
});

describe("discounts import", () => {
  it("creates a code Basic discount and queues extra codes", async () => {
    const m = mockGql({
      ImportDiscountByCode: () => ({ codeDiscountNodeByCode: null }),
      ImportDiscountCodeBasicCreate: () => ({ discountCodeBasicCreate: { ...ok, codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/300" } } }),
      ImportDiscountCodesAdd: () => ({ discountRedeemCodeBulkAdd: { ...ok, bulkCreation: { id: "gid://shopify/DiscountRedeemCodeBulkCreation/1" } } }),
    });
    const rows: Row[] = [
      {
        Title: "Ten off",
        Command: "NEW",
        Type: "Basic",
        Method: "Code",
        Code: "TEN",
        "Starts At": "2026-11-01T00:00:00Z",
        "Ends At": "",
        "Usage Limit": "50",
        "Once Per Customer": "TRUE",
        "Combines With": "Shipping",
        "Value Type": "fixed_amount",
        Value: "-10",
        "Minimum Requirement": "subtotal",
        "Minimum Requirement Value": "30",
        "Applies To": "collections",
        "Applies To: Collection IDs": "5, 6",
        "Customer Selection": "customers",
        "Customer Selection: Customer IDs": "8",
      },
      { Code: "TEN-B" },
      { Code: "TEN-C" },
    ];
    const r = await importDiscount(importCtx(m.gql), rows, "NEW");
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/DiscountCodeNode/300", message: "Created; 2 codes queued" });
    expect(m.ops()).toEqual(["ImportDiscountByCode", "ImportDiscountCodeBasicCreate", "ImportDiscountCodesAdd"]);
    expect(m.calls[0].vars).toEqual({ code: "TEN" });
    expect(m.calls[1].vars.input).toEqual({
      title: "Ten off",
      startsAt: "2026-11-01T00:00:00Z",
      combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
      context: { customers: { add: ["gid://shopify/Customer/8"] } },
      minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: "30" } },
      code: "TEN",
      usageLimit: 50,
      appliesOncePerCustomer: true,
      customerGets: {
        value: { discountAmount: { amount: "10", appliesOnEachItem: false } },
        items: { collections: { add: ["gid://shopify/Collection/5", "gid://shopify/Collection/6"] } },
      },
    });
    expect(m.calls[2].vars).toEqual({ discountId: "gid://shopify/DiscountCodeNode/300", codes: [{ code: "TEN-B" }, { code: "TEN-C" }] });
    expect(r.rowPatches).toEqual([{ ID: "300" }, { ID: "300" }, { ID: "300" }]);
  });

  it("creates an automatic Free Shipping discount (MERGE, not found by title)", async () => {
    const m = mockGql({
      ImportDiscountsByTitle: (v) => {
        expect(v.query).toBe('title:"Ship free"');
        return { discountNodes: { nodes: [{ id: "x", discount: { __typename: "DiscountAutomaticBasic", title: "Other" } }] } };
      },
      ImportDiscountAutomaticFreeShippingCreate: () => ({
        discountAutomaticFreeShippingCreate: { ...ok, automaticDiscountNode: { id: "gid://shopify/DiscountAutomaticNode/9" } },
      }),
    });
    const rows: Row[] = [{ Title: "Ship free", Type: "Free Shipping", Method: "Automatic", "Starts At": "2026-11-01", "Shipping Countries": "us, ca", "Maximum Shipping Price": "15" }];
    const r = await importDiscount(importCtx(m.gql), rows, "MERGE");
    expect(r.status).toBe("OK");
    expect(m.calls[1].vars.input).toEqual({
      title: "Ship free",
      startsAt: "2026-11-01",
      destination: { countries: { add: ["US", "CA"] } },
      maximumShippingPrice: "15",
    });
  });

  it("updates an existing code discount found by code, diffing products", async () => {
    const m = mockGql({
      ImportDiscountByCode: () => ({ codeDiscountNodeByCode: { id: "gid://shopify/DiscountCodeNode/100" } }),
      DiscountDetail: () => ({
        discountNode: {
          id: "gid://shopify/DiscountCodeNode/100",
          discount: {
            __typename: "DiscountCodeBasic",
            title: "Spring sale",
            customerGets: {
              items: { __typename: "DiscountProducts", products: { nodes: [{ id: "gid://shopify/Product/1" }, { id: "gid://shopify/Product/2" }] }, productVariants: { nodes: [] } },
            },
            context: { __typename: "DiscountBuyerSelectionAll", all: "ALL" },
            codes: { nodes: [{ code: "SPRING15" }] },
          },
        },
      }),
      ImportDiscountCodeBasicUpdate: () => ({ discountCodeBasicUpdate: { ...ok, codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/100" } } }),
      ImportDiscountCodesAdd: () => ({ discountRedeemCodeBulkAdd: ok }),
    });
    const rows: Row[] = [
      { Code: "spring15", Value: "20", "Value Type": "percentage", "Applies To": "products", "Applies To: Product IDs": "2, 3", "Ends At": "", "Minimum Requirement": "none" },
      { Code: "SPRING20" },
    ];
    const r = await importDiscount(importCtx(m.gql), rows, "UPDATE");
    expect(r).toMatchObject({ status: "OK", message: "Updated; 1 codes queued" });
    expect(m.ops()).toEqual(["ImportDiscountByCode", "DiscountDetail", "ImportDiscountCodeBasicUpdate", "ImportDiscountCodesAdd"]);
    expect(m.calls[2].vars).toEqual({
      id: "gid://shopify/DiscountCodeNode/100",
      input: {
        endsAt: null,
        minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: null }, subtotal: { greaterThanOrEqualToSubtotal: null } },
        customerGets: {
          value: { percentage: 0.2 },
          items: {
            products: {
              productsToAdd: ["gid://shopify/Product/3"],
              productVariantsToAdd: [],
              productsToRemove: ["gid://shopify/Product/1"],
              productVariantsToRemove: [],
            },
          },
        },
      },
    });
    expect(m.calls[3].vars.codes).toEqual([{ code: "SPRING20" }]);
  });

  it("finds by ID with Method and refuses changing the type", async () => {
    const m = mockGql({
      DiscountDetail: (v) => {
        expect(v.id).toBe("gid://shopify/DiscountAutomaticNode/200");
        return { discountNode: { id: v.id, discount: { __typename: "DiscountAutomaticFreeShipping", title: "Free" } } };
      },
    });
    const r = await importDiscount(importCtx(m.gql), [{ ID: "200", Method: "Automatic", Type: "Basic", Value: "5" }], "MERGE");
    expect(r.status).toBe("Failed");
    expect(r.message).toMatch(/use REPLACE/);
  });

  it("skips BxGy discounts with a message", async () => {
    const m = mockGql({
      DiscountDetail: () => ({ discountNode: { id: "gid://shopify/DiscountCodeNode/5", discount: { __typename: "DiscountCodeBxgy", title: "B", codes: { nodes: [] } } } }),
    });
    const r = await importDiscount(importCtx(m.gql), [{ ID: "5", Title: "B" }], "MERGE");
    expect(r).toMatchObject({ status: "Skipped", message: expect.stringMatching(/Buy X Get Y discounts are export-only/) });
  });

  it("deletes an automatic discount, trying both node types when Method is blank", async () => {
    const m = mockGql({
      DiscountDetail: (v) =>
        v.id.includes("DiscountCodeNode")
          ? { discountNode: null }
          : { discountNode: { id: v.id, discount: { __typename: "DiscountAutomaticBasic", title: "A" } } },
      ImportDiscountAutomaticDelete: () => ({ discountAutomaticDelete: { ...ok, deletedAutomaticDiscountId: "x" } }),
    });
    const r = await importDiscount(importCtx(m.gql), [{ ID: "42" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted" });
    expect(m.ops()).toEqual(["DiscountDetail", "DiscountDetail", "ImportDiscountAutomaticDelete"]);
    expect(m.calls[2].vars).toEqual({ id: "gid://shopify/DiscountAutomaticNode/42" });
  });

  it("deletes a code discount found by code", async () => {
    const m = mockGql({
      ImportDiscountByCode: () => ({ codeDiscountNodeByCode: { id: "gid://shopify/DiscountCodeNode/7" } }),
      DiscountDetail: (v) => ({ discountNode: { id: v.id, discount: { __typename: "DiscountCodeFreeShipping", title: "F", codes: { nodes: [{ code: "SHIP" }] } } } }),
      ImportDiscountCodeDelete: () => ({ discountCodeDelete: { ...ok, deletedCodeDiscountId: "x" } }),
    });
    const r = await importDiscount(importCtx(m.gql), [{ Code: "SHIP" }], "DELETE");
    expect(r.status).toBe("OK");
    expect(m.calls[2]).toEqual({ op: "ImportDiscountCodeDelete", vars: { id: "gid://shopify/DiscountCodeNode/7" } });
  });

  // --- Regression tests ---------------------------------------------------------

  const fixedNode = (extra: any = {}) => ({
    discountNode: {
      id: "gid://shopify/DiscountCodeNode/100",
      discount: {
        __typename: "DiscountCodeBasic",
        title: "Ten off",
        customerGets: {
          value: { __typename: "DiscountAmount", amount: { amount: "10.0" }, appliesOnEachItem: true },
          items: { __typename: "AllDiscountItems", allItems: true },
        },
        context: { __typename: "DiscountBuyerSelectionAll", all: "ALL" },
        codes: { nodes: [{ code: "TEN" }] },
        ...extra,
      },
    },
  });

  it("REPLACE with an invalid sheet fails before deleting the discount", async () => {
    const bad: Row[] = [
      { ID: "100", Method: "Code", Title: "Ten off", Code: "TEN", "Value Type": "bogus", Value: "5" },
      { ID: "100", Method: "Code", Code: "TEN", Value: "5" }, // no Title
      { ID: "100", Method: "Code", Title: "Ten off", Code: "TEN" }, // no Value
      { ID: "100", Method: "Code", Title: "Ten off", Code: "TEN", Value: "5", "Metafield: custom.flag [boolean]": "maybe" },
    ];
    for (const row of bad) {
      const m = mockGql({
        DiscountDetail: () => fixedNode(),
        ImportDiscountCodeDelete: () => ({ discountCodeDelete: { ...ok, deletedCodeDiscountId: "x" } }),
      });
      await expect(importDiscount(importCtx(m.gql), [row], "REPLACE")).rejects.toThrow();
      expect(m.ops()).not.toContain("ImportDiscountCodeDelete");
    }
  });

  it("REPLACE builds the input, then deletes and creates", async () => {
    const m = mockGql({
      DiscountDetail: () => fixedNode(),
      ImportDiscountCodeDelete: () => ({ discountCodeDelete: { ...ok, deletedCodeDiscountId: "x" } }),
      ImportDiscountCodeBasicCreate: () => ({ discountCodeBasicCreate: { ...ok, codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/101" } } }),
    });
    const r = await importDiscount(importCtx(m.gql), [{ ID: "100", Method: "Code", Title: "Ten off", Code: "TEN", Value: "5", "Starts At": "2026-01-01" }], "REPLACE");
    expect(r).toMatchObject({ status: "OK", message: "Replaced" });
    expect(m.ops()).toEqual(["DiscountDetail", "ImportDiscountCodeDelete", "ImportDiscountCodeBasicCreate"]);
  });

  it("partial sheet (ID + Value) keeps a fixed amount discount fixed", async () => {
    const m = mockGql({
      DiscountDetail: () => fixedNode(),
      ImportDiscountCodeBasicUpdate: () => ({ discountCodeBasicUpdate: { ...ok, codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/100" } } }),
    });
    const r = await importDiscount(importCtx(m.gql), [{ ID: "100", Method: "Code", Value: "15" }], "MERGE");
    expect(r.status).toBe("OK");
    expect(m.calls[1].vars.input).toEqual({ customerGets: { value: { discountAmount: { amount: "15", appliesOnEachItem: true } } } });
  });

  it("partial sheet keeps a percentage, and changing Value Type requires a Value", async () => {
    const pct = () =>
      fixedNode({ customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 }, items: { __typename: "AllDiscountItems", allItems: true } } });
    const m = mockGql({
      DiscountDetail: pct,
      ImportDiscountCodeBasicUpdate: () => ({ discountCodeBasicUpdate: { ...ok, codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/100" } } }),
    });
    await importDiscount(importCtx(m.gql), [{ ID: "100", Method: "Code", Value: "15", "Applies On Each Item": "" }], "MERGE");
    expect(m.calls[1].vars.input).toEqual({ customerGets: { value: { percentage: 0.15 } } });
    const m2 = mockGql({ DiscountDetail: pct });
    await expect(importDiscount(importCtx(m2.gql), [{ ID: "100", Method: "Code", "Value Type": "fixed_amount" }], "MERGE")).rejects.toThrow(
      /Value is required when changing Value Type/,
    );
  });

  it("changing only Applies On Each Item re-sends the existing amount", async () => {
    const m = mockGql({
      DiscountDetail: () => fixedNode(),
      ImportDiscountCodeBasicUpdate: () => ({ discountCodeBasicUpdate: { ...ok, codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/100" } } }),
    });
    await importDiscount(importCtx(m.gql), [{ ID: "100", Method: "Code", "Applies On Each Item": "FALSE" }], "MERGE");
    expect(m.calls[1].vars.input).toEqual({ customerGets: { value: { discountAmount: { amount: "10", appliesOnEachItem: false } } } });
  });

  it("does not merge new discounts that share a title but have different codes", () => {
    const rows: Row[] = [
      { Title: "Summer", Code: "SUMMER-A", Value: "10" },
      { Title: "Summer", Code: "SUMMER-B", Value: "20" },
      { "Additional Code": "SUMMER-B2" },
    ];
    const items = groupRows(rows, discountsEntity.import!.keyColumns);
    expect(items.map((i) => i.rows.length)).toEqual([1, 2]);
  });

  it("export -> import round-trip keeps extra codes on one item, with or without the ID column", async () => {
    const items0 = { __typename: "DiscountProducts", products: { nodes: [{ id: "gid://shopify/Product/1" }] }, productVariants: { nodes: [] } };
    const exported = discountToRows(codeBasicNode, new Set(["codes"]), items0);
    expect(groupRows(exported, discountsEntity.import!.keyColumns)).toHaveLength(1);
    const noIds = exported.map(({ ID: _id, ...rest }) => rest as Row);
    const items = groupRows(noIds, discountsEntity.import!.keyColumns);
    expect(items).toHaveLength(1);

    const m = mockGql({
      ImportDiscountByCode: () => ({ codeDiscountNodeByCode: null }),
      ImportDiscountCodeBasicCreate: () => ({ discountCodeBasicCreate: { ...ok, codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/300" } } }),
      ImportDiscountCodesAdd: () => ({ discountRedeemCodeBulkAdd: ok }),
    });
    const r = await importDiscount(importCtx(m.gql), items[0].rows, "NEW");
    expect(r.status).toBe("OK");
    expect(m.calls[1].vars.input.code).toBe("SPRING15");
    expect(m.calls[2].vars.codes).toEqual([{ code: "SPRING15B" }]);
  });

  it("fails when a continuation row has its own Value or Type", async () => {
    const m = mockGql({ ImportDiscountByCode: () => ({ codeDiscountNodeByCode: null }) });
    const rows: Row[] = [
      { Title: "Summer", Code: "A", Value: "10", "Value Type": "percentage" },
      { Value: "20", "Additional Code": "B" },
    ];
    await expect(importDiscount(importCtx(m.gql), rows, "NEW")).rejects.toThrow(/own Value "20"/);
    const rows2: Row[] = [{ Title: "Auto", Type: "Basic", Value: "10" }, { Title: "Auto", Type: "Free Shipping" }];
    await expect(importDiscount(importCtx(m.gql), rows2, "NEW")).rejects.toThrow(/own Type/);
    expect(m.ops()).toEqual([]);
  });

  it("finds an automatic discount by exact title past other matches on later pages", async () => {
    const m = mockGql({
      ImportDiscountsByTitle: (v) =>
        v.after
          ? {
              discountNodes: {
                nodes: [{ id: "gid://shopify/DiscountAutomaticNode/7", discount: { __typename: "DiscountAutomaticBasic", title: "Sale" } }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            }
          : {
              discountNodes: {
                nodes: Array.from({ length: 250 }, (_, i) => ({ id: `x${i}`, discount: { __typename: "DiscountAutomaticBasic", title: `Sale ${i}` } })),
                pageInfo: { hasNextPage: true, endCursor: "c1" },
              },
            },
      DiscountDetail: (v) => ({ discountNode: { id: v.id, discount: { __typename: "DiscountAutomaticBasic", title: "Sale" } } }),
      ImportDiscountAutomaticDelete: () => ({ discountAutomaticDelete: { ...ok, deletedAutomaticDiscountId: "x" } }),
    });
    const r = await importDiscount(importCtx(m.gql), [{ Title: "Sale" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/DiscountAutomaticNode/7" });
    expect(m.calls[1].vars).toMatchObject({ after: "c1" });
  });

  it("reads product lists past 250 (export and update diff)", async () => {
    const page1 = Array.from({ length: 250 }, (_, i) => ({ id: `gid://shopify/Product/${i + 1}` }));
    const detail = (v: any) => ({
      discountNode: {
        id: v.id,
        discount: {
          __typename: "DiscountCodeBasic",
          title: "Big",
          customerGets: {
            value: { __typename: "DiscountPercentage", percentage: 0.1 },
            items: {
              __typename: "DiscountProducts",
              products: { nodes: page1, pageInfo: { hasNextPage: true, endCursor: "p1" } },
              productVariants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
          context: { __typename: "DiscountBuyerSelectionAll", all: "ALL" },
          codes: { nodes: [{ code: "BIG" }] },
        },
      },
    });
    const itemsPage = (v: any) => {
      expect(v).toMatchObject({ after: "p1", products: true, variants: false, collections: false });
      return {
        discountNode: {
          id: v.id,
          discount: {
            __typename: "DiscountCodeBasic",
            customerGets: { items: { products: { nodes: [{ id: "gid://shopify/Product/251" }], pageInfo: { hasNextPage: false, endCursor: null } } } },
          },
        },
      };
    };

    // Export: all 251 products.
    const m = mockGql({ DiscountDetail: detail, DiscountItemsPage: itemsPage });
    const out: Row[][] = [];
    const ctx: ExportContext = {
      gql: m.gql,
      bulk: () =>
        (async function* () {
          yield codeBasicNode;
        })(),
      options: { groups: ["codes"] },
      log: () => {},
      cache: new Map(),
      progress: () => {},
    };
    await discountsEntity.export!(ctx, async (rows) => {
      out.push(rows);
    });
    expect(out[0][0]["Applies To: Product IDs"].split(", ")).toHaveLength(251);

    // Update: product 251 is already there, so nothing is added or removed.
    const m2 = mockGql({
      DiscountDetail: detail,
      DiscountItemsPage: itemsPage,
      ImportDiscountCodeBasicUpdate: () => ({ discountCodeBasicUpdate: { ...ok, codeDiscountNode: { id: "x" } } }),
    });
    const ids = Array.from({ length: 251 }, (_, i) => String(i + 1)).join(", ");
    await importDiscount(importCtx(m2.gql), [{ ID: "100", Method: "Code", "Applies To": "products", "Applies To: Product IDs": ids }], "MERGE");
    const products = m2.calls.find((c) => c.op === "ImportDiscountCodeBasicUpdate")!.vars.input.customerGets.items.products;
    expect(products).toEqual({ productsToAdd: [], productVariantsToAdd: [], productsToRemove: [], productVariantsToRemove: [] });
  });
});
