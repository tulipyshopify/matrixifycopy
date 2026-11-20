import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
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
  /** Things the reader noticed that the person should know (e.g. the text encoding it assumed). */
  notes?: string[];
  /** The file inside a ZIP this sheet came from. */
  file?: string;
  /** How to show the sheet when its name alone doesn't say which file it is from ("file › sheet"). */
  label?: string;
  /** The data type this sheet was matched to by a saved column layout (overrides recognising it). */
  entity?: string;
  /** Columns a saved layout sets aside: kept in the sheet, not imported and not reported as unknown. */
  ignoredColumns?: string[];
  /** Row number in the file of each row, when the rows are a part of a larger sheet (default: position + 2). */
  rowNumbers?: number[];
}

/**
 * Put in a cell that holds a formula whose result was not saved in the file
 * (files written by scripts, not by Excel). The import fails such a row with a
 * clear reason instead of importing an empty or wrong value.
 */
export const NO_VALUE_MARK = "#NOVALUE!";

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
    if ("formula" in v || "sharedFormula" in v) return `${NO_VALUE_MARK}=${v.formula ?? v.sharedFormula}`;
    if ("text" in v) return cellText(v.text);
    if ("error" in v) return "";
  }
  return String(v);
}

/**
 * Builds rows as one object literal with every column, so all rows of a sheet
 * share one compact layout. Filling an empty object column by column makes
 * the engine store each wide row as its own hash table, several times larger.
 */
function rowFactory(headers: string[]): (cells: string[], share: (v: string, j?: number) => string) => Row {
  const fields = headers.map((h, j) => (h ? `${h === "__proto__" ? `["__proto__"]` : JSON.stringify(h)}: share(cells[${j}] ?? "", ${j})` : "")).filter(Boolean);
  // Header names only ever appear as JSON string literals: nothing from the file runs as code.
  return new Function("cells", "share", `return { ${fields.join(", ")} };`) as (cells: string[], share: (v: string, j?: number) => string) => Row;
}

/** A problem with the file itself, already worded for the person who uploaded it. */
export class FileError extends Error {}

/** Columns whose values identify things: look-alike and invisible characters are never meant there. */
const KEY_COLUMN = /(^|\s)(ID|SKU|Barcode|Handle|Email|Code|Path|Target|Command)$/i;
const BEYOND_LATIN = /[^\u0000-˿]/;
const INVISIBLE = /[​⁠﻿]/;
const BIDI = /[‪-‮⁦-⁩]/;
const FULL_WIDTH = /[！-～　]/;
/** Text that a spreadsheet program would run as a formula if the file were opened there. */
export function looksLikeFormula(v: string): boolean {
  const c = v.charCodeAt(0);
  if (c === 61) return true; // =
  if (c !== 43 && c !== 45 && c !== 64) return false; // + - @
  return /\||[A-Za-z_]\(/.test(v);
}
/** Whole-cell Excel error values: a broken formula's result, never real data. */
export const EXCEL_ERROR = /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NULL!|NUM!|SPILL!|CALC!|GETTING_DATA)$/i;

