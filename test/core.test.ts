import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { assemble } from "../app/lib/core/bulk";
import { createGql } from "../app/lib/core/gql";
import { groupRows, runImport } from "../app/lib/core/importer";
import { runExport } from "../app/lib/core/exporter";
import { detectEntity } from "../app/lib/core/registry";
import { createCsvOut, createXlsxOut, parseCsv, readWorkbook } from "../app/lib/core/sheets";
import type { Entity, Row } from "../app/lib/core/types";
import {
  buildSearchQuery,
  cellToMetafieldValue,
  metafieldToCell,
  metafieldsFromRow,
  parseBool,
  parseMetafieldColumn,
  toGid,
} from "../app/lib/core/util";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-"));

async function* lines(arr: object[]) {
  for (const o of arr) yield JSON.stringify(o);
}

describe("util", () => {
  it("parses metafield columns", () => {
    expect(parseMetafieldColumn("Metafield: custom.color [single_line_text_field]")).toEqual({
      prefix: "Metafield",
      namespace: "custom",
      key: "color",
      type: "single_line_text_field",
    });
    expect(parseMetafieldColumn("Variant Metafield: a.b [list.single_line_text_field]", "Variant Metafield")?.type).toBe(
      "list.single_line_text_field",
    );
    expect(parseMetafieldColumn("Metafield: custom.color")?.type).toBe("single_line_text_field");
    expect(parseMetafieldColumn("Title")).toBeNull();
  });

  it("round-trips list metafield values through cells", () => {
    const cell = metafieldToCell("list.single_line_text_field", '["a","b"]');
    expect(cell).toBe("a\nb");
    expect(cellToMetafieldValue("list.single_line_text_field", cell)).toBe('["a","b"]');
    expect(cellToMetafieldValue("list.number_integer", "1\n2")).toBe("[1,2]");
    expect(cellToMetafieldValue("list.single_line_text_field", '["x"]')).toBe('["x"]');
  });

  it("splits set and blank metafields", () => {
    const r = metafieldsFromRow({ "Metafield: a.b [boolean]": "yes", "Metafield: a.c": "", Title: "x" });
    expect(r.set).toEqual([{ namespace: "a", key: "b", type: "boolean", value: "true" }]);
    expect(r.blank.map((b) => b.key)).toEqual(["c"]);
  });

  it("parses booleans and ids", () => {
    expect(parseBool("TRUE")).toBe(true);
    expect(parseBool("no")).toBe(false);
    expect(parseBool("")).toBeUndefined();
    expect(() => parseBool("maybe")).toThrow();
    expect(toGid("Product", "12")).toBe("gid://shopify/Product/12");
    expect(toGid("Product", "gid://shopify/Product/12")).toBe("gid://shopify/Product/12");
    expect(toGid("Product", "")).toBeUndefined();
    expect(() => toGid("Product", "abc")).toThrow();
  });

  it("builds search queries", () => {
    expect(buildSearchQuery({ query: "status:active", updatedAfter: "2026-01-01" })).toBe(
      "(status:active) AND updated_at:>='2026-01-01'",
    );
    expect(buildSearchQuery({})).toBe("");
  });
});

describe("bulk JSONL assembly", () => {
  it("nests children under their parents", async () => {
    const out = [];
    for await (const o of assemble(
      lines([
        { id: "gid://shopify/Product/1", title: "A" },
        { id: "gid://shopify/ProductVariant/10", __parentId: "gid://shopify/Product/1" },
        { id: "gid://shopify/Metafield/5", __parentId: "gid://shopify/ProductVariant/10", key: "k" },
        { id: "gid://shopify/MediaImage/7", __parentId: "gid://shopify/Product/1" },
        { id: "gid://shopify/Product/2", title: "B" },
      ]),
    )) {
      out.push(o);
    }
    expect(out).toHaveLength(2);
    expect(out[0].variants[0].metafields[0].key).toBe("k");
    expect(out[0].media).toHaveLength(1);
    expect(out[1].title).toBe("B");
  });
});

