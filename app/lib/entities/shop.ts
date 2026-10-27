import type { Command, Entity, ExportContext, ImportContext, ItemResult, Row } from "../core/types";
import { paginate } from "../core/gql";
import { boolCell, cell, gidToId, metafieldsFromRow, metafieldsToRow, toGid } from "../core/util";
import { writeMetafields } from "../core/lookups";
import { cachedPromise } from "./_content_helpers";

// --- Columns --------------------------------------------------------------------

// Everything except metafields is read-only: the Admin API does not let apps
// change these shop settings, so import ignores them.
const SHOP_COLUMNS = [
  "ID",
  "Command",
  "Name",
  "Email",
  "Contact Email",
  "Owner Name",
  "Domain",
  "Myshopify Domain",
  "URL",
  "Currency",
  "Enabled Currencies",
  "Plan",
  "Shopify Plus",
  "Timezone",
  "Timezone Abbreviation",
  "Weight Unit",
  "Unit System",
  "Taxes Included",
  "Tax Shipping",
  "Address 1",
  "Address 2",
  "City",
  "Province",
  "Province Code",
  "Zip",
  "Country",
  "Country Code",
  "Phone",
  "Company",
  "Created At",
  "Updated At",
];

const WEIGHT_UNIT_CELL: Record<string, string> = { GRAMS: "g", KILOGRAMS: "kg", OUNCES: "oz", POUNDS: "lb" };

// --- Export -------------------------------------------------------------------------

const SHOP_DETAILS = `#graphql
  query ShopExport {
    shop {
      id name email contactEmail shopOwnerName myshopifyDomain url currencyCode enabledPresentmentCurrencies
      ianaTimezone timezoneAbbreviation weightUnit unitSystem taxesIncluded taxShipping createdAt updatedAt
      primaryDomain { host }
      plan { publicDisplayName shopifyPlus }
      shopAddress { address1 address2 city province provinceCode zip country countryCodeV2 phone company }
    }
  }
`;

const SHOP_METAFIELDS = `#graphql
  query ShopMetafieldsExport($after: String) {
    shop {
      metafields(first: 250, after: $after) {
        nodes { id namespace key type value }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export function shopToRow(s: any, metafields: any[] | undefined): Row {
  const a = s.shopAddress ?? {};
  const row: Row = {
    ID: gidToId(s.id),
    Command: "MERGE",
    Name: s.name ?? "",
    Email: s.email ?? "",
    "Contact Email": s.contactEmail ?? "",
    "Owner Name": s.shopOwnerName ?? "",
    Domain: s.primaryDomain?.host ?? "",
    "Myshopify Domain": s.myshopifyDomain ?? "",
    URL: s.url ?? "",
    Currency: s.currencyCode ?? "",
    "Enabled Currencies": (s.enabledPresentmentCurrencies ?? []).join(", "),
    Plan: s.plan?.publicDisplayName ?? "",
    "Shopify Plus": boolCell(s.plan?.shopifyPlus),
    Timezone: s.ianaTimezone ?? "",
    "Timezone Abbreviation": s.timezoneAbbreviation ?? "",
    "Weight Unit": WEIGHT_UNIT_CELL[s.weightUnit] ?? s.weightUnit ?? "",
    "Unit System": s.unitSystem ?? "",
    "Taxes Included": boolCell(s.taxesIncluded),
    "Tax Shipping": boolCell(s.taxShipping),
    "Address 1": a.address1 ?? "",
    "Address 2": a.address2 ?? "",
    City: a.city ?? "",
    Province: a.province ?? "",
    "Province Code": a.provinceCode ?? "",
    Zip: a.zip ?? "",
    Country: a.country ?? "",
    "Country Code": a.countryCodeV2 ?? "",
    Phone: a.phone ?? "",
    Company: a.company ?? "",
    "Created At": s.createdAt ?? "",
    "Updated At": s.updatedAt ?? "",
  };
  if (metafields) metafieldsToRow(row, metafields);
  return row;
}

async function exportShop(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? shopEntity.groups!.filter((g) => g.default).map((g) => g.key));
  const shop = (await ctx.gql(SHOP_DETAILS)).shop;
  let metafields: any[] | undefined;
  if (groups.has("metafields")) {
    metafields = [];
    for await (const mf of paginate(ctx.gql, SHOP_METAFIELDS, {}, (d) => d.shop.metafields)) metafields.push(mf);
  }
  await emit([shopToRow(shop, metafields)]);
  ctx.progress(1);
}

// --- Import ---------------------------------------------------------------------

const SHOP_ID = `#graphql
  query ImportShopId { shop { id } }
`;

/** Only shop metafields are written; every other column is read-only and ignored. */
export async function importShop(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const row = rows[0];
  if (command !== "MERGE" && command !== "UPDATE") {
    return { status: "Failed", command, message: `The shop can only be updated (MERGE or UPDATE), not ${command}` };
  }
  const shopId = await cachedPromise(ctx.cache, "shop:id", async () => (await ctx.gql(SHOP_ID)).shop.id as string);
  const idCell = cell(row, "ID");
  if (idCell && toGid("Shop", idCell) !== shopId) {
    return { status: "Failed", command, message: `Shop ID ${idCell} is not this shop (${gidToId(shopId)})` };
  }
  const mf = metafieldsFromRow(row);
  await writeMetafields(ctx.gql, shopId, mf.set, mf.blank);
  const parts: string[] = [];
  if (mf.set.length) parts.push(`${mf.set.length} metafield(s) set`);
  if (mf.blank.length) parts.push(`${mf.blank.length} metafield(s) deleted`);
  if (!parts.length) parts.push("No metafields to update");
  parts.push("other shop columns are read-only and were ignored");
  return { status: "OK", command, id: shopId, message: parts.join("; ") };
}

export const shopEntity: Entity = {
  key: "shop",
  sheet: "Shop",
  aliases: ["shop details", "store"],
  description: "Shop details (one row, read-only) and shop metafields, which can be imported.",
  columns: SHOP_COLUMNS,
  groups: [{ key: "metafields", label: "Shop metafields", default: true }],
  export: exportShop,
  import: { keyColumns: ["ID", "Myshopify Domain", "Name"], apply: importShop },
};
