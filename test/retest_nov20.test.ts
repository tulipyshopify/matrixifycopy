import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jobSummary, jobTiming, jobRow } from "../app/components/jobs";
import { imageInfo, judgeImage, stripLocation } from "../app/lib/core/images";
import { runImport } from "../app/lib/core/importer";
import { parseCsv } from "../app/lib/core/sheets";
import { ENTITIES } from "../app/lib/entities";
import { menusEntity } from "../app/lib/entities/menus";
import { importProduct, lookUpProducts, stockWarnings } from "../app/lib/entities/products";
import { fakeStore, product, variant } from "./helpers/fake_store";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-rt-"));

/** Replays the retest of 20 Nov 2026 (O1…O12, N1…N12) and checks what was fixed. */
const preview = async (sheets: any[], store: ReturnType<typeof fakeStore>, options: Record<string, unknown> = {}) => {
  const stats = await runImport({ ctx: { gql: store.gql, options: { dryRun: true, defaultCommand: "UPDATE", ...options } as any, log: () => {}, cache: new Map() } as any, sheets, entities: ENTITIES, log: () => {} });
  return { stats, items: stats.flatMap((s) => s.preview ?? []) };
};
const sheet = (headers: string[], ...rows: string[][]) => [{ name: "Products", headers, rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) }];

