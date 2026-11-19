import path from "node:path";
import { type JobFilter, countJobs, downloadLinks, listJobs, listSchedules } from "./jobs.server";
import { describeSchedule } from "./schedule-time";

/** Jobs for a list on a page: with download links, file names and how often a scheduled one repeats. */
export async function jobListData(shop: string, take: number, filter: JobFilter = "all") {
  const [jobs, schedules, total] = await Promise.all([listJobs(shop, take, filter), listSchedules(shop), countJobs(shop, filter)]);
  const repeats = new Map(schedules.map((s) => [s.id, describeSchedule(s)]));
  return {
    total,
    schedules,
    repeats,
    jobs: jobs.map(({ resultFile, scheduleId, ...j }) => ({
      ...j,
      links: downloadLinks({ id: j.id, resultFile, inputFile: null }),
      fileName: resultFile ? path.basename(resultFile) : null,
      repeat: scheduleId ? (repeats.get(scheduleId) ?? null) : null,
    })),
  };
}
