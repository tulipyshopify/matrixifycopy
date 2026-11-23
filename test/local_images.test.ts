import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { LOCAL_PREFIX, imageInfo, judgeImage, parkLocalImages, sendLocalImages, type LocalImages } from "../app/lib/core/images";
import { readWorkbook, readZipEntryHead, zipEntries } from "../app/lib/core/sheets";
import { fakeStore, product, variant } from "./helpers/fake_store";

process.env.DATABASE_URL ??= "file:dev.sqlite";
process.env.STORAGE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "bulkport-img-"));

/** A real, tiny PNG of the given size (header and one empty data chunk are enough for the checks). */
function png(width: number, height: number, pad = 0): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc(pad))), chunk("IEND", Buffer.alloc(0))]));
}
/** The start of a JPEG: enough of it to read its size from. */
function jpeg(width: number, height: number): Uint8Array {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(200), Buffer.from([0xff, 0xd9])]));
}

describe("image files: what they are and whether Shopify takes them", () => {
  it("reads type and size in pixels from the file itself", () => {
    expect(imageInfo(png(1200, 800))).toEqual({ type: "png", width: 1200, height: 800 });
    expect(imageInfo(jpeg(3000, 2000))).toEqual({ type: "jpeg", width: 3000, height: 2000 });
    expect(imageInfo(new Uint8Array(Buffer.from("GIF89a\x40\x01\xf0\x00rest", "latin1")))).toMatchObject({ type: "gif", width: 320, height: 240 });
    expect(imageInfo(strToU8("<html>not an image</html>"))).toEqual({ type: null });
  });

  it("judges size, pixels and contents", () => {
    expect(judgeImage("a.png", 400_000, png(1200, 1200))).toEqual({ problem: null, warning: null });
    // Shape is only remarked on when the shop says its images should be square.
    expect(judgeImage("a.png", 400_000, png(1200, 800))).toEqual({ problem: null, warning: null });
    expect(judgeImage("a.png", 400_000, png(1200, 800), { square: true }).warning).toMatch(/a.png is not square \(1,200 × 800\)/);
    expect(judgeImage("a.jpg", 900_000, jpeg(3000, 900), { square: true }).warning).toMatch(/much wider than tall/);
    expect(judgeImage("a.png", 700_000, png(1200, 1200)).warning).toMatch(/684 KB PNG: for a photo, JPEG/);
    expect(judgeImage("a.png", 2_000_000, png(1200, 1200)).warning).toMatch(/2.0 MB PNG: for a photo, JPEG/);
    expect(judgeImage("a.png", 24_000_000, null).problem).toMatch(/is 24 MB; Shopify accepts images up to 21 MB/);
    expect(judgeImage("a.jpg", 5_000_000, jpeg(6000, 5000)).problem).toMatch(/6,000 × 5,000 pixels; Shopify accepts up to 25 megapixels/);
    expect(judgeImage("a.jpg", 900, strToU8("<html>")).problem).toMatch(/is not an image Shopify can use/);
    expect(judgeImage("a.jpg", 0, null).problem).toMatch(/empty file/);
    expect(judgeImage("tiny.png", 900, png(120, 90)).warning).toMatch(/tiny.png is only 120 × 90 pixels/);
    expect(judgeImage("big.jpg", 12_000_000, jpeg(4000, 3000)).warning).toMatch(/big.jpg is 12 MB/);
  });

  it("matches cells to uploaded files by name, folder or name without ending; links are left alone", () => {
    const files = [{ name: "images/Barrel-1.JPG", size: 10 }, { name: "images/hurdle.png", size: 10 }, { name: "a/dup.jpg", size: 1 }, { name: "b/dup.jpg", size: 1 }];
    const sheet: any = { name: "Products", headers: ["Handle", "Image Src", "Variant Image"], rows: [
      { Handle: "a", "Image Src": "barrel-1.jpg", "Variant Image": "https://cdn.shopify.com/x.jpg" },
      { Handle: "b", "Image Src": "images/hurdle.png", "Variant Image": "hurdle" },
      { Handle: "c", "Image Src": "dup.jpg", "Variant Image": "" },
      { Handle: "d", "Image Src": "missing.jpg", "Variant Image": "drawing.tiff" },
    ] };
    const images: LocalImages = { refs: new Map(), unused: [] };
    expect(parkLocalImages(sheet, files, images)).toBe(6);
    expect(sheet.rows[0]).toMatchObject({ "Image Src": `${LOCAL_PREFIX}images/Barrel-1.JPG`, "Variant Image": "https://cdn.shopify.com/x.jpg" });
    expect(sheet.rows[1]["Variant Image"]).toBe(`${LOCAL_PREFIX}images/hurdle.png`);
    const of = (v: string) => images.refs.get(v)!;
    expect(of(sheet.rows[0]["Image Src"])).toMatchObject({ typed: "barrel-1.jpg", file: { name: "images/Barrel-1.JPG" }, problem: null });
    expect(of(sheet.rows[2]["Image Src"]).problem).toMatch(/is in the upload 2 times \(a\/dup.jpg, b\/dup.jpg\). Write the folder too/);
    expect(of(sheet.rows[3]["Image Src"]).problem).toMatch(/is not among the 4 image files that came with the sheet/);
    expect(of(sheet.rows[3]["Variant Image"]).problem).toMatch(/is a TIFF file; Shopify product images must be JPEG, PNG, WebP, GIF or HEIC/);
    // No images at all with the sheet: say how to send them.
    const alone: any = { name: "Products", headers: ["Image Src"], rows: [{ "Image Src": "barrel.jpg" }] };
    const none: LocalImages = { refs: new Map(), unused: [] };
    parkLocalImages(alone, [], none);
    expect([...none.refs.values()][0].problem).toMatch(/no image files came with the sheet.*select them together with the sheet/);
  });

  it("swaps parked addresses for Shopify's, wherever they sit in what is sent", async () => {
    const a = `${LOCAL_PREFIX}x.jpg`;
    const out = await sendLocalImages({ id: "1", media: [{ originalSource: a, alt: "" }, { originalSource: "https://e.com/y.jpg" }], n: 3, file: { originalSource: a } }, async (u) => `staged:${u.slice(LOCAL_PREFIX.length)}`);
    expect(out).toEqual({ id: "1", media: [{ originalSource: "staged:x.jpg", alt: "" }, { originalSource: "https://e.com/y.jpg" }], n: 3, file: { originalSource: "staged:x.jpg" } });
  });
});

