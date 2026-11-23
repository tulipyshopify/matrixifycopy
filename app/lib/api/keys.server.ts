import crypto from "node:crypto";
import prisma from "../../db.server";

/**
 * Access keys for the API, MCP server, CLI and Sheets add-on. A key belongs to
 * one store. Only its SHA-256 hash is stored, so a key can be shown once.
 */

export const KEY_PREFIX = "bp_";
export const MAX_KEYS = 20;

const hashKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

export type KeyScope = "read" | "preview" | "full";
export const EXPIRY_CHOICES = [30, 90, 365, 0];
/** An assistant's sign-in (ChatGPT, Claude) left unused this long stops working: removing the app over there doesn't tell us. */
export const UNUSED_SIGN_IN_DAYS = 14;
export const SIGNED_IN = "An assistant's sign-in";

/**
 * `scope`: "read" exports and reads only; "preview" also makes import
 * previews; "full" can also import for real. `expiresInDays` 0 = no expiry.
 * (A boolean is still accepted for the scope: true = full, false = preview.)
 */
export async function createKey(shop: string, name: string, scopeOrCanImport: KeyScope | boolean, expiresInDays = 0, more: { entities?: string[] | null; createdBy?: string } = {}) {
  const scope: KeyScope = typeof scopeOrCanImport === "boolean" ? (scopeOrCanImport ? "full" : "preview") : scopeOrCanImport;
  const canImport = scope === "full";
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error("Give the key a name, so you can tell what uses it");
  if ((await prisma.apiKey.count({ where: { shop, revokedAt: null } })) >= MAX_KEYS) {
    throw new Error(`A store can have ${MAX_KEYS} keys. Revoke one you no longer use.`);
  }
  const key = KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
  const row = await prisma.apiKey.create({
    data: { shop, name: clean, prefix: key.slice(0, 9), hash: hashKey(key), canImport, readOnly: scope === "read", entities: more.entities?.length ? [...new Set(more.entities)].join(",") : null, createdBy: (more.createdBy ?? "").slice(0, 80), expiresAt: expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86400_000) : null },
  });
  return { key, row };
}

export function listKeys(shop: string) {
  return prisma.apiKey.findMany({ where: { shop, revokedAt: null }, orderBy: { createdAt: "desc" } });
}

export async function revokeKey(shop: string, id: string) {
  await prisma.apiKey.updateMany({ where: { id, shop, revokedAt: null }, data: { revokedAt: new Date() } });
}

/**
 * A person revokes a key in Settings. For the key of a signed-in assistant
 * this ends the sign-in too: without that, the assistant would quietly get a
 * new key the next time it asked.
 */
export async function revokeKeyAndSignIn(shop: string, id: string) {
  await revokeKey(shop, id);
  await prisma.oAuthGrant.deleteMany({ where: { shop, keyId: id } });
}

export interface KeyAuth {
  shop: string;
  keyId: string;
  name: string;
  canImport: boolean;
  /** Exports and reading only. */
  readOnly: boolean;
  /** The data types the key is limited to; null or absent = all. */
  entities?: string[] | null;
}

