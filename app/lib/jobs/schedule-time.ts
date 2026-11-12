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

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Calendar date, time and weekday of an instant in a time zone. */
function localParts(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute"), second: n("second") };
}

/** The instant at which a zone's clock shows the given local date and time. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  // Two passes settle the offset, including on days when the clocks change.
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += wanted - shown;
  }
  return new Date(guess);
}

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