interface MatrixOptions {
  /** Matrix indexes of rows the workbook hides (hidden by hand or by a filter). */
  hidden?: Set<number>;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

function rowsFromMatrix(matrix: string[][], opts: MatrixOptions = {}): { headers: string[]; rows: Row[]; notes: string[] } {
  const notes: string[] = [];
  const filled = (r: string[] | undefined) => (r ? r.reduce((n, c) => n + ((c ?? "").trim() !== "" ? 1 : 0), 0) : 0);
  let headerIdx = matrix.findIndex((r) => filled(r) > 0);
  if (headerIdx < 0) return { headers: [], rows: [], notes };
  // A title line above the table ("Price list – November"): one filled cell,
  // followed by a row with several. The column names are in that later row.
  for (let tries = 0; tries < 5 && filled(matrix[headerIdx]) === 1; tries++) {
    let next = headerIdx + 1;
    while (next < matrix.length && next <= headerIdx + 5 && filled(matrix[next]) === 0) next++;
    if (next >= matrix.length || filled(matrix[next]) < 2) break;
    const title = matrix[headerIdx].find((c) => (c ?? "").trim())!.trim();
    notes.push(`Row ${headerIdx + 1} ("${title.length > 60 ? `${title.slice(0, 57)}…` : title}") was read as a title line, not as column names. The column names were taken from row ${next + 1}.`);
    headerIdx = next;
  }
  const raw = matrix[headerIdx].map((h) => (h ?? "").replace(/[​⁠﻿]/g, "").replace(/ /g, " ").trim());
  // De-duplicate repeated headers ("Tags", "Tags (2)") so no data is lost.
  const seen = new Map<string, number>();
  const repeated = new Set<string>();
  const headers = raw.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    if (n > 1 && h) repeated.add(h);
    return n === 1 ? h : `${h} (${n})`;
  });
  for (const h of repeated) {
    notes.push(`Column "${h}" appears ${seen.get(h) === 2 ? "twice" : `${seen.get(h)} times`} in this sheet. Only the first is used; the other${seen.get(h) === 2 ? " is" : "s are"} ignored. Remove the extra column${seen.get(h) === 2 ? "" : "s"} if that is not what you want.`);
  }
  const rows: Row[] = [];
  const make = rowFactory(headers);
  const keyColumn = headers.map((h) => KEY_COLUMN.test(h));
  const found = { invisible: 0, invisibleAt: "", bidi: 0, bidiAt: "", wide: 0, wideAt: "", formula: 0, formulaAt: "" };
  let rowNumber = 0;
  /** Look-alike and invisible characters: removed where they can only be a mistake, pointed out elsewhere. */
  const tidy = (v: string, j: number): string => {
    let t = v;
    if (keyColumn[j]) {
      if (INVISIBLE.test(t) || BIDI.test(t) || /[‌‍ ]/.test(t)) {
        t = t.replace(/[​-‍⁠﻿‪-‮⁦-⁩]/g, "").replace(/ /g, " ").trim();
        if (!found.invisible++) found.invisibleAt = `row ${rowNumber}, "${headers[j]}"`;
      }
      if (FULL_WIDTH.test(t)) {
        if (!found.wide++) found.wideAt = `row ${rowNumber}, "${headers[j]}": ${t.length > 30 ? `${t.slice(0, 30)}…` : t}`;
        t = t.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ").trim();
      }
      return t;
    }
    if (BIDI.test(t) && !found.bidi++) found.bidiAt = `row ${rowNumber}, "${headers[j]}"`;
    else if (INVISIBLE.test(t) && !found.invisible++) found.invisibleAt = `row ${rowNumber}, "${headers[j]}"`;
    return t;
  };
  // The same short values repeat down a column (handles, "MERGE", "TRUE"…):
  // keeping one copy of each roughly halves the memory of a large sheet.
  const pool = new Map<string, string>();
  const share = (v: string, j = -1): string => {
    if (v.length === 0) return "";
    if (BEYOND_LATIN.test(v) || (j >= 0 && keyColumn[j] && v.includes(" "))) v = tidy(v, j);
    const first = v.charCodeAt(0);
    if ((first === 61 || first === 43 || first === 45 || first === 64) && !keyColumn[j] && looksLikeFormula(v) && !found.formula++) {
      found.formulaAt = `row ${rowNumber}, "${headers[j] ?? ""}": ${v.length > 40 ? `${v.slice(0, 40)}…` : v}`;
    }
    if (v.length > 40) return v;
    const known = pool.get(v);
    if (known !== undefined) return known;
    // Detach from the file's text, so that text can be freed.
    const own = v.length < 13 ? v : (" " + v).slice(1);
    if (pool.size < 200_000) pool.set(own, own);
    return own;
  };
  let repeatedHeaders = 0;
  let overflow = 0;
  let hiddenRows = 0;
  const unnamed = new Set<number>();
  const width = headers.length;
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const r = matrix[i];
    // Converted rows are dropped from the matrix straight away, so both are never held in full.
    (matrix as Array<string[] | undefined>)[i] = undefined;
    if (!r || r.every((c) => (c ?? "").trim() === "")) continue;
    // The column names again, further down (pasted pages, a print layout): not data.
    if (r.length >= 2 && raw.every((h, j) => (r[j] ?? "").trim() === h) && filled(r) === raw.filter(Boolean).length) {
      repeatedHeaders++;
      continue;
    }
    if (r.length > width && r.slice(width).some((c) => (c ?? "").trim() !== "")) overflow++;
    for (let j = 0; j < width; j++) if (!headers[j] && (r[j] ?? "").trim() !== "") unnamed.add(j);
    if (opts.hidden?.has(i)) hiddenRows++;
    rowNumber = i + 1;
    rows.push(make(r, share));
  }
  if (repeatedHeaders) notes.push(`The row of column names appears ${plural(repeatedHeaders, "more time")} further down the sheet. ${repeatedHeaders === 1 ? "That row was" : "Those rows were"} skipped, not imported as data.`);
  if (overflow) notes.push(`${plural(overflow, "row")} ${overflow === 1 ? "has" : "have"} values to the right of the last named column. Those values are ignored.`);
  if (unnamed.size) notes.push(`${plural(unnamed.size, "column")} with no name in the first row ${unnamed.size === 1 ? "holds" : "hold"} values (column ${[...unnamed].slice(0, 5).map((j) => columnLetter(j)).join(", ")}${unnamed.size > 5 ? "…" : ""}). ${unnamed.size === 1 ? "It is" : "They are"} ignored.`);
  if (hiddenRows) notes.push(`${plural(hiddenRows, "hidden or filtered-out row")} on this sheet ${hiddenRows === 1 ? "is" : "are"} included in the import. A filter in Excel only hides rows, it does not remove them. Delete the rows from the file if they should not be imported.`);
  if (found.wide) notes.push(`${plural(found.wide, "value")} in key columns ${found.wide === 1 ? "was" : "were"} typed in full-width characters (first: ${found.wideAt}). They were read as ordinary letters and digits, so they match what is in the store.`);
  if (found.invisible) notes.push(`${plural(found.invisible, "cell")} ${found.invisible === 1 ? "contains" : "contain"} an invisible character, such as a zero-width space (first: ${found.invisibleAt}). In ID, handle, SKU and barcode columns it was removed; elsewhere it is imported as it is.`);
  if (found.bidi) notes.push(`${plural(found.bidi, "cell")} ${found.bidi === 1 ? "contains" : "contain"} a hidden character that reverses the direction of text (first: ${found.bidiAt}). It can make text read differently from what is stored and is rarely meant in shop data. Check ${found.bidi === 1 ? "that cell" : "those cells"} before importing.`);
  if (found.formula) notes.push(`${plural(found.formula, "cell")} ${found.formula === 1 ? "starts" : "start"} like a spreadsheet formula (first: ${found.formulaAt}). ${found.formula === 1 ? "It is" : "They are"} imported as plain text, never run. Check that this text is meant to be there.`);
  return { headers: headers.filter(Boolean), rows, notes };
}

