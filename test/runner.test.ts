import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-storage-"));

const { executeJob } = await import("../app/lib/jobs/runner.server");
const { readWorkbook } = await import("../app/lib/core/sheets");

const product = {
  id: "gid://shopify/Product/1",
  handle: "tee",
  title: "Tee",
  tags: [],
  status: "ACTIVE",
  options: [],
  variants: [
    {
      id: "gid://shopify/ProductVariant/10",
      position: 1,
      price: "5.00",
      sku: "T1",
      selectedOptions: [{ name: "Title", value: "Default Title" }],
      inventoryItem: { id: "gid://shopify/InventoryItem/100", tracked: true },
    },
  ],
};

function deps(gql: any = async () => ({})) {
  const logs: string[] = [];
  return {
    logs,
    deps: {
      gql,
      bulk: async function* () {
        yield product;
      },
      log: (m: string) => logs.push(m),
      progress: () => {},
      isCancelled: async () => false,
    },
  };
}

describe("job runner", () => {
  let exported = "";

  beforeAll(async () => {
    const { deps: d } = deps();
    const res = await executeJob(
      {
        id: "job1",
        shop: "test.myshopify.com",
        type: "export",
        config: JSON.stringify({ entities: [{ entity: "products", options: {} }] }),
        format: "xlsx",
        name: "",
        inputFile: null,
        inputName: null,
      },
      d,
    );
    exported = res.resultFile;
    expect(res.stats).toEqual([{ entity: "products", rows: 1, items: 1 }]);
  });

  it("exports a workbook into the job folder", async () => {
    expect(exported.startsWith(process.env.STORAGE_DIR!)).toBe(true);
    const [sheet] = await readWorkbook(exported);
    expect(sheet.name).toBe("Products");
    expect(sheet.rows[0]).toMatchObject({ ID: "1", Handle: "tee", "Variant SKU": "T1", "Variant Price": "5.00" });
  });

  it("imports an edited export and writes a result file", async () => {
    // Edit the exported file like a merchant would: change the price.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(exported);
    const ws = wb.getWorksheet("Products")!;
    const header = (ws.getRow(1).values as string[]).slice(1);
    ws.getRow(2).getCell(header.indexOf("Variant Price") + 1).value = "7.50";
    const edited = path.join(path.dirname(exported), "edited.xlsx");
    await wb.xlsx.writeFile(edited);

    const sent: Array<{ op: string; vars: any }> = [];
    const gql = async (query: string, vars: any) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)![1];
      sent.push({ op, vars });
      switch (op) {
        case "ImportProductById":
          return { product: { id: product.id, handle: "tee", title: "Tee", hasOnlyDefaultVariant: true, options: [{ id: "o", name: "Title", position: 1, optionValues: [] }], media: { nodes: [] } } };
        case "ImportProductVariants":
          return { product: { variants: { nodes: [{ ...product.variants[0], inventoryItem: { ...product.variants[0].inventoryItem, inventoryLevels: { nodes: [] } } }], pageInfo: { hasNextPage: false } } } };
        case "ImportProductUpdate":
          return { productUpdate: { product: { id: product.id }, userErrors: [] } };
        case "MetafieldsSet":
          return { metafieldsSet: { userErrors: [] } };
        case "Publications":
          return { publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store", catalog: { title: "Online Store" } }] } };
        case "Publish":
          return { publishablePublish: { userErrors: [] } };
        case "Unpublish":
          return { publishableUnpublish: { userErrors: [] } };
        case "ImportVariantsUpdate":
          return { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } };
        case "Locations":
          return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main", isActive: true }], pageInfo: { hasNextPage: false } } };
        case "ImportInventoryActivate":
          return { inventoryActivate: { userErrors: [] } };
        case "ImportInventorySet":
          return { inventorySetQuantities: { userErrors: [] } };
        default:
          throw new Error(`unexpected ${op}`);
      }
    };
    const { deps: d, logs } = deps(gql);
    const res = await executeJob(
      {
        id: "job2",
        shop: "test.myshopify.com",
        type: "import",
        config: JSON.stringify({ options: {} }),
        format: "xlsx",
        name: "",
        inputFile: edited,
        inputName: "edited.xlsx",
      },
      d,
    );
    expect(res.stats[0]).toMatchObject({ sheet: "Products", ok: 1, failed: 0 });
    const variantUpdate = sent.find((s) => s.op === "ImportVariantsUpdate")!.vars.variants[0];
    expect(variantUpdate).toMatchObject({ id: "gid://shopify/ProductVariant/10", price: "7.5" });
    const [result] = await readWorkbook(res.resultFile);
    expect(result.rows[0]["Import Result"]).toBe("OK");
    expect(logs.join("\n")).toMatch(/1 OK, 0 failed/);
  });
});