/** Who may create full keys in a shop: the listed people, or anyone while the list is empty. */
export async function keyAdmins(shop: string): Promise<string[]> {
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { keyAdmins: true } });
  return (s?.keyAdmins ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

export function mayCreateFullKeys(admins: string[], user: string): boolean {
  return !admins.length || (!!user && admins.includes(user));
}

/** Changes the list. Only someone on it may, once it has anyone on it. */
export async function setKeyAdmins(shop: string, user: string, next: string[]) {
  const now = await keyAdmins(shop);
  if (!user) throw new Error("Shopify did not say who you are, so this can't be changed from here. Open the app from the Shopify admin and try again.");
  if (!mayCreateFullKeys(now, user)) throw new Error("Only the people who may create full keys can change who they are.");
  const clean = [...new Set(next.map((x) => x.trim()).filter((x) => /^\d{1,20}$/.test(x)))].slice(0, 30);
  // Whoever restricts it stays on the list: nobody locks everyone out by accident.
  if (clean.length && !clean.includes(user)) clean.unshift(user);
  const value = clean.join(",");
  await prisma.shopSetting.upsert({ where: { shop }, create: { shop, keyAdmins: value }, update: { keyAdmins: value } });
  return clean;
}

/** Requests per key per minute; a runaway script or agent can't flood the app. */
const RATE_LIMIT = Number(process.env.API_RATE_LIMIT ?? 120);
const hits = new Map<string, { start: number; n: number }>();

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Wrong keys allowed from one address in FAIL_WINDOW before further wrong ones are turned away unchecked. */
export const MAX_FAILURES = 10;
const FAIL_WINDOW = 5 * 60_000;
const failures = new Map<string, { start: number; n: number }>();

/** The caller's address, as the proxy in front of the app reports it. */
export function callerAddress(request: Request): string {
  return (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

function failed(from: string | undefined, now: number): never {
  if (from) {
    const f = failures.get(from);
    if (!f || now - f.start >= FAIL_WINDOW) failures.set(from, { start: now, n: 1 });
    else f.n++;
    if (failures.size > 5000) for (const [k, v] of failures) if (now - v.start >= FAIL_WINDOW) failures.delete(k);
  }
  throw new ApiError(401, "Missing or invalid access key");
}

/**
 * Looks a key up. Throws ApiError 401 (unknown or revoked) or 429 (too many
 * requests, or too many wrong keys from the caller's address `from`).
 */
export async function checkKey(key: string | null | undefined, now = Date.now(), from?: string): Promise<KeyAuth> {
  const f = from ? failures.get(from) : undefined;
  const locked = !!f && now - f.start < FAIL_WINDOW && f.n >= MAX_FAILURES;
  if (!key || !key.startsWith(KEY_PREFIX) || key.length < 40) {
    if (locked) throw new ApiError(429, "Too many wrong access keys from this address. Wait a few minutes and try again.");
    return failed(key ? from : undefined, now);
  }
  const row = await prisma.apiKey.findUnique({ where: { hash: hashKey(key) } });
  if (!row || row.revokedAt) {
    // After repeated wrong keys the answer no longer says whether this one exists.
    if (locked) throw new ApiError(429, "Too many wrong access keys from this address. Wait a few minutes and try again.");
    return failed(from, now);
  }
  if (row.expiresAt && row.expiresAt.getTime() < now) throw new ApiError(401, "This access key has expired. Create a new one in the app's Settings.");
  if ((row.createdBy === SIGNED_IN || / \(signed in\)$/.test(row.name)) && now - (row.lastUsedAt ?? row.createdAt).getTime() > UNUSED_SIGN_IN_DAYS * 86400_000) {
    await prisma.apiKey.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date(now) } }).catch(() => {});
    await prisma.oAuthGrant.deleteMany({ where: { keyId: row.id } }).catch(() => {});
    throw new ApiError(401, `This sign-in was not used for ${UNUSED_SIGN_IN_DAYS} days and has ended. Connect the assistant to the shop again.`);
  }
  const h = hits.get(row.id);
  if (!h || now - h.start >= 60_000) hits.set(row.id, { start: now, n: 1 });
  else if (++h.n > RATE_LIMIT) throw new ApiError(429, "Too many requests. Wait a minute and try again.");
  // "Last used" only needs to be roughly right; skip the write when recent.
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > 60_000) {
    await prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } }).catch(() => {});
  }
  return { shop: row.shop, keyId: row.id, name: row.name, canImport: row.canImport, readOnly: row.readOnly, entities: row.entities ? row.entities.split(",").filter(Boolean) : null };
}

/** The key from "Authorization: Bearer bp_…". */
export function bearerKey(request: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}
