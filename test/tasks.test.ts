import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adjustedPrice, computedCells } from "../app/lib/ai/changes";
import { generateChangeFile } from "../app/lib/ai/generate";
import { runImport } from "../app/lib/core/importer";
import { readWorkbook } from "../app/lib/core/sheets";
import { ENTITIES, getEntity } from "../app/lib/entities";
import { fakeStore, product, variant } from "./helpers/fake_store";

process.env.DATABASE_URL ??= "file:dev.sqlite";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-task-"));

describe("quick changes: working out new values", () => {
  it("prices by percentage or amount, with an ending", () => {
    const up5 = { action: "adjust_price" as const, value: "", percent: 5 };
    expect(adjustedPrice("100.00", up5)).toBe("105.00");
    expect(adjustedPrice("9.99", up5)).toBe("10.49");
    expect(adjustedPrice("24.50", { ...up5, percent: -20 })).toBe("19.60");
    expect(adjustedPrice("24.50", { action: "adjust_price", value: "", amount: 2 })).toBe("26.50");
    // The nearest price with the chosen ending.
    expect(adjustedPrice("12.00", { ...up5, ending: "99" })).toBe("12.99");
    expect(adjustedPrice("11.50", { ...up5, ending: "99" })).toBe("11.99");
    expect(adjustedPrice("100.00", { ...up5, ending: "00" })).toBe("105.00");
    expect(adjustedPrice("0.40", { ...up5, ending: "99" })).toBe("0.99");
    // Nothing sensible to work from, or a result at or below zero: left alone.
    expect(adjustedPrice("", up5)).toBeNull();
    expect(adjustedPrice("abc", up5)).toBeNull();
    expect(adjustedPrice("1.00", { action: "adjust_price", value: "", amount: -5 })).toBeNull();
  });

  it("a sale shows the old price; ending one puts it back", () => {
    const sale = [{ action: "adjust_price" as const, value: "", percent: -20, compareAt: "old_price" as const }];
    expect(computedCells({ "Variant ID": "1", "Variant Price": "50.00", "Variant Compare At Price": "" }, sale)).toEqual({ "Variant Price": "40.00", "Variant Compare At Price": "50.00" });
    // A higher "was" price already shown is kept.
    expect(computedCells({ "Variant ID": "1", "Variant Price": "50.00", "Variant Compare At Price": "60.00" }, sale)).toEqual({ "Variant Price": "40.00" });
    const end = [{ action: "end_sale" as const, value: "", restorePrice: true }];
    expect(computedCells({ "Variant ID": "1", "Variant Price": "40.00", "Variant Compare At Price": "50.00" }, end)).toEqual({ "Variant Price": "50.00", "Variant Compare At Price": "" });
    expect(computedCells({ "Variant ID": "1", "Variant Price": "40.00", "Variant Compare At Price": "" }, end)).toEqual({});
    expect(computedCells({ "Variant ID": "1", "Variant Price": "40.00", "Variant Compare At Price": "50.00" }, [{ action: "end_sale", value: "" }])).toEqual({ "Variant Compare At Price": "" });
  });

  it("find and replace takes the text literally", () => {
    const c = [{ action: "replace_text" as const, column: "Title", find: "(old)", value: "$1 new" }];
    expect(computedCells({ Title: "Planter (OLD) and (old)" }, c)).toEqual({ Title: "Planter $1 new and $1 new" });
    expect(computedCells({ Title: "Planter (OLD)" }, [{ ...c[0], matchCase: true }])).toEqual({});
    expect(computedCells({ Title: "Nothing here" }, c)).toEqual({});
  });
});

