import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareFeeds, feedSummary } from "../app/lib/jobs/feed.server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-feed-"));
const write = (name: string, text: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
};
const at = new Date("2026-11-19T06:00:00Z");

describe("a feed compared with the file fetched last time", () => {
  it("counts new, gone and changed rows, and says which columns changed most", async () => {
    const before = write("a.csv", "Variant SKU,Variant Price,Variant Inventory Qty,Title\nAC-100,50.00,4,Oak Barrel\nAC-200,39.99,10,Willow Hurdle\nAC-300,120.00,0,Old Oak Tub\n");
    const after = write("b.csv", "Variant SKU,Variant Price,Variant Inventory Qty,Title,Colour\nAC-100,55.00,2,Oak Barrel,Brown\nAC-200,39.99,7,Willow Hurdle,\nAC-400,15.00,30,New Trowel,Green\n");
    const d = (await compareFeeds({ file: before, name: "Products.csv", at }, { file: after, name: "Products.csv" }))!;
    expect(d.identical).toBe(false);
    expect(d.sheets[0]).toMatchObject({ key: "Variant SKU", rows: 3, added: 1, removed: 1, changed: 2, addedColumns: ["Colour"], removedColumns: [] });
    expect(d.sheets[0].columns).toEqual([{ column: "Variant Inventory Qty", cells: 2 }, { column: "Variant Price", cells: 1 }]);
    expect(d.sheets[0].examples).toContain("AC-100: Variant Price 50.00 → 55.00");
    expect(feedSummary(d)[0]).toBe("since the last file, 1 new, 1 no longer in the file, 2 changed (of 3 rows, matched by Variant SKU). Mostly Variant Inventory Qty (2), Variant Price (1). New columns: Colour.");
  });

  it("says when nothing was updated at the source, and warns when a large part of the file is gone", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => `S-${i},${i}.00`).join("\n");
    const full = write("full.csv", `Code,Price\n${rows}\n`);
    const same = write("same.csv", `Code,Price\n${rows}\n`);
    expect(feedSummary((await compareFeeds({ file: full, name: "feed.csv", at }, { file: same, name: "feed.csv" }))!)).toEqual(["This file is exactly the one fetched last time: the source has not been updated."]);
    const half = write("half.csv", `Code,Price\n${rows.split("\n").slice(0, 40).join("\n")}\n`);
    const d = (await compareFeeds({ file: full, name: "feed.csv", at }, { file: half, name: "feed.csv" }))!;
    // A supplier's own column names: rows are matched by the first column.
    expect(d.sheets[0]).toMatchObject({ key: "Code", removed: 60, added: 0, changed: 0 });
    expect(feedSummary(d)[0]).toMatch(/60 no longer in the file .*That is a large part of the file gone: check the source before applying\./);
  });
});
