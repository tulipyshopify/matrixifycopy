import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { inflateSync, unzipSync, Zip, ZipDeflate } from "fflate";
import type { Logger, Row } from "./types";

export interface Sheet {
  name: string;
  headers: string[];
  rows: Row[];
}

export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_CELL = 32_767;

// --- Reading ------------------------------------------------------------------

function cellText(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text).join("");
    if ("result" in v) return cellText(v.result);
    if ("text" in v) return cellText(v.text);
    if ("error" in v) return "";
  }
  return String(v);
}

function rowsFromMatrix(matrix: string[][]): { headers: string[]; rows: Row[] } {
  const headerIdx = matrix.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (headerIdx < 0) return { headers: [], rows: [] };
  const raw = matrix[headerIdx].map((h) => h.trim());
  // De-duplicate repeated headers ("Tags", "Tags (2)") so no data is lost.
  const seen = new Map<string, number>();
  const headers = raw.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
  const rows: Row[] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const r = matrix[i];
    if (!r || r.every((c) => (c ?? "").trim() === "")) continue;
    const row: Row = {};
    headers.forEach((h, j) => {
      if (h) row[h] = r[j] ?? "";
    });
    rows.push(row);
  }
  return { headers: headers.filter(Boolean), rows };
}

export function parseCsv(text: string): { headers: string[]; rows: Row[] } {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parsed = Papa.parse<string[]>(clean, { skipEmptyLines: false });
  return rowsFromMatrix(parsed.data as string[][]);
}

/**
 * Reads one small entry of a zip (e.g. "xl/workbook.xml") through the zip's
 * central directory, without unpacking the rest. Null when it isn't there or
 * the archive uses a layout this doesn't cover (zip64).
 */
export async function readZipEntry(input: string | Buffer, name: string): Promise<Buffer | null> {
  return (await zipDirectory(input, name))?.data ?? null;
}

/** Names of every entry in a zip, from its central directory; null when unreadable. */
export async function zipEntryNames(input: string | Buffer): Promise<string[] | null> {
  return (await zipDirectory(input, null))?.names ?? null;
}

async function zipDirectory(input: string | Buffer, want: string | null): Promise<{ names: string[]; data: Buffer | null } | null> {
  const fh = typeof input === "string" ? await fs.promises.open(input, "r") : null;
  try {
    const size = fh ? (await fh.stat()).size : (input as Buffer).length;
    const read = async (pos: number, len: number) => {
      if (!fh) return (input as Buffer).subarray(pos, pos + len);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      return buf;
    };
    // End of central directory: in the last 64 KB + 22 bytes.
    const tailLen = Math.min(size, 65_557);
    const tail = await read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const names: string[] = [];
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    if (dirOffset === 0xffffffff || dirOffset + dirSize > size) return null;
    const dir = await read(dirOffset, dirSize);
    for (let p = 0, n = 0; n < count && p + 46 <= dir.length; n++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) return null;
      const method = dir.readUInt16LE(p + 10);
      const compSize = dir.readUInt32LE(p + 20);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      const local = dir.readUInt32LE(p + 42);
      const entryName = dir.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      names.push(entryName);
      if (entryName === want) {
        const head = await read(local, 30);
        if (head.readUInt32LE(0) !== 0x04034b50) return null;
        const start = local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
        const data = await read(start, compSize);
        if (method === 0) return { names, data: Buffer.from(data) };
        if (method === 8) return { names, data: Buffer.from(inflateSync(data)) };
        return null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return want ? null : { names, data: null };
  } finally {
    await fh?.close();
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Sheet names an .xlsx says it has, in order; null when that can't be read. */
export async function xlsxSheetNames(input: string | Buffer): Promise<string[] | null> {
  const xml = await readZipEntry(input, "xl/workbook.xml").catch(() => null);
  if (!xml) return null;
  return [...xml.toString("utf8").matchAll(/<sheet\b[^>]*?\bname="([^"]*)"/g)].map((m) =>
    m[1].replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
      e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1] === "x" ? 2 : 1), e[1] === "x" ? 16 : 10)) : XML_ENTITIES[e.toLowerCase()],
    ),
  );
}

async function streamXlsx(input: string | Buffer): Promise<Sheet[]> {
  const stream = typeof input === "string" ? fs.createReadStream(input) : Readable.from(input);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream as any, {
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    worksheets: "emit",
  });
  const sheets: Sheet[] = [];
  for await (const ws of reader as any) {
    const matrix: string[][] = [];
    for await (const row of ws) {
      const values: any[] = row.values ?? [];
      // row.values is 1-indexed
      const arr: string[] = [];
      for (let c = 1; c < values.length; c++) arr.push(cellText(values[c]));
      matrix[row.number - 1] = arr;
    }
    for (let i = 0; i < matrix.length; i++) matrix[i] ??= [];
    const { headers, rows } = rowsFromMatrix(matrix);
    sheets.push({ name: ws.name ?? `Sheet${sheets.length + 1}`, headers, rows });
  }
  return sheets;
}

