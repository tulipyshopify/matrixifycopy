import { describe, expect, it } from "vitest";
import { shopEntity } from "../app/lib/entities/shop";
import { exportCtx, hasSchema, importCtx, mockGql, runExport, schemaErrors } from "./_content_test_helpers";

const SHOP = {
  id: "gid://shopify/Shop/77",
  name: "Acme",
  email: "owner@acme.test",
  contactEmail: "hi@acme.test",
  shopOwnerName: "Ann",
  myshopifyDomain: "acme.myshopify.com",
  url: "https://acme.test",
  currencyCode: "GBP",
  enabledPresentmentCurrencies: ["GBP", "EUR"],
  ianaTimezone: "Europe/London",
  timezoneAbbreviation: "GMT",
  weightUnit: "KILOGRAMS",
  unitSystem: "METRIC_SYSTEM",
  taxesIncluded: true,
  taxShipping: false,
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  primaryDomain: { host: "acme.test" },
  plan: { publicDisplayName: "Basic", shopifyPlus: false },
  shopAddress: { address1: "1 High St", address2: null, city: "London", province: null, provinceCode: null, zip: "N1", country: "United Kingdom", countryCodeV2: "GB", phone: "+44", company: "Acme Ltd" },
};

const mfPage = (nodes: any[], hasNextPage: boolean, endCursor: string | null) => ({
  shop: { metafields: { nodes, pageInfo: { hasNextPage, endCursor } } },
});

describe("shop export", () => {
  it("exports one row with details and paginated metafields", async () => {
    const m = mockGql({
      ShopExport: { shop: SHOP },
      ShopMetafieldsExport: (v: any) =>
        v.after
          ? mfPage([{ namespace: "custom", key: "b", type: "list.single_line_text_field", value: '["x","y"]' }], false, null)
          : mfPage([{ namespace: "custom", key: "a", type: "single_line_text_field", value: "1" }], true, "c1"),
    });
    const { ctx } = exportCtx(m.gql);
    const rows = await runExport(shopEntity, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ID: "77",
      Name: "Acme",
      Domain: "acme.test",
      Currency: "GBP",
      "Enabled Currencies": "GBP, EUR",
      Plan: "Basic",
      "Shopify Plus": "FALSE",
      Timezone: "Europe/London",
      "Weight Unit": "kg",
      "Taxes Included": "TRUE",
      "Address 1": "1 High St",
      "Address 2": "",
      "Country Code": "GB",
      "Metafield: custom.a [single_line_text_field]": "1",
      "Metafield: custom.b [list.single_line_text_field]": "x\ny",
    });
    expect(m.calls[2].vars).toEqual({ after: "c1" });
  });

  it.skipIf(!hasSchema)("export queries match the schema", async () => {
    const m = mockGql({ ShopExport: { shop: SHOP }, ShopMetafieldsExport: mfPage([], false, null) });
    const { ctx } = exportCtx(m.gql, [], { groups: ["metafields"] });
    await runExport(shopEntity, ctx);
    expect(m.calls.length).toBe(2);
    for (const c of m.calls) expect(schemaErrors(c.query), c.query).toEqual([]);
  });
});

describe("shop import", () => {
  const ok = { userErrors: [] };

  it("writes shop metafields only and ignores read-only columns", async () => {
    const m = mockGql({
      ImportShopId: { shop: { id: SHOP.id } },
      MetafieldsSet: { metafieldsSet: ok },
      MetafieldsDelete: { metafieldsDelete: ok },
    });
    const r = await shopEntity.import!.apply(
      importCtx(m.gql),
      [{ ID: "77", Name: "Renamed", "Metafield: custom.a [number_integer]": "5", "Metafield: custom.b": "" }],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", id: SHOP.id });
    expect(r.message).toContain("read-only");
    expect(m.call("MetafieldsSet")!.vars.metafields).toEqual([
      { namespace: "custom", key: "a", type: "number_integer", value: "5", ownerId: SHOP.id },
    ]);
    expect(m.call("MetafieldsDelete")!.vars.metafields).toEqual([{ ownerId: SHOP.id, namespace: "custom", key: "b" }]);
  });

  it("refuses other commands and other shops", async () => {
    const m = mockGql({ ImportShopId: { shop: { id: SHOP.id } } });
    expect((await shopEntity.import!.apply(importCtx(m.gql), [{ ID: "77" }], "DELETE")).status).toBe("Failed");
    expect((await shopEntity.import!.apply(importCtx(m.gql), [{ ID: "78" }], "UPDATE")).message).toMatch(/not this shop/);
    expect(m.ops()).toEqual(["ImportShopId"]);
  });
});
