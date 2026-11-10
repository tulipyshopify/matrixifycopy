import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { selectColumns } from "../app/lib/core/exporter";
import { getEntity } from "../app/lib/entities";

process.env.DATABASE_URL ??= "file:dev.sqlite";
const { default: prisma } = await import("../app/db.server");
const jobs = await import("../app/lib/jobs/jobs.server");
const shop = `presets-test-${Date.now()}.myshopify.com`;

describe("location and metafield column choices", () => {
  const products = getEntity("products")!;
  const headers = [
    "ID", "Handle", "Title",
    "Inventory Available: Warehouse", "Inventory Available: Shop",
    "Metafield: custom.fit [single_line_text_field]", "Metafield: custom.care [multi_line_text_field]",
    "Variant Metafield: custom.size [single_line_text_field]",
  ];
  it("keeps everything when nothing is chosen", () => {
    expect(selectColumns(products, {}, headers)).toEqual(headers);
  });
  it("keeps only chosen locations and metafields", () => {
    expect(
      selectColumns(products, { locations: ["warehouse"], metafields: ["custom.care"], variantMetafields: ["other.key"] }, headers),
    ).toEqual(["ID", "Handle", "Title", "Inventory Available: Warehouse", "Metafield: custom.care [multi_line_text_field]"]);
  });
  it("validates the choices", () => {
    const cfg = jobs.parseExportConfig({ entities: [{ entity: "products", options: { locations: [" Shop ", "Shop"], metafields: ["custom.fit"] } }] });
    expect(cfg.entities[0].options).toMatchObject({ locations: ["Shop"], metafields: ["custom.fit"] });
    expect(() => jobs.parseExportConfig({ entities: [{ entity: "products", options: { metafields: ["nodot"] } }] })).toThrow(/namespace\.key/);
    expect(() => jobs.parseExportConfig({ entities: [{ entity: "products", options: { locations: [] } }] })).toThrow(/at least one inventory location/);
  });
});

// Needs the local database (npm run setup); skipped on a fresh checkout without one.
describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("presets", () => {
  afterAll(async () => {
    await prisma.preset.deleteMany({ where: { shop } });
    await prisma.job.deleteMany({ where: { shop } });
  });
  const data = { format: "csv", entities: [{ entity: "products", options: { columns: ["Title"], filters: [{ field: "vendor", op: "is", value: "Acme" }] } }] };

  it("saves, overwrites by name, lists and deletes per shop", async () => {
    const a = await jobs.savePreset(shop, "  Weekly stock ", data);
    const again = await jobs.savePreset(shop, "Weekly stock", { ...data, format: "xlsx" });
    expect(again.id).toBe(a.id);
    await jobs.savePreset(shop, "Another", data);
    const list = await jobs.listPresets(shop);
    expect(list.map((p) => p.name)).toEqual(["Another", "Weekly stock"]);
    expect(list[1].data).toMatchObject({ format: "xlsx", entities: [{ entity: "products", options: { columns: ["Title"] } }] });
    expect(await jobs.listPresets("other-shop.myshopify.com")).toEqual([]);
    await jobs.deletePreset("other-shop.myshopify.com", a.id); // other shops can't delete it
    expect(await jobs.listPresets(shop)).toHaveLength(2);
    await jobs.deletePreset(shop, a.id);
    expect((await jobs.listPresets(shop)).map((p) => p.name)).toEqual(["Another"]);
  });

  it("rejects empty names and invalid set-ups", async () => {
    await expect(jobs.savePreset(shop, "  ", data)).rejects.toThrow(/name/);
    await expect(jobs.savePreset(shop, "Bad", { entities: [{ entity: "nope", options: {} }] })).rejects.toThrow();
  });

  it("offers the most recent export as 'Latest export'", async () => {
    expect(await jobs.latestExportPreset(shop)).toBeNull();
    await jobs.createExportJob(shop, jobs.parseExportConfig(data), "csv");
    expect(await jobs.latestExportPreset(shop)).toMatchObject({ format: "csv", entities: [{ entity: "products" }] });
  });
});
