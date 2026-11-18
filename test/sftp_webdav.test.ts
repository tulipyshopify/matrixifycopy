import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ssh2 from "ssh2";

process.env.ALLOW_PRIVATE_SOURCES = "true";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-src-"));
const { downloadSource, uploadResult, webDavRequest, redactUrl } = await import("../app/lib/jobs/sources.server");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-src-"));

/** A tiny SFTP server over a temp folder: user "shop", password "s3cret". */
function sftpServer(root: string) {
  const { Server, utils } = ssh2;
  const { STATUS_CODE, OPEN_MODE } = utils.sftp;
  const key = utils.generateKeyPairSync("ed25519").private;
  const real = (p: string) => path.join(root, path.posix.normalize(`/${p}`));
  const attrs = (st: fs.Stats) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: 0, mtime: 0 });
  return new Server({ hostKeys: [key] }, (client: any) => {
    client.on("authentication", (ctx: any) => (ctx.method === "password" && ctx.username === "shop" && ctx.password === "s3cret" ? ctx.accept() : ctx.reject(["password"])));
    client.on("error", () => {});
    client.on("ready", () => {
      client.on("session", (accept: any) => {
        accept().on("sftp", (acceptSftp: any) => {
          const sftp = acceptSftp();
          const open = new Map<number, number>();
          let next = 0;
          const fd = (h: Buffer) => open.get(h.readUInt32BE(0))!;
          const stat = (id: number, p: string) => {
            try {
              sftp.attrs(id, attrs(fs.statSync(real(p))));
            } catch {
              sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            }
          };
          sftp.on("REALPATH", (id: number, p: string) => sftp.name(id, [{ filename: path.posix.normalize(`/${p}`), longname: p, attrs: {} }]));
          sftp.on("STAT", stat).on("LSTAT", stat);
          sftp.on("FSTAT", (id: number, h: Buffer) => sftp.attrs(id, attrs(fs.fstatSync(fd(h)))));
          sftp.on("FSETSTAT", (id: number) => sftp.status(id, STATUS_CODE.OK));
          sftp.on("SETSTAT", (id: number) => sftp.status(id, STATUS_CODE.OK));
          sftp.on("MKDIR", (id: number, p: string) => {
            fs.mkdirSync(real(p), { recursive: true });
            sftp.status(id, STATUS_CODE.OK);
          });
          sftp.on("OPEN", (id: number, p: string, flags: number) => {
            try {
              const n = fs.openSync(real(p), flags & OPEN_MODE.WRITE ? "w" : "r");
              const h = Buffer.alloc(4);
              h.writeUInt32BE(next, 0);
              open.set(next++, n);
              sftp.handle(id, h);
            } catch {
              sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            }
          });
          sftp.on("READ", (id: number, h: Buffer, offset: number, length: number) => {
            const buf = Buffer.alloc(length);
            const n = fs.readSync(fd(h), buf, 0, length, offset);
            if (n) sftp.data(id, buf.subarray(0, n));
            else sftp.status(id, STATUS_CODE.EOF);
          });
          sftp.on("WRITE", (id: number, h: Buffer, offset: number, data: Buffer) => {
            fs.writeSync(fd(h), data, 0, data.length, offset);
            sftp.status(id, STATUS_CODE.OK);
          });
          sftp.on("CLOSE", (id: number, h: Buffer) => {
            fs.closeSync(fd(h));
            sftp.status(id, STATUS_CODE.OK);
          });
        });
      });
    });
  });
}