describe("retest 20 Nov: stock, handles and variants", () => {
  it("N1: stock from an earlier export is flagged, as is a number that jumps; a supplier's file is not", async () => {
    const make = () => fakeStore([product("compost-bin", "Easy Fill Wooden Compost Bin", [variant("CB011", "89.00", {}, { stock: { Warehouse: 15 } })])]);
    // An export of this app carries "Updated At": its 16 is from then, the store has 15 now.
    const stale = await preview(sheet(["Handle", "Updated At", "Variant SKU", "Inventory Available: Warehouse"], ["compost-bin", "2026-11-20T08:00:00Z", "CB011", "16"]), make());
    expect(stale.items[0].action).toBe("update");
    expect(stale.items[0].warnings!.join()).toMatch(/stock of .*CB011.* at Warehouse would be set to 16; the store has 15 now\. This file was exported on 20 Nov, 08:00 UTC: units sold or received after that would be undone\. To add or take away instead, use an "Inventory Available Adjust" column/);
    expect(stale.stats[0].risk).toMatchObject({ warned: 1 });
    // The same number from a file with no export time (a supplier's stock list) is a plain update.
    const feed = await preview(sheet(["Handle", "Variant SKU", "Inventory Available: Warehouse"], ["compost-bin", "CB011", "16"]), make());
    expect(feed.items[0].warnings ?? []).toEqual([]);
    // …unless it jumps far beyond what is there.
    const jump = await preview(sheet(["Handle", "Variant SKU", "Inventory Available: Warehouse"], ["compost-bin", "CB011", "999"]), make());
    expect(jump.items[0].warnings!.join()).toMatch(/jumps from 15 to 999\. Check the number/);
    // An unchanged number is no change, export or not.
    const same = await preview(sheet(["Handle", "Updated At", "Variant SKU", "Inventory Available: Warehouse"], ["compost-bin", "2026-11-20T08:00:00Z", "CB011", "15"]), make());
    expect(same.items[0].action).toBe("none");
    expect(stockWarnings("x", 5, 5, { at: "2026-11-20T08:00:00Z", changedSince: true })).toEqual([]);
    expect(stockWarnings("x", 5, 6, { at: "2026-11-20T08:00:00Z", changedSince: true })[0]).toMatch(/and the product has changed in the store since then/);
  });

  it("N2: a handle change is flagged, and the old address is redirected", async () => {
    const store = fakeStore([product("530-litre-easy-fill-compost-bin", "Compost Bin", [variant("CB011", "89.00")])]);
    const id = store.products[0].id.split("/").pop()!;
    const rows = sheet(["ID", "Handle"], [id, "easy-fill-wooden-compost-bin"]);
    const p = await preview(rows, store);
    expect(p.items[0].changes).toEqual(["Handle: 530-litre-easy-fill-compost-bin → easy-fill-wooden-compost-bin"]);
    expect(p.items[0].warnings!.join()).toMatch(/the handle changes, which changes the product's web address .*A redirect from the old address is created with it/);
    const sent: any[] = [];
    const gql = (async (q: string, v: any) => {
      if (/mutation ImportProductUpdate\b/.test(q)) sent.push(v.product);
      return store.gql(q, v);
    }) as any;
    await runImport({ ctx: { gql, options: { defaultCommand: "UPDATE" } as any, log: () => {}, cache: new Map() } as any, sheets: sheet(["ID", "Handle"], [id, "easy-fill-wooden-compost-bin"]), entities: ENTITIES, log: () => {} });
    expect(sent[0]).toMatchObject({ handle: "easy-fill-wooden-compost-bin", redirectNewHandle: true });
  });

  it("O9: removing one variant is one change, counted as a deletion and not also as an update", async () => {
    const store = fakeStore([product("test-b", "ZZ Test B", [variant("A1", "5.00", { Size: "S" }), variant("A2", "6.00", { Size: "L" })])]);
    const p = await preview(sheet(["Handle", "Variant ID", "Variant Command"], ["test-b", store.products[0].variants[1].id.split("/").pop()!, "DELETE"]), store);
    expect(p.items[0]).toMatchObject({ action: "update", deletes: 1 });
    expect(p.stats[0].risk).toMatchObject({ updates: 0, deletes: 1 });
  });

  it("N5: which products exist is asked in batches, and rows for missing ones cost no further request", async () => {
    const store = fakeStore([product("here", "Here", [variant("H", "1.00")])]);
    const asked: Array<{ op: string; vars: any }> = [];
    const gql = (async (q: string, v: any) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(q)?.[1] ?? "?";
      asked.push({ op, vars: v });
      if (op === "ImportProductsExistByHandle") return Object.fromEntries(Object.entries(v).map(([k, h]) => [k.replace("h", "p"), h === "here" ? { id: store.products[0].id, handle: "here" } : null]));
      if (op === "ImportProductsExistById") return { nodes: v.ids.map((id: string) => (id === store.products[0].id ? { id } : null)) };
      return store.gql(q, v);
    }) as any;
    const items = [...Array.from({ length: 120 }, (_, i) => ({ rows: [{ Handle: `missing-${i}` }] })), { rows: [{ Handle: "Here" }] }, { rows: [{ ID: "999" }] }, { rows: [{ ID: store.products[0].id.split("/").pop()! }] }];
    const ctx: any = { gql, options: { dryRun: true }, log: () => {}, cache: new Map() };
    const known = await lookUpProducts(ctx, items);
    // 121 handles in three requests of at most 50, two IDs in one.
    expect(asked.map((a) => a.op)).toEqual(["ImportProductsExistById", "ImportProductsExistByHandle", "ImportProductsExistByHandle", "ImportProductsExistByHandle"]);
    expect([...known.handles]).toEqual(["here"]);
    expect(known.checkedHandles.size).toBe(121);
    expect([...known.ids]).toEqual([store.products[0].id]);
    ctx.cache.set("products:known", known);
    asked.length = 0;
    const gone = await importProduct(ctx, [{ Handle: "missing-7", Title: "x" }], "UPDATE");
    expect(gone.status).toBe("Failed");
    expect(asked).toEqual([]);
    const found = await importProduct(ctx, [{ Handle: "here", Title: "Here now" }], "UPDATE");
    expect(found.status).toBe("OK");
    expect(asked.some((a) => a.op === "ImportProductByHandle")).toBe(true);
  });
});

