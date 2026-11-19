import { applyDryRun, applyNeeds } from "./jobs.server";

/**
 * A scheduled import set to "hold unusual results" runs as a preview first.
 * A clean preview is applied straight away; one that would create, delete or
 * empty something, has warnings or failing rows, waits for a person.
 */
export function heldConfig(type: string, config: string): string {
  if (type !== "import") return config;
  try {
    const c = JSON.parse(config);
    if (!c?.options?.hold || c.options.dryRun) return config;
    return JSON.stringify({ ...c, options: { ...c.options, dryRun: true }, autoApply: true });
  } catch {
    return config;
  }
}

/** After a held preview: apply it when it is clean; otherwise say why it waits. Returns the reason it is held, if it is. */
export async function settleHeldPreview(shop: string, jobId: string, stats: unknown): Promise<string | null> {
  const n = applyNeeds(stats);
  const reasons = [
    n.creates ? `${n.creates} new item${n.creates === 1 ? "" : "s"}` : "",
    n.deletes ? `${n.deletes} deletion${n.deletes === 1 ? "" : "s"}` : "",
    n.clearing ? `${n.clearing} with emptied fields` : "",
    n.warned ? `${n.warned} with warnings` : "",
    n.failing ? `${n.failing} that would fail` : "",
    n.skippedSheets.length ? `${n.skippedSheets.length} sheet${n.skippedSheets.length === 1 ? "" : "s"} not recognised` : "",
  ].filter(Boolean);
  if (reasons.length) return `Held for approval: ${reasons.join(", ")}. Open the preview, choose what to include and apply it.`;
  if (n.changes) await applyDryRun(shop, jobId, "trusted");
  return null;
}