function columnLetter(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Marks a CSV value exported with a guard against running as a formula in Excel. */
const FORMULA_GUARD = "'";

export function parseCsv(text: string): { headers: string[]; rows: Row[]; notes: string[] } {
  let clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Excel in some regions writes "sep=;" as the first line: the delimiter, not data.
  let delimiter: string | undefined;
  const sep = /^sep=([^\r\n]?)\r?\n?/i.exec(clean.slice(0, 12));
  if (sep) {
    delimiter = sep[1] || undefined;
    clean = clean.slice(sep[0].length);
  }
  let parsed = Papa.parse<string[]>(clean, { skipEmptyLines: false, ...(delimiter ? { delimiter } : {}) });
  // A short file can leave the delimiter undecided: if the first row came out as one cell that
  // holds tabs, semicolons or bars, that character is the delimiter.
  if (!delimiter) {
    const first = (parsed.data as string[][]).find((r) => r.some((c) => c.trim() !== ""));
    if (first && first.length === 1) {
      const found = ["\t", ";", "|"].map((d) => ({ d, n: first[0].split(d).length - 1 })).sort((a, b) => b.n - a.n)[0];
      if (found.n > 0) parsed = Papa.parse<string[]>(clean, { skipEmptyLines: false, delimiter: found.d });
    }
  }
  const quote = parsed.errors.find((e) => e.type === "Quotes");
  if (quote) {
    const at = (quote.row ?? 0) + 1 + (sep ? 1 : 0);
    throw new FileError(
      `Row ${at} has an unclosed or misplaced quote mark ("), so the rows after it can't be told apart reliably. Nothing was imported. In that row, put a second quote mark next to any quote that is part of the text (""), or remove it, then import again.`,
    );
  }
  const matrix = parsed.data as string[][];
  // A cell that holds a line break followed by what looks like a whole row: probably rows that ran together.
  const width = matrix.find((r) => r.some((c) => c.trim() !== ""))?.length ?? 0;
  let swallowed = "";
  if (width >= 4) {
    const d = parsed.meta.delimiter || ",";
    outer: for (let i = 1; i < matrix.length; i++) {
      for (const c of matrix[i]) {
        if (c.length < 8 || !c.includes("\n") || c.includes("<")) continue;
        if (c.split(/\r?\n/).slice(1).some((line) => line.split(d).length === width)) {
          swallowed = `Row ${i + 1 + (sep ? 1 : 0)} has a cell with a line break followed by what looks like a whole row of the file. A stray quote mark may have joined two rows together: check that row before importing.`;
          break outer;
        }
      }
    }
  }
  // Values our own CSV exports guarded against running as formulas come back as they were.
  for (const r of matrix) {
    for (let j = 0; j < r.length; j++) {
      const c = r[j];
      if (c.charCodeAt(0) === 39 && c.length > 1 && looksLikeFormula(c.slice(1))) r[j] = c.slice(1);
    }
  }
  const out = rowsFromMatrix(matrix);
  if (swallowed) out.notes.unshift(swallowed);
  return out;
}

/**
 * Turns a text file's bytes into text, working out the encoding: UTF-8 and
 * UTF-16 by their marks (or UTF-16's tell-tale zero bytes), and anything that
 * is not valid UTF-8 as Windows-1252, which is what Excel on Windows saves
 * "CSV" files in. Never produces replacement characters from a readable file.
 */
export function decodeText(buf: Uint8Array): { text: string; encoding: string } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: b.subarray(3).toString("utf8"), encoding: "UTF-8" };
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(b.subarray(2)), encoding: "UTF-16" };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(b.subarray(2)), encoding: "UTF-16" };
  // UTF-16 without a mark: every other byte of plain text is zero.
  const sample = b.subarray(0, 2000);
  if (sample.length >= 4) {
    let even = 0;
    let odd = 0;
    for (let i = 0; i < sample.length; i++) if (sample[i] === 0) i % 2 ? odd++ : even++;
    if (odd > sample.length * 0.2 && even < sample.length * 0.02) return { text: new TextDecoder("utf-16le").decode(b), encoding: "UTF-16" };
    if (even > sample.length * 0.2 && odd < sample.length * 0.02) return { text: new TextDecoder("utf-16be").decode(b), encoding: "UTF-16" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(b), encoding: "UTF-8" };
  } catch {
    // Latin-1 for the bytes both share, then the Windows-1252 extras (€ ‚ „ … – — ‘ ’ “ ” • ™ …).
    const text = b.toString("latin1").replace(/[\x80-\x9f]/g, (c) => CP1252[c.charCodeAt(0) - 0x80] ?? c);
    return { text, encoding: "Windows-1252" };
  }
}

const CP1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

