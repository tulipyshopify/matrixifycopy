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
export function detectEntity(sheet: Pick<Sheet, "name">, entities: Entity[]): Entity | null {
  const name = norm(sheet.name);
  const namesOf = (e: Entity) => [norm(e.sheet), norm(e.key), ...(e.aliases ?? []).map(norm)];
  for (const e of entities) if (namesOf(e).includes(name)) return e;
  let best: { e: Entity; len: number } | null = null;
  for (const e of entities) {
    for (const n of namesOf(e)) {
      if (n && name.includes(n) && (!best || n.length > best.len)) best = { e, len: n.length };
    }
  }
  return best?.e ?? null;
}
