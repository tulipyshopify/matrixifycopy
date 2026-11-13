/**
 * Next run times for schedules. Daily and weekly schedules can run at an exact
 * local time ("07:30" in Europe/London), which stays put across clock changes.
 */

export interface ScheduleTiming {
  intervalMinutes: number;
  runAt?: string | null;
  timezone?: string | null;
  weekday?: number | null;
}

import { isValidTimeZone, localParts, zonedTimeToUtc } from "../core/time";

export { isValidTimeZone, zonedTimeToUtc };

/**
 * First run strictly after `after`. With an exact time (daily or longer
 * intervals) it is the next matching local time; otherwise `previous` plus
 * whole intervals, so runs don't drift with how long each job takes.
 */
export function nextRun(s: ScheduleTiming, after: Date, previous?: Date): Date {
  const intervalMs = Math.max(1, s.intervalMinutes) * 60_000;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.runAt ?? "");
  if (m && s.timezone && s.intervalMinutes >= 1440 && isValidTimeZone(s.timezone)) {
    const today = localParts(after, s.timezone);
    for (let offset = 0; offset <= 8; offset++) {
      // Date.UTC normalises day overflow (e.g. 31 + 2), giving the right calendar date.
      const cal = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
      if (s.weekday !== null && s.weekday !== undefined && cal.getUTCDay() !== s.weekday) continue;
      const at = zonedTimeToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), Number(m[1]), Number(m[2]), s.timezone);
      if (at.getTime() > after.getTime()) return at;
    }
  }
  let next = (previous ?? after).getTime() + intervalMs;
  if (next <= after.getTime()) next += Math.ceil((after.getTime() - next + 1) / intervalMs) * intervalMs;
  return new Date(next);
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Daily at 07:30 (Europe/London)", "Every Monday at 07:30 (…)", "Every 6 hours". */
export function describeSchedule(s: ScheduleTiming): string {
  const m = s.intervalMinutes;
  if (s.runAt && s.timezone && m >= 1440) {
    const day = s.weekday !== null && s.weekday !== undefined ? `Every ${DAYS[s.weekday]}` : "Daily";
    return `${day} at ${s.runAt} (${s.timezone})`;
  }
  if (m % 10080 === 0) return m === 10080 ? "Weekly" : `Every ${m / 10080} weeks`;
  if (m % 1440 === 0) return m === 1440 ? "Daily" : `Every ${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? "Hourly" : `Every ${m / 60} hours`;
  return `Every ${m} minutes`;
}