/** Reads CSV bytes into a sheet, noting the encoding when it had to be guessed. */
function csvSheet(name: string, data: Uint8Array): Sheet {
  const { text, encoding } = decodeText(data);
  // A link that answers with a web page (a login screen, an error page): none of it is shown or imported.
  if (/^\s*(<!doctype html|<html[\s>]|<\?xml[^>]*>\s*<(!doctype html|html))/i.test(text.slice(0, 300))) {
    throw new FileError("This is a web page, not a spreadsheet. If it came from a link, the link opens a page (perhaps a login or an error page) instead of downloading the file. Use a link that downloads the file directly.");
  }
  const { headers, rows, notes } = parseCsv(text);
  const sheet: Sheet = { name, headers, rows };
  if (notes.length) sheet.notes = notes;
  if (encoding === "Windows-1252") {
    (sheet.notes ??= []).push("This file is not saved as UTF-8, so it was read as Windows-1252 (Excel's \"CSV\" format). Check accented letters and currency signs in the preview; to be sure, save it as \"CSV UTF-8\".");
  }
  return sheet;
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

/**
 * The first bytes of one entry of a zip (enough to tell what kind of file it
 * is), without unpacking the whole entry. Null when it isn't there.
 */
export async function readZipEntryHead(file: string, name: string, bytes = 262_144): Promise<Buffer | null> {
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const read = async (pos: number, len: number) => {
      const buf = Buffer.alloc(Math.max(0, Math.min(len, size - pos)));
      await fh.read(buf, 0, buf.length, pos);
      return buf;
    };
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
    const dir = await read(tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12));
    for (let p = 0; p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50; ) {
      const nameLen = dir.readUInt16LE(p + 28);
      if (dir.subarray(p + 46, p + 46 + nameLen).toString("utf8") === name) {
        const method = dir.readUInt16LE(p + 10);
        const compSize = dir.readUInt32LE(p + 20);
        const local = dir.readUInt32LE(p + 42);
        const head = await read(local, 30);
        if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) return null;
        const data = await read(local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), Math.min(compSize, bytes));
        if (method === 0) return data;
        if (method === 8) return zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).subarray(0, bytes);
        return null;
      }
      p += 46 + nameLen + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Every entry of a zip with its unpacked size, from its directory (nothing is unpacked); null when unreadable. */
export async function zipEntries(input: string | Buffer): Promise<Array<{ name: string; size: number }> | null> {
  const d = await zipDirectory(input, null);
  return d ? d.names.map((name, i) => ({ name, size: d.sizes[i] })) : null;
}

async function zipDirectory(input: string | Buffer, want: string | null): Promise<{ names: string[]; sizes: number[]; data: Buffer | null } | null> {
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
    const sizes: number[] = [];
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
      sizes.push(dir.readUInt32LE(p + 24));
      if (entryName === want) {
        const head = await read(local, 30);
        if (head.readUInt32LE(0) !== 0x04034b50) return null;
        const start = local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
        const data = await read(start, compSize);
        if (method === 0) return { names, sizes, data: Buffer.from(data) };
        if (method === 8) return { names, sizes, data: Buffer.from(inflateSync(data)) };
        return null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return want ? null : { names, sizes, data: null };
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

// --- Our own .xlsx reader -------------------------------------------------------
//
// Reads the parts of a workbook an import needs (cell values, sheet names,
// what is hidden) straight from its XML. Files written by other programs
// (SheetJS, openpyxl, report tools) differ in ways a general-purpose library
// trips over; comments, tables, drawings and styles are simply never opened here.

/** Most unpacked data read from one upload: a small archive can be made to unpack to gigabytes. */
export const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;

const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6)).toLocaleString("en-GB")} MB`;

/** Size of everything in a zip once unpacked, per entry, as its directory states (nothing is unpacked). */
export function unpackedSizes(zip: Uint8Array): Array<{ name: string; size: number }> {
  const entries: Array<{ name: string; size: number }> = [];
  unzipSync(zip, {
    filter: (f) => {
      entries.push({ name: f.name, size: f.originalSize });
      return false;
    },
  });
  return entries;
}

/** Unpacks the wanted entries of a zip, refusing one that would unpack too large. */
function unpack(zip: Uint8Array, what: string, want: (name: string) => boolean): Record<string, Uint8Array> {
  let total = 0;
  try {
    for (const e of unpackedSizes(zip)) if (want(e.name)) total += e.size;
  } catch {
    throw new FileError(`${what} is damaged or is not a real ${/\.zip"?$/i.test(what) ? "ZIP" : "Excel"} file, so it couldn't be opened. Create the file again and upload that copy.`);
  }
  if (total > MAX_UNPACKED_BYTES) {
    throw new FileError(`${what} unpacks to ${mb(total)}, more than the ${mb(MAX_UNPACKED_BYTES)} that is read from one upload. Nothing was imported. Split the data into smaller files and import them one after another.`);
  }
  return unzipSync(zip, { filter: (f) => want(f.name) });
}

