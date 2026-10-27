import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client as FtpClient } from "basic-ftp";
import { safeName } from "./storage.server";

/**
 * Rewrites share links of common file hosts into direct download links.
 * Google Sheets are exported as XLSX so every tab comes through.
 */
export function directDownloadUrl(url: string): string {
  const u = new URL(url);
  const sheet = /^\/spreadsheets\/d\/([^/]+)/.exec(u.pathname);
  if (u.hostname === "docs.google.com" && sheet) {
    return `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=xlsx`;
  }
  const driveFile = /^\/file\/d\/([^/]+)/.exec(u.pathname);
  if (u.hostname === "drive.google.com" && driveFile) {
    return `https://drive.google.com/uc?export=download&id=${driveFile[1]}`;
  }
  if (u.hostname.endsWith("dropbox.com")) {
    u.searchParams.set("dl", "1");
    return u.toString();
  }
  return url;
}

/** Guesses a file name with extension for a downloaded file. */
function fileNameFor(url: string, contentType: string | null, disposition: string | null): string {
  const fromDisposition = disposition && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  if (fromDisposition) return safeName(decodeURIComponent(fromDisposition));
  const fromPath = safeName(decodeURIComponent(new URL(url).pathname.split("/").pop() || "import"));
  if (/\.(xlsx|csv|zip|txt)$/i.test(fromPath)) return fromPath;
  if (contentType?.includes("spreadsheetml")) return `${fromPath}.xlsx`;
  if (contentType?.includes("zip")) return `${fromPath}.zip`;
  return `${fromPath}.csv`;
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
}

/** Blocks requests into the app's own network (SSRF), checking resolved IPs. */
async function assertSafeHost(url: URL) {
  if (process.env.ALLOW_PRIVATE_SOURCES === "true") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error(`Refusing to connect to private address ${url.hostname}`);
  }
}

/** fetch() that re-checks the host on every redirect hop. */
async function safeFetch(url: string, hops = 5): Promise<Response> {
  let current = url;
  for (let i = 0; i <= hops; i++) {
    await assertSafeHost(new URL(current));
    const res = await fetch(current, { redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

/**
 * Downloads an import file from http(s) or ftp(s) into `dir`. Returns the local
 * path and the original file name (used to detect the entity of CSV files).
 */
export async function downloadSource(source: string, dir: string): Promise<{ file: string; name: string }> {
  const url = new URL(source);
  if (url.protocol === "http:" || url.protocol === "https:") {
    const res = await safeFetch(directDownloadUrl(source));
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const name = fileNameFor(url.toString(), res.headers.get("content-type"), res.headers.get("content-disposition"));
    const file = path.join(dir, `input-${name}`);
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(file));
    return { file, name };
  }
  if (url.protocol === "ftp:" || url.protocol === "ftps:") {
    const name = safeName(decodeURIComponent(url.pathname.split("/").pop() || "import.csv"));
    const file = path.join(dir, `input-${name}`);
    await assertSafeHost(url);
    await withFtp(url, (c) => c.downloadTo(file, decodeURIComponent(url.pathname)));
    return { file, name };
  }
  throw new Error(`Unsupported source protocol ${url.protocol}`);
}

/** Uploads a result file to an ftp(s):// URL; a URL ending in "/" keeps the file name. */
export async function uploadResult(file: string, target: string): Promise<string> {
  const url = new URL(target);
  await assertSafeHost(url);
  if (url.protocol !== "ftp:" && url.protocol !== "ftps:") throw new Error("Upload target must be ftp:// or ftps://");
  let remote = decodeURIComponent(url.pathname || "/");
  if (remote.endsWith("/")) remote += path.basename(file);
  await withFtp(url, async (c) => {
    await c.ensureDir(path.posix.dirname(remote));
    await c.uploadFrom(file, path.posix.basename(remote));
  });
  return remote;
}

async function withFtp(url: URL, fn: (c: FtpClient) => Promise<unknown>) {
  const client = new FtpClient(60_000);
  try {
    await client.access({
      host: url.hostname,
      port: url.port ? Number(url.port) : 21,
      user: decodeURIComponent(url.username) || "anonymous",
      password: decodeURIComponent(url.password) || "anonymous",
      secure: url.protocol === "ftps:",
    });
    await fn(client);
  } finally {
    client.close();
  }
}

/** Removes credentials from a URL for display/logging. */
export function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return u;
  }
}
