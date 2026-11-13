import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assemble } from "../app/lib/core/bulk";
import { runExport } from "../app/lib/core/exporter";
import { createCsvOut, createXlsxOut, readWorkbook } from "../app/lib/core/sheets";
import { getEntity } from "../app/lib/entities";
import { variableErrors } from "./_variables";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-mf-"));
async function* lines(arr: object[]) {
  for (const o of arr) yield JSON.stringify(o);
}

// What Shopify's bulk export returns: one JSON line per object, children pointing at their parent.
const P1 = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";
const V1 = "gid://shopify/ProductVariant/11";
const jsonl = [
  { id: P1, handle: "bin", title: "Bin", status: "ACTIVE" },
  { id: "gid://shopify/Metafield/1", namespace: "custom", key: "material", type: "single_line_text_field", value: "Steel", __parentId: P1 },
  { id: "gid://shopify/Metafield/2", namespace: "custom", key: "colours", type: "list.single_line_text_field", value: '["Red","Blue"]', __parentId: P1 },
  { id: V1, title: "Default", sku: "BIN-1", selectedOptions: [], inventoryItem: { id: "gid://shopify/InventoryItem/1" }, __parentId: P1 },
  { id: "gid://shopify/Metafield/3", namespace: "custom", key: "pre_order", type: "boolean", value: "true", __parentId: V1 },
  { id: P2, handle: "lid", title: "Lid", status: "ACTIVE" },
];

const definitions: Record<string, Array<[string, string, string]>> = {
  PRODUCT: [["custom", "material", "single_line_text_field"], ["custom", "care", "multi_line_text_field"], ["custom", "warranty_years", "number_integer"]],
  PRODUCTVARIANT: [["custom", "pre_order", "boolean"], ["custom", "restock_date", "date"]],
};
const calls: Array<{ query: string; vars: any }> = [];
const gql = (async (query: string, vars: any) => {
  calls.push({ query, vars });
  if (!/ExportMetafieldDefinitions/.test(query)) return {};
  return { metafieldDefinitions: { nodes: (definitions[vars.ownerType] ?? []).map(([namespace, key, name]) => ({ namespace, key, type: { name } })), pageInfo: { hasNextPage: false } } };
}) as any;

async function exportProducts(options: Record<string, any>, format: "csv" | "xlsx" = "csv", gqlImpl = gql) {
  const dir = tmp();
  const out = format === "csv" ? createCsvOut(path.join(dir, "e")) : createXlsxOut(path.join(dir, "e.xlsx"));
  await runExport({
    gql: gqlImpl,
    bulk: () => assemble(lines(jsonl)),
    requests: [{ entity: getEntity("products")!, options: { v: 2, groups: ["variants", "metafields", "variant_metafields"], ...options } }],
    out,
    tmpDir: dir,
    log: () => {},
  });
  const [sheet] = await readWorkbook(await out.close());
  return sheet;
}

describe("metafields in exports", () => {
  it("writes the values, and lists defined metafields that have none", async () => {
    for (const format of ["csv", "xlsx"] as const) {
      const sheet = await exportProducts({}, format);
      const mf = sheet.headers.filter((h) => /Metafield: /.test(h));
      expect(mf, format).toEqual([
        "Metafield: custom.care [multi_line_text_field]", // defined, no value anywhere
        "Metafield: custom.colours [list.single_line_text_field]", // has a value, no definition
        "Metafield: custom.material [single_line_text_field]",
        "Metafield: custom.warranty_years [number_integer]",
        "Variant Metafield: custom.pre_order [boolean]",
        "Variant Metafield: custom.restock_date [date]",
      ]);
      const bin = sheet.rows.find((r) => r.Handle === "bin" && r["Metafield: custom.material [single_line_text_field]"])!;
      expect(bin["Metafield: custom.material [single_line_text_field]"]).toBe("Steel");
      expect(bin["Metafield: custom.colours [list.single_line_text_field]"]).toBe("Red\nBlue");
      expect(bin["Metafield: custom.care [multi_line_text_field]"] ?? "").toBe("");
      expect(sheet.rows.find((r) => r["Variant SKU"] === "BIN-1")!["Variant Metafield: custom.pre_order [boolean]"]).toMatch(/^true$/i);
      const lid = sheet.rows.find((r) => r.Handle === "lid")!;
      expect(lid["Metafield: custom.material [single_line_text_field]"] ?? "").toBe("");
    }
  });

  it("keeps to the named metafields, adding named ones that don't exist yet", async () => {
    const sheet = await exportProducts({ metafields: ["custom.care", "custom.material", "custom.brand_new"], variantMetafields: ["custom.restock_date"] });
    expect(sheet.headers.filter((h) => /Metafield: /.test(h))).toEqual([
      "Metafield: custom.brand_new [single_line_text_field]",
      "Metafield: custom.care [multi_line_text_field]",
      "Metafield: custom.material [single_line_text_field]",
      "Variant Metafield: custom.restock_date [date]",
    ]);
  });

  it("leaves them out when metafields are switched off, and survives a refused definitions query", async () => {
    const off = await exportProducts({ groups: ["variants"] });
    expect(off.headers.filter((h) => /Metafield: /.test(h))).toEqual([]);
    const refused = await exportProducts({}, "csv", (async () => {
      throw new Error("Access denied");
    }) as any);
    expect(refused.headers.filter((h) => /Metafield: /.test(h))).toEqual([
      "Metafield: custom.colours [list.single_line_text_field]",
      "Metafield: custom.material [single_line_text_field]",
      "Variant Metafield: custom.pre_order [boolean]",
    ]);
  });

  it.skipIf(!fs.existsSync(".cache/schema/admin_2026-10.json.gz"))("asks Shopify for definitions with valid variables", () => {
    const c = calls.find((x) => /ExportMetafieldDefinitions/.test(x.query))!;
    expect(variableErrors(c.query, c.vars)).toEqual([]);
    expect(calls.filter((x) => /ExportMetafieldDefinitions/.test(x.query)).map((x) => x.vars.ownerType)).toContain("PRODUCTVARIANT");
  });
});