describe("retest 20 Nov: files and other data types", () => {
  it("O5: a header row is split by its own delimiter, whatever the cells below hold", () => {
    const body = '"<p>Planting; watering; pruning; feeding; mulching; staking; tying; harvesting; storing; composting</p>"';
    const { headers, rows, notes } = parseCsv(`ID,Handle,Command,Title,Body HTML,Author\n1,spring-jobs,,Spring jobs,${body},Sam\n2,autumn-jobs,,Autumn jobs,${body},Sam\n`);
    expect(headers).toEqual(["ID", "Handle", "Command", "Title", "Body HTML", "Author"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Handle: "spring-jobs", Author: "Sam" });
    expect(notes.join()).not.toMatch(/title line/);
    // Semicolons and tabs still win when the header uses them.
    expect(parseCsv("Handle;Title\na;B, C\n").rows).toEqual([{ Handle: "a", Title: "B, C" }]);
    expect(parseCsv("Handle\tTitle\na\tB, C; D\n").rows).toEqual([{ Handle: "a", Title: "B, C; D" }]);
  });

  it("O6: a short menu file says which links it would remove, and starts flagged", async () => {
    const item = (id: number, title: string, url: string) => ({ id: `gid://shopify/MenuItem/${id}`, title, type: "HTTP", resourceId: null, url, tags: [], items: [] });
    const main = { id: "gid://shopify/Menu/1", handle: "main-menu", title: "Main menu", isDefault: true, items: [item(1, "Home", "/"), item(2, "Shop", "/collections/all"), item(3, "About", "/pages/about"), item(4, "Contact", "/pages/contact")] };
    const ctx: any = { gql: async (q: string) => (/ImportMenuById/.test(q) ? { menu: main } : { menus: { nodes: [main], pageInfo: { hasNextPage: false } } }), options: { dryRun: true }, log: () => {}, cache: new Map() };
    const r = await menusEntity.import!.apply(ctx, [{ ID: "1", Handle: "main-menu", Title: "Main menu", "Item: Title": "Sale", "Item: Type": "HTTP", "Item: URL": "/collections/sale", "Item: Level": "1" }], "UPDATE");
    expect(r.status).toBe("OK");
    expect(r.preview!.changes).toEqual(["Adds 1 link: Sale", "Removes 4 of the 4 links in the menu: Home, Shop, About, Contact"]);
    expect(r.preview!.warnings.join()).toMatch(/the file lists 1 link and the menu "Main menu" has 4: a menu import replaces the whole list/);
    expect(r.preview!.clears).toEqual(["Menu links"]);
    // The menu's own rows fed back are no change.
    const same = await menusEntity.import!.apply(ctx, main.items.map((it, i) => ({ ID: "1", Handle: "main-menu", ...(i === 0 ? { Title: "Main menu" } : {}), "Item: ID": it.id.split("/").pop()!, "Item: Title": it.title, "Item: Type": "HTTP", "Item: URL": it.url, "Item: Level": "1" })), "UPDATE");
    expect(same.preview).toMatchObject({ action: "none", changes: [], warnings: [] });
  });

  it("N8: print colours and oversized PNG photos are pointed out; a photo's location is taken out, the rest left", () => {
    const sof = (components: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0xe8, 0x05, 0xdc, components, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 4, 0x11, 1, 0xff, 0xd9]);
    expect(imageInfo(sof(4))).toMatchObject({ type: "jpeg", width: 1500, height: 1000, cmyk: true });
    expect(imageInfo(sof(3)).cmyk).toBeUndefined();
    expect(judgeImage("print.jpg", 500_000, sof(4)).warning).toMatch(/print\.jpg is in print colours \(CMYK\)/);
    const png = new Uint8Array(40);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x07, 0xd0, 0, 0, 0x07, 0xd0]);
    expect(judgeImage("photo.png", 4_000_000, png).warning).toMatch(/photo\.png is a 4\.0 MB PNG: for a photo, JPEG gives the same picture at a fraction of the size/);
    expect(judgeImage("logo.png", 300_000, png).warning).toBeNull();

    // A JPEG whose EXIF holds an orientation and a GPS block with a latitude.
    const tiff = Buffer.alloc(120);
    tiff.write("II");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(2, 8); // two entries
    tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(6, 18); // orientation = 6
    tiff.writeUInt16LE(0x8825, 22); tiff.writeUInt16LE(4, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt32LE(40, 30); // GPS block at 40
    tiff.writeUInt16LE(1, 40); // one entry: latitude, three rationals at 60
    tiff.writeUInt16LE(2, 42); tiff.writeUInt16LE(5, 44); tiff.writeUInt32LE(3, 46); tiff.writeUInt32LE(60, 50);
    for (let k = 0; k < 6; k++) tiff.writeUInt32LE(51 + k, 60 + k * 4);
    const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const head = Buffer.alloc(4);
    head[0] = 0xff; head[1] = 0xe1; head.writeUInt16BE(exif.length + 2, 2);
    const photo = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), head, exif, Buffer.from(sof(3).subarray(2))]));
    const before = Buffer.from(photo);
    expect(stripLocation(photo)).toBe(true);
    const t = 2 + 4 + 6;
    expect(Buffer.from(photo).readUInt16LE(t + 40)).toBe(0); // the GPS block is empty
    expect(Buffer.from(photo).subarray(t + 60, t + 84).every((x) => x === 0)).toBe(true); // the latitude is gone
    expect(Buffer.from(photo).readUInt16LE(t + 18)).toBe(6); // the orientation stays
    expect(photo.length).toBe(before.length);
    expect(imageInfo(photo)).toMatchObject({ type: "jpeg", width: 1500, height: 1000 });
    expect(stripLocation(photo)).toBe(false);
    expect(stripLocation(sof(3))).toBe(false);
  });
});

