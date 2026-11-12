import { describe, expect, it } from "vitest";
import { assemble } from "../app/lib/core/bulk";
import { discountsEntity } from "../app/lib/entities/discounts";
import { productToRows } from "../app/lib/entities/products";
import type { ExportContext, Row } from "../app/lib/core/types";

async function* lines(arr: object[]) {
  for (const o of arr) yield JSON.stringify(o);
}

describe("bulk assembly safety", () => {
  it("caps the child records kept per item and reports what was left out", async () => {
    const input = [
      { id: "gid://shopify/DiscountCodeNode/1" },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `gid://shopify/DiscountRedeemCode/${i}`, code: `C${i}`, __parentId: "gid://shopify/DiscountCodeNode/1" })),
      { id: "gid://shopify/DiscountCodeNode/2" },
      { id: "gid://shopify/DiscountRedeemCode/99", code: "X", __parentId: "gid://shopify/DiscountCodeNode/2" },
    ];
    const truncated: Array<[string, number]> = [];
    const out = [];
    for await (const o of assemble(lines(input), undefined, (id, n) => truncated.push([id, n]), 4)) out.push(o);
    expect(out[0].codes).toHaveLength(4);
    expect(out[1].codes).toHaveLength(1); // the cap is per item
    expect(truncated).toEqual([["gid://shopify/DiscountCodeNode/1", 6]]);
  });

  it("attaches inventory levels whether Shopify parents them to the variant or its inventory item", async () => {
    const level = (parent: string) => ({ id: "gid://shopify/InventoryLevel/1?inventory_item_id=100", location: { id: "gid://shopify/Location/1", name: "Warehouse" }, quantities: [{ name: "available", quantity: 7 }], __parentId: parent });
    for (const parent of ["gid://shopify/InventoryItem/100", "gid://shopify/ProductVariant/10"]) {
      const out = [];
      for await (const o of assemble(lines([
        { id: "gid://shopify/Product/1", handle: "tee" },
        { id: "gid://shopify/ProductVariant/10", position: 1, selectedOptions: [], inventoryItem: { id: "gid://shopify/InventoryItem/100", tracked: true }, __parentId: "gid://shopify/Product/1" },
        level(parent),
      ]))) out.push(o);
      const rows = productToRows(out[0], new Set(["variants", "inventory"]));
      expect(rows[0]["Inventory Available: Warehouse"], parent).toBe("7");
    }
  });
});

describe("discount export volume guard", () => {
  async function run(codesPerDiscount: number) {
    const queries: string[] = [];
    const logs: string[] = [];
    const ctx: ExportContext = {
      gql: (async () => ({
        discountNodes: {
          nodes: [{ discount: { codesCount: { count: codesPerDiscount } } }, { discount: {} }, { discount: { codesCount: { count: codesPerDiscount } } }],
          pageInfo: { hasNextPage: false },
        },
      })) as any,
      bulk: (q) => {
        queries.push(q);
        return (async function* () {})();
      },
      options: { groups: ["codes"] },
      log: (m) => logs.push(m),
      cache: new Map(),
      progress: () => {},
    };
    await discountsEntity.export!(ctx, async (_r: Row[]) => {});
    return { queries, logs };
  }

  it("exports codes when the volume is reasonable", async () => {
    const { queries, logs } = await run(500);
    expect(queries[0]).toMatch(/codes \{/);
    expect(logs.join(" ")).toMatch(/1,000 codes to export/);
  });

  it("leaves codes out and says so when there are too many", async () => {
    const { queries, logs } = await run(2_000_000);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toMatch(/codes \{/);
    expect(logs.join(" ")).toMatch(/4,000,000 codes, more than the limit.*without their codes/);
  });
});
