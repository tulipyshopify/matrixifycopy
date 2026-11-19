import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { createXlsxOut, libraryXlsx, readWorkbook, readZipEntry, xlsxSheetNames, zipEntryNames } from "../app/lib/core/sheets";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-xlsx-"));

async function twoSheets(dir = tmp()) {
  const out = createXlsxOut(path.join(dir, "t.xlsx"));
  await out.addSheet("Products & Co", ["Handle"], [{ Handle: "a" }]);
  await out.addSheet("Customers", ["Email"], [{ Email: "x@y.z" }]);
  return out.close();
}

/** Makes ExcelJS's streaming reader stop after the first sheet, unnamed, the way the flaky run did. */
function shortReads(times: number) {
  const orig = ExcelJS.stream.xlsx.WorkbookReader.prototype.parse;
  let left = times;
  return vi.spyOn(ExcelJS.stream.xlsx.WorkbookReader.prototype as any, "parse").mockImplementation(async function* (this: any, ...a: any[]) {
    const short = left-- > 0;
    for await (const item of (orig as any).apply(this, a)) {
      if (item.eventType === "worksheet" && short) {
        item.value.name = undefined;
        yield item;
        return;
      }
      yield item;
    }
  });
}

describe("reading .xlsx files completely", () => {
  it("reads the file's own sheet list and entries", async () => {
    const file = await twoSheets();
    expect(await xlsxSheetNames(file)).toEqual(["Products & Co", "Customers"]);
    expect(await xlsxSheetNames(fs.readFileSync(file))).toEqual(["Products & Co", "Customers"]);
    expect((await zipEntryNames(file))!.filter((n) => n.startsWith("xl/worksheets/"))).toEqual(["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
    expect(await readZipEntry(file, "nope.xml")).toBeNull();
    const notZip = path.join(tmp(), "x.xlsx");
    fs.writeFileSync(notZip, "hello");
    expect(await xlsxSheetNames(notZip)).toBeNull();
  });

  it("the library reader never returns a short read: it reads the whole file instead", async () => {
    const file = await twoSheets();
    const spy = shortReads(1);
    try {
      expect((await libraryXlsx(file)).map((s) => s.name)).toEqual(["Products & Co", "Customers"]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to reading the whole file when the quick reader keeps coming up short", async () => {
    const file = await twoSheets();
    const spy = shortReads(5);
    try {
      expect((await readWorkbook(file)).map((s) => s.name)).toEqual(["Products & Co", "Customers"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("accepts files saved by Excel with tabs in another order", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Second").addRow(["B"]);
    wb.addWorksheet("First").addRow(["A"]);
    (wb.worksheets[0] as any).orderNo = 1;
    (wb.worksheets[1] as any).orderNo = 0;
    const file = path.join(tmp(), "excel.xlsx");
    await wb.xlsx.writeFile(file);
    const names = (await readWorkbook(file)).map((s) => s.name).sort();
    expect(names).toEqual(["First", "Second"]);
  });
});