describe("gql client", () => {
  it("retries throttled requests and returns data", async () => {
    let calls = 0;
    const gql = createGql(async () => {
      calls++;
      if (calls === 1) return { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 1, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 1000 } } } };
      return { data: { ok: true } };
    });
    expect(await gql("query { shop { id } }")).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("throws on GraphQL errors", async () => {
    const gql = createGql(async () => ({ errors: [{ message: "Field 'x' doesn't exist" }] }));
    await expect(gql("query { x }")).rejects.toThrow("Field 'x' doesn't exist");
  });
});

describe("sheets", () => {
  it("parses CSV with BOM, quotes and duplicate headers", () => {
    const { headers, rows } = parseCsv('﻿Handle,Title,Tags,Tags\r\na,"Hello, ""world""","x",y\r\n,,,\r\n');
    expect(headers).toEqual(["Handle", "Title", "Tags", "Tags (2)"]);
    expect(rows).toEqual([{ Handle: "a", Title: 'Hello, "world"', Tags: "x", "Tags (2)": "y" }]);
  });

  it("writes and reads back XLSX, keeping leading zeros and long text", async () => {
    const dir = tmp();
    const out = createXlsxOut(path.join(dir, "t.xlsx"));
    const long = "x".repeat(5000);
    await out.addSheet("Products", ["Handle", "Variant Barcode", "Body HTML"], [
      { Handle: "a", "Variant Barcode": "00123", "Body HTML": long },
      { Handle: "b", "Variant Barcode": "", "Body HTML": "<p>é</p>" },
    ]);
    await out.addSheet("Customers", ["Email"], [{ Email: "x@y.z" }]);
    const file = await out.close();
    const sheets = await readWorkbook(file);
    expect(sheets.map((s) => s.name)).toEqual(["Products", "Customers"]);
    expect(sheets[0].rows[0]["Variant Barcode"]).toBe("00123");
    expect(sheets[0].rows[0]["Body HTML"]).toBe(long);
    expect(sheets[0].rows[1]["Body HTML"]).toBe("<p>é</p>");
  });

  it("writes CSV (single) and ZIP (multiple sheets) and reads them back", async () => {
    const dir = tmp();
    const single = createCsvOut(path.join(dir, "one"));
    await single.addSheet("Products", ["Handle"], [{ Handle: "a" }]);
    const csvFile = await single.close();
    expect(csvFile.endsWith(".csv")).toBe(true);
    expect((await readWorkbook(csvFile, "Products.csv"))[0].rows).toEqual([{ Handle: "a" }]);

    const multi = createCsvOut(path.join(dir, "two"));
    await multi.addSheet("Products", ["Handle"], [{ Handle: "a" }]);
    await multi.addSheet("Redirects", ["Path", "Target"], [{ Path: "/x", Target: "/y" }]);
    const zipFile = await multi.close();
    expect(zipFile.endsWith(".zip")).toBe(true);
    const sheets = await readWorkbook(zipFile);
    expect(sheets.map((s) => s.name)).toEqual(["Products", "Redirects"]);
    expect(sheets[1].rows[0]).toEqual({ Path: "/x", Target: "/y" });
  });

  it("reads a zip made elsewhere", async () => {
    const dir = tmp();
    const file = path.join(dir, "in.zip");
    fs.writeFileSync(file, zipSync({ "folder/Customers.csv": strToU8("Email\na@b.c\n") }));
    const sheets = await readWorkbook(file);
    expect(sheets[0]).toMatchObject({ name: "Customers", rows: [{ Email: "a@b.c" }] });
  });
});

const fakeEntity = (key: string, sheet: string, apply?: Entity["import"]): Entity => ({
  key,
  sheet,
  description: "",
  columns: ["ID", "Handle", "Title"],
  import: apply,
});

describe("registry", () => {
  const entities = [fakeEntity("products", "Products"), fakeEntity("smart_collections", "Smart Collections"), fakeEntity("custom_collections", "Custom Collections")];
  it("detects entities from sheet and file names", () => {
    expect(detectEntity({ name: "Products" }, entities)?.key).toBe("products");
    expect(detectEntity({ name: "products (2)" }, entities)?.key).toBe("products");
    expect(detectEntity({ name: "Export_2026-10-27_Smart_Collections" }, entities)?.key).toBe("smart_collections");
    expect(detectEntity({ name: "Sheet1" }, entities)).toBeNull();
  });
});

