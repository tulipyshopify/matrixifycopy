import prisma from "../../db.server";
import { OPTIONS_VERSION } from "../jobs/jobs.server";
import { ALL_RULES, RULES, type CheckReport } from "./rules";
import { isValidTimeZone, nextRun } from "../jobs/schedule-time";
import { assistantAllowed } from "../ai/assistant.server";
import { AI_FIXABLE, MAX_AI_PRODUCTS } from "./aifix";

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

/** Tags whose products the check leaves out (internal items, placeholders…). */
export async function checkExclusions(shop: string): Promise<string[]> {
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { checkExcludeTags: true } });
  return splitExclusions(s?.checkExcludeTags ?? "");
}

const splitExclusions = (v: string) => [...new Set(v.split(",").map((t) => t.trim()).filter(Boolean))].slice(0, 20);

export async function saveCheckExclusions(shop: string, tags: string) {
  const clean = splitExclusions(tags).map((t) => t.slice(0, 255)).join(", ");
  await prisma.shopSetting.upsert({ where: { shop }, create: { shop, checkExcludeTags: clean }, update: { checkExcludeTags: clean } });
  return splitExclusions(clean);
}

/**
 * An export set-up holding every product a rule flags, with the columns needed
 * to fix them. The export finds them itself with the same rule (so all of
 * them are included, not just the ones a report has room to list); only the
 * duplicate-SKU rule, which compares products with each other, goes by the
 * report's list.
 */
export async function fixExport(shop: string, jobId: string, ruleKey: string) {
  const job = await prisma.job.findFirst({ where: { id: jobId, shop, kind: "check", status: "finished" } });
  const rule = ALL_RULES.find((r) => r.key === ruleKey);
  const found = job ? reportOf(job.stats)?.rules.find((r) => r.key === ruleKey) : undefined;
  if (!rule || !found?.count) return null;
  const columns = ["ID", "Title", ...rule.fixColumns];
  const groups = [
    ...(columns.some((c) => c.startsWith("Variant") || c.startsWith("Option")) ? ["variants"] : []),
    ...(columns.some((c) => c.startsWith("Image")) ? ["images"] : []),
    ...(columns.some((c) => c.startsWith("SEO")) ? ["seo"] : []),
  ];
  const filters = RULES.some((r) => r.key === ruleKey)
    ? [
        { field: "status", op: "is" as const, value: "active" },
        ...(await checkExclusions(shop)).map((tag) => ({ field: "tag", op: "is_not" as const, value: tag })),
        { field: "problem", op: "is" as const, value: ruleKey },
      ]
    : [{ field: "id", op: "any_of" as const, value: found.ids.join(",") }];
  return {
    entities: [{ entity: "products", options: { v: OPTIONS_VERSION, groups, columns, filters } }],
    format: "xlsx",
  };
}

// --- Weekly check -------------------------------------------------------------


export async function getCheckSchedule(shop: string) {
  return prisma.schedule.findFirst({ where: { shop, kind: "check" } });
}

/** Switches the weekly check on (Mondays 06:00 in the merchant's time zone) or off. */
export async function setWeeklyCheck(shop: string, enabled: boolean, timezone: string) {
  const tz = isValidTimeZone(timezone) ? timezone : "UTC";
  const timing = { intervalMinutes: 10080, runAt: "06:00", timezone: tz, weekday: 1 };
  const data = { name: "Weekly data check", type: "export", kind: "check", format: "csv", config: "{}", ...timing, enabled, nextRunAt: nextRun(timing, new Date()) };
  const existing = await getCheckSchedule(shop);
  return existing ? prisma.schedule.update({ where: { id: existing.id }, data }) : prisma.schedule.create({ data: { shop, ...data } });
}

/**
 * For the home screen: the latest check scored lower than the one before and
 * nobody has opened the Data check page since.
 */
export async function scoreDrop(shop: string): Promise<{ from: number; to: number } | null> {
  const { latest, previous } = await latestChecks(shop);
  if (!latest || !previous || latest.job.reviewedAt) return null;
  const to = latest.report!.score;
  const from = previous.report!.score;
  return to < from ? { from, to } : null;
}

/** Opening the Data check page counts as seeing the latest result. */
export async function markCheckSeen(shop: string) {
  await prisma.job.updateMany({ where: { shop, kind: "check", reviewedAt: null, status: { in: ["finished", "failed"] } }, data: { reviewedAt: new Date() } });
}

// --- AI-drafted fixes -----------------------------------------------------------

/** Starts a preview import of AI drafts for the products a rule flagged (first MAX_AI_PRODUCTS). */
export async function startAiFix(shop: string, jobId: string, ruleKey: string) {
  if (!assistantAllowed(shop)) throw new Error("AI drafts need the Claude API key on the server");
  const job = await prisma.job.findFirst({ where: { id: jobId, shop, kind: "check", status: "finished" } });
  const rule = ALL_RULES.find((r) => r.key === ruleKey);
  const ids = (job && reportOf(job.stats)?.rules.find((r) => r.key === ruleKey)?.ids) ?? [];
  if (!rule || !AI_FIXABLE[ruleKey] || !ids.length) throw new Error("There is nothing to draft for that problem");
  return prisma.job.create({
    data: {
      shop,
      type: "import",
      name: `AI drafts: ${rule.title.toLowerCase()}`,
      config: JSON.stringify({ options: { dryRun: true, defaultCommand: "UPDATE" }, aiFix: { rule: ruleKey, ids: ids.slice(0, MAX_AI_PRODUCTS) } }),
    },
  });
}
