import prisma from "../../db.server";
import { safePostJson } from "./sources.server";
import { openSecret, sealSecret } from "./storage.server";

/**
 * Optional alerts outside the app: when a scheduled job or a backup fails or
 * finishes with problems, a short message is posted to a Slack or Microsoft
 * Teams "incoming webhook" the merchant has pasted in. Off unless set; the
 * home screen's attention banner works either way.
 */

export async function alertWebhookSet(shop: string): Promise<boolean> {
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { alertWebhook: true } });
  return !!s?.alertWebhook;
}

/** Saves (or, with an empty value, removes) the webhook address. It is stored sealed and never shown again. */
export async function saveAlertWebhook(shop: string, url: string) {
  const clean = url.trim();
  if (clean) {
    let u: URL;
    try {
      u = new URL(clean);
    } catch {
      throw new Error("That is not a valid webhook address");
    }
    if (u.protocol !== "https:") throw new Error("The webhook address must start with https://");
  }
  const alertWebhook = clean ? sealSecret(clean) : null;
  await prisma.shopSetting.upsert({ where: { shop }, create: { shop, alertWebhook }, update: { alertWebhook } });
}

/** Posts a message; resolves to whether it was accepted. Never throws: an alert must not fail a job. */
export async function sendAlert(shop: string, text: string): Promise<boolean> {
  try {
    const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { alertWebhook: true } });
    const url = openSecret(s?.alertWebhook);
    if (!url) return false;
    const status = await safePostJson(url, { text });
    return status >= 200 && status < 300;
  } catch (e) {
    console.error("[alerts] could not post", (e as Error)?.message);
    return false;
  }
}

/** The message for a job that needs a look, or null when it needs none (or isn't a kind worth interrupting anyone for). */
export function alertText(job: { shop: string; type: string; kind: string; name: string; scheduled: boolean }, outcome: { status: string; problems: number; summary: string; error?: string | null }): string | null {
  // One-off jobs are watched by the person who started them; unattended ones are not.
  if (!job.scheduled && job.kind !== "backup") return null;
  const failed = outcome.status === "failed";
  if (!failed && !outcome.problems) return null;
  const what = job.kind === "backup" ? "Store backup" : `Scheduled ${job.type}${job.name ? ` "${job.name}"` : ""}`;
  const store = job.shop.replace(/\.myshopify\.com$/, "");
  return `Bulkport, ${store}: ${what} ${failed ? "failed" : "finished with problems"}. ${(outcome.error || outcome.summary || "").slice(0, 400)} Open the app's home screen for details.`.replace(/\s+/g, " ");
}
