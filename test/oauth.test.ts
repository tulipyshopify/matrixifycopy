import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";
process.env.SHOPIFY_APP_URL = "https://bulk.test";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-oauth-"));

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("sign-in for assistants (OAuth for the MCP server)", async () => {
  const { default: prisma } = await import("../app/db.server");
  const oauth = await import("../app/lib/api/oauth.server");
  const { handleMcp } = await import("../app/lib/api/mcp.server");
  const register = await import("../app/routes/oauth.register");
  const tokenRoute = await import("../app/routes/oauth.token");
  const authorize = await import("../app/routes/oauth.authorize");
  const shop = `oauth-${Date.now()}.myshopify.com`;
  const redirect = "https://claude.example/api/mcp/auth_callback";
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const post = (route: any, body: any, type = "application/json") =>
    route.action({ request: new Request("https://bulk.test/x", { method: "POST", headers: { "Content-Type": type }, body: typeof body === "string" ? body : JSON.stringify(body) }), params: {}, context: {} }) as Promise<Response>;
  const mcp = (key: string | null) =>
    handleMcp(new Request("https://bulk.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));

  it("tells an unsigned client where to sign in", async () => {
    const res = await mcp(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://bulk.test/.well-known/oauth-protected-resource"');
    expect(oauth.resourceMetadata()).toMatchObject({ resource: "https://bulk.test/mcp", authorization_servers: ["https://bulk.test"] });
    expect(oauth.serverMetadata()).toMatchObject({
      authorization_endpoint: "https://bulk.test/oauth/authorize",
      token_endpoint: "https://bulk.test/oauth/token",
      registration_endpoint: "https://bulk.test/oauth/register",
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("runs the whole flow: register, show a code, approve it in the app, exchange, use, refresh, disconnect", async () => {
    const reg = await post(register, { client_name: "Claude", redirect_uris: [redirect] });
    expect(reg.status).toBe(201);
    const client = await reg.json();
    expect((await post(register, { redirect_uris: ["javascript:alert(1)"] })).status).toBe(400);

    const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz" });
    const page: Response = await authorize.loader({ request: new Request(`https://bulk.test/oauth/authorize?${q}`), params: {}, context: {} } as any);
    const html = await page.text();
    expect(page.status).toBe(200);
    const userCode = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(html)![1];
    const id = /status\?id=([a-z0-9]+)/.exec(html)![1];
    expect(html).toContain("Connect Claude to Bulkport");
    // A redirect address that wasn't registered is refused on the page, not redirected to.
    const bad = new URLSearchParams(q);
    bad.set("redirect_uri", "https://evil.example/cb");
    expect((await authorize.loader({ request: new Request(`https://bulk.test/oauth/authorize?${bad}`), params: {}, context: {} } as any)).status).toBe(400);

    expect(await oauth.authorizationStatus(id)).toEqual({ status: "waiting" });
    await expect(oauth.approveConnection(shop, "AAAA-AAAA")).rejects.toThrow(/isn't valid/);
    expect(await oauth.approveConnection(shop, userCode.toLowerCase().replace("-", " "))).toBe("Claude");
    await expect(oauth.approveConnection("other.myshopify.com", userCode)).rejects.toThrow(/isn't valid/);
    const status = (await oauth.authorizationStatus(id)) as { status: "approved"; redirect: string };
    const back = new URL(status.redirect);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get("state")).toBe("xyz");
    const code = back.searchParams.get("code")!;

    const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const wrong = await post(tokenRoute, form({ grant_type: "authorization_code", code, code_verifier: "not-the-verifier", client_id: client.client_id, redirect_uri: redirect }), "application/x-www-form-urlencoded");
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("invalid_grant");
    const ok = await post(tokenRoute, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect }), "application/x-www-form-urlencoded");
    const tokens = await ok.json();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 30 * 86400 });
    // The code works once.
    expect((await post(tokenRoute, form({ grant_type: "authorization_code", code, code_verifier: verifier }), "application/x-www-form-urlencoded")).status).toBe(400);

    // The token is an ordinary preview-only key of this store, with an expiry.
    expect((await mcp(tokens.access_token)).status).toBe(200);
    const key = await prisma.apiKey.findFirstOrThrow({ where: { shop }, orderBy: { createdAt: "desc" } });
    expect(key).toMatchObject({ canImport: false, readOnly: false, name: "Claude (signed in)" });
    expect(key.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);

    // Refreshing replaces both tokens; the old ones stop working.
    const again = await (await post(tokenRoute, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }), "application/x-www-form-urlencoded")).json();
    expect(again.access_token).not.toBe(tokens.access_token);
    expect((await mcp(tokens.access_token)).status).toBe(401);
    expect((await mcp(again.access_token)).status).toBe(200);
    expect((await post(tokenRoute, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }), "application/x-www-form-urlencoded")).status).toBe(400);

    // Settings lists it, and disconnecting ends it.
    const list = await oauth.listConnections(shop);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Claude");
    await oauth.removeConnection("other.myshopify.com", list[0].id);
    expect((await mcp(again.access_token)).status).toBe(200);
    await oauth.removeConnection(shop, list[0].id);
    expect((await mcp(again.access_token)).status).toBe(401);
    expect(await oauth.listConnections(shop)).toEqual([]);
    await prisma.apiKey.deleteMany({ where: { shop } });
    await prisma.oAuthClient.deleteMany({ where: { id: client.client_id } });
  });

  it("R30: the approval code locks after a few wrong tries", async () => {
    const store = "locked-shop.myshopify.com";
    const t = Date.now() + 60 * 60_000;
    for (let i = 0; i < oauth.MAX_WRONG_CODES; i++) await expect(oauth.approveConnection(store, `WRONG-${i}AAA`, t)).rejects.toThrow(/isn't valid/);
    await expect(oauth.approveConnection(store, "WRONG-ZZZZ", t)).rejects.toThrow(/Too many wrong codes. Wait 15 minutes/);
    // Another store is not affected, and the lock lifts by itself.
    await expect(oauth.approveConnection("other-shop.myshopify.com", "WRONG-ZZZZ", t)).rejects.toThrow(/isn't valid/);
    await expect(oauth.approveConnection(store, "WRONG-ZZZZ", t + 16 * 60_000)).rejects.toThrow(/isn't valid/);
  });
});
