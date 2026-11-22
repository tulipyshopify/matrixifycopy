import type { ReactNode } from "react";

/**
 * Small pieces shared by the app's screens: line icons drawn in the app's own
 * style, the two-or-three-way switch between sibling pages, and the action
 * tiles of the home screen.
 */

const PATHS: Record<string, ReactNode> = {
  import: (
    <>
      <path d="M12 3v11" />
      <path d="m7.5 10 4.5 4.5L16.5 10" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  export: (
    <>
      <path d="M12 15V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  bolt: <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" />,
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M3 15h18M9 4v16" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  heart: <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4 3 19.5h18L12 4Z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  undo: (
    <>
      <path d="M8 5 4 9l4 4" />
      <path d="M4 9h10a5.5 5.5 0 0 1 0 11H9" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.5-5.8" />
      <path d="M4 5v4h4M12 8v4.5l3 1.8" />
    </>
  ),
  arrow: <path d="M5 12h14m-5.5-5.5L19 12l-5.5 5.5" />,
  sparkle: <path d="M12 3.5 13.8 9 19.5 11l-5.7 2L12 18.5 10.2 13 4.5 11l5.7-2L12 3.5Z" />,
};

export function Icon({ name, size = 20 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name] ?? null}
    </svg>
  );
}

/** A switch between pages that belong together ("Quick changes | Edit in a table"). */
export function SubNav({ items, current }: { items: Array<{ href: string; label: string }>; current: string }) {
  return (
    <nav className="bp-seg" aria-label="Section">
      {items.map((i) => (
        <a key={i.href} href={i.href} className={i.href === current ? "bp-seg-on" : ""} aria-current={i.href === current ? "page" : undefined}>
          {i.label}
        </a>
      ))}
    </nav>
  );
}

export const EDIT_PAGES = [
  { href: "/app/tasks", label: "Quick changes" },
  { href: "/app/edit", label: "Edit in a table" },
];
export const JOB_PAGES = [
  { href: "/app/jobs", label: "Jobs" },
  { href: "/app/history", label: "Change history" },
];

/** One of the home screen's ways in. */
export function ActionTile({ href, icon, title, note, primary }: { href: string; icon: string; title: string; note: string; primary?: boolean }) {
  return (
    <a href={href} className={`bp-act${primary ? " bp-act-primary" : ""}`}>
      <span className="bp-act-icon">
        <Icon name={icon} />
      </span>
      <span className="bp-act-text">
        <b>{title}</b>
        <span>{note}</span>
      </span>
      <span className="bp-act-go">
        <Icon name="arrow" size={16} />
      </span>
    </a>
  );
}

/** A status figure on the home screen: what it is, how it stands, and where to act on it. */
export function StatTile({ href, icon, label, value, note, tone = "idle" }: { href: string; icon: string; label: string; value: string; note?: string; tone?: "ok" | "warn" | "bad" | "idle" }) {
  return (
    <a href={href} className={`bp-stat bp-stat-${tone}`}>
      <span className="bp-stat-icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="bp-stat-body">
        <span className="bp-stat-label">{label}</span>
        <span className="bp-stat-value">{value}</span>
        {note ? <span className="bp-stat-note">{note}</span> : null}
      </span>
    </a>
  );
}

/** An empty list, said kindly, with the way to fill it. */
export function EmptyState({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="bp-empty">
      <span className="bp-empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <b>{title}</b>
      <div>{children}</div>
    </div>
  );
}