function xmlText(s: string): string {
  if (!s.includes("&") && !s.includes("_x")) return s;
  return s
    .replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
      if (e[0] !== "#") return XML_ENTITIES[e.toLowerCase()] ?? whole;
      const code = parseInt(e.slice(e[1] === "x" || e[1] === "X" ? 2 : 1), e[1] === "x" || e[1] === "X" ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function xmlAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s(?:\\w+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? xmlText(m[1] ?? m[2] ?? "") : undefined;
}

/** A part's XML with any namespace prefix on its tags removed ("<x:row>" → "<row>"). */
function xmlPart(data: Uint8Array | undefined, what: string): string {
  if (!data) return "";
  let xml = decodeText(data).text;
  if (/<!DOCTYPE|<!ENTITY/i.test(xml.slice(0, 4000))) {
    throw new FileError(`${what} is not an ordinary Excel file: it declares its own text shortcuts ("entities"), which are never read, for safety. Open it in Excel, save it as a new .xlsx and upload that copy.`);
  }
  const prefix = /<(\w+):(?:worksheet|workbook|sst|styleSheet|Relationships)\b/.exec(xml.slice(0, 2000))?.[1];
  if (prefix) xml = xml.replace(new RegExp(`<(/?)${prefix}:`, "g"), "<$1");
  return xml;
}

/** All text of a string item or inline string (rich text runs joined, phonetic guides left out). */
function stringItem(xml: string): string {
  if (!xml) return "";
  const body = xml.includes("<rPh") ? xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "") : xml;
  let out = "";
  for (const m of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += xmlText(m[1] ?? "");
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormat(code: string): boolean {
  const bare = code.replace(/\[[^\]]*]/g, "").replace(/"[^"]*"/g, "").replace(/\\./g, "");
  return /[ymdhMsb]/.test(bare);
}

/** For each cell style: does it show a number as a date? */
function dateStyles(stylesXml: string): boolean[] {
  if (!stylesXml) return [];
  const custom = new Map<number, boolean>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(xmlAttr(m[0], "numFmtId"));
    custom.set(id, isDateFormat(xmlAttr(m[0], "formatCode") ?? ""));
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(xmlAttr(m[0], "numFmtId") ?? 0);
    return custom.get(id) ?? BUILTIN_DATE_FORMATS.has(id);
  });
}

function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

const CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const CELL_REF = /\sr="([A-Za-z]+)\d*"/;
const CELL_TYPE = /\st="(\w+)"/;
const CELL_STYLE = /\ss="(\d+)"/;
const CELL_VALUE = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/;
const CELL_FORMULA = /<f\b[^>]*?(?:\/>|>([\s\S]*?)<\/f>)/;

interface XlsxParts {
  shared: string[];
  dates: boolean[];
  date1904: boolean;
}

function sheetMatrix(data: Uint8Array, parts: XlsxParts, what: string): { matrix: string[][]; hidden: Set<number> } {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const head = buf.subarray(0, 2000).toString("latin1");
  if (/<!DOCTYPE|<!ENTITY/i.test(head)) xmlPart(data.subarray(0, 4000), what);
  if (buf[0] === 0xff || buf[0] === 0xfe || (buf.length > 1 && (buf[0] === 0 || buf[1] === 0))) {
    // UTF-16 XML (rare): no byte scanning, read it whole.
    return matrixFromXml(xmlPart(data, what), parts);
  }
  const prefix = /<(\w+):worksheet\b/.exec(head)?.[1];
  const open = prefix ? `<${prefix}:row` : "<row";
  const close = prefix ? `</${prefix}:row>` : "</row>";
  const strip = prefix ? new RegExp(`<(/?)${prefix}:`, "g") : null;
  const matrix: string[][] = [];
  const hidden = new Set<number>();
  let rowNumber = 0;
  let pos = 0;
  for (;;) {
    const start = buf.indexOf(open, pos);
    if (start < 0) break;
    const after = buf[start + open.length];
    // "<row" must be the whole tag name ("<rowBreaks" is something else).
    if (after !== 0x20 && after !== 0x3e && after !== 0x2f && after !== 0x09 && after !== 0x0a && after !== 0x0d) {
      pos = start + open.length;
      continue;
    }
    const tagEnd = buf.indexOf(">", start);
    if (tagEnd < 0) break;
    let end: number;
    if (buf[tagEnd - 1] === 0x2f) end = tagEnd + 1;
    else {
      const c = buf.indexOf(close, tagEnd);
      end = c < 0 ? buf.length : c + close.length;
    }
    let chunk = buf.toString("utf8", start, end);
    if (strip) chunk = chunk.replace(strip, "<$1");
    rowNumber = readRow(chunk, rowNumber, matrix, hidden, parts);
    pos = end;
  }
  for (let i = 0; i < matrix.length; i++) matrix[i] ??= [];
  return { matrix, hidden };
}

function matrixFromXml(xml: string, parts: XlsxParts): { matrix: string[][]; hidden: Set<number> } {
  const matrix: string[][] = [];
  const hidden = new Set<number>();
  let rowNumber = 0;
  for (const m of xml.matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) rowNumber = readRow(m[0], rowNumber, matrix, hidden, parts);
  for (let i = 0; i < matrix.length; i++) matrix[i] ??= [];
  return { matrix, hidden };
}

