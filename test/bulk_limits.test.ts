import { describe, expect, it } from "vitest";
import { productsEntity } from "../app/lib/entities/products";
import type { ExportContext, Row } from "../app/lib/core/types";

async function run(groups: string[]) {
  const queries: string[] = [];
  const rows: Row[] = [];
  const ctx: ExportContext = {
    gql: (async () => ({})) as any,
    bulk: (q) => {
      queries.push(q);
      const main = /descriptionHtml/.test(q);
      return (async function* () {
        yield main
          ? { id: "gid://shopify/Product/1", handle: "tee", title: "Tee", variants: [{ id: "gid://shopify/ProductVariant/10", position: 1, selectedOptions: [], inventoryItem: {} }, { id: "gid://shopify/ProductVariant/11", position: 2, selectedOptions: [], inventoryItem: {} }] }
          : { id: "gid://shopify/Product/1", variants: [{ id: "gid://shopify/ProductVariant/11", metafields: [{ namespace: "custom", key: "size", type: "single_line_text_field", value: "XL" }] }, { id: "gid://shopify/ProductVariant/10" }] };
      })();
    },
    options: { groups },
    log: () => {},
    cache: new Map(),
    progress: () => {},
  };
  await productsEntity.export!(ctx, async (r) => void rows.push(...r));
  return { queries, rows };
}

const connections = (q: string) => (q.match(/\bedges\b/g) ?? []).length;

describe("products export stays within Shopify's 5-connection bulk limit", () => {
  it("fetches variant metafields in a separate query when everything is selected", async () => {
    const { queries, rows } = await run(["variants", "images", "inventory", "metafields", "variant_metafields", "seo"]);
    expect(queries).toHaveLength(2);
    for (const q of queries) expect(connections(q)).toBeLessThanOrEqual(5);
    expect(rows[0]["Variant Metafield: custom.size [single_line_text_field]"]).toBeUndefined();
    expect(rows[1]).toMatchObject({ "Variant ID": "11", "Variant Metafield: custom.size [single_line_text_field]": "XL" });
  });

  it("uses a single query when there is room", async () => {
    const { queries } = await run(["variants", "variant_metafields"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/metafields/);
  });
});
