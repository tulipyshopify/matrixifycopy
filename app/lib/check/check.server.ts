import prisma from "../../db.server";
import { OPTIONS_VERSION } from "../jobs/jobs.server";
import { ALL_RULES, type CheckReport } from "./rules";

/** Starts a data check (one at a time per store). */
export async function startCheck(shop: string) {
  const running = await prisma.job.findFirst({ where: { shop, kind: "check", status: { in: ["queued", "running"] } } });
  if (running) return running;
  // Old reports aren't needed once there are a few newer ones.
  const old = await prisma.job.findMany({ where: { shop, kind: "check" }, orderBy: { createdAt: "desc" }, skip: 9, select: { id: true } });
  if (old.length) await prisma.job.deleteMany({ where: { id: { in: old.map((j) => j.id) } } });
  return prisma.job.create({ data: { shop, type: "export", kind: "check", format: "csv", name: "Data check", config: "{}" } });
}

function reportOf(stats: string): CheckReport | null {
  try {
    const r = JSON.parse(stats)[0];
    return r && typeof r.score === "number" ? (r as CheckReport) : null;
  } catch {
    return null;
  }
}

/** The check in progress (if any), the latest finished report, and the one before it for the trend. */
export async function latestChecks(shop: string) {
  const jobs = await prisma.job.findMany({ where: { shop, kind: "check" }, orderBy: { createdAt: "desc" }, take: 10 });
  const active = jobs.find((j) => j.status === "queued" || j.status === "running") ?? null;
  const done = jobs.filter((j) => j.status === "finished").map((j) => ({ job: j, report: reportOf(j.stats) })).filter((x) => x.report);
  const failed = jobs[0]?.status === "failed" ? jobs[0] : null;
  return { active, latest: done[0] ?? null, previous: done[1] ?? null, failed };
}

/** An export set-up holding just the products a rule flagged, with the columns needed to fix them. */
export async function fixExport(shop: string, jobId: string, ruleKey: string) {
  const job = await prisma.job.findFirst({ where: { id: jobId, shop, kind: "check", status: "finished" } });
  const rule = ALL_RULES.find((r) => r.key === ruleKey);
  const ids = (job && reportOf(job.stats)?.rules.find((r) => r.key === ruleKey)?.ids) ?? [];
  if (!rule || !ids.length) return null;
  const columns = ["ID", "Title", ...rule.fixColumns];
  const groups = [
    ...(columns.some((c) => c.startsWith("Variant") || c.startsWith("Option")) ? ["variants"] : []),
    ...(columns.some((c) => c.startsWith("Image")) ? ["images"] : []),
    ...(columns.some((c) => c.startsWith("SEO")) ? ["seo"] : []),
  ];
  return {
    entities: [{ entity: "products", options: { v: OPTIONS_VERSION, groups, columns, filters: [{ field: "id", op: "any_of" as const, value: ids.join(",") }] } }],
    format: "xlsx",
  };
}
