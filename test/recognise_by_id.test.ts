import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runImport } from "../app/lib/core/importer";
import * as registry from "../app/lib/core/registry";
import { detectEntity, detectEntityByIds } from "../app/lib/core/registry";
import { createCsvOut, parseCsv } from "../app/lib/core/sheets";
import type { Entity } from "../app/lib/core/types";
import { ENTITIES } from "../app/lib/entities";
import { variableErrors } from "./_variables";

// The file from the report: only ID and tag columns, and a name that says nothing.
const csv = "ID,Command,Tags,Tags Command\n8170312597741,UPDATE,YGroup_easy-fill-compost-bin,MERGE\n";
const sheet = { name: "compostbinstagtestWW2", ...parseCsv(csv) };

/** A store where the given GIDs exist. */
function store(existing: Record<string, any>) {
  const calls: Array<{ query: string; vars: any }> = [];
  const gql = async (query: string, vars: any = {}) => {
    calls.push({ query, vars });
    if (/ImportRecogniseById/.test(query)) return { nodes: vars.ids.map((id: string) => existing[id] ?? null) };
    throw new Error("unexpected");
  };
  return { gql, calls };
}

describe("recognising a file by its IDs", () => {
  it("can't tell from these columns alone", () => {
    expect(detectEntity(sheet, ENTITIES)).toBeNull();
  });

  it("looks the IDs up and finds they are products", async () => {
    const s = store({ "gid://shopify/Product/8170312597741": { __typename: "Product", id: "gid://shopify/Product/8170312597741" } });
    expect((await detectEntityByIds(s.gql, sheet, ENTITIES))?.key).toBe("products");
    const types = s.calls.map((c) => c.vars.ids[0].split("/")[3]);
    expect(types).toContain("Product");
    expect(types).toContain("Customer");
    expect(types).toContain("Order");
    if (fs.existsSync(".cache/schema/admin_2026-10.json.gz")) expect(variableErrors(s.calls[0].query, s.calls[0].vars)).toEqual([]);
  });

  it("tells customers, orders and the two kinds of collection apart", async () => {
    const by = async (existing: Record<string, any>, headers = sheet.headers) => (await detectEntityByIds(store(existing).gql, { ...sheet, headers }, ENTITIES))?.key ?? null;
    expect(await by({ "gid://shopify/Customer/8170312597741": { __typename: "Customer" } })).toBe("customers");
    expect(await by({ "gid://shopify/Order/8170312597741": { __typename: "Order" } })).toBe("orders");
    const collection = ["ID", "Title"];
    expect(await by({ "gid://shopify/Collection/8170312597741": { __typename: "Collection", ruleSet: { appliedDisjunctively: false } } }, collection)).toBe("smart_collections");
    expect(await by({ "gid://shopify/Collection/8170312597741": { __typename: "Collection", ruleSet: null } }, collection)).toBe("custom_collections");
  });

  it("doesn't guess when the ID is unknown, exists under two types, or there is no ID", async () => {
    expect(await detectEntityByIds(store({}).gql, sheet, ENTITIES)).toBeNull();
    const both = store({ "gid://shopify/Product/8170312597741": { __typename: "Product" }, "gid://shopify/Customer/8170312597741": { __typename: "Customer" } });
    expect(await detectEntityByIds(both.gql, sheet, ENTITIES)).toBeNull();
    const noId = store({});
    expect(await detectEntityByIds(noId.gql, { headers: ["Title", "Tags"], rows: [{ Title: "x", Tags: "y" }] }, ENTITIES)).toBeNull();
    expect(noId.calls).toEqual([]);
    // A type the app may not read is skipped, not fatal.
    const denied = async (q: string, v: any) => {
      if (v.ids[0].includes("/Customer/")) throw new Error("Access denied");
      return { nodes: v.ids.map((id: string) => (id.includes("/Product/") ? { __typename: "Product" } : null)) };
    };
    expect((await detectEntityByIds(denied, sheet, ENTITIES))?.key).toBe("products");
  });

  it("the import then runs the sheet as Products", async () => {
    const applied: string[] = [];
    const entities: Entity[] = ENTITIES.map((e) =>
      e.key === "products" ? { ...e, import: { ...e.import!, apply: async (_ctx, rows, command) => (applied.push(`${command}:${rows[0].ID}:${rows[0].Tags}`), { status: "OK", command }) } } : e,
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-rec-"));
    const logs: string[] = [];
    const s = store({ "gid://shopify/Product/8170312597741": { __typename: "Product" } });
    const [summary] = await runImport({
      ctx: { gql: s.gql as any, options: {}, log: () => {}, cache: new Map() },
      sheets: [sheet],
      entities,
      out: createCsvOut(path.join(dir, "r")),
      log: (m) => logs.push(m),
      progress: () => {},
    });
    expect(summary).toMatchObject({ entity: "products", items: 1, ok: 1, failed: 0 });
    expect(applied).toEqual(["UPDATE:8170312597741:YGroup_easy-fill-compost-bin"]);
    expect(logs.join("\n")).toMatch(/recognised as Products from its IDs/);
  });
});

// The scheduled sheet from the report: order IDs with two order metafields.
const carrier = {
  name: "CarrierNumbers-UploadSheet",
  ...parseCsv("ID,Metafield: custom.courier [single_line_text_field],Metafield: custom.couriercost [number_decimal],Command\n7505575215279,P: DHL Next Day,31.2,Update\n7506047336623,P: DX Freight,28,Update\n"),
};

describe("recognising a file by its metafields", () => {
  const { detectEntityByMetafields } = registry;
  /** A store where these "OWNER namespace.key" metafields are defined. */
  const defs = (defined: string[]) => {
    const calls: any[] = [];
    const gql = async (query: string, v: any) => {
      calls.push({ query, v });
      return { metafieldDefinitions: { nodes: defined.includes(`${v.ownerType} ${v.namespace}.${v.key}`) ? [{ id: "x" }] : [] } };
    };
    return { gql, calls };
  };

  it("picks the data type that has those metafields defined", async () => {
    expect(detectEntity(carrier, ENTITIES)).toBeNull();
    const s = defs(["ORDER custom.courier", "ORDER custom.couriercost"]);
    expect((await detectEntityByMetafields(s.gql, carrier, ENTITIES))?.key).toBe("orders");
    if (fs.existsSync(".cache/schema/admin_2026-10.json.gz")) expect(variableErrors(s.calls[0].query, s.calls[0].v)).toEqual([]);
    expect((await detectEntityByMetafields(defs(["PRODUCT custom.courier", "PRODUCT custom.couriercost", "ORDER custom.courier"]).gql, carrier, ENTITIES))?.key).toBe("products");
  });

  it("doesn't guess when they are defined for two types alike, or not at all", async () => {
    expect(await detectEntityByMetafields(defs(["ORDER custom.courier", "PRODUCT custom.courier"]).gql, carrier, ENTITIES)).toBeNull();
    expect(await detectEntityByMetafields(defs([]).gql, carrier, ENTITIES)).toBeNull();
    const none = defs([]);
    expect(await detectEntityByMetafields(none.gql, sheet, ENTITIES)).toBeNull();
    expect(none.calls).toEqual([]);
  });

  it("the import runs the sheet as Orders: by ID when the orders are found, else by metafield", async () => {
    for (const idsFound of [true, false]) {
      const applied: string[] = [];
      const entities: Entity[] = ENTITIES.map((e) =>
        e.key === "orders" ? { ...e, import: { ...e.import!, apply: async (_c, rows, command) => (applied.push(`${command}:${rows[0].ID}`), { status: "OK", command }) } } : e,
      );
      const logs: string[] = [];
      const gql = async (query: string, v: any) => {
        if (/ImportRecogniseById/.test(query)) return { nodes: v.ids.map((id: string) => (idsFound && id.includes("/Order/") ? { __typename: "Order" } : null)) };
        if (/ImportRecogniseByMetafield/.test(query)) return { metafieldDefinitions: { nodes: v.ownerType === "ORDER" ? [{ id: "x" }] : [] } };
        throw new Error("unexpected");
      };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-rec-"));
      const [summary] = await runImport({
        ctx: { gql: gql as any, options: {}, log: () => {}, cache: new Map() },
        sheets: [carrier],
        entities,
        out: createCsvOut(path.join(dir, "r")),
        log: (m) => logs.push(m),
        progress: () => {},
      });
      expect(summary).toMatchObject({ entity: "orders", items: 2, ok: 2 });
      expect(applied).toEqual(["UPDATE:7505575215279", "UPDATE:7506047336623"]);
      expect(logs.join("\n")).toMatch(idsFound ? /recognised as Orders from its IDs/ : /recognised as Orders from its metafields/);
    }
  });

  it("an unrecognised sheet gives a result file that opens, with the reason", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-rec-"));
    const out = createCsvOut(path.join(dir, "r"));
    const gql = async (query: string, v: any) => (/ById/.test(query) ? { nodes: v.ids.map(() => null) } : { metafieldDefinitions: { nodes: [] } });
    const [summary] = await runImport({ ctx: { gql: gql as any, options: {}, log: () => {}, cache: new Map() }, sheets: [carrier], entities: ENTITIES, out, log: () => {}, progress: () => {} });
    expect(summary).toMatchObject({ entity: null, skipped: 2 });
    const file = await out.close();
    expect(file).toMatch(/\.csv$/);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(/7505575215279,P: DHL Next Day,31.2,Update,Skipped,/);
    expect(text).toMatch(/not recognised, nothing imported/);
    // No sheets at all: still a file that opens, not an empty archive.
    const empty = createCsvOut(path.join(dir, "e"));
    expect(fs.readFileSync(await empty.close(), "utf8")).toMatch(/no sheets with rows/);
  });
});
