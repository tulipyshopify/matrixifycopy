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

/** Whether this server can send email at all (an SMTP account is set in its environment). */
export const emailAvailable = () => !!process.env.SMTP_URL;

export async function alertEmails(shop: string): Promise<string[]> {
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { alertEmails: true } });
  return splitEmails(s?.alertEmails ?? "");
}

const splitEmails = (v: string) => [...new Set(v.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 10);

export async function saveAlertEmails(shop: string, value: string) {
  const list = splitEmails(value);
  const bad = list.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad) throw new Error(`"${bad}" is not an email address`);
  const alertEmails = list.join(", ");
  await prisma.shopSetting.upsert({ where: { shop }, create: { shop, alertEmails }, update: { alertEmails } });
  return list;
}

async function sendEmail(to: string[], subject: string, text: string): Promise<boolean> {
  if (!emailAvailable() || !to.length) return false;
  const { createTransport } = await import("nodemailer");
  const transport = createTransport(process.env.SMTP_URL!);
  await transport.sendMail({ from: process.env.SMTP_FROM || "Bulkport <no-reply@localhost>", to: to.join(", "), subject, text });
  return true;
}

/**
 * Sends an alert to wherever the store asked for: its Slack/Teams webhook and
 * its email addresses. Resolves to whether anything was accepted. Never
 * throws: an alert must not fail a job.
 */
export async function sendAlert(shop: string, text: string): Promise<boolean> {
  let sent = false;
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { alertWebhook: true, alertEmails: true } }).catch(() => null);
  try {
    const url = openSecret(s?.alertWebhook);
    if (url) {
      const status = await safePostJson(url, { text });
      sent = status >= 200 && status < 300;
    }
  } catch (e) {
    console.error("[alerts] could not post", (e as Error)?.message);
  }
  try {
    if (await sendEmail(splitEmails(s?.alertEmails ?? ""), text.split(". ")[0].slice(0, 140), text)) sent = true;
  } catch (e) {
    console.error("[alerts] could not email", (e as Error)?.message);
  }
  return sent;
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
