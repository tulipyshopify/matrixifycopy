import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import type { BulkRunner, ExportOptions, Gql, ImportOptions, Logger } from "../core/types";
import { runExport, type ExportSummary } from "../core/exporter";
import { runImport, type ImportSummary, type SheetEdits } from "../core/importer";
import { createWorkbookOut, readWorkbook, readZipEntry, readZipEntryHead, unpackedSizes, zipEntries, type OutputFormat, type ReadOptions, type Sheet } from "../core/sheets";
import { IMAGE_FILE, MAX_IMAGE_BYTES, MIME, imageInfo, isLocalRef, judgeImage, localName, parkLocalImages, sendLocalImages, stripLocation, unparkRow, type LocalImages } from "../core/images";
import { ImportError } from "../core/types";
import { ENTITIES, getEntity } from "../entities";
import { resolveBarcodes } from "../entities/products";
import { applyLayout, matchLayout, type ColumnLayout } from "../core/layouts";
import { backupDir, jobDir, tmpDir } from "./storage.server";
import { generateChangeFile, type GenerateSpec } from "../ai/generate";
import { runCheck } from "../check/run";
import { generateAiFixFile, type AiFixSpec } from "../check/aifix";

/** Dry-run preview of an import, in the job's folder. */
const STAGE_IMAGE = `#graphql
  mutation ImportStageImage($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

async function httpUploadFile(url: string, parameters: Array<{ name: string; value: string }>, data: Uint8Array, filename: string, mimeType: string) {
  const form = new FormData();
  for (const p of parameters) form.set(p.name, p.value);
  form.set("file", new Blob([data as BlobPart], { type: mimeType }), filename);
  const res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new ImportError(`Image ${filename} could not be sent to Shopify (HTTP ${res.status}). Try the import again.`);
}

export const PREVIEW_FILE = "preview.json";
/** While a preview runs: its first items and running totals, for a first look. */
export const PARTIAL_FILE = "preview-partial.json";
/** Cells corrected on a preview's page (see SheetEdits). */
export const EDITS_FILE = "edits.json";

export async function readEdits(dir: string): Promise<SheetEdits> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(dir, EDITS_FILE), "utf8")) as SheetEdits;
  } catch {
    return {};
  }
}

/**
 * Reads an import's file into the sheets the import works on: the whole file,
 * or for a restore only the chosen items and fields.
 */
/** Key columns a saved matching may rest on: the data type's own, and for products a barcode (looked up in the shop). */
export function layoutKeys(entityKey: string): string[] {
  const keys = getEntity(entityKey)?.import?.keyColumns ?? [];
  return entityKey === "products" ? [...keys, "Variant Barcode"] : keys;
}

/**
 * Which row holds the column names, according to the saved matchings: one
 * saved with a row of its own applies when that row of this file fits it.
 */
export function headerRowFromLayouts(layouts: ColumnLayout[]): ReadOptions["headerRow"] {
  const own = layouts.filter((l) => l.headerRow !== undefined);
  if (!own.length) return undefined;
  return (top) => {
    for (const l of own) {
      if (l.headerRow === 0) {
        const width = Math.max(0, ...top.map((r) => r.length));
        const letters = Array.from({ length: width }, (_, j) => `Column ${String.fromCharCode(65 + (j % 26))}`).slice(0, 26);
        if (matchLayout(letters, [l])) return 0;
        continue;
      }
      const row = top[l.headerRow! - 1];
      if (row && matchLayout(row.map((c) => c.trim()).filter(Boolean), [l])) return l.headerRow;
    }
    return undefined;
  };
}

export async function readImportSheets(job: { inputFile: string; inputName: string | null }, config: ImportConfig, log: (m: string) => void = () => {}, layouts: ColumnLayout[] = [], read?: ReadOptions): Promise<Sheet[]> {
  log(`Reading ${job.inputName ?? path.basename(job.inputFile)}`);
  await assertFitsInMemory(job.inputFile, job.inputName ?? job.inputFile);
  const sheets = await readWorkbook(job.inputFile, job.inputName ?? undefined, read ?? { headerRow: headerRowFromLayouts(layouts) });
  log(`Found ${sheets.length} sheet(s): ${sheets.map((s) => `${s.name} (${s.rows.length} rows)`).join(", ")}`);
  // Files in someone else's layout are read with the column matching saved for them.
  if (layouts.length) {
    for (const sheet of sheets) {
      const layout = matchLayout(sheet.headers, layouts);
      if (!layout) continue;
      const note = applyLayout(sheet, layout, layoutKeys(layout.entity));
      (sheet.notes ??= []).push(note);
      log(`Sheet "${sheet.label ?? sheet.name}": ${note}`);
    }
  }
  let chosen = sheets;
  if (config.onlyItems?.length) {
    const { kept, missing } = keepOnlyItems(sheets, config.onlyItems);
    // Sheets without any of the chosen items are left out entirely.
    chosen = sheets.filter((s) => s.rows.length);
    log(`Only the ${config.onlyItems.length} chosen item(s) are imported: ${kept} row(s) kept.`);
    if (missing.length) log(`Not in the file: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? `, and ${missing.length - 20} more` : ""}.`);
    if (!kept) throw new Error(`None of the chosen items is in this file (${config.onlyItems.slice(0, 5).join(", ")}${config.onlyItems.length > 5 ? "…" : ""}). Use the ID, handle, order name or email exactly as in the backup.`);
  }
  if (config.onlyFields) {
    const dropped = keepOnlyFields(chosen, config.onlyFields);
    if (dropped.length) log(`Left out of this restore, so not touched: ${dropped.slice(0, 12).join(", ")}${dropped.length > 12 ? `, and ${dropped.length - 12} more columns` : ""}.`);
  }
  return chosen;
}

export interface ExportConfig {
  entities: Array<{ entity: string; options: ExportOptions }>;
}

export interface ImportConfig {
  options: ImportOptions;
  /** A change asked for in plain English: the input file is built when the job runs. */
  generate?: GenerateSpec;
  /** AI-drafted fixes from the data check: likewise built when the job runs. */
  aiFix?: AiFixSpec;
  /**
   * The preview job this import was started from ("Import for real"). Items
   * that changed in the store since that preview are not imported.
   */
  previewOf?: string;
  /**
   * Import only the items identified by one of these values (ID, handle,
   * order name, email, path or code). Used to restore single items from a backup.
   */
  onlyItems?: string[];
  /** Restore only these kinds of field (keys of RESTORE_FIELDS); other columns of those kinds are dropped. */
  onlyFields?: string[];
  /** Items the person chose to skip at the preview, by sheet name. */
  exclude?: Record<string, string[]>;
  /** Failures the preview already announced, by sheet name: not counted towards stopping early. */
  expectedFailed?: Record<string, number>;
  /** Stop a sheet when more than this share of its items fail unexpectedly (see runImport). */
  stopAtFailedPercent?: number;
  /** This import undoes another one (the job it puts back). */
  undoOf?: string;
}

/** The file that undoes an import, in the job's folder (its sheets are named after their data types). */
export const UNDO_DIR = "undo";

/** Path of a job's undo file, or null when it has none. */
export function undoFileOf(dir: string): string | null {
  try {
    const name = fs.readdirSync(path.join(dir, UNDO_DIR)).find((f) => /\.(csv|zip)$/.test(f));
    return name ? path.join(dir, UNDO_DIR, name) : null;
  } catch {
    return null;
  }
}

/**
 * Kinds of field a restore can bring back, each with the columns it covers.
 * Columns in none of them (IDs, handles, commands, other data types' columns)
 * always stay. Stock is off unless asked for: orders since the backup would
 * be overwritten.
 */
export const RESTORE_FIELDS: Array<{ key: string; label: string; note?: string; byDefault: boolean; match: RegExp }> = [
  { key: "details", label: "Titles, descriptions and status", byDefault: true, match: /^(Title|Body HTML|Vendor|Type|Status|Published|Published At|Template Suffix|Category: .+|Gift Card)$/ },
  { key: "tags", label: "Tags", byDefault: true, match: /^Tags( Command)?$/ },
  { key: "seo", label: "Search title and description", byDefault: true, match: /^SEO / },
  { key: "prices", label: "Prices and costs", byDefault: true, match: /^Variant (Price|Compare At Price|Cost|Taxable|Tax Code)$/ },
  { key: "variants", label: "SKUs, barcodes, weights and options", byDefault: true, match: /^(Variant (SKU|Barcode|Weight|Weight Unit|Requires Shipping|HS Code|Country of Origin|Province of Origin|Position)|Option[123] (Name|Value))$/ },
  { key: "images", label: "Images", byDefault: true, match: /^(Image .+|Variant Image)$/ },
  { key: "metafields", label: "Metafields", byDefault: true, match: /^(Variant )?Metafield: / },
  { key: "stock", label: "Stock levels", note: "Off by default: stock sold or received since the backup would be overwritten.", byDefault: false, match: /^(Inventory .+: .+|Variant Inventory (Qty|Adjust|Tracker|Policy)|Total Inventory Qty)$/ },
];

/** Removes the columns of the field kinds that were not chosen. Returns the columns dropped. */
export function keepOnlyFields(sheets: Array<{ headers: string[]; rows: Array<Record<string, string>> }>, chosen: string[]): string[] {
  const off = RESTORE_FIELDS.filter((f) => !chosen.includes(f.key));
  const dropped = new Set<string>();
  for (const sheet of sheets) {
    const drop = sheet.headers.filter((h) => off.some((f) => f.match.test(h)));
    // A variant's SKU is also how its row is found: it stays unless there is a Variant ID to go by.
    const keepSku = !chosen.includes("variants") && !sheet.headers.includes("Variant ID");
    const gone = drop.filter((h) => !(keepSku && h === "Variant SKU"));
    if (!gone.length) continue;
    for (const h of gone) dropped.add(h);
    sheet.headers = sheet.headers.filter((h) => !gone.includes(h));
    for (const row of sheet.rows) for (const h of gone) delete row[h];
  }
  return [...dropped];
}

/** Columns that can name an item when restoring just some of a backup. */
const ITEM_KEYS = ["ID", "Handle", "Name", "Email", "Path", "Code", "Variant SKU"];

/** Keeps only the rows of the named items. Returns how many items were asked for but not found. */
export function keepOnlyItems(sheets: Array<{ name: string; headers: string[]; rows: Array<Record<string, string>> }>, only: string[]): { kept: number; missing: string[] } {
  const wanted = new Set(only.map((v) => v.trim().toLowerCase().replace(/^#/, "")).filter(Boolean));
  const found = new Set<string>();
  let kept = 0;
  for (const sheet of sheets) {
    const keys = ITEM_KEYS.filter((k) => sheet.headers.includes(k));
    sheet.rows = sheet.rows.filter((row) => {
      let keep = false;
      for (const k of keys) {
        const v = (row[k] ?? "").trim().toLowerCase().replace(/^#/, "");
        if (v && wanted.has(v)) {
          found.add(v);
          keep = true;
        }
      }
      return keep;
    });
    kept += sheet.rows.length;
  }
  return { kept, missing: [...wanted].filter((v) => !found.has(v)) };
}

/** One item an import changed, for the change history. */
export interface ChangeEntry {
  entity: string;
  itemKey: string;
  itemId: string;
  title: string;
  action: string;
  changes: string[];
}

export interface JobRecord {
  id: string;
  shop: string;
  type: string;
  config: string;
  format: string;
  name: string;
  inputFile: string | null;
  inputName: string | null;
  kind?: string;
}

export interface RunnerDeps {
  gql: Gql;
  bulk: BulkRunner;
  /** GET on the store's REST Admin API (relative path). */
  rest?: (path: string) => Promise<any>;
  log: Logger;
  progress: (done: number, total: number) => void;
  isCancelled: () => Promise<boolean>;
  /** The shop's IANA time zone. */
  timezone?: () => Promise<string>;
  /** Claude API client; only tests pass one. */
  anthropic?: any;
  /** Called when a job builds its own input file, so it can be saved on the job. */
  onInput?: (file: string, name: string) => Promise<void>;
  /** Expected number of items for an entity's export, or null when unknown. */
  count?: (entity: string, options: ExportOptions) => Promise<number | null>;
  /** The worker's bulk runner reports prepared root items through this hook. */
  bulkEvents?: { onRoots: (n: number) => void };
  /** Data check: tags whose products are left out. */
  checkExclusions?: () => Promise<string[]>;
  /** Sends one uploaded file to the address Shopify staged for it (tests replace this). */
  uploadFile?: (url: string, parameters: Array<{ name: string; value: string }>, data: Uint8Array, filename: string, mimeType: string) => Promise<void>;
  /** Records what a real import changed, item by item (the change history). */
  onChanges?: (entries: ChangeEntry[]) => Promise<void>;
  /** The store's saved column layouts, for files in someone else's layout. */
  layouts?: () => Promise<ColumnLayout[]>;
  /** The shop keeps its product images square: ones that are not are pointed out. */
  squareImages?: () => Promise<boolean>;
  /** Checks an image link loads and is an image (see ImportContext.checkImageUrl). */
  checkImageUrl?: (url: string) => Promise<string | null>;
}

/** Share of an export's time spent while Shopify prepares the data (the rest is writing the file). */
const PREPARE_WEIGHT = 0.8;

/**
 * Rough memory a file needs once read into rows, as a multiple of its size on
 * disk (compressed formats unpack to several times that first).
 */
const MEMORY_FACTOR: Record<string, number> = { ".csv": 12, ".txt": 12, ".tsv": 12, ".xlsx": 45, ".xlsm": 45, ".zip": 45 };

/**
 * Refuses a file that would not fit in the server's memory, with a reason,
 * instead of letting it take the whole server down mid-import (which would
 * also interrupt every other job that is running).
 */
export async function assertFitsInMemory(file: string, name: string, heap = v8.getHeapStatistics()) {
  const size = (await fs.promises.stat(file)).size;
  const ext = path.extname(name).toLowerCase();
  let need = size * (MEMORY_FACTOR[ext] ?? 45);
  let unpacked = 0;
  // Compressed files are judged by what they unpack to (their directory says, without unpacking):
  // a small archive can hold a very large file.
  if ((ext === ".zip" || ext === ".xlsx" || ext === ".xlsm") && size < 200 * 1024 * 1024) {
    try {
      const entries = unpackedSizes(new Uint8Array(await fs.promises.readFile(file)));
      let byContent = 0;
      for (const e of entries) {
        const inner = path.extname(e.name).toLowerCase();
        if (ext === ".zip") byContent += e.size * (MEMORY_FACTOR[inner] ?? 0);
        else if (/^\/?xl\/(worksheets\/|sharedStrings)/i.test(e.name)) byContent += e.size * 4;
        unpacked += e.size;
      }
      need = ext === ".zip" ? byContent : Math.max(need, byContent);
    } catch {
      // not a readable archive: the reader says so
    }
  }
  const free = heap.heap_size_limit - heap.used_heap_size;
  if (need > free * 0.9) {
    const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`;
    // Said without the server's own figures: they are nobody's business but ours.
    throw new Error(
      `This file is too large to import in one go: it is ${mb(size)}${unpacked > size * 2 ? ` (${mb(unpacked)} once unpacked)` : ""}, more than can be read at once. Split it into smaller files (for example by product type, or about 20,000 rows each) and import them one after another.`,
    );
  }
}

