import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectEntity } from "../core/registry";
import { readWorkbook } from "../core/sheets";
import { ENTITIES } from "../entities";

/**
 * For imports that fetch a file on a schedule (a supplier's feed): what is
 * different in this file compared with the one fetched last time, so a person
 * approving it sees at a glance whether it is the usual update or something odd.
 */

export const FEED_FILE = "feed.json";
/** Files larger than this are not compared (both would be held in memory at once). */
const MAX_COMPARE_BYTES = 25 * 1024 * 1024;

export interface FeedDiff {
  /** The file is byte for byte the one fetched last time. */
  identical: boolean;
  previousAt: string;
  sheets: Array<{
    sheet: string;
    key: string;
    rows: number;
    added: number;
    removed: number;
    changed: number;
    /** Columns with the most changed cells, most first. */
    columns: Array<{ column: string; cells: number }>;
    /** A few examples: "AC-100: Variant Price 50.00 → 55.00". */
    examples: string[];
    addedColumns: string[];
    removedColumns: string[];
  }>;
}

const hash = async (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });

/** Compares this run's file with the previous run's. Null when they can't be compared. */
export async function compareFeeds(previous: { file: string; name: string; at: Date }, current: { file: string; name: string }): Promise<FeedDiff | null> {
  const [a, b] = await Promise.all([fs.promises.stat(previous.file), fs.promises.stat(current.file)]);
  if (a.size === b.size && (await hash(previous.file)) === (await hash(current.file))) return { identical: true, previousAt: previous.at.toISOString(), sheets: [] };
  if (a.size > MAX_COMPARE_BYTES || b.size > MAX_COMPARE_BYTES) return null;
  const [before, after] = await Promise.all([readWorkbook(previous.file, previous.name), readWorkbook(current.file, current.name)]);
  const diff: FeedDiff = { identical: false, previousAt: previous.at.toISOString(), sheets: [] };
  for (const sheet of after) {
    const name = sheet.label ?? sheet.name;
    const old = before.find((s) => (s.label ?? s.name) === name) ?? (after.length === 1 && before.length === 1 ? before[0] : null);
    if (!old) {
      diff.sheets.push({ sheet: name, key: "", rows: sheet.rows.length, added: sheet.rows.length, removed: 0, changed: 0, columns: [], examples: [], addedColumns: sheet.headers, removedColumns: [] });
      continue;
    }
    // Rows are matched by what identifies them: the data type's key column if the sheet has one, else its first column.
    const entity = detectEntity(sheet, ENTITIES);
    const key = entity?.import?.keyColumns.find((k) => sheet.headers.includes(k) && sheet.rows.some((r) => r[k])) ?? sheet.headers[0] ?? "";
    const index = new Map<string, Record<string, string>>();
    for (const r of old.rows) if (r[key] && !index.has(r[key])) index.set(r[key], r);
    const shared = sheet.headers.filter((h) => h !== key && old.headers.includes(h));
    const perColumn = new Map<string, number>();
    const seen = new Set<string>();
    let added = 0;
    let changed = 0;
    const examples: string[] = [];
    for (const r of sheet.rows) {
      const k = r[key];
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      const was = index.get(k);
      if (!was) {
        added++;
        continue;
      }
      let any = false;
      for (const h of shared) {
        if ((r[h] ?? "") === (was[h] ?? "")) continue;
        any = true;
        perColumn.set(h, (perColumn.get(h) ?? 0) + 1);
        if (examples.length < 5) {
          const short = (v: string) => (v === "" ? "(empty)" : v.length > 40 ? `${v.slice(0, 37)}…` : v);
          examples.push(`${k}: ${h} ${short(was[h] ?? "")} → ${short(r[h] ?? "")}`);
        }
      }
      if (any) changed++;
    }
    let removed = 0;
    for (const k of index.keys()) if (!seen.has(k)) removed++;
    diff.sheets.push({
      sheet: name,
      key,
      rows: sheet.rows.length,
      added,
      removed,
      changed,
      columns: [...perColumn.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([column, cells]) => ({ column, cells })),
      examples,
      addedColumns: sheet.headers.filter((h) => !old.headers.includes(h)).slice(0, 20),
      removedColumns: old.headers.filter((h) => !sheet.headers.includes(h)).slice(0, 20),
    });
  }
  return diff;
}

const n = (x: number) => x.toLocaleString("en-GB");

/** The comparison in a sentence or two, for the log and the job's page. */
export function feedSummary(d: FeedDiff): string[] {
  if (d.identical) return ["This file is exactly the one fetched last time: the source has not been updated."];
  return d.sheets.map((s) => {
    const parts = [s.added ? `${n(s.added)} new` : "", s.removed ? `${n(s.removed)} no longer in the file` : "", s.changed ? `${n(s.changed)} changed` : ""].filter(Boolean);
    const cols = s.columns.length ? ` Mostly ${s.columns.slice(0, 3).map((c) => `${c.column} (${n(c.cells)})`).join(", ")}.` : "";
    const layout = [s.addedColumns.length ? ` New columns: ${s.addedColumns.slice(0, 5).join(", ")}.` : "", s.removedColumns.length ? ` Columns gone: ${s.removedColumns.slice(0, 5).join(", ")}.` : ""].join("");
    // A feed that suddenly loses a large part of its rows is more likely broken than updated.
    const shrink = s.removed > 20 && s.removed > (s.rows + s.removed) * 0.3 ? " That is a large part of the file gone: check the source before applying." : "";
    return `${d.sheets.length > 1 ? `${s.sheet}: ` : ""}since the last file, ${parts.length ? parts.join(", ") : "no row differs"} (of ${n(s.rows)} rows, matched by ${s.key || "position"}).${cols}${layout}${shrink}`;
  });
}

export async function readFeedDiff(dir: string): Promise<FeedDiff | null> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(dir, FEED_FILE), "utf8")) as FeedDiff;
  } catch {
    return null;
  }
}