/** Reads one "<row>…</row>" into the matrix; returns its row number. */
function readRow(chunk: string, previous: number, matrix: string[][], hidden: Set<number>, parts: XlsxParts): number {
  const tagEnd = chunk.indexOf(">");
  const tag = chunk.slice(0, tagEnd + 1);
  const r = /\sr="(\d+)"/.exec(tag);
  const rowNumber = r ? Number(r[1]) : previous + 1;
  if (rowNumber > EXCEL_MAX_ROWS) throw new FileError("This Excel file has more rows than a sheet can hold, so it is damaged or not a real workbook. Nothing was imported.");
  if (/\shidden="(1|true)"/.test(tag)) hidden.add(rowNumber - 1);
  const cells: string[] = [];
  let col = -1;
  CELL.lastIndex = tagEnd;
  for (let m = CELL.exec(chunk); m; m = CELL.exec(chunk)) {
    const attrs = m[1];
    const ref = CELL_REF.exec(attrs);
    col = ref ? columnIndex(ref[1]) : col + 1;
    const body = m[2];
    if (body === undefined || body === "") continue;
    const type = CELL_TYPE.exec(attrs)?.[1] ?? "n";
    const v = CELL_VALUE.exec(body);
    let text: string;
    if (type === "inlineStr" || (!v && body.includes("<is"))) text = stringItem(body);
    else if (!v || ((v[1] ?? "") === "" && type !== "str" && body.includes("<f"))) {
      const f = CELL_FORMULA.exec(body);
      if (!f) continue;
      // A formula whose result was never saved: the import refuses the row rather than guess.
      text = `${NO_VALUE_MARK}=${xmlText(f[1] ?? "") || "shared formula"}`;
    } else {
      const raw = v[1] ?? "";
      if (type === "s") text = parts.shared[Number(raw)] ?? "";
      else if (type === "str" || type === "e" || type === "d") text = xmlText(raw);
      else if (type === "b") text = raw.trim() === "0" || raw.trim().toLowerCase() === "false" ? "FALSE" : "TRUE";
      else {
        const n = parseFloat(raw);
        if (Number.isNaN(n)) text = xmlText(raw);
        else {
          const style = CELL_STYLE.exec(attrs);
          if (style && parts.dates[Number(style[1])]) {
            const d = new Date(Math.round((n - 25569 + (parts.date1904 ? 1462 : 0)) * 86_400_000));
            text = Number.isNaN(d.getTime()) ? String(n) : d.toISOString();
          } else text = String(n);
        }
      }
    }
    if (text !== "") {
      while (cells.length < col) cells.push("");
      cells[col] = text;
    }
  }
  for (let i = 0; i < cells.length; i++) cells[i] ??= "";
  matrix[rowNumber - 1] = cells;
  return rowNumber;
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const out = base.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/");
}

