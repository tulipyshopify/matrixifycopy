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

/** Mail domains that are nearly always a slip of the keyboard, and what was meant. */
const DOMAIN_SLIPS: Record<string, string> = { "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmail.co": "gmail.com", "gnail.com": "gmail.com", "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "outlok.com": "outlook.com", "outloo.com": "outlook.com", "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "icloud.co": "icloud.com" };

/** An address that looks mistyped, with what was probably meant; null when none does. */
export function likelyTypo(list: string[]): string | null {
  for (const e of list) {
    const domain = e.split("@")[1] ?? "";
    if (DOMAIN_SLIPS[domain]) return `"${e}" looks mistyped: did you mean ${e.split("@")[0]}@${DOMAIN_SLIPS[domain]}?`;
  }
  return null;
}

/**
 * Sends a test message to the store's alert addresses, so a wrong address or
 * a mail set-up that doesn't deliver shows now and not when an alert matters.
 */
export async function sendTestEmail(shop: string): Promise<string[]> {
  const to = await alertEmails(shop);
  if (!to.length) throw new Error("Save at least one address first.");
  if (!emailAvailable()) throw new Error("Email isn't switched on for this app yet (the server has no mail account set), so no test can be sent. The addresses are saved and will be used once it is.");
  try {
    await sendEmail(to, "Bulkport: test alert", `This is a test from Bulkport for ${shop.replace(/\.myshopify\.com$/, "")}.\n\nIf you are reading it, alerts about failed or held jobs will reach this address. Nothing is wrong with your store.`);
  } catch (e: any) {
    throw new Error(`The test could not be sent: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  return to;
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