describe("retest 20 Nov: job list", () => {
  it("N7: a job's time counts from when it was asked for; rows a cancelled job never reached are not 'skipped'", () => {
    const t = (m: number, s = 0) => new Date(Date.UTC(2026, 10, 20, 15, m, s));
    expect(jobTiming({ status: "finished", progress: 0, total: 0, createdAt: t(0), startedAt: t(12, 53), finishedAt: t(13) })).toBe("Took 13 min 0 sec (12 min 53 sec of it waiting to start)");
    expect(jobTiming({ status: "finished", progress: 0, total: 0, createdAt: t(0), startedAt: t(0, 2), finishedAt: t(0, 9) })).toMatch(/^Took 9 sec$/);
    const row = jobRow({ id: "abcdef123456", type: "import", status: "cancelled", config: "{}", format: "csv", name: "", inputName: "big.csv", stats: JSON.stringify([{ sheet: "Products", items: 250000, ok: 12, failed: 0, skipped: 249988 }]), progress: 0, total: 0, createdAt: t(0), startedAt: t(12, 53), finishedAt: t(13) } as any);
    expect(row.counts.map((c) => c.label)).toContain("Not processed: 249,988");
    expect(row.took).toBe("13 min 0 sec");
  });

  it("N12: a quick change is listed by what it does", () => {
    const job = { type: "import", config: JSON.stringify({ options: { dryRun: true }, generate: { entity: "products" } }), inputName: "Products.csv", name: "Quick change: Lower prices by 95% (title contains zz)" };
    expect(jobSummary(job)).toBe("Lower prices by 95% (title contains zz)");
    expect(jobSummary({ type: "import", config: "{}", inputName: "My file.csv", name: "" })).toBe("My file.csv");
    expect(jobRow({ id: "abcdef123456", status: "finished", format: "csv", stats: JSON.stringify([{ sheet: "Products", items: 1, ok: 1 }]), progress: 0, total: 0, startedAt: null, finishedAt: null, ...job } as any).title).toBe("Lower prices by 95% (title contains zz)");
  });
});