/**
 * Reads an .xlsx. The streaming reader can stop early and return only the
 * first sheet, unnamed, without an error; so the result is checked against
 * the sheet list in the file itself, read once more if it doesn't match, and
 * refused rather than imported half.
 */
async function readXlsx(input: string | Buffer): Promise<Sheet[]> {
  // What the file holds: its worksheet files, and the tab names (chart tabs included).
  const entries = await zipEntryNames(input).catch(() => null);
  const worksheetCount = entries?.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length ?? null;
  const names = await xlsxSheetNames(input);
  const complete = (sheets: Sheet[]) =>
    worksheetCount === null || !names || (sheets.length === worksheetCount && sheets.every((s) => names.includes(s.name)));
  let sheets = await streamXlsx(input);
  if (complete(sheets)) return sheets;
  sheets = await streamXlsx(input);
  if (complete(sheets)) return sheets;
  throw new Error(
    `This Excel file couldn't be read completely (found ${sheets.length} of its ${worksheetCount} sheets). Save it again in Excel, or use CSV, and import it again.`,
  );
}

/**
 * Reads an uploaded file into sheets. CSV files become a single sheet named
 * after the file (so "Products.csv" is recognised as products); ZIP archives
 * may hold several CSV/XLSX files.
 */
export async function readWorkbook(filePath: string, originalName = path.basename(filePath)): Promise<Sheet[]> {
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, ext);
  if (ext === ".xlsx" || ext === ".xlsm") return readXlsx(filePath);
  if (ext === ".csv" || ext === ".txt" || ext === ".tsv") {
    const { headers, rows } = parseCsv(await fs.promises.readFile(filePath, "utf8"));
    return [{ name: baseName, headers, rows }];
  }
  if (ext === ".zip") {
    const files = unzipSync(new Uint8Array(await fs.promises.readFile(filePath)));
    const sheets: Sheet[] = [];
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith("/") || name.startsWith("__MACOSX")) continue;
      const e = path.extname(name).toLowerCase();
      const b = path.basename(name, e);
      if (e === ".csv") {
        const { headers, rows } = parseCsv(Buffer.from(data).toString("utf8"));
        sheets.push({ name: b, headers, rows });
      } else if (e === ".xlsx") {
        sheets.push(...(await readXlsx(Buffer.from(data))));
      }
    }
    return sheets;
  }
  throw new Error(`Unsupported file type "${ext}". Upload .xlsx, .csv or .zip`);
}

// --- Writing ------------------------------------------------------------------

export type OutputFormat = "xlsx" | "csv";

export interface WorkbookOut {
  /** Adds a sheet. Rows are pulled from the iterable in order. */
  addSheet(name: string, headers: string[], rows: AsyncIterable<Row> | Iterable<Row>): Promise<void>;
  /** Finishes writing and returns the final path (extension may change). */
  close(): Promise<string>;
}

function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
  let candidate = base;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function createXlsxOut(filePath: string, log: Logger = () => {}): WorkbookOut {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true, useSharedStrings: false });
  const used = new Set<string>();
  let truncated = 0;
  let sheetCount = 0;
  return {
    async addSheet(name, headers, rows) {
      let ws: any = null;
      let n = 0;
      let part = 1;
      const open = () => {
        ws = wb.addWorksheet(safeSheetName(part === 1 ? name : `${name} (${part})`, used), {
          views: [{ state: "frozen", ySplit: 1 }],
        });
        ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.min(60, Math.max(10, h.length + 2)) }));
        ws.getRow(1).font = { bold: true };
        ws.getRow(1).commit();
        n = 1;
        sheetCount++;
      };
      open();
      for await (const row of rows as AsyncIterable<Row>) {
        if (n >= EXCEL_MAX_ROWS) {
          ws.commit();
          part++;
          open();
        }
        const values = headers.map((h) => {
          let v = row[h] ?? "";
          if (v.length > EXCEL_MAX_CELL) {
            truncated++;
            v = v.slice(0, EXCEL_MAX_CELL);
          }
          return v;
        });
        ws.addRow(values).commit();
        n++;
      }
      ws.commit();
    },
    async close() {
      if (sheetCount === 0) {
        const ws = wb.addWorksheet("Empty");
        ws.addRow(["No data"]).commit();
        ws.commit();
      }
      await wb.commit();
      if (truncated) log(`Warning: ${truncated} cells exceeded Excel's 32,767 character limit and were truncated. Use CSV format to keep full values.`);
      return filePath;
    },
  };
}