/** A tiny WebDAV server over a temp folder (GET, PUT, MKCOL) with Basic auth. */
function davServer(root: string, seen: string[]) {
  return http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Basic ${Buffer.from("shop:p@ss word").toString("base64")}`) return void res.writeHead(401).end();
    const file = path.join(root, decodeURIComponent(new URL(req.url!, "http://x").pathname));
    if (req.method === "GET") {
      if (!fs.existsSync(file)) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/csv" }).end(fs.readFileSync(file));
    } else if (req.method === "MKCOL") {
      if (fs.existsSync(file)) return void res.writeHead(405).end();
      fs.mkdirSync(file);
      res.writeHead(201).end();
    } else if (req.method === "PUT") {
      if (!fs.existsSync(path.dirname(file))) return void req.resume().on("end", () => res.writeHead(409).end());
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c)).on("end", () => {
        fs.writeFileSync(file, Buffer.concat(chunks));
        res.writeHead(201).end();
      });
    } else res.writeHead(405).end();
  });
}

describe("SFTP and WebDAV links", () => {
  const sftpRoot = tmp();
  const davRoot = tmp();
  const seen: string[] = [];
  const sftp = sftpServer(sftpRoot);
  const dav = davServer(davRoot, seen);
  let sftpPort = 0;
  let davPort = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => sftp.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => dav.listen(0, "127.0.0.1", () => r()));
    sftpPort = (sftp.address() as any).port;
    davPort = (dav.address() as any).port;
    fs.mkdirSync(path.join(sftpRoot, "feeds"));
    fs.writeFileSync(path.join(sftpRoot, "feeds", "Products.csv"), "ID,Title\n1,Bin\n");
    fs.writeFileSync(path.join(davRoot, "Stock levels.csv"), "SKU,Qty\nA,4\n");
  });
  afterAll(() => {
    sftp.close();
    dav.close();
  });

  it("imports a file from sftp://", async () => {
    const got = await downloadSource(`sftp://shop:s3cret@127.0.0.1:${sftpPort}/feeds/Products.csv`, tmp());
    expect(got.name).toBe("Products.csv");
    expect(fs.readFileSync(got.file, "utf8")).toBe("ID,Title\n1,Bin\n");
  });

  it("uploads an export to sftp://, creating the folder and keeping the file name", async () => {
    const file = path.join(tmp(), "Export_2026.csv");
    fs.writeFileSync(file, "ID\n7\n");
    const remote = await uploadResult(file, `sftp://shop:s3cret@127.0.0.1:${sftpPort}/out/daily/`);
    expect(remote).toBe("/out/daily/Export_2026.csv");
    expect(fs.readFileSync(path.join(sftpRoot, "out/daily/Export_2026.csv"), "utf8")).toBe("ID\n7\n");
  });

  it("says so plainly when the SFTP password is wrong or missing", async () => {
    await expect(downloadSource(`sftp://shop:wrong@127.0.0.1:${sftpPort}/feeds/Products.csv`, tmp())).rejects.toThrow(/user name or password was refused/);
    await expect(downloadSource(`sftp://127.0.0.1:${sftpPort}/feeds/Products.csv`, tmp())).rejects.toThrow(/needs a user name and password/);
  });

  it("imports a file from webdav:// with the sign-in sent as a header, not in the address", async () => {
    const got = await downloadSource(`webdav://shop:p%40ss%20word@127.0.0.1:${davPort}/Stock%20levels.csv`, tmp());
    expect(fs.readFileSync(got.file, "utf8")).toBe("SKU,Qty\nA,4\n");
    expect(got.name).toMatch(/\.csv$/);
    expect(seen.at(-1)).toBe("GET /Stock%20levels.csv");
    expect(webDavRequest(new URL("davs://u:p@files.example.com/remote.php/dav/x.csv"))).toEqual({
      href: "https://files.example.com/remote.php/dav/x.csv",
      headers: { Authorization: `Basic ${Buffer.from("u:p").toString("base64")}` },
    });
    await expect(downloadSource(`webdav://shop:nope@127.0.0.1:${davPort}/Stock%20levels.csv`, tmp())).rejects.toThrow(/refused/);
    await expect(downloadSource(`webdav://shop:p%40ss%20word@127.0.0.1:${davPort}/missing.csv`, tmp())).rejects.toThrow(/HTTP 404/);
  });

  it("uploads an export to webdav://, creating missing folders", async () => {
    const file = path.join(tmp(), "Orders.xlsx");
    fs.writeFileSync(file, "xlsx-bytes");
    const remote = await uploadResult(file, `webdav://shop:p%40ss%20word@127.0.0.1:${davPort}/exports/2026/`);
    expect(remote).toBe("/exports/2026/Orders.xlsx");
    expect(fs.readFileSync(path.join(davRoot, "exports/2026/Orders.xlsx"), "utf8")).toBe("xlsx-bytes");
  });

  it("refuses other upload targets and hides passwords when shown", async () => {
    await expect(uploadResult("x.csv", "https://example.com/x.csv")).rejects.toThrow(/ftp:\/\/, ftps:\/\/, sftp:\/\/ or webdav/);
    expect(redactUrl("sftp://shop:s3cret@host/x.csv")).toBe("sftp://shop:****@host/x.csv");
    expect(redactUrl("webdavs://shop:s3cret@host/x.csv")).toBe("webdavs://shop:****@host/x.csv");
  });
});