/** Reads a workbook from its bytes with our own reader. Hidden sheets are skipped and said so. */
function plainXlsx(zip: Uint8Array, what: string): Sheet[] {
  if (zip[0] === 0xd0 && zip[1] === 0xcf && zip[2] === 0x11 && zip[3] === 0xe0) {
    throw new FileError(`${what} is password-protected, or is an older Excel file (.xls) with a newer file's name. Open it in Excel, remove the password (File › Info › Protect Workbook) or choose "Save as › Excel Workbook (.xlsx)", and upload that copy.`);
  }
  if (!(zip[0] === 0x50 && zip[1] === 0x4b)) {
    throw new FileError(`${what} is not a real Excel file (its contents are something else with an Excel file name). Open it in a spreadsheet program, save it as .xlsx or CSV and upload that copy.`);
  }
  const wanted = /^(_rels\/\.rels|xl\/.*\.xml|xl\/_rels\/.*\.rels)$/i;
  const skip = /^xl\/(theme|media|drawings|charts|comments|tables|pivot|printerSettings|ctrlProps|externalLinks|richData|persons|threadedComments|diagrams|embeddings|activeX|slicer|timeline|queryTables|customXml)/i;
  const lower = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(unpack(zip, what, (n) => wanted.test(n.replace(/^\//, "")) && !skip.test(n.replace(/^\//, ""))))) {
    lower.set(name.replace(/^\//, "").toLowerCase(), data);
  }
  const part = (name: string) => lower.get(name.toLowerCase());
  const rootRels = xmlPart(part("_rels/.rels"), what);
  let workbookPath = "xl/workbook.xml";
  for (const m of rootRels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (/officeDocument$/.test(xmlAttr(m[0], "Type") ?? "")) workbookPath = resolveTarget("", xmlAttr(m[0], "Target") ?? workbookPath);
  }
  const workbook = xmlPart(part(workbookPath), what);
  if (!workbook) throw new FileError(`${what} has no list of sheets, so it is damaged or not a real Excel workbook. Open it in a spreadsheet program, save it again and upload that copy.`);
  const relsPath = workbookPath.replace(/([^/]+)$/, "_rels/$1.rels");
  const targets = new Map<string, { target: string; type: string }>();
  for (const m of xmlPart(part(relsPath), what).matchAll(/<Relationship\b[^>]*>/g)) {
    targets.set(xmlAttr(m[0], "Id") ?? "", { target: resolveTarget(workbookPath, xmlAttr(m[0], "Target") ?? ""), type: xmlAttr(m[0], "Type") ?? "" });
  }
  const parts: XlsxParts = { shared: [], dates: [], date1904: /<workbookPr\b[^>]*\sdate1904="(1|true)"/.test(workbook) };
  const sharedTarget = [...targets.values()].find((t) => /sharedStrings$/.test(t.type))?.target ?? "xl/sharedStrings.xml";
  const sharedXml = xmlPart(part(sharedTarget), what);
  for (const m of sharedXml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) parts.shared.push(stringItem(m[1] ?? ""));
  const stylesTarget = [...targets.values()].find((t) => /\/styles$/.test(t.type))?.target ?? "xl/styles.xml";
  parts.dates = dateStyles(xmlPart(part(stylesTarget), what));

  const sheets: Sheet[] = [];
  const hiddenSheets: string[] = [];
  let listed = 0;
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlAttr(m[0], "name") ?? `Sheet${listed + 1}`;
    const rel = targets.get(xmlAttr(m[0], "id") ?? "");
    // Chart tabs have no cells.
    if (rel && /chartsheet|dialogsheet|macrosheet/i.test(rel.type)) continue;
    listed++;
    const state = xmlAttr(m[0], "state");
    if (state === "hidden" || state === "veryHidden") {
      hiddenSheets.push(name);
      continue;
    }
    const data = part(rel?.target ?? `xl/worksheets/sheet${listed}.xml`);
    if (!data) throw new FileError(`${what}: the sheet "${name}" is listed in the workbook but its contents are missing, so the file is damaged. Save it again from the program it came from and upload that copy.`);
    const { matrix, hidden } = sheetMatrix(data, parts, what);
    const { headers, rows, notes } = rowsFromMatrix(matrix, { hidden });
    const sheet: Sheet = { name, headers, rows };
    if (notes.length) sheet.notes = notes;
    sheets.push(sheet);
  }
  if (!sheets.length && hiddenSheets.length) {
    throw new FileError(`Every sheet in ${what} is hidden (${hiddenSheets.map((n) => `"${n}"`).join(", ")}), and hidden sheets are not imported. Unhide the sheet you want to import (right-click a sheet tab › Unhide), save and upload again.`);
  }
  if (!sheets.length) throw new FileError(`${what} has no sheets with cells in it.`);
  if (hiddenSheets.length) {
    (sheets[0].notes ??= []).unshift(
      `${hiddenSheets.length === 1 ? `The hidden sheet "${hiddenSheets[0]}" was` : `${hiddenSheets.length} hidden sheets (${hiddenSheets.map((n) => `"${n}"`).join(", ")}) were`} skipped: hidden sheets are not imported. To import ${hiddenSheets.length === 1 ? "it" : "one"}, unhide it in Excel first.`,
    );
  }
  return sheets;
}

// --- The library reader (kept as a second opinion for files ours can't read) -----

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
    const { headers, rows, notes } = rowsFromMatrix(matrix);
    sheets.push({ name: ws.name ?? `Sheet${sheets.length + 1}`, headers, rows, ...(notes.length ? { notes } : {}) });
  }
  return sheets;
}

/**
 * The library's reading of an .xlsx. Its streaming reader can stop early and
 * return only the first sheet, unnamed, without an error; so the result is
 * checked against the sheet list in the file itself and refused rather than
 * imported half.
 */
export async function libraryXlsx(input: string | Buffer): Promise<Sheet[]> {
  const entries = await zipEntryNames(input).catch(() => null);
  const worksheetCount = entries?.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length ?? null;
  const names = await xlsxSheetNames(input);
  const complete = (sheets: Sheet[]) =>
    worksheetCount === null || !names || (sheets.length === worksheetCount && sheets.every((s) => names.includes(s.name)));
  let sheets: Sheet[] = [];
  try {
    sheets = await streamXlsx(input);
    if (complete(sheets)) return sheets;
  } catch {
    // try the whole-file way below
  }
  const size = typeof input === "string" ? (await fs.promises.stat(input)).size : input.length;
  if (size <= WHOLE_FILE_MAX_BYTES) {
    const whole = await wholeXlsx(input);
    if (complete(whole)) return whole;
  }
  throw new Error("incomplete");
}

/** Largest .xlsx read the whole-file way (it is held in memory unpacked). */
const WHOLE_FILE_MAX_BYTES = 30 * 1024 * 1024;

async function wholeXlsx(input: string | Buffer): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  if (typeof input === "string") await wb.xlsx.readFile(input);
  else await wb.xlsx.load(input as any);
  return wb.worksheets.map((ws) => {
    const matrix: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const values = (row.values ?? []) as any[];
      const arr: string[] = [];
      for (let c = 1; c < values.length; c++) arr.push(cellText(values[c]));
      matrix[n - 1] = arr;
    });
    for (let i = 0; i < matrix.length; i++) matrix[i] ??= [];
    const { headers, rows, notes } = rowsFromMatrix(matrix);
    return { name: ws.name, headers, rows, ...(notes.length ? { notes } : {}) };
  });
}

/**
 * Reads an .xlsx: with our own reader, and if that can't make sense of the
 * file, with the library. A file neither can read is refused in plain words.
 */
async function readXlsx(input: string | Buffer, what: string): Promise<Sheet[]> {
  const zip = typeof input === "string" ? await fs.promises.readFile(input) : input;
  try {
    return plainXlsx(zip, what);
  } catch (e) {
    if (e instanceof FileError) throw e;
    try {
      return await libraryXlsx(zip);
    } catch {
      throw new FileError(`${what} couldn't be read as an Excel file: its contents are not laid out the way Excel writes them. Open it in Excel, Google Sheets or LibreOffice, save it as a new .xlsx (or as CSV) and upload that copy.`);
    }
  }
}

