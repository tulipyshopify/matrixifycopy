import prisma from "../../db.server";
import { jobHealth, isDryRunConfig } from "./health";

/**
 * Failure alerts by email. Sending needs SMTP_URL on the server, e.g.
 * smtps://user:password@smtp.example.com:465, and ALERT_FROM (the sender).
 * Without them, problems are still flagged in the app; nothing is emailed.
 */

export function emailConfigured(): boolean {
  return !!process.env.SMTP_URL;
}

export type Mailer = (msg: { to: string; subject: string; text: string }) => Promise<void>;

let mailer: Mailer | null = null;

async function defaultMailer(): Promise<Mailer | null> {
  if (!process.env.SMTP_URL) return null;
  if (!mailer) {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(process.env.SMTP_URL);
    const from = process.env.ALERT_FROM || "Bulkport <no-reply@localhost>";
    mailer = async ({ to, subject, text }) => {
      await transport.sendMail({ from, to, subject, text });
    };
  }
  return mailer;
}

export async function getSettings(shop: string) {
  return (await prisma.shopSetting.findUnique({ where: { shop } })) ?? { shop, alertEmail: null as string | null, alertScope: "scheduled" };
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Saves the alert address (blank switches emails off) and which jobs alert. */
export async function saveSettings(shop: string, input: { alertEmail?: string; alertScope?: string }) {
  const emails = (input.alertEmail ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  for (const e of emails) if (!EMAIL.test(e)) throw new Error(`"${e}" is not an email address`);
  if (emails.length > 5) throw new Error("At most 5 addresses");
  const alertScope = input.alertScope === "all" ? "all" : "scheduled";
  const alertEmail = emails.length ? emails.join(", ") : null;
  return prisma.shopSetting.upsert({
    where: { shop },
    create: { shop, alertEmail, alertScope },
    update: { alertEmail, alertScope },
  });
}

/** App address of a job, for links in emails. */
function jobLink(shop: string, jobId: string): string {
  const handle = shop.replace(/\.myshopify\.com$/, "");
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  return `https://admin.shopify.com/store/${handle}/apps/${apiKey}/app/jobs/${jobId}`;
}

/**
 * Emails the store's alert address when a finished job failed or had
 * problems. Each job alerts at most once. Returns true when an email went out.
 */
export async function alertIfNeeded(jobId: string, send?: Mailer): Promise<boolean> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.alertedAt) return false;
  const dryRun = isDryRunConfig(job.config);
  const health = jobHealth({ ...job, dryRun });
  // Stopped on purpose: no alert.
  if (health.level === "ok" || health.level === "running" || job.status === "cancelled") return false;
  const settings = await getSettings(job.shop);
  if (!settings.alertEmail) return false;
  if (settings.alertScope !== "all" && !job.scheduleId) return false;
  const deliver = send ?? (await defaultMailer());
  if (!deliver) return false;

  const schedule = job.scheduleId ? await prisma.schedule.findUnique({ where: { id: job.scheduleId } }) : null;
  const what = `${dryRun ? "Preview" : job.type === "export" ? "Export" : "Import"}${schedule && schedule.intervalMinutes > 0 ? ` "${schedule.name}"` : job.inputName ? ` of ${job.inputName}` : ""}`;
  const subject = `Bulkport: ${what} ${job.status === "failed" ? "failed" : "had problems"} (${job.shop.replace(/\.myshopify\.com$/, "")})`;
  const text = [
    `${what} on ${job.shop} ${job.status === "failed" ? "failed" : "finished with problems"}.`,
    "",
    health.summary,
    "",
    `Open the job: ${jobLink(job.shop, job.id)}`,
    job.type === "import" && job.status !== "failed" ? "The results file there has the reason on every row that failed." : "",
    "",
    "You get this email because alerts are switched on in Bulkport's Settings.",
  ]
    .filter((l, i, a) => l || a[i - 1])
    .join("\n");
  try {
    await deliver({ to: settings.alertEmail, subject, text });
  } catch (e: any) {
    console.error(`[alerts] could not email ${job.shop} about job ${job.id}: ${e?.message ?? e}`);
    return false;
  }
  await prisma.job.update({ where: { id: job.id }, data: { alertedAt: new Date() } });
  return true;
}

/** Sends a test email to the store's alert address. */
export async function sendTestAlert(shop: string, send?: Mailer) {
  const settings = await getSettings(shop);
  if (!settings.alertEmail) throw new Error("Save an alert email address first");
  const deliver = send ?? (await defaultMailer());
  if (!deliver) throw new Error("Email isn't set up on the server yet (SMTP_URL). Problems are still flagged in the app.");
  await deliver({
    to: settings.alertEmail,
    subject: `Bulkport: test alert (${shop.replace(/\.myshopify\.com$/, "")})`,
    text: "This is a test. Bulkport will email this address when a job fails or finishes with problems.",
  });
}
