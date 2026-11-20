import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../app/lib/core/sheets";
import { runImport } from "../app/lib/core/importer";
import { ENTITIES } from "../app/lib/entities";
import { fakeStore, product, variant } from "./helpers/fake_store";

process.env.DATABASE_URL ??= "file:dev.sqlite";

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("edit in a table", async () => {
  const { editFile, startEdit } = await import("../app/lib/jobs/edit.server");
  const { default: prisma } = await import("../app/db.server");
  const store = () =>
    fakeStore([
      product("barrel", "Oak Barrel", [variant("B1", "50.00", { Size: "S" }), variant("B2", "80.00", { Size: "L" })], { vendor: "Woven Wood" }),
      product("hurdle", "Willow Hurdle", [variant("H1", "39.99")], { vendor: "Woven Wood" }),
    ]);
  /** The rows the table was read from, as the export writes them. */
  const exported = (s: ReturnType<typeof store>) =>
    s.products.flatMap((p) =>
      p.variants.map((v, i) => ({
        ID: p.id.split("/").pop()!,
        Handle: p.handle,
        Title: i === 0 ? p.title : "",
        Vendor: i === 0 ? p.vendor : "",
        "Variant ID": v.id.split("/").pop()!,
        "Variant SKU": v.sku ?? "",
        "Variant Price": v.price,
      })),
    );
  const columns = ["Title", "Vendor", "Variant SKU", "Variant Price"];
  const preview = async (csv: string, s: ReturnType<typeof store>) => {
    const { headers, rows } = parseCsv(csv);
    const stats = await runImport({ ctx: { gql: s.gql, options: { dryRun: true, defaultCommand: "UPDATE" } as any, log: () => {}, cache: new Map() } as any, sheets: [{ name: "Products", headers, rows }], entities: ENTITIES, log: () => {} });
    return stats.flatMap((x) => x.preview ?? []);
  };

  it("a price changed on a second variant: only that row is written, and only that changes", async () => {
    const s = store();
    const made = editFile(exported(s), columns, [{ i: 1, column: "Variant Price", value: "85.00" }]);
    expect(made).toMatchObject({ rows: 1, cells: 1 });
    expect(parseCsv(made.csv).rows).toEqual([{ ID: s.products[0].id.split("/").pop(), Command: "UPDATE", "Variant ID": s.products[0].variants[1].id.split("/").pop(), "Variant Price": "85.00" }]);
    const items = await preview(made.csv, s);
    expect(items).toHaveLength(1);
    expect(items[0].changes).toEqual(["Variant Price (SKU B2): 80 → 85"]);
  });

  it("a title and a variant price on different products: every written cell is new or current, never blank", async () => {
    const s = store();
    const made = editFile(exported(s), columns, [
      { i: 1, column: "Variant Price", value: "85.00" },
      { i: 2, column: "Title", value: "Willow Hurdle Panel" },
      // Typed and put back: not a change.
      { i: 0, column: "Vendor", value: "Woven Wood" },
    ]);
    expect(made.cells).toBe(2);
    const rows = parseCsv(made.csv).rows;
    // The barrel's first row is written too, carrying its current title, because its variant row is.
    expect(rows.map((r) => [r.Title, r["Variant Price"]])).toEqual([
      ["Oak Barrel", "50.00"],
      ["", "85.00"],
      ["Willow Hurdle Panel", "39.99"],
    ]);
    const items = await preview(made.csv, s);
    expect(items.map((i) => i.changes)).toEqual([["Variant Price (SKU B2): 80 → 85"], ["Title: Willow Hurdle → Willow Hurdle Panel"]]);
  });

  it("refuses nothing changed, and cells outside the table", () => {
    const s = store();
    expect(() => editFile(exported(s), columns, [{ i: 0, column: "Title", value: "Oak Barrel" }])).toThrow(/Nothing was changed/);
    expect(() => editFile(exported(s), columns, [{ i: 0, column: "Body HTML", value: "x" }])).toThrow(/not part of this table/);
    expect(() => editFile(exported(s), columns, [{ i: 99, column: "Title", value: "x" }])).toThrow(/not part of this table/);
  });

  it("reading the products is an export of just the chosen columns, for a limited number", async () => {
    const shop = `edit-${Date.now()}.myshopify.com`;
    await expect(startEdit(shop, { columns: ["Title"] })).rejects.toThrow(/Choose which products/);
    await expect(startEdit(shop, { all: true, columns: [] })).rejects.toThrow(/at least one column/);
    const job = await startEdit(shop, { pick: [{ field: "vendor", value: "Woven Wood" }], columns: ["Title", "Variant Price", "Body HTML"] });
    const config = JSON.parse(job.config);
    expect(job).toMatchObject({ type: "export", format: "csv", name: "Edit in a table: vendor is Woven Wood" });
    expect(config.edit).toEqual({ columns: ["Title", "Variant Price"] });
    expect(config.entities[0]).toMatchObject({ entity: "products", options: { limit: 1000, groups: ["variants"], filters: [{ field: "vendor", op: "is", value: "Woven Wood" }] } });
    expect(config.entities[0].options.columns).toEqual(expect.arrayContaining(["ID", "Title", "Variant Price", "Variant ID", "Option1 Value"]));
    await prisma.job.deleteMany({ where: { shop } });
  });
});