describe("quick changes: the change file and its preview", () => {
  const store = () =>
    fakeStore([
      product("barrel", "Oak Barrel Planter", [variant("B1", "50.00", { Size: "S" }), variant("B2", "80.00", { Size: "L" }, { compareAtPrice: "95.00" })], { vendor: "Woven Wood" }),
      product("hurdle", "Willow Hurdle", [variant("H1", "39.99")], { vendor: "Woven Wood" }),
      product("free", "Free sample", [variant("F1", "0.00")], { vendor: "Woven Wood" }),
    ]);
  /** Stands in for the products export: the rows a real export would give. */
  const withExport = (s: ReturnType<typeof store>) => {
    const real = getEntity("products")!;
    const rows = s.products.flatMap((p) =>
      p.variants.map((v, i) => ({
        ID: p.id.split("/").pop()!,
        Handle: p.handle,
        ...(i === 0 ? { Title: p.title, "Body HTML": p.descriptionHtml, Vendor: p.vendor } : {}),
        "Variant ID": v.id.split("/").pop()!,
        "Variant Price": v.price,
        "Variant Compare At Price": v.compareAtPrice ?? "",
      })),
    );
    return { ...real, export: async (_ctx: any, emit: any) => emit(rows) };
  };
  const generate = async (changes: any[], s = store()) => {
    const dir = tmp();
    const entity = withExport(s);
    const { vi } = await import("vitest");
    const spy = vi.spyOn(await import("../app/lib/entities"), "getEntity").mockReturnValue(entity as any);
    try {
      const logs: string[] = [];
      const made = await generateChangeFile({ entity: "products", options: {}, changes }, { gql: s.gql as any, bulk: (async function* () {}) as any, log: (m) => logs.push(m) }, dir);
      const sheets = await readWorkbook(made.file, made.name);
      return { s, made, sheets, rows: sheets[0].rows, log: logs.join("\n") };
    } finally {
      spy.mockRestore();
    }
  };
  const preview = async (sheets: any, s: ReturnType<typeof store>) => {
    const stats = await runImport({ ctx: { gql: s.gql, options: { dryRun: true, defaultCommand: "UPDATE" } as any, log: () => {}, cache: new Map() } as any, sheets, entities: ENTITIES, log: () => {} });
    return stats.flatMap((x) => x.preview ?? []);
  };

  it("a 10% sale: one row per variant that changes, previewed old → new, nothing else touched", async () => {
    const g = await generate([{ action: "adjust_price", value: "", percent: -10, compareAt: "old_price" }]);
    expect(g.sheets[0].headers).toEqual(["ID", "Command", "Variant ID", "Variant Price", "Variant Compare At Price"]);
    expect(g.rows.map((r) => [r["Variant Price"], r["Variant Compare At Price"]])).toEqual([
      ["45.00", "50.00"],
      ["72.00", "95.00"],
      ["35.99", "39.99"],
    ]);
    expect(g.log).toMatch(/3 products match; 3 rows would change, 1 need no change/);
    expect(g.log).toMatch(/1 variant has no price above zero/);
    const items = await preview(g.sheets, g.s);
    expect(items.map((i) => i.action)).toEqual(["update", "update"]);
    const lines = items.flatMap((i) => i.changes).join("\n");
    expect(lines).toMatch(/Variant Price \(.*B1.*\): 50 → 45/);
    expect(lines).toMatch(/Variant Compare At Price \(.*B1.*\): \(empty\) → 50/);
    // B2's higher compare-at price stays as it is: not a change.
    expect(lines).not.toMatch(/Compare At Price \(.*B2/);
  });

  it("find and replace writes only the products that contain the text, and never blanks another cell", async () => {
    const g = await generate([{ action: "replace_text", column: "Title", find: "planter", value: "Tub" }]);
    expect(g.rows).toEqual([{ ID: g.s.products[0].id.split("/").pop(), Command: "UPDATE", Title: "Oak Barrel Tub" }]);
    const items = await preview(g.sheets, g.s);
    expect(items).toHaveLength(1);
    expect(items[0].changes).toEqual(["Title: Oak Barrel Planter → Oak Barrel Tub"]);
  });

  it("a tag together with a price change: the tag sits on the product's first written row", async () => {
    const g = await generate([{ action: "add_tags", value: "Sale" }, { action: "adjust_price", value: "", amount: -5 }]);
    const barrel = g.rows.filter((r) => r.ID === g.s.products[0].id.split("/").pop());
    expect(barrel.map((r) => [r.Tags, r["Tags Command"], r["Variant Price"]])).toEqual([
      ["Sale", "MERGE", "45.00"],
      ["", "", "75.00"],
    ]);
    // The product with no usable price still gets its tag.
    expect(g.rows.find((r) => r.ID === g.s.products[2].id.split("/").pop())).toMatchObject({ Tags: "Sale", "Variant Price": "0.00" });
  });

  it("says so when nothing needs the change", async () => {
    await expect(generate([{ action: "replace_text", column: "Title", find: "zzz", value: "x" }])).rejects.toThrow(/3 products match, but none of them needs this change/);
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("quick changes: the form", async () => {
  const { planTask } = await import("../app/lib/jobs/tasks.server");
  it("turns the form into filters and a change, with a name that says what it does", () => {
    const p = planTask({ task: "prices", pick: [{ field: "vendor", value: "Woven Wood" }, { field: "tag", value: "" }], direction: "down", by: "percent", number: "20%", ending: "99", showOldPrice: true });
    expect(p.name).toBe("Lower prices by 20%, ending in .99, old price shown as compare-at (vendor is Woven Wood)");
    expect(p.filters).toEqual([{ field: "vendor", op: "is", value: "Woven Wood" }]);
    expect(p.changes).toEqual([{ action: "adjust_price", value: "", percent: -20, ending: "99", compareAt: "old_price" }]);
    expect(planTask({ task: "tags", all: true, tagAction: "remove", tags: "Sale, Winter" }).changes).toEqual([{ action: "remove_tags", value: "Sale" }, { action: "remove_tags", value: "Winter" }]);
    expect(planTask({ task: "field", all: true, column: "Status", value: "Draft" })).toMatchObject({ name: "Set status to Draft (every product)", changes: [{ action: "set_column", column: "Status", value: "Draft" }] });
  });
  it("refuses what would be a mistake", () => {
    expect(() => planTask({ task: "prices", number: "5" })).toThrow(/Choose which products/);
    expect(() => planTask({ task: "prices", all: true, number: "0" })).toThrow(/number above zero/);
    expect(() => planTask({ task: "prices", all: true, direction: "down", number: "100" })).toThrow(/100% or more/);
    expect(() => planTask({ task: "replace", all: true, column: "Tags", find: "a" })).toThrow(/where to look/);
    expect(() => planTask({ task: "replace", all: true, column: "Title", find: " " })).toThrow(/text to find/);
    expect(() => planTask({ task: "field", all: true, column: "Status", value: "Deleted" })).toThrow(/Choose a value/);
    expect(() => planTask({ task: "prices", pick: [{ field: "collection_id", value: "abc" }], number: "5" })).toThrow(/not an ID/);
  });
});