describe("a sheet uploaded with its image files", async () => {
  const { executeJob } = await import("../app/lib/jobs/runner.server");
  const { bundleUpload } = await import("../app/lib/jobs/bundle");
  const dir = fs.mkdtempSync(path.join(process.env.STORAGE_DIR!, "zip-"));
  const csv = "Handle,Title,Image Src,Image Alt Text\nbarrel,Oak Barrel,barrel-front.png,Front\nbarrel,,photos/barrel-side.jpg,\nhurdle,Willow Hurdle,missing.png,\nhurdle,,https://example.com/h.jpg,\n";
  const zip = zipSync({ "Products.csv": strToU8(csv), "barrel-front.png": [png(1600, 1200, 5000), { level: 0 }], "photos/barrel-side.jpg": jpeg(2000, 1500), "photos/unused.png": png(800, 800), "__MACOSX/._barrel-front.png": strToU8("junk"), "notes.txt": strToU8("Handle\nx\n") });
  const file = path.join(dir, "upload.zip");
  fs.writeFileSync(file, zip);
  const store = () => fakeStore([product("barrel", "Oak Barrel", [variant("B1", "50.00")]), product("hurdle", "Willow Hurdle", [variant("H1", "39.99")])]);
  const run = async (s: ReturnType<typeof store>, dryRun: boolean, id: string) => {
    const logs: string[] = [];
    const uploads: Array<{ url: string; filename: string; mimeType: string; bytes: number; key: string }> = [];
    const staged: any[] = [];
    const gql = (async (q: string, v: any) => {
      if (/ImportStageImage/.test(q)) {
        staged.push(v.input[0]);
        return { stagedUploadsCreate: { stagedTargets: [{ url: "https://staging.example/upload", resourceUrl: `https://staged.example/${v.input[0].filename}`, parameters: [{ name: "key", value: `tmp/${v.input[0].filename}` }] }], userErrors: [] } };
      }
      return s.gql(q, v);
    }) as any;
    const job = { id, shop: "img-test.myshopify.com", type: "import", config: JSON.stringify({ options: { dryRun, defaultCommand: "UPDATE" } }), format: "csv", name: "", inputFile: file, inputName: "upload.zip" };
    const out = await executeJob(job as any, {
      gql,
      bulk: (async function* () {}) as any,
      log: (m) => logs.push(m),
      progress: () => {},
      isCancelled: async () => false,
      uploadFile: async (url, parameters, data, filename, mimeType) => void uploads.push({ url, filename, mimeType, bytes: data.length, key: parameters[0].value }),
    });
    return { ...out, log: logs.join("\n"), uploads, staged };
  };

  it("lists the upload's files and reads the start of one without unpacking it all", async () => {
    const entries = (await zipEntries(file))!;
    expect(entries.find((e) => e.name === "barrel-front.png")!.size).toBeGreaterThan(50);
    expect(imageInfo((await readZipEntryHead(file, "photos/barrel-side.jpg"))!)).toMatchObject({ type: "jpeg", width: 2000, height: 1500 });
    expect(imageInfo((await readZipEntryHead(file, "barrel-front.png", 64))!)).toMatchObject({ type: "png", width: 1600 });
    expect(await readZipEntryHead(file, "nope.png")).toBeNull();
    // The images are not mistaken for sheets.
    expect((await readWorkbook(file, "upload.zip")).map((s) => s.name)).toEqual(["Products", "notes"]);
  });

  it("the preview checks each named file and sends nothing to Shopify", async () => {
    const s = store();
    const r = await run(s, true, "img-preview");
    expect(r.uploads).toEqual([]);
    expect(r.staged).toEqual([]);
    const preview = JSON.parse(fs.readFileSync(path.join(process.env.STORAGE_DIR!, "img-test.myshopify.com", "img-preview", "preview.json"), "utf8"));
    const products = preview.find((p: any) => p.entity === "products");
    const [barrel, hurdle] = products.items;
    expect(barrel.action).toBe("update");
    expect(barrel.changes.join("\n")).toMatch(/barrel-front\.png/);
    expect(barrel.changes.join("\n")).toMatch(/barrel-side\.jpg/);
    expect(JSON.stringify(barrel)).not.toContain("bulkport.invalid");
    // A file that is missing is skipped with the reason; the product's other image still goes on.
    expect(hurdle.action).toBe("update");
    expect(hurdle.warnings.join("\n")).toMatch(/image missing\.png is not among the 3 image files that came with the sheet.*It is skipped/);
    expect(hurdle.changes.join("\n")).toMatch(/adds h\.jpg/);
    expect(hurdle.changes.join("\n")).not.toMatch(/missing/);
    expect(products.warnings.join("\n")).toMatch(/2 image files from the upload are used by this sheet\. They are checked now and sent to Shopify when the import is applied/);
    expect(products.warnings.join("\n")).toMatch(/1 image file in the upload is not named by any row and is not imported: photos\/unused\.png/);
    // The results file shows the names as typed.
    const result = JSON.stringify(await readWorkbook(r.resultFile));
    expect(result).toContain('"Image Src":"barrel-front.png"');
    expect(result).toContain('"Image Src":"photos/barrel-side.jpg"');
    expect(result).not.toContain("bulkport.invalid");
  });

  it("the import sends each file once and gives the product the address Shopify returns", async () => {
    const s = store();
    const r = await run(s, false, "img-real");
    // (The two files go up side by side, so their order is not fixed.)
    expect([...r.staged].sort((x, y) => x.filename.localeCompare(y.filename))).toEqual([
      { resource: "IMAGE", filename: "barrel-front.png", mimeType: "image/png", httpMethod: "POST", fileSize: expect.any(String) },
      { resource: "IMAGE", filename: "barrel-side.jpg", mimeType: "image/jpeg", httpMethod: "POST", fileSize: expect.any(String) },
    ]);
    expect(r.uploads.map((u) => [u.filename, u.mimeType, u.key]).sort()).toEqual([["barrel-front.png", "image/png", "tmp/barrel-front.png"], ["barrel-side.jpg", "image/jpeg", "tmp/barrel-side.jpg"]]);
    expect(s.products[0].images).toEqual(["https://staged.example/barrel-front.png", "https://staged.example/barrel-side.jpg"]);
    // The missing file is left out, as the preview said; the linked image of that product is still added.
    expect(r.stats.find((x: any) => x.entity === "products")).toMatchObject({ ok: 2, failed: 0 });
    expect(s.products[1].images).toEqual(["https://example.com/h.jpg"]);
  });

  it("files selected together are bundled into one upload the import reads the same way", async () => {
    const bundled: File = await bundleUpload(new File([csv], "Products.csv"), [new File([png(900, 900) as BlobPart], "barrel-front.png"), new File([jpeg(900, 900) as BlobPart], "barrel-front.png"), new File([jpeg(10, 10) as BlobPart], "a/b.jpg")]);
    expect(bundled.name).toBe("Products.zip");
    const f = path.join(dir, "bundled.zip");
    fs.writeFileSync(f, Buffer.from(await bundled.arrayBuffer()));
    expect((await zipEntries(f))!.map((e) => e.name)).toEqual(["Products.csv", "barrel-front.png", "a_b.jpg"]);
    expect(imageInfo((await readZipEntryHead(f, "barrel-front.png"))!).type).toBe("png");
  });
});
