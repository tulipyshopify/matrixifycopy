import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.SHOPIFY_API_SECRET ??= "test-secret";
process.env.SHOPIFY_APP_URL = "https://bulk.test";
process.env.GOOGLE_CLIENT_ID = "client-id";
process.env.GOOGLE_CLIENT_SECRET = "client-secret";

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("Google Drive backup copies", async () => {
  const { default: prisma } = await import("../app/db.server");
  const drive = await import("../app/lib/jobs/drive.server");
  const shop = `drive-${Date.now()}.myshopify.com`;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  it("connects with a sign-in that names the store, keeps the token sealed, and uploads backups to its folder", async () => {
    const url = new URL(drive.driveConnectUrl(shop));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "client-id", redirect_uri: "https://bulk.test/google/callback", scope: "https://www.googleapis.com/auth/drive.file", access_type: "offline" });
    const state = url.searchParams.get("state")!;
    expect(state).not.toContain(shop);
    expect(drive.shopFromState(state)).toBe(shop);
    expect(() => drive.shopFromState(state, Date.now() + 16 * 60_000)).toThrow(/expired/);
    expect(() => drive.shopFromState("made-up")).toThrow(/expired/);

    const calls: Array<{ url: string; init: any }> = [];
    const fake = (async (u: any, init: any = {}) => {
      calls.push({ url: String(u), init });
      if (String(u).includes("oauth2.googleapis.com/token")) {
        const body = new URLSearchParams(init.body);
        return body.get("grant_type") === "authorization_code" ? json({ access_token: "at-1", refresh_token: "rt-secret" }) : json({ access_token: "at-2" });
      }
      if (String(u).includes("/drive/v3/files?fields=id")) return json({ id: "folder-1" });
      if (String(u).includes("uploadType=resumable")) return json({}, 200, { location: "https://upload.test/session-1" });
      if (String(u) === "https://upload.test/session-1") {
        let body = "";
        for await (const c of init.body as any) body += Buffer.from(c).toString();
        calls.at(-1)!.init.sent = body;
        return json({ id: "file-1" });
      }
      throw new Error(`unexpected ${u}`);
    }) as any;

    expect(await drive.driveConnected(shop)).toBe(false);
    expect(await drive.connectDrive("code-1", state, fake)).toBe(shop);
    const saved = await prisma.shopSetting.findUniqueOrThrow({ where: { shop } });
    expect(saved.driveFolder).toBe("folder-1");
    expect(saved.driveToken).not.toContain("rt-secret");
    expect(await drive.driveConnected(shop)).toBe(true);

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-drive-")), "Backup_2026-11-19.zip");
    fs.writeFileSync(file, "zip-bytes");
    calls.length = 0;
    expect(await drive.uploadToDrive(shop, file, fake)).toBe(true);
    expect(new URLSearchParams(calls[0].init.body).get("refresh_token")).toBe("rt-secret");
    expect(JSON.parse(calls[1].init.body)).toEqual({ name: "Backup_2026-11-19.zip", parents: ["folder-1"] });
    expect(calls[1].init.headers.Authorization).toBe("Bearer at-2");
    expect(calls[2].init.sent).toBe("zip-bytes");

    // Google withdrew the permission: said plainly.
    const revoked = (async () => json({ error: "invalid_grant" }, 400)) as any;
    await expect(drive.uploadToDrive(shop, file, revoked)).rejects.toThrow(/Connect Google Drive again/);
    await drive.disconnectDrive(shop);
    expect(await drive.uploadToDrive(shop, file, fake)).toBe(false);
    await prisma.shopSetting.deleteMany({ where: { shop } });
  });
});
