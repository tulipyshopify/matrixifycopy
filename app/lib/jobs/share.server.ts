import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import prisma from "../../db.server";
import { applyNeeds, readPreview } from "./jobs.server";
import { jobDir } from "./storage.server";

/**
 * Sharing a preview for a second pair of eyes: a link that shows the preview,
 * read only, to someone without access to the store (a colleague, a client),
 * who can say "approved" or "please change". It never applies anything: only
 * a person in the app can do that.
 */

const SHARE_FILE = "share.json";
export const SHARE_DAYS = 7;
const MAX_REPLIES = 20;
/** Items of each sheet shown on the shared page. */
const SHARED_ITEMS = 300;

export interface ShareReply {
  at: string;
  verdict: "approve" | "changes";
  name: string;
  note: string;
}

interface ShareRecord {
  hash: string;
  createdAt: string;
  expiresAt: string;
  replies: ShareReply[];
}

const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const file = (shop: string, id: string) => path.join(jobDir(shop, id), SHARE_FILE);

async function read(shop: string, id: string): Promise<ShareRecord | null> {
  try {
    return JSON.parse(await fs.promises.readFile(file(shop, id), "utf8")) as ShareRecord;
  } catch {
    return null;
  }
}

const live = (r: ShareRecord | null, now = Date.now()): r is ShareRecord => !!r && new Date(r.expiresAt).getTime() > now;

async function previewJob(shop: string, id: string) {
  const job = await prisma.job.findFirst({ where: { id, shop } });
  let dryRun = false;
  try {
    dryRun = !!JSON.parse(job?.config ?? "{}").options?.dryRun;
  } catch {
    dryRun = false;
  }
  if (!job || job.type !== "import" || !dryRun || job.status !== "finished") throw new Error("Only a finished preview can be shared");
  return job;
}

/** Makes (or replaces) the preview's link. The link is shown once: only its fingerprint is kept. */
export async function createShare(shop: string, id: string, now = Date.now()): Promise<{ path: string; expiresAt: string }> {
  await previewJob(shop, id);
  const token = crypto.randomBytes(24).toString("base64url");
  const old = await read(shop, id);
  const record: ShareRecord = { hash: sha(token), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SHARE_DAYS * 86_400_000).toISOString(), replies: old?.replies ?? [] };
  await fs.promises.writeFile(file(shop, id), JSON.stringify(record));
  return { path: `/share/${id}.${token}`, expiresAt: record.expiresAt };
}

export async function stopShare(shop: string, id: string) {
  const old = await read(shop, id);
  if (!old) return;
  // Replies already given stay on the job's page; the link stops working.
  await fs.promises.writeFile(file(shop, id), JSON.stringify({ ...old, hash: "", expiresAt: new Date(0).toISOString() }));
}

/** For the job's page: whether a link is live, and what was answered. */
export async function shareStatus(shop: string, id: string): Promise<{ active: boolean; expiresAt: string | null; replies: ShareReply[] }> {
  const r = await read(shop, id);
  return { active: live(r), expiresAt: live(r) ? r.expiresAt : null, replies: r?.replies ?? [] };
}

async function open(ref: string) {
  const [id, token] = String(ref ?? "").split(".");
  if (!id || !token || !/^[\w-]+$/.test(id)) return null;
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return null;
  const record = await read(job.shop, id);
  if (!live(record) || !record.hash) return null;
  const given = Buffer.from(sha(token));
  const kept = Buffer.from(record.hash);
  if (given.length !== kept.length || !crypto.timingSafeEqual(given, kept)) return null;
  return { job, record };
}

/** What the shared page shows; null when the link is wrong, stopped or expired. */
export async function sharedPreview(ref: string) {
  const found = await open(ref);
  if (!found) return null;
  const { job, record } = found;
  const sheets = await readPreview(job.shop, job.id);
  const needs = applyNeeds(job.stats);
  return {
    name: job.inputName || job.name || "Import",
    store: job.shop.replace(/\.myshopify\.com$/, ""),
    madeAt: job.finishedAt ?? job.createdAt,
    expiresAt: record.expiresAt,
    totals: { changes: needs.changes, creates: needs.creates, deletes: needs.deletes, unchanged: needs.unchanged, failing: needs.failing },
    sheets: sheets.map((s) => {
      // What matters to a reviewer first: problems, deletions, creations and warnings, then the plain updates.
      const weight = (i: (typeof s.items)[number]) => (i.action === "failed" ? 0 : i.action === "delete" || i.action === "replace" || i.deletes ? 1 : i.action === "create" || i.warnings?.length || i.clears?.length ? 2 : i.action === "none" ? 4 : 3);
      const changing = s.items.filter((i) => i.action !== "none" && i.action !== "skipped");
      return {
        sheet: s.sheet,
        total: s.items.length,
        unchanged: s.items.length - changing.length,
        items: [...changing]
          .sort((a, b) => weight(a) - weight(b) || a.row - b.row)
          .slice(0, SHARED_ITEMS)
          .map((i) => ({ row: i.row, title: i.title || i.item, item: i.item, action: i.action, changes: i.changes.slice(0, 20), more: Math.max(0, i.changes.length - 20), warnings: i.warnings ?? [], errors: i.errors?.length ? i.errors : i.action === "failed" ? [i.message] : [] })),
        more: Math.max(0, changing.length - SHARED_ITEMS),
      };
    }),
    replies: record.replies,
  };
}

/** Records the reviewer's answer on the job. */
export async function replyToShare(ref: string, input: { verdict: string; name: string; note: string }): Promise<ShareReply> {
  const found = await open(ref);
  if (!found) throw new Error("This link no longer works. Ask for a new one.");
  const { job, record } = found;
  if (record.replies.length >= MAX_REPLIES) throw new Error("This preview already has many answers. Ask for a new link.");
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new Error("Enter your name, so the store knows who answered.");
  const reply: ShareReply = { at: new Date().toISOString(), verdict: input.verdict === "approve" ? "approve" : "changes", name, note: String(input.note ?? "").trim().slice(0, 1000) };
  record.replies.push(reply);
  await fs.promises.writeFile(file(job.shop, job.id), JSON.stringify(record));
  const stamp = reply.at.slice(11, 19);
  await prisma.job.update({ where: { id: job.id }, data: { log: `${job.log ?? ""}[${stamp}] Shared preview: ${name} ${reply.verdict === "approve" ? "approved it" : "asked for changes"}${reply.note ? `: "${reply.note.slice(0, 300)}"` : ""}\n` } });
  return reply;
}
