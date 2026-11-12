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
 * Finds the entity a sheet belongs to: exact sheet name or alias first, then the
 * longest entity name contained in the sheet/file name (e.g.
 * "Export_2026-10-27_Products.csv" -> Products).
 */
export function detectEntity(sheet: Pick<Sheet, "name"> & { headers?: string[] }, entities: Entity[]): Entity | null {
  const name = norm(sheet.name);
  const namesOf = (e: Entity) => [norm(e.sheet), norm(e.key), ...(e.aliases ?? []).map(norm)];
  for (const e of entities) if (namesOf(e).includes(name)) return e;
  let best: { e: Entity; len: number } | null = null;
  for (const e of entities) {
    for (const n of namesOf(e)) {
      if (n && name.includes(n) && (!best || n.length > best.len)) best = { e, len: n.length };
    }
  }
  return best?.e ?? detectByHeaders(sheet.headers ?? [], entities);
}

/** Columns too common to tell data types apart. */
const GENERIC = new Set(["ID", "Handle", "Command", "Title", "Tags", "Tags Command", "Created At", "Updated At", "Row #", "Top Row", "Name", "Email", "Phone", "Note", "Status"]);

/**
 * Fallback for files whose name says nothing (e.g. a Google Sheet tab called
 * "Arrival Dates"): the importable data type whose columns match the most
 * headers wins, if it is a clear winner.
 */
function detectByHeaders(headers: string[], entities: Entity[]): Entity | null {
  const distinctive = headers.map((h) => h.trim()).filter((h) => h && !GENERIC.has(h));
  if (!distinctive.length) return null;
  const scored = entities
    .filter((e) => e.import)
    .map((e) => {
      const cols = new Set(e.columns);
      // "Variant Metafield: …" style columns count for the type that has "Variant …" columns.
      const prefixes = new Set(e.columns.map((c) => c.split(/[ :]/)[0]));
      const score = distinctive.filter((h) => cols.has(h) || (/^(Variant|Line|Address|Rule|Item|Field) /.test(h) && prefixes.has(h.split(" ")[0]))).length;
      return { e, score };
    })
    .sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  return first && first.score > 0 && first.score > (second?.score ?? 0) ? first.e : null;
}