describe("importer", () => {
  it("groups rows by key and continuation rows", () => {
    const rows: Row[] = [
      { ID: "", Handle: "a" },
      { ID: "", Handle: "" },
      { ID: "", Handle: "b" },
      { ID: "", Handle: "A" },
    ];
    const items = groupRows(rows, ["ID", "Handle"]);
    expect(items.map((i) => i.rowIndexes)).toEqual([[0, 1, 3], [2]]);
  });

  it("applies commands, records results and writes a result sheet", async () => {
    const seen: string[] = [];
    const entity = fakeEntity("products", "Products", {
      keyColumns: ["ID", "Handle"],
      async apply(_ctx, rows, command) {
        seen.push(`${command}:${rows[0].Handle}`);
        if (rows[0].Handle === "bad") throw new Error("boom");
        return { status: "OK", command, id: "gid://shopify/Product/99", message: "Done" };
      },
    });
    const dir = tmp();
    const out = createXlsxOut(path.join(dir, "r.xlsx"));
    const summaries = await runImport({
      ctx: { gql: (async () => ({})) as any, options: {}, log: () => {}, cache: new Map() },
      sheets: [
        {
          name: "Products",
          headers: ["Handle", "Command"],
          rows: [
            { Handle: "a", Command: "" },
            { Handle: "b", Command: "delete" },
            { Handle: "c", Command: "IGNORE" },
            { Handle: "bad", Command: "" },
            { Handle: "d", Command: "nope" },
          ],
        },
        { name: "Unknown", headers: ["X"], rows: [{ X: "1" }] },
      ],
      entities: [entity],
      out,
      log: () => {},
    });
    expect(seen.sort()).toEqual(["DELETE:b", "MERGE:a", "MERGE:bad"]);
    const s = summaries.find((x) => x.entity === "products")!;
    expect(s).toMatchObject({ items: 5, ok: 2, failed: 2, skipped: 1 });
    const result = (await readWorkbook(await out.close()))[0];
    expect(result.headers.slice(-2)).toEqual(["Import Result", "Import Comment"]);
    expect(result.rows[0]).toMatchObject({ ID: "99", "Import Result": "OK" });
    expect(result.rows[3]).toMatchObject({ "Import Result": "Failed", "Import Comment": "Error: boom" });
    expect(result.rows[4]["Import Comment"]).toMatch(/Unknown command/);
  });

  it("dry run calls nothing", async () => {
    let called = false;
    const entity = fakeEntity("products", "Products", {
      keyColumns: ["Handle"],
      async apply(_c, _r, command) {
        called = true;
        return { status: "OK", command };
      },
    });
    const [s] = await runImport({
      ctx: { gql: (async () => ({})) as any, options: { dryRun: true }, log: () => {}, cache: new Map() },
      sheets: [{ name: "Products", headers: ["Handle"], rows: [{ Handle: "a" }] }],
      entities: [entity],
      log: () => {},
    });
    expect(called).toBe(false);
    expect(s.skipped).toBe(1);
  });
});

describe("exporter", () => {
  it("spools rows, orders columns and appends dynamic columns", async () => {
    const entity: Entity = {
      key: "products",
      sheet: "Products",
      description: "",
      columns: ["ID", "Handle", "Title"],
      async export(ctx, emit) {
        await emit([{ Title: "A", ID: "1", "Metafield: b.b [x]": "2" }]);
        await emit([{ ID: "2", Handle: "h", "Metafield: a.a [x]": "1" }]);
        ctx.progress(2);
      },
    };
    const dir = tmp();
    const out = createXlsxOut(path.join(dir, "e.xlsx"));
    const [summary] = await runExport({
      gql: (async () => ({})) as any,
      bulk: async function* () {},
      requests: [{ entity, options: {} }],
      out,
      tmpDir: dir,
      log: () => {},
    });
    expect(summary).toEqual({ entity: "products", rows: 2, items: 2 });
    const [sheet] = await readWorkbook(await out.close());
    expect(sheet.headers).toEqual(["ID", "Handle", "Title", "Metafield: a.a [x]", "Metafield: b.b [x]"]);
  });
});
