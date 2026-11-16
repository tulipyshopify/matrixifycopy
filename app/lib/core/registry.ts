import type { Entity } from "./types";
import type { Sheet } from "./sheets";

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(\d+\)$/, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds the data type a sheet holds.
 *
 * 1. A sheet named exactly after a data type ("Products") is that type.
 * 2. Otherwise the columns decide, when they clearly point at one type, so a
 *    file can be called anything ("stock update.csv", "Sheet1").
 * 3. Otherwise a data type's name inside the file name ("Export_Products_2026.csv").
 * 4. Otherwise the best guess from the columns, if there is a single one.
 */
export function detectEntity(sheet: Pick<Sheet, "name"> & { headers?: string[] }, entities: Entity[]): Entity | null {
  const name = norm(sheet.name);
  const namesOf = (e: Entity) => [norm(e.sheet), norm(e.key), ...(e.aliases ?? []).map(norm)];
  for (const e of entities) if (namesOf(e).includes(name)) return e;
  const byHeaders = scoreByHeaders(sheet.headers ?? [], entities);
  if (byHeaders.confident) return byHeaders.confident;
  let best: { e: Entity; len: number } | null = null;
  for (const e of entities) {
    for (const n of namesOf(e)) {
      if (n && name.includes(n) && (!best || n.length > best.len)) best = { e, len: n.length };
    }
  }
  return best?.e ?? byHeaders.guess;
}

/** Columns too common to tell data types apart. */
const GENERIC = new Set(["ID", "Handle", "Command", "Title", "Tags", "Tags Command", "Created At", "Updated At", "Row #", "Top Row", "Name", "Email", "Phone", "Note", "Status"]);

/** Columns added to result files, and other headers that say nothing about the data type. */
const IGNORED = /^(Import Result|Import Comment)$/i;

/** Dynamic columns ("Variant Metafield: …", "Inventory Available: …") and the fixed column that proves the type has them. */
const DYNAMIC: Array<[RegExp, string]> = [
  [/^Variant Metafield: /, "Variant ID"],
  [/^Inventory [A-Za-z ]+: /, "Variant Inventory Qty"],
  [/^(Variant|Line|Address|Rule|Item|Field) /, ""],
];

/**
 * Scores each importable data type by how many of the sheet's columns it
 * knows. `confident`: one type clearly ahead on distinctive columns, and it
 * knows most of them. `guess`: a single best match, even on common columns.
 */
function scoreByHeaders(headers: string[], entities: Entity[]): { confident: Entity | null; guess: Entity | null } {
  const all = headers.map((h) => h.trim()).filter((h) => h && !IGNORED.test(h) && !/^Metafield: /.test(h));
  const distinctive = all.filter((h) => !GENERIC.has(h));
  if (!all.length) return { confident: null, guess: null };
  const scored = entities
    .filter((e) => e.import)
    .map((e) => {
      const cols = new Set(e.columns);
      const prefixes = new Set(e.columns.map((c) => c.split(/[ :]/)[0]));
      const knows = (h: string) => {
        if (cols.has(h)) return true;
        for (const [re, proof] of DYNAMIC) {
          if (re.test(h)) return proof ? cols.has(proof) : prefixes.has(h.split(" ")[0]);
        }
        return false;
      };
      return { e, score: distinctive.filter(knows).length, total: all.filter(knows).length };
    });
  const top = [...scored].sort((a, b) => b.score - a.score || b.total - a.total);
  const [first, second] = top;
  if (!first || first.total === 0) return { confident: null, guess: null };
  const ahead = first.score > (second?.score ?? 0);
  // Tied on distinctive columns: the common ones (Handle, Tags, Email…) may still single one out.
  const aheadOverall = ahead || (first.score === second?.score && first.total > second.total);
  const confident = ahead && first.score >= 2 && first.score >= distinctive.length * 0.6 ? first.e : ahead && distinctive.length === 1 && first.total >= 2 ? first.e : null;
  const guess = aheadOverall && (first.score > 0 || first.total >= 2) ? first.e : null;
  return { confident, guess };
}
