import crypto from "node:crypto";
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
export const UPLOAD_PROTOCOLS = ["ftp:", "ftps:", "sftp:", "webdav:", "webdavs:", "dav:", "davs:", "s3:"];

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
  if (!UPLOAD_PROTOCOLS.includes(url.protocol)) throw new Error("Upload target must be ftp://, ftps://, sftp://, webdav(s):// or s3://");
  await assertSafeHost(url);
  if (url.protocol === "s3:") return uploadS3(file, url);
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

// --- S3-compatible object storage ---------------------------------------------

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac("sha256", key).update(data).digest();
const sha256 = (data: string) => crypto.createHash("sha256").update(data).digest("hex");
const awsEncode = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4 for one request: returns the Authorization header.
 * `headers` must already hold every header to sign (host and x-amz-date included).
 */
export function signV4(opts: { method: string; path: string; query?: string; headers: Record<string, string>; payloadHash: string; accessKey: string; secretKey: string; region: string; service: string }): string {
  const names = Object.keys(opts.headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const amzDate = lower["x-amz-date"];
  const date = amzDate.slice(0, 8);
  const canonical = [opts.method, opts.path, opts.query ?? "", ...names.map((n) => `${n}:${lower[n]}`), "", names.join(";"), opts.payloadHash].join("\n");
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.secretKey}`, date), opts.region), opts.service), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

/** Region of an S3 endpoint: from ?region=, else from an Amazon host name, else "auto" (Google Cloud Storage, R2). */
export function s3Region(url: URL): string {
  const given = url.searchParams.get("region");
  if (given) return given;
  const m = /(?:^|\.)s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(url.hostname);
  if (m) return m[1];
  return url.hostname === "s3.amazonaws.com" ? "us-east-1" : "auto";
}

/**
 * Uploads to S3-compatible storage. The link is
 * s3://ACCESS_KEY:SECRET@endpoint/bucket/folder/ (endpoint: s3.eu-west-2.amazonaws.com,
 * storage.googleapis.com with an HMAC key, an R2 or Backblaze endpoint…).
 */
async function uploadS3(file: string, url: URL): Promise<string> {
  if (!url.username || !url.password) throw new Error("S3 storage needs an access key and a secret (the user name and password fields)");
  let objectPath = decodeURIComponent(url.pathname || "/");
  if (objectPath.split("/").filter(Boolean).length < 1) throw new Error("The S3 link must name a bucket: s3://endpoint/bucket/folder/");
  if (objectPath.endsWith("/")) objectPath += path.basename(file);
  const encodedPath = objectPath.split("/").map(awsEncode).join("/");
  const size = (await fs.promises.stat(file)).size;
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    "x-amz-date": new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""),
  };
  const authorization = signV4({
    method: "PUT",
    path: encodedPath,
    headers,
    payloadHash: "UNSIGNED-PAYLOAD",
    accessKey: decodeURIComponent(url.username),
    secretKey: decodeURIComponent(url.password),
    region: s3Region(url),
    service: "s3",
  });
  const scheme = process.env.S3_INSECURE_FOR_TESTS === "1" ? "http" : "https";
  const res = await fetch(`${scheme}://${url.host}${encodedPath}`, {
    method: "PUT",
    headers: { ...headers, Authorization: authorization, "Content-Length": String(size), "Content-Type": "application/octet-stream" },
    body: Readable.toWeb(fs.createReadStream(file)) as any,
    duplex: "half",
    redirect: "manual",
  } as RequestInit);
  if (res.status === 403) throw new Error("The storage refused the access key or secret, or the key may not write to this bucket (HTTP 403)");
  if (res.status === 404) throw new Error("The storage has no bucket with this name (HTTP 404)");
  if (!res.ok) throw new Error(`The storage answered HTTP ${res.status}${res.status === 301 ? " (the bucket is in another region: add ?region=… to the link)" : ""}`);
  return objectPath;
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

/** Posts JSON to an https address outside the app's own network (used for alert webhooks). */
export async function safePostJson(url: string, body: unknown): Promise<number> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("The address must start with https://");
  await assertSafeHost(u);
  const res = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(15_000) });
  return res.status;
}