function csvLine(values: string[]): string {
  return Papa.unparse([values], { newline: "\r\n" }) + "\r\n";
}

/**
 * CSV output: one sheet -> one .csv file; several sheets -> a .zip with one
 * CSV per sheet. `filePath` should be given without extension.
 */
export function createCsvOut(filePathNoExt: string): WorkbookOut {
  const tmpFiles: Array<{ name: string; file: string }> = [];
  const used = new Set<string>();
  return {
    async addSheet(name, headers, rows) {
      const file = `${filePathNoExt}.${tmpFiles.length}.csv.tmp`;
      const out = fs.createWriteStream(file);
      let failed: Error | null = null;
      out.on("error", (e) => (failed = e));
      const write = async (s: string) => {
        if (failed) throw failed;
        if (!out.write(s)) await new Promise((r) => out.once("drain", r));
      };
      await write("﻿" + csvLine(headers));
      for await (const row of rows as AsyncIterable<Row>) await write(csvLine(headers.map((h) => row[h] ?? "")));
      await new Promise<void>((r) => out.end(r));
      tmpFiles.push({ name: safeSheetName(name, used), file });
    },
    async close() {
      if (tmpFiles.length === 0) {
        // Nothing was written: a readable note instead of an empty archive.
        const final = `${filePathNoExt}.csv`;
        await fs.promises.writeFile(final, "\ufeff" + csvLine(["Note"]) + csvLine(["The file had no sheets with rows."]));
        return final;
      }
      if (tmpFiles.length === 1) {
        const final = `${filePathNoExt}.csv`;
        await fs.promises.rename(tmpFiles[0].file, final);
        return final;
      }
      const final = `${filePathNoExt}.zip`;
      const out = fs.createWriteStream(final);
      const zip = new Zip((err, data, final) => {
        if (err) throw err;
        out.write(Buffer.from(data));
        if (final) out.end();
      });
      for (const t of tmpFiles) {
        const entry = new ZipDeflate(`${t.name}.csv`, { level: 6 });
        zip.add(entry);
        const rl = fs.createReadStream(t.file);
        for await (const buf of rl) entry.push(new Uint8Array(buf as Buffer), false);
        entry.push(new Uint8Array(0), true);
        await fs.promises.unlink(t.file);
      }
      zip.end();
      await new Promise<void>((r) => (out.writableFinished ? r() : out.on("finish", () => r())));
      return final;
    },
  };
}

export function createWorkbookOut(format: OutputFormat, filePathNoExt: string, log?: Logger): WorkbookOut {
  return format === "csv" ? createCsvOut(filePathNoExt) : createXlsxOut(`${filePathNoExt}.xlsx`, log);
}

// --- Row spool ------------------------------------------------------------------

/**
 * Temporary on-disk store of rows. Exports don't know every column up front
 * (metafields, inventory locations), so rows are spooled first and written to
 * the workbook once the full header set is known.
 */
export class RowSpool {
  private out: fs.WriteStream;
  private headerSet = new Set<string>();
  count = 0;
  constructor(public file: string) {
    this.out = fs.createWriteStream(file);
  }
  async push(row: Row) {
    for (const k of Object.keys(row)) this.headerSet.add(k);
    this.count++;
    if (!this.out.write(JSON.stringify(row) + "\n")) {
      await new Promise((r) => this.out.once("drain", r));
    }
  }
  headers(preferred: string[]): string[] {
    const ordered = preferred.filter((h) => this.headerSet.has(h));
    const rest = [...this.headerSet].filter((h) => !preferred.includes(h));
    // Keep dynamic columns grouped and sorted (metafields, inventory, etc.).
    rest.sort((a, b) => a.localeCompare(b));
    return [...ordered, ...rest];
  }
  async finish() {
    await new Promise<void>((r) => this.out.end(r));
  }
  async *rows(): AsyncGenerator<Row> {
    const rl = createInterface({ input: fs.createReadStream(this.file), crlfDelay: Infinity });
    for await (const line of rl) if (line) yield JSON.parse(line);
  }
  async dispose() {
    // Close the stream first: it may still be opening the file (failed or
    // cancelled exports), which would otherwise recreate it after the unlink.
    if (!this.out.closed) {
      await new Promise<void>((r) => {
        this.out.once("close", () => r());
        this.out.destroy();
      });
    }
    await fs.promises.unlink(this.file).catch(() => {});
  }
}
