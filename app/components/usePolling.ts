import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

/**
 * Reloads the page's data every `ms` while `active` is true (a job is running).
 * A reload that never comes back must not stop the polling for good, so after
 * a while a new one is started regardless.
 */
export function usePolling(active: boolean, ms = 2000) {
  const revalidator = useRevalidator();
  const latest = useRef(revalidator);
  latest.current = revalidator;
  useEffect(() => {
    if (!active) return;
    let busySince = 0;
    const t = setInterval(() => {
      const r = latest.current;
      if (r.state !== "idle") {
        busySince ||= Date.now();
        if (Date.now() - busySince < 15_000) return;
      }
      busySince = 0;
      void r.revalidate();
    }, ms);
    return () => clearInterval(t);
  }, [active, ms]);
}
