import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import prisma from "../../db.server";
import { openSecret, sealSecret } from "./storage.server";

/**
 * Backup copies to the merchant's own Google Drive. The merchant signs in to
 * Google once; Bulkport is given access only to the files it creates there
 * (the "drive.file" permission), keeps the refresh token sealed, and puts
 * each backup in a "Bulkport backups" folder.
 *
 * Needs a Google OAuth client for this server: GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET, with <app address>/google/callback as redirect URI.
 */

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER = "Bulkport backups";
type Fetch = typeof fetch;

export const driveAvailable = () => !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = () => `${(process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "")}/google/callback`;

/** Where to send the merchant to connect their Drive. The state names the store and expires in 15 minutes. */
export function driveConnectUrl(shop: string, now = Date.now()): string {
  const state = sealSecret(JSON.stringify({ shop, exp: now + 15 * 60_000 }))!;
  const q = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? "", redirect_uri: redirectUri(), response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export function shopFromState(state: string, now = Date.now()): string {
  let parsed: { shop?: string; exp?: number } = {};
  try {
    parsed = JSON.parse(openSecret(state) ?? "{}");
  } catch {
    parsed = {};
  }
  if (!parsed.shop || !parsed.exp || parsed.exp < now) throw new Error("This sign-in link has expired. Start again from the Backups page.");
  return parsed.shop;
}

async function token(body: Record<string, string>, f: Fetch): Promise<any> {
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", ...body }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error === "invalid_grant" ? "Google no longer accepts this connection. Connect Google Drive again on the Backups page." : `Google sign-in failed (${data.error_description || data.error || res.status})`);
  return data;
}

/** Finishes the sign-in: keeps the refresh token and makes the backups folder. */
export async function connectDrive(code: string, state: string, f: Fetch = fetch): Promise<string> {
  const shop = shopFromState(state);
  const t = await token({ code, grant_type: "authorization_code", redirect_uri: redirectUri() }, f);
  if (!t.refresh_token) throw new Error("Google did not give a lasting permission. Remove Bulkport under your Google account's third-party access, then connect again.");
  const res = await f("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder" }),
  });
  const folder: any = await res.json().catch(() => ({}));
  if (!res.ok || !folder.id) throw new Error(`Could not make the "${FOLDER}" folder in Google Drive (${folder.error?.message ?? res.status})`);
  const data = { driveToken: sealSecret(t.refresh_token), driveFolder: folder.id as string };
  await prisma.shopSetting.upsert({ where: { shop }, create: { shop, ...data }, update: data });
  return shop;
}

export async function driveConnected(shop: string): Promise<boolean> {
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { driveToken: true } });
  return !!s?.driveToken;
}

export async function disconnectDrive(shop: string) {
  await prisma.shopSetting.updateMany({ where: { shop }, data: { driveToken: null, driveFolder: null } });
}

/** Uploads a file to the store's Drive folder. Returns false when no Drive is connected. */
export async function uploadToDrive(shop: string, file: string, f: Fetch = fetch): Promise<boolean> {
  const s = await prisma.shopSetting.findUnique({ where: { shop }, select: { driveToken: true, driveFolder: true } });
  const refresh = openSecret(s?.driveToken);
  if (!refresh) return false;
  const { access_token } = await token({ refresh_token: refresh, grant_type: "refresh_token" }, f);
  const size = (await fs.promises.stat(file)).size;
  // A resumable upload: announce the file, then send it to the address Google gives back.
  const start = await f("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(size) },
    body: JSON.stringify({ name: path.basename(file), ...(s?.driveFolder ? { parents: [s.driveFolder] } : {}) }),
  });
  const location = start.headers.get("location");
  if (!start.ok || !location) {
    const err: any = await start.json().catch(() => ({}));
    throw new Error(start.status === 404 ? `The "${FOLDER}" folder is no longer in your Google Drive. Connect Google Drive again on the Backups page.` : `Google Drive refused the upload (${err.error?.message ?? start.status})`);
  }
  const put = await f(location, { method: "PUT", headers: { "Content-Length": String(size) }, body: Readable.toWeb(fs.createReadStream(file)) as any, duplex: "half" } as RequestInit);
  if (!put.ok) throw new Error(`Google Drive did not take the file (HTTP ${put.status})`);
  return true;
}
