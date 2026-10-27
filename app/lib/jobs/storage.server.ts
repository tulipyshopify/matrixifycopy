import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Job files live on local disk under STORAGE_DIR (default ./storage). */
export const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR ?? "storage");

/** Days to keep job files before cleanup. */
export const RETENTION_DAYS = Number(process.env.FILE_RETENTION_DAYS ?? 30);

function shopDir(shop: string) {
  return path.join(STORAGE_DIR, shop.replace(/[^a-z0-9.-]/gi, "_"));
}

export function jobDir(shop: string, jobId: string): string {
  const dir = path.join(shopDir(shop), jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tmpDir(): string {
  const dir = path.join(STORAGE_DIR, "_tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Makes sure a stored path is inside STORAGE_DIR before reading it. */
export function resolveStored(file: string): string {
  const abs = path.resolve(file);
  if (!abs.startsWith(STORAGE_DIR + path.sep)) throw new Error("Invalid file path");
  return abs;
}

/** Safe file name for user supplied names. */
export function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, "_").trim();
  return base || "file";
}

/** Stores an uploaded web File for a job and returns its path. */
export async function saveUpload(shop: string, jobId: string, file: File): Promise<string> {
  const dest = path.join(jobDir(shop, jobId), `input-${safeName(file.name)}`);
  const out = fs.createWriteStream(dest);
  const reader = file.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise((r) => out.once("drain", r));
    }
  } finally {
    await new Promise<void>((r) => out.end(r));
  }
  return dest;
}

// --- Signed download links ---------------------------------------------------
// Embedded app pages authenticate with session tokens, which a plain browser
// download can't send. The app hands out short-lived HMAC signed links instead.

function secret() {
  const s = process.env.SHOPIFY_API_SECRET || process.env.DOWNLOAD_SECRET;
  if (!s) throw new Error("SHOPIFY_API_SECRET is not set");
  return s;
}

function sign(payload: string) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function signedDownloadUrl(jobId: string, kind: "result" | "input", ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = sign(`${jobId}:${kind}:${exp}`);
  return `/download/${jobId}?kind=${kind}&exp=${exp}&sig=${sig}`;
}

export function verifyDownload(jobId: string, kind: string, exp: string, sig: string): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(`${jobId}:${kind}:${exp}`));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Deletes job folders older than the retention period. */
export async function cleanupOldFiles(): Promise<number> {
  if (!fs.existsSync(STORAGE_DIR)) return 0;
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  let removed = 0;
  for (const shop of await fs.promises.readdir(STORAGE_DIR)) {
    const sdir = path.join(STORAGE_DIR, shop);
    if (!(await fs.promises.stat(sdir)).isDirectory()) continue;
    for (const job of await fs.promises.readdir(sdir)) {
      const jdir = path.join(sdir, job);
      const st = await fs.promises.stat(jdir);
      if (st.mtimeMs < cutoff) {
        await fs.promises.rm(jdir, { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}