export function timestamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
}

export async function executeJob(
  job: JobRecord,
  deps: RunnerDeps,
): Promise<{ resultFile: string; stats: Array<ExportSummary | ImportSummary> }> {
  const dir = job.kind === "backup" ? backupDir(job.shop, job.id) : jobDir(job.shop, job.id);
  const format: OutputFormat = job.format === "csv" ? "csv" : "xlsx";

  if (job.kind === "check") {
    // While Shopify prepares the products, show how many it has so far.
    if (deps.bulkEvents) deps.bulkEvents.onRoots = (n) => deps.progress(n, 0);
    const { resultFile, report } = await runCheck(deps, dir, await (deps.checkExclusions?.() ?? []));
    return { resultFile, stats: [report as any] };
  }

  if (job.type === "export") {
    const config = JSON.parse(job.config) as ExportConfig;
    // Date ranges ("Last month") are worked out in the shop's own time zone.
    const timezone = deps.timezone ? await deps.timezone() : "UTC";
    const requests = config.entities.map(({ entity, options }) => {
      const e = getEntity(entity);
      if (!e) throw new Error(`Unknown entity "${entity}"`);
      return { entity: e, options: { ...options, timezone } };
    });
    const base = job.name ? job.name.replace(/[^\w.-]+/g, "_") : `Export_${timestamp()}`;
    // A backup is always a compressed archive, one type or many: a tenth of the disk space, and the same kind of file every day.
    const out = createWorkbookOut(format, path.join(dir, base), deps.log, { alwaysZip: job.kind === "backup" });
    // Expected totals make a percentage and time estimate possible. If any
    // data type can't be counted, progress falls back to a plain item counter.
    const expected: Array<number | null> = [];
    for (const r of requests) {
      expected.push(deps.count ? await deps.count(r.entity.key, r.options).catch(() => null) : null);
    }
    const known = expected.every((n) => n !== null);
    const grandTotal = known ? (expected as number[]).reduce((a, b) => a + b, 0) : 0;
    const counts = new Map<string, number>();
    let index = -1;
    let doneBefore = 0;
    let prepared = 0;
    let written = 0;
    const report = () => {
      if (!known || !grandTotal) {
        return deps.progress([...counts.values()].reduce((a, b) => a + b, 0), 0);
      }
      const t = expected[index] ?? 0;
      const units = doneBefore + PREPARE_WEIGHT * Math.min(prepared, t) + (1 - PREPARE_WEIGHT) * Math.min(written, t);
      // Keep 100% for the real finish.
      deps.progress(Math.min(Math.round(units), grandTotal - 1), grandTotal);
    };
    if (deps.bulkEvents) {
      deps.bulkEvents.onRoots = (n) => {
        prepared = Math.max(prepared, n);
        report();
      };
    }
    const stats = await runExport({
      gql: deps.gql,
      bulk: deps.bulk,
      rest: deps.rest,
      requests,
      out,
      tmpDir: tmpDir(),
      log: deps.log,
      isCancelled: deps.isCancelled,
      onStart: () => {
        if (index >= 0) doneBefore += expected[index] ?? 0;
        index++;
        prepared = 0;
        written = 0;
      },
      progress: (entity, n) => {
        counts.set(entity, n);
        written = n;
        report();
      },
    });
    const resultFile = await out.close();
    const done = stats.reduce((n, x) => n + x.items, 0);
    deps.progress(done, done);
    return { resultFile, stats };
  }

  if (job.type === "import") {
    const config = JSON.parse(job.config) as ImportConfig;
    // What a quick change left out and why, for the preview's notes.
    let generatedNotes: string[] = [];
    if (!job.inputFile && config.generate) {
      const timezone = deps.timezone ? await deps.timezone() : "UTC";
      const made = await generateChangeFile(config.generate, { ...deps, timezone }, dir);
      job.inputFile = made.file;
      job.inputName = made.name;
      generatedNotes = made.notes ?? [];
      await deps.onInput?.(made.file, made.name);
    }
    if (!job.inputFile && config.aiFix) {
      const made = await generateAiFixFile(config.aiFix, deps, dir);
      job.inputFile = made.file;
      job.inputName = made.name;
      await deps.onInput?.(made.file, made.name);
    }
    if (!job.inputFile) throw new Error("No input file");
    const chosen = await readImportSheets({ inputFile: job.inputFile, inputName: job.inputName }, config, deps.log, (await deps.layouts?.()) ?? []);
    if (generatedNotes.length && chosen[0]) (chosen[0].notes ??= []).push(...generatedNotes);
    const inputBase = path.basename(job.inputName ?? "Import", path.extname(job.inputName ?? ""));
    const resultFormat: OutputFormat = /\.(csv|tsv|txt|zip)$/i.test(job.inputName ?? "") ? "csv" : format;
    const out = createWorkbookOut(resultFormat, path.join(dir, `${inputBase}_Import_Result_${timestamp()}`), deps.log);
    const cache = new Map<string, unknown>();
    // Cells corrected on the preview's page: this preview's own, or those of the preview being applied.
    const edits = await readEdits(jobDir(job.shop, config.previewOf ?? job.id));
    const edited = Object.values(edits).reduce((n: number, rows) => n + Object.keys(rows).length, 0);
    if (edited) deps.log(`${edited} row${edited === 1 ? " was" : "s were"} corrected in the preview; the corrected values are used.`);
    // "Import for real" after a preview: what the preview saw in the store, to compare with now.
    let expected: Record<string, Record<string, Record<string, string>>> | undefined;
    if (config.previewOf && !config.options?.dryRun) {
      try {
        const saved = JSON.parse(await fs.promises.readFile(path.join(jobDir(job.shop, config.previewOf), PREVIEW_FILE), "utf8")) as Array<{ sheet: string; seen?: Record<string, Record<string, string>> }>;
        expected = Object.fromEntries(saved.filter((s) => s.seen).map((s) => [s.sheet, s.seen!]));
        deps.log("Checking each item against the preview: anything changed in the store since then is left alone and reported.");
      } catch {
        deps.log("The preview's record is no longer kept, so this import can't check for changes made since the preview.");
      }
    }
    // Image files that came with the sheet (in the same ZIP): cells naming one are checked here and uploaded as part of the import.
    const isZip = /\.zip$/i.test(job.inputName ?? job.inputFile);
    const uploaded = isZip ? ((await zipEntries(job.inputFile).catch(() => null)) ?? []).filter((e) => IMAGE_FILE.test(e.name) && !e.name.startsWith("__MACOSX") && !path.basename(e.name).startsWith(".")) : [];
    const images: LocalImages = { refs: new Map(), unused: [] };
    const judged = new Map<string, Promise<{ problem: string | null; warning: string | null; located?: boolean }>>();
    let squareSetting: Promise<boolean> | undefined;
    const squareWanted = () => (squareSetting ??= deps.squareImages?.().catch(() => false) ?? Promise.resolve(false));
    let locationsRemoved = 0;
    const judge = (address: string) => {
      if (!judged.has(address)) {
        judged.set(
          address,
          (async () => {
            const ref = images.refs.get(address);
            if (!ref) return { problem: "is not a file of this upload", warning: null };
            if (ref.problem || !ref.file) return { problem: ref.problem ?? "is not a file of this upload", warning: null };
            const head = ref.file.size <= MAX_IMAGE_BYTES ? await readZipEntryHead(job.inputFile!, ref.file.name).catch(() => null) : null;
            // Whether the photo says where it was taken (checked on a copy: nothing is changed here).
            const located = head ? stripLocation(new Uint8Array(head)) : false;
            return { ...judgeImage(ref.typed, ref.file.size, head, { square: await squareWanted() }), located };
          })(),
        );
      }
      return judged.get(address)!;
    };
    // The same image link is often on many rows: check each once.
    const checked = new Map<string, Promise<string | null>>();
    const checkImageUrl = (url: string): Promise<string | null> => {
      if (isLocalRef(url)) return judge(url).then((j) => j.problem);
      if (!deps.checkImageUrl) return Promise.resolve(null);
      if (!checked.has(url)) checked.set(url, deps.checkImageUrl(url));
      return checked.get(url)!;
    };
    // A real import: the moment a row is sent, its uploaded files go to Shopify and the row carries the address Shopify gives.
    const sent = new Map<string, Promise<string>>();
    const sendImage = (address: string) => {
      if (!sent.has(address)) {
        sent.set(
          address,
          (async () => {
            const ref = images.refs.get(address);
            const j = await judge(address);
            if (!ref?.file || j.problem) throw new ImportError(`Image ${ref?.typed ?? localName(address)} ${j.problem ?? "is not a file of this upload"}`);
            const data = await readZipEntry(job.inputFile!, ref.file.name);
            if (!data) throw new ImportError(`Image ${ref.typed} could not be read from the upload`);
            // Where a photo was taken is nobody's business in a shop: it is taken out before the file leaves.
            if (stripLocation(data)) locationsRemoved++;
            const filename = path.basename(ref.file.name);
            const mimeType = MIME[imageInfo(data.subarray(0, 262_144)).type ?? "jpeg"];
            const staged = (await deps.gql(STAGE_IMAGE, { input: [{ resource: "IMAGE", filename, mimeType, httpMethod: "POST", fileSize: String(data.length) }] })).stagedUploadsCreate;
            const target = staged?.stagedTargets?.[0];
            if (staged?.userErrors?.length || !target?.url || !target.resourceUrl) throw new ImportError(`Image ${ref.typed} was refused by Shopify: ${(staged?.userErrors ?? []).map((e: any) => e.message).join("; ") || "no upload address was given"}`);
            await (deps.uploadFile ?? httpUploadFile)(target.url, target.parameters ?? [], data, filename, mimeType);
            return target.resourceUrl as string;
          })(),
        );
      }
      return sent.get(address)!;
    };
    const importGql: Gql = ((query: string, variables?: Record<string, unknown>) =>
      images.refs.size && variables && /^\s*(?:#graphql\s*)?mutation\b/.test(query) ? sendLocalImages(variables, sendImage).then((v) => deps.gql(query, v)) : deps.gql(query, variables)) as Gql;
    const imageNotes: string[] = [];
    const prepareSheet = async (sheet: Sheet, entity?: { key: string }) => {
      // A supplier's list that names products only by barcode: find which variant each barcode is.
      if (entity?.key === "products") {
        const b = await resolveBarcodes(deps.gql, sheet).catch(() => null);
        if (b) {
          const n = (x: number) => x.toLocaleString("en-GB");
          (sheet.notes ??= []).push(`Rows without a SKU were matched to the shop by barcode: ${n(b.matched)} found${b.missing ? `, ${n(b.missing)} not in the shop` : ""}${b.twice ? `, ${n(b.twice)} with a barcode that several variants share (not imported: add the SKU)` : ""}.`);
        }
      }
      const before = images.refs.size;
      if (!parkLocalImages(sheet, uploaded, images)) return;
      const fresh = [...images.refs.keys()].slice(before);
      const warnings: string[] = [];
      let located = 0;
      for (const address of fresh) {
        const j = await judge(address);
        if (j.warning) warnings.push(j.warning);
        if (j.located) located++;
      }
      if (located) (sheet.notes ??= []).push(`${located.toLocaleString("en")} photo${located === 1 ? " carries" : "s carry"} the place ${located === 1 ? "it was" : "they were"} taken (GPS data). It is removed before ${located === 1 ? "the photo is" : "they are"} sent to Shopify; nothing else in the ${located === 1 ? "file" : "files"} is changed.`);
      const found = fresh.filter((a) => images.refs.get(a)!.file).length;
      if (found) (sheet.notes ??= []).push(`${found.toLocaleString("en")} image file${found === 1 ? "" : "s"} from the upload ${found === 1 ? "is" : "are"} used by this sheet. ${config.options?.dryRun ? "They are checked now and sent to Shopify when the import is applied." : "Each is sent to Shopify with its row."}`);
      if (warnings.length) (sheet.notes ??= []).push(`About the images: ${warnings.slice(0, 8).join("; ")}${warnings.length > 8 ? `; and ${warnings.length - 8} more` : ""}.`);
    };
    // The results file shows the file names as they were typed.
    const outAdd = out.addSheet.bind(out);
    out.addSheet = async (name, headers, rows) => {
      if (images.refs.size && Array.isArray(rows)) for (const row of rows) unparkRow(row, images);
      return outAdd(name, headers, rows);
    };
    // A copy of the items a sheet is about to change, read with the type's own export (all its data groups).
    const snapshot = async (entity: (typeof ENTITIES)[number], ids: string[], named?: { column: string; field: string; values: string[] }) => {
      const wantedIds = new Set(ids);
      const wantedNames = new Set((named?.values ?? []).map((v) => v.toLowerCase()));
      const rows: Array<Record<string, string>> = [];
      // IDs and names are asked for in searches of a manageable length.
      const terms = [...ids.map((id) => `id:${id}`), ...(named?.values ?? []).map((v) => `${named!.field}:"${v}"`)];
      for (let i = 0; i < terms.length; i += 100) {
        const chunk = terms.slice(i, i + 100);
        let keep = false;
        await entity.export!(
          {
            gql: deps.gql,
            bulk: deps.bulk,
            rest: deps.rest,
            // The limit stops a runaway read if the store's search were to ignore the terms.
            options: { query: chunk.join(" OR "), groups: (entity.groups ?? []).map((g) => g.key).filter((g) => g !== "codes"), limit: chunk.length + 5 },
            log: () => {},
            cache,
            progress: () => {},
          },
          async (out) => {
            for (const row of out) {
              // Rows of an item follow its first row; only the items asked for are kept (a search can match loosely).
              if (row.ID) keep = wantedIds.has(row.ID) || (!!named && wantedNames.has((row[named.column] ?? "").toLowerCase()));
              if (keep) rows.push({ ...row, ...(row.ID ? { Command: "UPDATE" } : {}) });
            }
          },
        );
      }
      return rows;
    };
    const stats = await runImport({
      snapshot,
      ctx: { gql: importGql, options: config.options ?? {}, log: deps.log, cache, checkImageUrl },
      prepareSheet,
      sheets: chosen,
      entities: ENTITIES,
      out,
      log: deps.log,
      progress: deps.progress,
      isCancelled: deps.isCancelled,
      expected,
      exclude: config.options?.dryRun ? undefined : config.exclude,
      stopAtFailedPercent: config.options?.dryRun ? undefined : config.stopAtFailedPercent,
      expectedFailed: config.expectedFailed,
      edits,
      // A first look for the job's page while a large file is still being checked.
      onPartial: config.options?.dryRun
        ? (sheets) => {
            const tmp = path.join(dir, `${PARTIAL_FILE}.tmp`);
            void fs.promises
              .writeFile(tmp, JSON.stringify(sheets))
              .then(() => fs.promises.rename(tmp, path.join(dir, PARTIAL_FILE)))
              .catch(() => {});
          }
        : undefined,
    });
    if (locationsRemoved) deps.log(`The place it was taken (GPS data) was removed from ${locationsRemoved.toLocaleString("en")} photo${locationsRemoved === 1 ? "" : "s"} before upload.`);
    if (uploaded.length) {
      const used = new Set([...images.refs.values()].map((r) => r.file?.name).filter(Boolean));
      const unused = uploaded.filter((f) => !used.has(f.name)).map((f) => f.name);
      if (unused.length) {
        const note = `${unused.length.toLocaleString("en")} image file${unused.length === 1 ? "" : "s"} in the upload ${unused.length === 1 ? "is" : "are"} not named by any row and ${unused.length === 1 ? "is" : "are"} not imported: ${unused.slice(0, 6).join(", ")}${unused.length > 6 ? "…" : ""}. Write a file's name in the Image Src column of the row it belongs to.`;
        deps.log(note);
        imageNotes.push(note);
        const first = stats.find((s) => s.entity);
        if (first) first.warnings = [...(first.warnings ?? []), note];
      }
    }
    const resultFile = await out.close();
    // What puts this import back, as a file that can itself be imported.
    const undoByType = new Map<string, Array<Record<string, string>>>();
    for (const st of stats) {
      const sheetName = ENTITIES.find((e) => e.key === st.entity)?.sheet;
      if (images.refs.size) for (const row of st.undo ?? []) unparkRow(row, images);
      if (st.undo?.length && sheetName) undoByType.set(sheetName, [...(undoByType.get(sheetName) ?? []), ...st.undo]);
    }
    if (undoByType.size) {
      await fs.promises.mkdir(path.join(dir, UNDO_DIR), { recursive: true });
      // One data type: the file is named after it, so the undo import recognises it.
      const undoName = undoByType.size === 1 ? `Undo_${[...undoByType.keys()][0].replace(/\s+/g, "_")}` : "Undo";
      const undoOut = createWorkbookOut("csv", path.join(dir, UNDO_DIR, undoName), deps.log);
      for (const [sheetName, rows] of undoByType) {
        const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        await undoOut.addSheet(sheetName, headers, rows.map((r) => Object.fromEntries(headers.filter((h) => h in r).map((h) => [h, r[h]]))));
      }
      await undoOut.close();
      deps.log(`This import can be undone from its page (${[...undoByType.values()].reduce((n, r) => n + r.length, 0)} rows recorded).`);
    }
    // The dry-run preview is kept in a file of its own beside the results.
    if (config.options?.dryRun) {
      await fs.promises.writeFile(
        path.join(dir, PREVIEW_FILE),
        JSON.stringify(stats.map((s) => ({ sheet: s.sheet, entity: s.entity, items: s.preview ?? [], seen: s.seen, risk: s.risk, warnings: s.warnings }))),
      );
      await fs.promises.rm(path.join(dir, PARTIAL_FILE), { force: true }).catch(() => {});
    }
    // The change history: what each item was changed from and to, as the preview showed it.
    if (!config.options?.dryRun && deps.onChanges && stats.some((s) => s.applied?.length)) {
      const shown = new Map<string, { title?: string; action: string; changes: string[] }>();
      if (config.previewOf) {
        try {
          const saved = JSON.parse(await fs.promises.readFile(path.join(jobDir(job.shop, config.previewOf), PREVIEW_FILE), "utf8")) as Array<{ sheet: string; items: Array<{ key?: string; title?: string; action: string; changes: string[] }> }>;
          for (const sh of saved) for (const i of sh.items) if (i.key) shown.set(`${sh.sheet}\u0000${i.key}`, { title: i.title, action: i.action, changes: i.changes });
        } catch {
          // the preview is no longer kept: the history says that the item changed, without the values
        }
      }
      const entries: ChangeEntry[] = [];
      for (const s of stats) {
        for (const a of s.applied ?? []) {
          const p = shown.get(`${s.sheet}\u0000${a.key}`);
          if (p?.action === "none") continue;
          entries.push({
            entity: s.entity ?? "",
            itemKey: a.key,
            itemId: a.id ?? "",
            title: a.title ?? p?.title ?? "",
            action: config.undoOf ? "undo" : (p?.action ?? (/^(created|replaced)/i.test(a.message ?? "") ? "create" : /^deleted/i.test(a.message ?? "") ? "delete" : "update")),
            changes: (p?.changes?.length ? p.changes : a.message ? [a.message] : []).slice(0, 30).map((c) => (c.length > 400 ? `${c.slice(0, 397)}…` : c)),
          });
        }
      }
      await deps.onChanges(entries).catch((e: any) => deps.log(`The change history could not be recorded (${e?.message ?? e}).`));
    }
    return { resultFile, stats: stats.map(({ preview: _p, seen: _s, undo, applied: _a, ...s }) => ({ ...s, ...(undo?.length ? { undoRows: undo.length } : {}) })) };
  }

  throw new Error(`Unknown job type ${job.type}`);
}
