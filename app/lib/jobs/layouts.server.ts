import crypto from "node:crypto";
import prisma from "../../db.server";
import { oddMatches, type ColumnLayout } from "../core/layouts";
import { getEntity } from "../entities";

export const MAX_LAYOUTS = 50;

export async function listLayouts(shop: string): Promise<ColumnLayout[]> {
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { columnLayouts: true } });
  try {
    const list = JSON.parse(s?.columnLayouts ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function store(shop: string, layouts: ColumnLayout[]) {
  const columnLayouts = JSON.stringify(layouts);
  await prisma.shopSetting.upsert({ where: { shop }, create: { shop, columnLayouts }, update: { columnLayouts } });
}

/** Saves a column matching. One with the same name is replaced. */
export async function saveLayout(shop: string, input: { name: string; entity: string; map: Record<string, string>; confirmedOdd?: boolean; headerRow?: number; skipUnknown?: boolean; inStockQty?: number | null }): Promise<ColumnLayout> {
  const entity = getEntity(input.entity);
  if (!entity?.import) throw new Error("Choose what kind of data this sheet holds.");
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Give this column matching a name, such as the supplier's.");
  const valid = new Set(entity.columns);
  const map: Record<string, string> = {};
  const used = new Map<string, string>();
  for (const [from, to] of Object.entries(input.map ?? {}).slice(0, 500)) {
    const header = String(from).slice(0, 200);
    const target = String(to ?? "");
    if (target && !valid.has(target) && !/^((Variant )?Metafield: \S|Inventory [A-Za-z ]+: \S|Option[123] (Name|Value)$)/.test(target)) throw new Error(`"${target}" is not a ${entity.sheet} column`);
    if (target && used.has(target)) throw new Error(`Two columns ("${used.get(target)}" and "${header}") are matched to ${target}. Match only one of them.`);
    if (target) used.set(target, header);
    map[header] = target;
  }
  if (!used.size) throw new Error("Match at least one column.");
  const odd = oddMatches(map);
  if (odd.length && !input.confirmedOdd) throw new Error(`${odd.join(". ")}. Change the match, or tick the box to say it is right.`);
  const keys = entity.key === "products" ? [...entity.import.keyColumns, "Variant Barcode"] : entity.import.keyColumns;
  if (!keys.some((k) => used.has(k))) {
    throw new Error(`Match a column that says which ${entity.sheet.toLowerCase().replace(/s$/, "")} each row is: ${keys.join(", or ")}.`);
  }
  const layouts = (await listLayouts(shop)).filter((l) => l.name.toLowerCase() !== name.toLowerCase());
  if (layouts.length >= MAX_LAYOUTS) throw new Error(`At most ${MAX_LAYOUTS} column matchings can be saved. Remove one in Settings first.`);
  const layout: ColumnLayout = { id: crypto.randomBytes(6).toString("hex"), name, entity: entity.key, map, savedAt: new Date().toISOString() };
  const row = Number(input.headerRow);
  if (input.headerRow !== undefined && Number.isInteger(row) && row >= 0 && row <= 200) layout.headerRow = row;
  if (input.skipUnknown === false) layout.skipUnknown = false;
  const qty = input.inStockQty === null || input.inStockQty === undefined || (input.inStockQty as unknown) === "" ? null : Number(input.inStockQty);
  if (qty !== null && Number.isFinite(qty) && qty >= 0 && qty <= 100000) layout.inStockQty = Math.round(qty);
  await store(shop, [...layouts, layout]);
  return layout;
}

export async function deleteLayout(shop: string, id: string) {
  await store(shop, (await listLayouts(shop)).filter((l) => l.id !== id));
}
