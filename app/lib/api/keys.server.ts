import crypto from "node:crypto";
import prisma from "../../db.server";

/**
 * Access keys for the API, MCP server, CLI and Sheets add-on. A key belongs to
 * one store. Only its SHA-256 hash is stored, so a key can be shown once.
 */

export const KEY_PREFIX = "bp_";
export const MAX_KEYS = 20;

const hashKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

export async function createKey(shop: string, name: string, canImport: boolean) {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error("Give the key a name, so you can tell what uses it");
  if ((await prisma.apiKey.count({ where: { shop, revokedAt: null } })) >= MAX_KEYS) {
    throw new Error(`A store can have ${MAX_KEYS} keys. Revoke one you no longer use.`);
  }
  const key = KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
  const row = await prisma.apiKey.create({
    data: { shop, name: clean, prefix: key.slice(0, 9), hash: hashKey(key), canImport },
  });
  return { key, row };
}

export function listKeys(shop: string) {
  return prisma.apiKey.findMany({ where: { shop, revokedAt: null }, orderBy: { createdAt: "desc" } });
}

export async function revokeKey(shop: string, id: string) {
  await prisma.apiKey.updateMany({ where: { id, shop, revokedAt: null }, data: { revokedAt: new Date() } });
}

export interface KeyAuth {
  shop: string;
  keyId: string;
  name: string;
  canImport: boolean;
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

/** Looks a key up. Throws ApiError 401 (unknown or revoked) or 429 (too many requests). */
export async function checkKey(key: string | null | undefined, now = Date.now()): Promise<KeyAuth> {
  if (!key || !key.startsWith(KEY_PREFIX) || key.length < 40) throw new ApiError(401, "Missing or invalid access key");
  const row = await prisma.apiKey.findUnique({ where: { hash: hashKey(key) } });
  if (!row || row.revokedAt) throw new ApiError(401, "Missing or invalid access key");
  const h = hits.get(row.id);
  if (!h || now - h.start >= 60_000) hits.set(row.id, { start: now, n: 1 });
  else if (++h.n > RATE_LIMIT) throw new ApiError(429, "Too many requests. Wait a minute and try again.");
  // "Last used" only needs to be roughly right; skip the write when recent.
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > 60_000) {
    await prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } }).catch(() => {});
  }
  return { shop: row.shop, keyId: row.id, name: row.name, canImport: row.canImport };
}

/** The key from "Authorization: Bearer bp_…". */
export function bearerKey(request: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}