const TEXT_TYPES = new Set([".csv", ".txt", ".tsv"]);
const EXCEL_TYPES = new Set([".xlsx", ".xlsm"]);
/** Spreadsheet formats that aren't read, each with how to get a file that is. */
const SAVE_AS: Record<string, string> = {
  ".xls": "This is an older Excel file (.xls). Open it in Excel and choose File › Save as › Excel Workbook (.xlsx), then upload that copy.",
  ".xlsb": "This is a binary Excel file (.xlsb). Open it in Excel and choose File › Save as › Excel Workbook (.xlsx), then upload that copy.",
  ".ods": "This is an OpenDocument spreadsheet (.ods). Open it in LibreOffice or Google Sheets and save it as Excel (.xlsx) or CSV, then upload that copy.",
  ".numbers": "This is an Apple Numbers file. In Numbers choose File › Export To › Excel (or CSV), then upload that copy.",
  ".gsheet": "This is a shortcut to a Google Sheet, not the sheet itself. In Google Sheets choose File › Download › Microsoft Excel (.xlsx), then upload that file.",
};

/**
 * Reads an uploaded file into sheets. CSV files become a single sheet named
 * after the file (so "Products.csv" is recognised as products); ZIP archives
 * may hold several CSV/XLSX files, each read on its own.
 */
export async function readWorkbook(filePath: string, originalName = path.basename(filePath)): Promise<Sheet[]> {
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, ext);
  const what = `"${path.basename(originalName)}"`;
  if (EXCEL_TYPES.has(ext)) return readXlsx(filePath, what);
  if (TEXT_TYPES.has(ext)) {
    const size = (await fs.promises.stat(filePath)).size;
    if (size > MAX_UNPACKED_BYTES) throw new FileError(`${what} is ${mb(size)}, more than the ${mb(MAX_UNPACKED_BYTES)} that is read from one upload. Split it into smaller files and import them one after another.`);
    const data = await fs.promises.readFile(filePath);
    // An Excel file saved with a .csv name is still an Excel file.
    if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) return readXlsx(data, what);
    return [csvSheet(baseName, data)];
  }
  if (ext === ".zip") {
    const zip = new Uint8Array(await fs.promises.readFile(filePath));
    const readable = (name: string) => {
      if (name.endsWith("/") || name.startsWith("__MACOSX") || path.basename(name).startsWith(".")) return false;
      const e = path.extname(name).toLowerCase();
      return TEXT_TYPES.has(e) || EXCEL_TYPES.has(e);
    };
    let names: string[] = [];
    try {
      names = unpackedSizes(zip).map((e) => e.name);
    } catch {
      // unpack() below reports it
    }
    const files = unpack(zip, what, readable);
    const sheets: Sheet[] = [];
    const skipped: string[] = [];
    for (const name of names) {
      if (name.endsWith("/") || name.startsWith("__MACOSX") || path.basename(name).startsWith(".") || readable(name)) continue;
      const e = path.extname(name).toLowerCase();
      if (e === ".zip") skipped.push(`"${path.basename(name)}" was skipped: ZIP files inside a ZIP are not read. Unpack it and upload its files directly.`);
      else if (SAVE_AS[e]) skipped.push(`"${path.basename(name)}" was skipped. ${SAVE_AS[e]}`);
    }
    const workbooks = Object.keys(files).filter((n) => EXCEL_TYPES.has(path.extname(n).toLowerCase())).length;
    for (const [name, data] of Object.entries(files)) {
      const e = path.extname(name).toLowerCase();
      const file = path.basename(name);
      try {
        if (TEXT_TYPES.has(e)) {
          const sheet = csvSheet(path.basename(name, e), data);
          sheet.file = file;
          sheets.push(sheet);
        } else {
          for (const sheet of await readXlsx(Buffer.from(data.buffer, data.byteOffset, data.byteLength), `"${file}"`)) {
            sheet.file = file;
            // Several workbooks often use the same sheet names: say which file each came from.
            if (workbooks > 1) sheet.label = `${file} › ${sheet.name}`;
            sheets.push(sheet);
          }
        }
      } catch (err: any) {
        // One unreadable file doesn't sink the others: it is left out, by name, with the reason.
        const reason = String(err?.message ?? err);
        skipped.push(reason.includes(`"${file}"`) ? `Skipped: ${reason}` : `"${file}" was skipped: ${reason}`);
      }
    }
    if (!sheets.length) {
      throw new FileError(skipped.length ? `Nothing in ${what} could be read. ${skipped.join(" ")}` : `${what} has no spreadsheet files in it (.xlsx, .csv, .tsv or .txt).`);
    }
    if (skipped.length) (sheets[0].notes ??= []).unshift(...skipped);
    return sheets;
  }
  if (SAVE_AS[ext]) throw new FileError(SAVE_AS[ext]);
  throw new FileError(`Files of type "${ext || "unknown"}" can't be imported. Upload an Excel file (.xlsx), a CSV or tab-separated file (.csv, .tsv, .txt), or a ZIP of those.`);
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
  // A value Excel would run as a formula when the CSV is opened is written with a leading
  // apostrophe, which makes it plain text there; reading the file here takes it off again.
  const safe = values.some((v) => typeof v === "string" && v.length > 1 && looksLikeFormula(v)) ? values.map((v) => (typeof v === "string" && v.length > 1 && looksLikeFormula(v) ? FORMULA_GUARD + v : v)) : values;
  return Papa.unparse([safe], { newline: "\r\n" }) + "\r\n";
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
