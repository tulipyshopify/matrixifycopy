import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client as FtpClient } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";
import { safeName } from "./storage.server";

/**
 * Rewrites share links of common file hosts into direct download links.
 * Google Sheets are exported as XLSX so every tab comes through.
 */
export function directDownloadUrl(url: string): string {
  const u = new URL(url);
  // "Publish to web" links (/spreadsheets/d/e/<id>/pub?output=csv) already
  // download a file; only the web-page form needs an output format.
  if (u.hostname === "docs.google.com" && u.pathname.startsWith("/spreadsheets/d/e/")) {
    if (u.pathname.endsWith("/pubhtml")) u.pathname = u.pathname.replace(/\/pubhtml$/, "/pub");
    if (!u.searchParams.get("output")) u.searchParams.set("output", "xlsx");
    return u.toString();
  }
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
async function safeFetch(url: string, hops = 5, init: RequestInit = {}): Promise<Response> {
  const origin = new URL(url).origin;
  let current = url;
  for (let i = 0; i <= hops; i++) {
    await assertSafeHost(new URL(current));
    // Credentials are never forwarded to another host on a redirect.
    const res = await fetch(current, { ...(new URL(current).origin === origin ? init : {}), redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

/** Protocols an import can be read from, and an export result uploaded to. */
export const SOURCE_PROTOCOLS = ["http:", "https:", "ftp:", "ftps:", "sftp:", "webdav:", "webdavs:", "dav:", "davs:"];
export const UPLOAD_PROTOCOLS = ["ftp:", "ftps:", "sftp:", "webdav:", "webdavs:", "dav:", "davs:"];

const isWebDav = (url: URL) => ["webdav:", "webdavs:", "dav:", "davs:"].includes(url.protocol);

/** webdav(s)://user:pass@host/path -> the http(s) URL and its Basic auth header. */
export function webDavRequest(url: URL): { href: string; headers: Record<string, string> } {
  const secure = url.protocol === "webdavs:" || url.protocol === "davs:";
  const http = new URL(`${secure ? "https" : "http"}://${url.host}${url.pathname}${url.search}`);
  const headers: Record<string, string> = {};
  if (url.username) {
    headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
  }
  return { href: http.toString(), headers };
}

/**
 * Downloads an import file from http(s), ftp(s), sftp or WebDAV into `dir`.
 * Returns the local path and the original file name (used to detect the entity
 * of CSV files).
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
  if (isWebDav(url)) {
    const { href, headers } = webDavRequest(url);
    const res = await safeFetch(href, 5, { headers });
    if (res.status === 401 || res.status === 403) throw new Error("WebDAV download failed: the user name or password was refused");
    if (!res.ok || !res.body) throw new Error(`WebDAV download failed: HTTP ${res.status}`);
    const name = fileNameFor(href, res.headers.get("content-type"), res.headers.get("content-disposition"));
    const file = path.join(dir, `input-${name}`);
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(file));
    return { file, name };
  }
  if (url.protocol === "ftp:" || url.protocol === "ftps:" || url.protocol === "sftp:") {
    const name = safeName(decodeURIComponent(url.pathname.split("/").pop() || "import.csv"));
    const file = path.join(dir, `input-${name}`);
    await assertSafeHost(url);
    if (url.protocol === "sftp:") await withSftp(url, (c) => c.fastGet(decodeURIComponent(url.pathname), file));
    else await withFtp(url, (c) => c.downloadTo(file, decodeURIComponent(url.pathname)));
    return { file, name };
  }
  throw new Error(`Unsupported source protocol ${url.protocol}`);
}

/** Uploads a result file to an ftp(s), sftp or WebDAV URL; a URL ending in "/" keeps the file name. */
export async function uploadResult(file: string, target: string): Promise<string> {
  const url = new URL(target);
  if (!UPLOAD_PROTOCOLS.includes(url.protocol)) throw new Error("Upload target must be ftp://, ftps://, sftp:// or webdav(s)://");
  await assertSafeHost(url);
  if (url.pathname.endsWith("/") || !url.pathname) url.pathname = `${url.pathname || "/"}${encodeURIComponent(path.basename(file))}`;
  const remote = decodeURIComponent(url.pathname);
  if (isWebDav(url)) {
    const { href, headers } = webDavRequest(url);
    const put = () =>
      fetch(href, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: fs.readFileSync(file), redirect: "manual" });
    let res = await put();
    // 409 = a folder on the way doesn't exist yet: create the folders, then retry once.
    if (res.status === 409) {
      const parts = new URL(href).pathname.split("/").filter(Boolean).slice(0, -1);
      let dirPath = "";
      for (const part of parts) {
        dirPath += `/${part}`;
        await fetch(new URL(`${dirPath}/`, href), { method: "MKCOL", headers, redirect: "manual" });
      }
      res = await put();
    }
    if (res.status === 401 || res.status === 403) throw new Error("WebDAV upload failed: the user name or password was refused");
    if (!res.ok) throw new Error(`WebDAV upload failed: HTTP ${res.status}`);
    return remote;
  }
  if (url.protocol === "sftp:") {
    await withSftp(url, async (c) => {
      const folder = path.posix.dirname(remote);
      if (folder !== "/" && folder !== "." && !(await c.exists(folder))) await c.mkdir(folder, true);
      await c.fastPut(file, remote);
    });
    return remote;
  }
  await withFtp(url, async (c) => {
    await c.ensureDir(path.posix.dirname(remote));
    await c.uploadFrom(file, path.posix.basename(remote));
  });
  return remote;
}

/** Password sign-in only (sftp://user:password@host[:port]/path). */
async function withSftp(url: URL, fn: (c: SftpClient) => Promise<unknown>) {
  if (!url.username) throw new Error("SFTP needs a user name and password in the link: sftp://user:password@host/path");
  const client = new SftpClient();
  try {
    await client.connect({
      host: url.hostname,
      port: url.port ? Number(url.port) : 22,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      readyTimeout: 30_000,
    });
    await fn(client);
  } catch (e: any) {
    if (/authentication/i.test(e?.message ?? "")) throw new Error("SFTP sign-in failed: the user name or password was refused");
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
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

/**
 * Checks that an image link can be loaded and really is an image, before it
 * is handed to Shopify (which would attach a broken placeholder and say
 * nothing). Returns the problem in plain words, or null when the link is fine
 * or can't be judged (a server that refuses the check is given the benefit).
 */
export async function checkImageUrl(url: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "is not a valid link";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "is not a web link (it must start with https://)";
  try {
    let res = await safeFetch(url, 5, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    // Some servers don't answer HEAD: ask for the first bytes instead.
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await safeFetch(url, 5, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(15_000) });
      await res.body?.cancel().catch(() => {});
    }
    if (res.status === 404 || res.status === 410) return `can't be loaded: the link answers "not found" (HTTP ${res.status})`;
    if (res.status === 401 || res.status === 403) return `can't be loaded: the link needs a sign-in (HTTP ${res.status}), which Shopify doesn't have`;
    if (res.status >= 400) return res.status >= 500 ? null : `can't be loaded (HTTP ${res.status})`;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !type.startsWith("image/") && !type.startsWith("application/octet-stream") && !type.startsWith("binary/")) {
      return `is not an image: the link returns ${type.split(";")[0]}`;
    }
    return null;
  } catch (e: any) {
    if (/private address/i.test(e?.message ?? "")) return "points to a private address, which Shopify can't reach";
    if (e?.cause?.code === "ENOTFOUND") return "can't be loaded: the website in the link doesn't exist";
    return null;
  }
}