describe.skipIf(!fs.existsSync("prisma/dev.sqlite"))("retest 20 Nov: applying, keys and uploads", async () => {
  const { default: prisma } = await import("../app/db.server");
  const { executeJob } = await import("../app/lib/jobs/runner.server");
  const { applyDryRun, sameUploadBefore, discardJob } = await import("../app/lib/jobs/jobs.server");
  const { applyPreview } = await import("../app/lib/api/service.server");
  const keys = await import("../app/lib/api/keys.server");
  const oauth = await import("../app/lib/api/oauth.server");
  const shop = `retest-${Date.now()}.myshopify.com`;
  const auth: any = { shop, keyId: "k", name: "Script", canImport: true, readOnly: false };
  const start = async (csv: string, config: Record<string, unknown> = { options: { dryRun: true, defaultCommand: "UPDATE" } }) => {
    const dir = fs.mkdtempSync(path.join(process.env.STORAGE_DIR!, "in-"));
    const file = path.join(dir, "Products.csv");
    fs.writeFileSync(file, csv);
    return prisma.job.create({ data: { shop, type: "import", config: JSON.stringify(config), format: "csv", name: "", inputFile: file, inputName: "Products.csv" } });
  };
  const run = async (id: string, store: ReturnType<typeof fakeStore>) => {
    const job = await prisma.job.findUniqueOrThrow({ where: { id } });
    const { stats } = await executeJob(job as any, { gql: store.gql, bulk: (async function* () {}) as any, log: () => {}, progress: () => {}, isCancelled: async () => false });
    await prisma.job.update({ where: { id }, data: { status: "finished", stats: JSON.stringify(stats) } });
  };
  const store = () => fakeStore([product("bin", "Bin", [variant("B1", "2.00")]), product("tub", "Tub", [variant("T1", "5.00")])]);

  it("O1: the API applies nothing a preview flagged until told to, and can leave those rows out", async () => {
    const s = store();
    const job = await start("Handle,Variant SKU,Variant Price\nbin,B1,0.10\ntub,T1,5.50\n");
    await run(job.id, s);
    await expect(applyPreview(auth, job.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/This preview flags 1 row that need a decision \(row 2: .*\)\. .*"confirm_warnings": true.*"skip_warnings": true/) });
    const rest = await applyPreview(auth, job.id, false, "skip");
    expect(JSON.parse((await prisma.job.findUniqueOrThrow({ where: { id: rest.id } })).config).exclude).toEqual({ Products: ["Handle=bin"] });
    const all = await applyPreview(auth, job.id, false, "confirm");
    expect(JSON.parse((await prisma.job.findUniqueOrThrow({ where: { id: all.id } })).config).exclude).toBeUndefined();
    // Nothing flagged: no extra word needed.
    const plain = await start("Handle,Variant SKU,Variant Price\ntub,T1,5.50\n");
    await run(plain.id, s);
    await expect(applyPreview(auth, plain.id)).resolves.toMatchObject({ type: "import" });
  });

  it("O3: a new item that also carries a warning can be applied once it is set to Create", async () => {
    const job = await start("Handle,Title,Command\nplanter-🌳-test,New planter,NEW\n");
    await run(job.id, store());
    await expect(applyDryRun(shop, job.id, {})).rejects.toThrow(/choose Include or Skip for 1 item/);
    const real = await applyDryRun(shop, job.id, { include: { Products: ["Handle=planter-🌳-test"] } });
    expect(real.type).toBe("import");
  });

  it("O2: revoking a signed-in assistant's key ends the sign-in: it can't quietly get a new key", async () => {
    const { key, row } = await keys.createKey(shop, "Claude (signed in)", "preview", 30);
    const refresh = "refresh-token-for-test-" + Date.now();
    const sha = (v: string) => require("node:crypto").createHash("sha256").update(v).digest("hex");
    const grant = await prisma.oAuthGrant.create({ data: { clientId: "c", redirectUri: "https://claude.ai/cb", challenge: "x", userCode: `T${Date.now()}`.slice(-9), shop, approvedAt: new Date(), keyId: row.id, refreshHash: sha(refresh), clientName: "Claude" } });
    await expect(keys.checkKey(key)).resolves.toMatchObject({ shop });
    await keys.revokeKeyAndSignIn(shop, row.id);
    await expect(keys.checkKey(key)).rejects.toMatchObject({ status: 401 });
    expect(await prisma.oAuthGrant.findUnique({ where: { id: grant.id } })).toBeNull();
    await expect(oauth.exchangeToken(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }))).rejects.toThrow(/not valid/);
    // A grant left behind by a key revoked some other way is refused too, and removed.
    const again = await keys.createKey(shop, "Claude (signed in)", "preview", 30);
    const g2 = await prisma.oAuthGrant.create({ data: { clientId: "c", redirectUri: "https://claude.ai/cb", challenge: "x", userCode: `U${Date.now()}`.slice(-9), shop, approvedAt: new Date(), keyId: again.row.id, refreshHash: sha(refresh + "2"), clientName: "Claude" } });
    await keys.revokeKey(shop, again.row.id);
    await expect(oauth.exchangeToken(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh + "2" }))).rejects.toThrow(/This connection was revoked/);
    expect(await prisma.oAuthGrant.findUnique({ where: { id: g2.id } })).toBeNull();
  });

  it("N4: the same file sent twice in a row is recognised; a different file or setting is not", async () => {
    const a = await start("Handle,Title\nbin,Bin 2\n");
    await prisma.job.update({ where: { id: a.id }, data: { status: "queued" } });
    const b = await start("Handle,Title\nbin,Bin 2\n");
    expect((await sameUploadBefore(shop, b))?.id).toBe(a.id);
    await discardJob(shop, b.id);
    expect(await prisma.job.findUnique({ where: { id: b.id } })).toBeNull();
    const other = await start("Handle,Title\nbin,Bin 3\n");
    expect(await sameUploadBefore(shop, other)).toBeNull();
    const merge = await start("Handle,Title\nbin,Bin 2\n", { options: { dryRun: true, defaultCommand: "MERGE" } });
    expect(await sameUploadBefore(shop, merge)).toBeNull();
    // Not after the window has passed.
    expect(await sameUploadBefore(shop, await start("Handle,Title\nbin,Bin 2\n"), 0)).toBeNull();
    await prisma.job.deleteMany({ where: { shop } });
    await prisma.apiKey.deleteMany({ where: { shop } });
  });
});
