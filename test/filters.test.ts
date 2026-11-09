import { describe, expect, it } from "vitest";
import { buildSearchQuery, compileFilters } from "../app/lib/core/util";
import { selectColumns } from "../app/lib/core/exporter";
import { ENTITIES, getEntity } from "../app/lib/entities";
import { FILTER_OPS } from "../app/lib/core/types";

// jobs.server imports prisma; load it lazily so prisma isn't needed for these tests.
const { parseExportConfig, parseFilters } = await import("../app/lib/jobs/jobs.server");

describe("filter compilation", () => {
  it("compiles each operator to Shopify search syntax", () => {
    expect(
      compileFilters([
        { field: "vendor", op: "is", value: "Acme Ltd" },
        { field: "tag", op: "is_not", value: "hidden" },
        { field: "title", op: "starts_with", value: "Blue shirt" },
        { field: "status", op: "any_of", value: "active,draft" },
        { field: "inventory_total", op: "lt", value: "5" },
        { field: "updated_at", op: "gte", value: "2026-01-01" },
        { field: "price", op: "between", value: "10", value2: "20.5" },
        { field: "gift_card", op: "is", value: "false" },
      ]),
    ).toBe(
      [
        'vendor:"Acme Ltd"',
        '-tag:"hidden"',
        "title:Blue\\ shirt*",
        '(status:"active" OR status:"draft")',
        "inventory_total:<5",
        "updated_at:>='2026-01-01'",
        "price:>=10 AND price:<=20.5",
        "gift_card:false",
      ].join(" AND "),
    );
  });

  it("quotes values so input can't change the query", () => {
    expect(compileFilters([{ field: "vendor", op: "is", value: 'x" OR status:draft "' }])).toBe(
      'vendor:"x\\" OR status:draft \\""',
    );
    expect(compileFilters([{ field: "title", op: "starts_with", value: "a:b (c)" }])).toBe("title:a\\:b\\ \\(c\\)*");
  });

  it("combines filters with the raw query and date options", () => {
    expect(buildSearchQuery({ filters: [{ field: "vendor", op: "is", value: "Acme" }], query: "tag:a OR tag:b" })).toBe(
      'vendor:"Acme" AND (tag:a OR tag:b)',
    );
  });
});

describe("filter validation", () => {
  const products = getEntity("products")!;

  it("accepts valid filters and normalises IDs", () => {
    expect(
      parseFilters(products, [
        { field: "status", op: "any_of", value: "active,archived" },
        { field: "collection_id", op: "is", value: "gid://shopify/Collection/123" },
      ]),
    ).toEqual([
      { field: "status", op: "any_of", value: "active,archived" },
      { field: "collection_id", op: "is", value: "123" },
    ]);
  });

  it("rejects unknown fields, wrong operators and bad values", () => {
    expect(() => parseFilters(products, [{ field: "financial_status", op: "is", value: "paid" }])).toThrow(/unknown filter/);
    expect(() => parseFilters(products, [{ field: "vendor", op: "gt", value: "a" }])).toThrow(/unsupported/);
    expect(() => parseFilters(products, [{ field: "status", op: "is", value: "deleted" }])).toThrow(/not allowed/);
    expect(() => parseFilters(products, [{ field: "price", op: "gt", value: "ten" }])).toThrow(/not a number/);
    expect(() => parseFilters(products, [{ field: "updated_at", op: "gte", value: "yesterday" }])).toThrow(/not a date/);
    expect(() => parseFilters(products, [{ field: "price", op: "between", value: "1", value2: "" }])).toThrow(/enter a value/);
    expect(() => parseFilters(products, [{ field: "vendor", op: "is", value: "  " }])).toThrow(/enter a value/);
  });

  it("validates columns in the export config", () => {
    const cfg = parseExportConfig({
      entities: [{ entity: "products", options: { columns: ["Title", "Variant SKU", "Not a column"] } }],
    });
    expect(cfg.entities[0].options.columns).toEqual(["Title", "Variant SKU"]);
    expect(() => parseExportConfig({ entities: [{ entity: "products", options: { columns: ["Nope"] } }] })).toThrow(/at least one column/);
  });

  it("every filter definition is usable", () => {
    for (const e of ENTITIES) {
      for (const f of e.filters ?? []) {
        expect(FILTER_OPS[f.type].length, `${e.key}.${f.key}`).toBeGreaterThan(0);
        if (f.type === "enum") expect(f.options?.length, `${e.key}.${f.key}`).toBeGreaterThan(0);
      }
    }
    // Every entity that accepts a search query offers structured filters too (payouts excepted).
    const missing = ENTITIES.filter((e) => e.supportsQuery && !e.filters?.length).map((e) => e.key);
    expect(missing).toEqual(["payouts"]);
  });
});

describe("column selection", () => {
  const products = getEntity("products")!;
  const headers = ["ID", "Handle", "Title", "Vendor", "Variant SKU", "Metafield: custom.fit [single_line_text_field]", "Inventory Available: Shop"];

  it("keeps all columns when no choice is made", () => {
    expect(selectColumns(products, {}, headers)).toEqual(headers);
  });

  it("keeps chosen columns, key columns and dynamic columns", () => {
    expect(selectColumns(products, { columns: ["Variant SKU"] }, headers)).toEqual([
      "ID",
      "Handle",
      "Variant SKU",
      "Metafield: custom.fit [single_line_text_field]",
      "Inventory Available: Shop",
    ]);
  });
});
