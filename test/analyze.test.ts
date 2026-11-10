import { describe, expect, it } from "vitest";
import { analyzeSheets } from "../app/lib/core/analyze";
import { ENTITIES } from "../app/lib/entities";

describe("import analysis", () => {
  it("summarises sheets, commands and columns without calling Shopify", () => {
    const [products, unknown, payouts] = analyzeSheets(
      [
        {
          name: "Products",
          headers: ["Handle", "Command", "Title", "Metafield: custom.fit [single_line_text_field]", "Inventory Available: Shop", "Colour notes"],
          rows: [
            { Handle: "a", Command: "", Title: "A" },
            { Handle: "a", Command: "", Title: "" },
            { Handle: "b", Command: "delete", Title: "B" },
            { Handle: "c", Command: "nonsense", Title: "C" },
            { Handle: "d", Command: "REPLACE", Title: "D" },
          ],
        },
        { name: "Sheet1", headers: ["X"], rows: [{ X: "1" }] },
        { name: "Payouts", headers: ["ID"], rows: [{ ID: "1" }] },
      ],
      ENTITIES,
    );
    expect(products).toMatchObject({
      entity: "products",
      canImport: true,
      rows: 5,
      items: 4,
      commands: { MERGE: 1, DELETE: 1, INVALID: 1, REPLACE: 1 },
      unknown: ["Colour notes"],
      keyColumns: ["Handle"],
    });
    expect(products.recognised).toContain("Metafield: custom.fit [single_line_text_field]");
    expect(products.recognised).toContain("Inventory Available: Shop");
    expect(products.warnings.join(" ")).toMatch(/unknown Command.*deleted.*re-created.*not recognised/);
    expect(unknown).toMatchObject({ entity: null, canImport: false });
    expect(payouts).toMatchObject({ entity: "payouts", canImport: false });
  });

  it("uses the default command for blank cells and warns about missing key columns", () => {
    const [s] = analyzeSheets([{ name: "Customers", headers: ["First Name"], rows: [{ "First Name": "A" }, { "First Name": "B" }] }], ENTITIES, "UPDATE");
    expect(s.commands).toEqual({ UPDATE: 1 });
    expect(s.warnings[0]).toMatch(/No ID/);
  });
});
