import crypto from "node:crypto";
import prisma from "../../db.server";
import { createKey, revokeKey } from "./keys.server";

/**
 * Sign-in for assistants (MCP clients such as Claude and ChatGPT) without a
 * key in the connector address: OAuth 2.1 with PKCE and dynamic client
 * registration, as the MCP authorization spec asks.
 *
 * The step where "the user signs in" can't be an ordinary login page, because
 * a store's staff sign in through Shopify, inside its admin. So the consent
 * page shows a short code, and the merchant approves that code in the app's
 * Settings. Only then does the assistant get a token: an ordinary access key,
 * preview-only, that expires and is renewed with a refresh token.
 */

export const TOKEN_DAYS = 30;
const REQUEST_MINUTES = 15;
const base = () => (process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "");
const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function resourceMetadata() {
  return { resource: `${base()}/mcp`, authorization_servers: [base()], bearer_methods_supported: ["header"], resource_name: "Bulkport" };
}

export function serverMetadata() {
  return {
    issuer: base(),
    authorization_endpoint: `${base()}/oauth/authorize`,
    token_endpoint: `${base()}/oauth/token`,
    registration_endpoint: `${base()}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["bulkport"],
  };
}

const okRedirect = (u: string) => {
  try {
    const url = new URL(u);
    // https, or a local address for desktop tools; never javascript:, data: and the like.
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) || /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !["javascript:", "data:", "file:", "vbscript:", "http:"].includes(url.protocol);
  } catch {
    return false;
  }
};

/** Dynamic client registration: an assistant introduces itself and says where it will be sent back to. */
export async function registerClient(body: any) {
  const uris: unknown = body?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && okRedirect(u))) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a list of https addresses");
  }
  const name = String(body?.client_name ?? "").slice(0, 80);
  const client = await prisma.oAuthClient.create({ data: { name, redirectUris: JSON.stringify(uris) } });
  return {
    client_id: client.id,
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const userCode = () => {
  const b = crypto.randomBytes(8);
  const c = [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

/** Starts a connection request. Returns what the consent page shows. */
export async function startAuthorization(q: URLSearchParams) {
  const client = await prisma.oAuthClient.findUnique({ where: { id: q.get("client_id") ?? "" } });
  if (!client) throw new OAuthError("invalid_client", "Unknown client. The assistant must register first.");
  const redirectUri = q.get("redirect_uri") ?? "";
  if (!(JSON.parse(client.redirectUris) as string[]).includes(redirectUri)) throw new OAuthError("invalid_request", "This redirect address is not one the client registered.");
  // From here on, problems go back to the client at its redirect address.
  if (q.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "Only the authorization code flow is supported");
  const challenge = q.get("code_challenge") ?? "";
  if (!challenge || (q.get("code_challenge_method") ?? "S256") !== "S256") throw new OAuthError("invalid_request", "PKCE with S256 is required");
  const grant = await prisma.oAuthGrant.create({
    data: { clientId: client.id, redirectUri, challenge, state: q.get("state") ?? "", userCode: userCode(), clientName: client.name },
  });
  return { id: grant.id, userCode: grant.userCode, clientName: client.name || "An assistant", minutes: REQUEST_MINUTES };
}

const fresh = (createdAt: Date, now = Date.now()) => now - createdAt.getTime() < REQUEST_MINUTES * 60_000;

export const MAX_WRONG_CODES = 5;
const CODE_LOCK_MS = 15 * 60_000;
const wrongCodes = new Map<string, { start: number; n: number }>();

/** The merchant, in the app's Settings, approves the code shown on the consent page. */
export async function approveConnection(shop: string, code: string, now = Date.now()) {
  // A code is 8 characters: a store that keeps getting it wrong is made to wait, so codes can't be guessed.
  const tries = wrongCodes.get(shop);
  if (tries && now - tries.start < CODE_LOCK_MS && tries.n >= MAX_WRONG_CODES) {
    throw new Error(`Too many wrong codes. Wait ${Math.max(1, Math.ceil((CODE_LOCK_MS - (now - tries.start)) / 60_000))} minutes, then start the connection again in the assistant and use the new code.`);
  }
  const wrong = () => {
    const t = wrongCodes.get(shop);
    if (!t || now - t.start >= CODE_LOCK_MS) wrongCodes.set(shop, { start: now, n: 1 });
    else t.n++;
  };
  const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const grant = clean.length === 8 ? await prisma.oAuthGrant.findUnique({ where: { userCode: `${clean.slice(0, 4)}-${clean.slice(4)}` } }) : null;
  if (!grant || grant.approvedAt || !fresh(grant.createdAt)) wrong();
  else wrongCodes.delete(shop);
  if (!grant || grant.approvedAt || !fresh(grant.createdAt)) throw new Error("That code isn't valid (or is older than 15 minutes). Start the connection again in the assistant and use the new code.");
  await prisma.oAuthGrant.update({ where: { id: grant.id }, data: { shop, approvedAt: new Date() } });
  return grant.clientName || "the assistant";
}

/** Polled by the consent page: once approved, where to send the browser (with a one-time code). */
export async function authorizationStatus(id: string): Promise<{ status: "waiting" | "expired" } | { status: "approved"; redirect: string }> {
  const grant = await prisma.oAuthGrant.findUnique({ where: { id } });
  if (!grant || grant.codeUsedAt || !fresh(grant.createdAt)) return { status: "expired" };
  if (!grant.approvedAt) return { status: "waiting" };
  const code = random(24);
  await prisma.oAuthGrant.update({ where: { id }, data: { codeHash: sha(code) } });
  const to = new URL(grant.redirectUri);
  to.searchParams.set("code", code);
  if (grant.state) to.searchParams.set("state", grant.state);
  return { status: "approved", redirect: to.toString() };
}

async function issue(grant: { id: string; shop: string | null; clientName: string; keyId: string | null }) {
  if (!grant.shop) throw new OAuthError("invalid_grant", "This connection was never approved");
  if (grant.keyId) await revokeKey(grant.shop, grant.keyId);
  // Preview-only, like every assistant connection: exports and import previews, never a change to the store.
  const { key, row } = await createKey(grant.shop, `${grant.clientName || "Assistant"} (signed in)`, "preview", TOKEN_DAYS);
  const refresh = random();
  await prisma.oAuthGrant.update({ where: { id: grant.id }, data: { keyId: row.id, refreshHash: sha(refresh) } });
  return { access_token: key, token_type: "Bearer", expires_in: TOKEN_DAYS * 86400, refresh_token: refresh, scope: "bulkport" };
}

/** The token endpoint: a code (with its PKCE verifier) or a refresh token, for an access token. */
export async function exchangeToken(form: URLSearchParams) {
  const type = form.get("grant_type");
  if (type === "authorization_code") {
    const grant = await prisma.oAuthGrant.findUnique({ where: { codeHash: sha(form.get("code") ?? "") } });
    if (!grant || grant.codeUsedAt || !grant.approvedAt || !fresh(grant.createdAt)) throw new OAuthError("invalid_grant", "The code is not valid or was already used");
    if (form.get("client_id") && form.get("client_id") !== grant.clientId) throw new OAuthError("invalid_grant", "The code belongs to another client");
    if (form.get("redirect_uri") && form.get("redirect_uri") !== grant.redirectUri) throw new OAuthError("invalid_grant", "The redirect address doesn't match");
    const verifier = form.get("code_verifier") ?? "";
    if (crypto.createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) throw new OAuthError("invalid_grant", "The PKCE verifier doesn't match");
    // Used once: a second use fails above.
    const { count } = await prisma.oAuthGrant.updateMany({ where: { id: grant.id, codeUsedAt: null }, data: { codeUsedAt: new Date() } });
    if (!count) throw new OAuthError("invalid_grant", "The code was already used");
    return issue(grant);
  }
  if (type === "refresh_token") {
    const grant = await prisma.oAuthGrant.findUnique({ where: { refreshHash: sha(form.get("refresh_token") ?? "") } });
    if (!grant) throw new OAuthError("invalid_grant", "The refresh token is not valid");
    return issue(grant);
  }
  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

/** Connections the store has approved, for Settings. */
export async function listConnections(shop: string) {
  const grants = await prisma.oAuthGrant.findMany({ where: { shop, keyId: { not: null } }, orderBy: { createdAt: "desc" } });
  const keys = await prisma.apiKey.findMany({ where: { id: { in: grants.map((g) => g.keyId!) }, revokedAt: null } });
  return grants
    .filter((g) => keys.some((k) => k.id === g.keyId))
    .map((g) => ({ id: g.id, name: g.clientName || "Assistant", approvedAt: g.approvedAt, lastUsedAt: keys.find((k) => k.id === g.keyId)?.lastUsedAt ?? null }));
}

export async function removeConnection(shop: string, id: string) {
  const grant = await prisma.oAuthGrant.findFirst({ where: { id, shop } });
  if (!grant) return;
  if (grant.keyId) await revokeKey(shop, grant.keyId);
  await prisma.oAuthGrant.delete({ where: { id } });
}

/** Requests never finished, and their leftovers, are cleared after a day. */
export async function clearStaleRequests(now = new Date()) {
  await prisma.oAuthGrant.deleteMany({ where: { keyId: null, createdAt: { lt: new Date(now.getTime() - 86400_000) } } });
}

export const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
export const oauthJson = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Strict-Transport-Security": "max-age=31536000; includeSubDomains", "X-Content-Type-Options": "nosniff", ...CORS } });
export const oauthFail = (e: unknown) => (e instanceof OAuthError ? oauthJson({ error: e.code, error_description: e.message }, e.status) : oauthJson({ error: "server_error" }, 500));
