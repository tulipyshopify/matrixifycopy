import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runImport } from "../app/lib/core/importer";
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
