import { useEffect, useState } from "react";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The browser's IANA time zone, e.g. "Europe/London". */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Exact run time for daily and weekly schedules: a time of day and, for
 * weekly, the weekday. Hourly schedules have no exact time.
 */
export function ScheduleTimeFields({
  intervalMinutes,
  runAt,
  weekday,
  onChange,
}: {
  intervalMinutes: number;
  runAt: string;
  weekday: number;
  onChange: (patch: { runAt?: string; weekday?: number }) => void;
}) {
  // Read in the browser only, so the server-rendered page matches.
  const [zone, setZone] = useState("");
  useEffect(() => setZone(browserTimeZone()), []);
  if (intervalMinutes < 1440) return null;
  const valid = !runAt || /^([01]?\d|2[0-3]):[0-5]\d$/.test(runAt.trim());
  return (
    <s-grid gridTemplateColumns={intervalMinutes >= 10080 ? "1fr 1fr" : "1fr"} gap="base" alignItems="start">
      {intervalMinutes >= 10080 ? (
        <s-select label="Day" value={String(weekday)} onChange={(ev: any) => onChange({ weekday: Number(ev.currentTarget.value) })}>
          {DAYS.map((d, i) => (
            <s-option key={d} value={String(i)}>
              {d}
            </s-option>
          ))}
        </s-select>
      ) : null}
      <s-text-field
        label="Time (optional)"
        placeholder="07:30"
        value={runAt}
        error={valid ? undefined : "Use 24-hour HH:MM, for example 07:30"}
        details={`Runs at this time${zone ? ` (${zone} time)` : ""}. Leave empty to start now and repeat from then.`}
        onInput={(ev: any) => onChange({ runAt: ev.currentTarget.value })}
      />
    </s-grid>
  );
}
