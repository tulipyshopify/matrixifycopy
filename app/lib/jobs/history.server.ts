import prisma from "../../db.server";
import type { ChangeEntry } from "./runner.server";
import { RETENTION_DAYS } from "./storage.server";

/**
 * The change history: for every item an import changed, what changed and in
 * which import, kept as long as the import's undo record.
 */

export async function recordChanges(shop: string, jobId: string, entries: ChangeEntry[]) {
  for (let i = 0; i < entries.length; i += 500) {
    await prisma.changeLog.createMany({
      data: entries.slice(i, i + 500).map((e) => ({ shop, jobId, entity: e.entity, itemKey: e.itemKey, itemId: e.itemId, title: e.title, action: e.action, changes: JSON.stringify(e.changes) })),
    });
  }
}

export interface HistoryEntry {
  id: string;
  jobId: string;
  jobName: string;
  entity: string;
  item: string;
  title: string;
  action: string;
  changes: string[];
  at: Date;
}

/** Changes, newest first: all of them, or those of the items a search matches (handle, ID, SKU, email or part of a title). */
export async function searchHistory(shop: string, query: string, limit = 100): Promise<HistoryEntry[]> {
  const q = query.trim().toLowerCase().slice(0, 200);
  const id = q.replace(/^gid:\/\/shopify\/\w+\//, "");
  const rows = await prisma.changeLog.findMany({
    where: q ? { shop, OR: [{ itemKey: { contains: q } }, ...(/^\d+$/.test(id) ? [{ itemId: id }] : []), { title: { contains: query.trim().slice(0, 200) } }] } : { shop },
    orderBy: { createdAt: "desc" },
    take: Math.min(500, Math.max(1, limit)),
  });
  const jobs = new Map((await prisma.job.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.jobId))] } }, select: { id: true, name: true, inputName: true } })).map((j) => [j.id, j.name || j.inputName || "Import"]));
  return rows.map((r) => {
    let changes: string[] = [];
    try {
      changes = JSON.parse(r.changes);
    } catch {
      changes = [];
    }
    return { id: r.id, jobId: r.jobId, jobName: jobs.get(r.jobId) ?? "An import no longer in the job list", entity: r.entity, item: r.itemKey.replace("=", ": "), title: r.title, action: r.action, changes, at: r.createdAt };
  });
}

/** Drops history older than the undo period. */
export async function clearOldHistory(now = new Date()): Promise<number> {
  const { count } = await prisma.changeLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - RETENTION_DAYS * 86_400_000) } } });
  return count;
}
