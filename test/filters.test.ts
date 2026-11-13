import { describe, expect, it } from "vitest";
import { buildSearchQuery, compileFilters } from "../app/lib/core/util";
import { selectColumns } from "../app/lib/core/exporter";
import { ENTITIES, getEntity } from "../app/lib/entities";
import { FILTER_OPS } from "../app/lib/core/types";

// jobs.server imports prisma; load it lazily so prisma isn't needed for these tests.
const jobs = await import("../app/lib/jobs/jobs.server");
const { parseExportConfig, parseFilters } = jobs;

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

  it("writes chosen columns in the order they were arranged", () => {
    expect(selectColumns(products, { columns: ["Variant SKU", "Title", "ID", "Not exported"] }, headers)).toEqual([
      "Variant SKU",
      "Title",
      "ID",
      "Metafield: custom.fit [single_line_text_field]",
      "Inventory Available: Shop",
    ]);
  });

  it("keeps exactly the chosen columns plus dynamic columns (key columns are optional)", () => {
    expect(selectColumns(products, { columns: ["Variant SKU"] }, headers)).toEqual([
      "Variant SKU",
      "Metafield: custom.fit [single_line_text_field]",
      "Inventory Available: Shop",
    ]);
    expect(selectColumns(products, { columns: ["ID", "Variant SKU"] }, headers).slice(0, 2)).toEqual(["ID", "Variant SKU"]);
  });
});

describe("named metafields among the columns", () => {
  const products = getEntity("products")!;
  const headers = ["ID", "Title", "Vendor", "Metafield: custom.fit [single_line_text_field]", "Metafield: custom.care [multi_line_text_field]", "Variant Metafield: custom.size [number_integer]"];

  it("puts a moved metafield at its place, the rest at the end", () => {
    const options = { columns: ["Title", "Metafield: custom.care", "ID", "Variant Metafield: custom.size", "Metafield: custom.gone"] };
    expect(selectColumns(products, options, headers)).toEqual([
      "Title",
      "Metafield: custom.care [multi_line_text_field]",
      "ID",
      "Variant Metafield: custom.size [number_integer]",
      "Metafield: custom.fit [single_line_text_field]",
    ]);
  });

  it("only accepts metafields that are also chosen", () => {
    const cfg = parseExportConfig({
      entities: [{ entity: "products", options: { metafields: ["custom.care"], columns: ["Metafield: custom.care", "Title", "Metafield: custom.other", "Bogus"] } }],
    });
    expect(cfg.entities[0].options.columns).toEqual(["Metafield: custom.care", "Title"]);
    expect(() => parseExportConfig({ entities: [{ entity: "products", options: { metafields: ["custom.care"], columns: ["Metafield: custom.care"] } }] })).toThrow(/at least one column/);
  });
});

describe("stock columns among the columns", () => {
  const products = getEntity("products")!;
  const headers = ["ID", "Variant SKU", "Inventory Available: Main", "Inventory Available: Depot", "Inventory On Hand: Main", "Metafield: custom.fit [single_line_text_field]"];

  it("are written where they were placed; ones taken out are dropped", () => {
    const columns = ["Inventory Available: Depot", "Variant SKU", "Inventory On Hand: Main", "ID"];
    expect(selectColumns(products, { columns }, headers)).toEqual([
      "Inventory Available: Depot",
      "Variant SKU",
      "Inventory On Hand: Main",
      "ID",
      "Metafield: custom.fit [single_line_text_field]",
    ]);
    // No stock column listed (older set-ups): all of them follow at the end.
    expect(selectColumns(products, { columns: ["Variant SKU"] }, headers)).toEqual(["Variant SKU", ...headers.slice(2)]);
  });

  it("are accepted for data types that have stock", () => {
    const parse = (entity: string) => parseExportConfig({ entities: [{ entity, options: { columns: ["ID", "Inventory Available: Main", "Inventory Bogus: Main"] } }] }).entities[0].options.columns;
    expect(parse("products")).toEqual(["ID", "Inventory Available: Main"]);
    expect(parse("orders")).toEqual(["ID"]);
  });
});

describe("date range", async () => {
  const { resolveDateRange, compileDateRange } = await import("../app/lib/core/util");
  const now = new Date("2026-11-10T15:00:00Z");
  it("resolves presets relative to the run date", () => {
    expect(resolveDateRange({ field: "created_at", preset: "today" }, now)).toEqual({ from: "2026-11-10", to: "2026-11-10" });
    expect(resolveDateRange({ field: "created_at", preset: "last_7_days" }, now)).toEqual({ from: "2026-11-04", to: "2026-11-10" });
    expect(resolveDateRange({ field: "created_at", preset: "last_month" }, now)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolveDateRange({ field: "created_at", preset: "last_year" }, now)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });
  it("compiles to exact instants, so the end day stops at midnight", () => {
    expect(compileDateRange({ field: "updated_at", preset: "yesterday" }, now)).toBe(
      "updated_at:>='2026-11-09T00:00:00Z' AND updated_at:<'2026-11-10T00:00:00Z'",
    );
    expect(compileDateRange({ field: "processed_at", preset: "custom", from: "2026-01-01" }, now)).toBe("processed_at:>='2026-01-01T00:00:00Z'");
  });

  it("'Last month' ends at the first midnight of this month, in the shop's time zone", () => {
    // Was: created_at:<'2026-11-01', which Shopify read as "up to the end of 1 November".
    expect(compileDateRange({ field: "created_at", preset: "last_month" }, now, "Europe/London")).toBe(
      "created_at:>='2026-09-30T23:00:00Z' AND created_at:<'2026-11-01T00:00:00Z'",
    );
    // 1 October is still in British Summer Time (UTC+1); 1 November is not.
    expect(compileDateRange({ field: "created_at", preset: "last_month" }, now, "America/New_York")).toBe(
      "created_at:>='2026-10-01T04:00:00Z' AND created_at:<'2026-11-01T04:00:00Z'",
    );
  });

  it("'Today' is the shop's date, not the UTC date", () => {
    const lateEvening = new Date("2026-11-10T23:30:00Z"); // already 11 Nov in Auckland, still 10 Nov in London
    expect(resolveDateRange({ field: "created_at", preset: "today" }, lateEvening, "Europe/London")).toEqual({ from: "2026-11-10", to: "2026-11-10" });
    expect(resolveDateRange({ field: "created_at", preset: "today" }, lateEvening, "Pacific/Auckland")).toEqual({ from: "2026-11-11", to: "2026-11-11" });
    expect(resolveDateRange({ field: "created_at", preset: "today" }, lateEvening, "Not/AZone")).toEqual({ from: "2026-11-10", to: "2026-11-10" });
  });
  it("is validated against the entity's date fields", () => {
    const orders = getEntity("orders")!;
    const { parseDateRange } = jobs;
    expect(parseDateRange(orders, { field: "processed_at", preset: "last_30_days" })).toEqual({ field: "processed_at", preset: "last_30_days" });
    expect(() => parseDateRange(orders, { field: "email", preset: "today" })).toThrow(/can't filter by date/);
    expect(() => parseDateRange(orders, { field: "created_at", preset: "custom", from: "2026-02-01", to: "2026-01-01" })).toThrow(/after the end/);
  });
});
