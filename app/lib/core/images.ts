import type { Sheet } from "./sheets";

/**
 * Image files uploaded together with the sheet. A cell of an image column
 * that holds a file name instead of a link ("barrel-1.jpg") refers to a file
 * of the upload: the preview checks the file, and the import hands it to
 * Shopify and uses the address Shopify gives for it. No separate "upload the
 * images, export their links, paste the links" round is needed.
 */

/** Columns that take an image, as a link or as the name of an uploaded file. */
export const IMAGE_COLUMNS = ["Image Src", "Variant Image"];
/** Where a cell's file name is parked while the import runs: an address that exists nowhere. */
export const LOCAL_PREFIX = "https://upload.bulkport.invalid/";

/** Shopify's published limits for product and collection images. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
/** Worth a word: slow to upload and far more than a shop page shows. */
const LARGE_IMAGE_BYTES = 8 * 1024 * 1024;
/** Too small to look sharp on a product page. */
const SMALL_IMAGE_SIDE = 400;

export const IMAGE_FILE = /\.(jpe?g|png|gif|webp|heic|heif)$/i;
/** Picture formats people have on disk that a shop can't use as they are. */
const OTHER_PICTURE = /\.(tiff?|bmp|psd|svg|avif|eps|ai|raw|cr2|nef|pdf)$/i;

const isLink = (v: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.startsWith("//") || v.startsWith("data:");
export const isLocalRef = (v: string) => v.startsWith(LOCAL_PREFIX);
export const localName = (v: string) => decodeURIComponent(v.slice(LOCAL_PREFIX.length));

const mb = (n: number) => `${(n / 1e6).toFixed(n < 10e6 ? 1 : 0)} MB`;

export interface ImageInfo {
  type: "jpeg" | "png" | "gif" | "webp" | "heic" | null;
  width?: number;
  height?: number;
}

/** What kind of image the bytes are, and its size in pixels where the header says. */
export function imageInfo(b: Uint8Array): ImageInfo {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length > 24 && b[0] === 0x89 && ascii(1, 3) === "PNG") return { type: "png", width: u32(16), height: u32(20) };
  if (b.length > 10 && ascii(0, 3) === "GIF") return { type: "gif", width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b.length > 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return { type: "webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 ") return { type: "webp", width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: "webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    return { type: "webp" };
  }
  if (b.length > 12 && ascii(4, 4) === "ftyp" && /^(heic|heix|hevc|mif1|msf1|heim|heis)/.test(ascii(8, 4))) return { type: "heic" };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the frame header, which holds the size.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: "jpeg", height: u16(i + 5), width: u16(i + 7) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + u16(i + 2);
    }
    return { type: "jpeg" };
  }
  return { type: null };
}

/** Why an image file can't be used (null when it can), and anything worth pointing out. */
export function judgeImage(name: string, size: number, head: Uint8Array | null): { problem: string | null; warning: string | null } {
  if (size > MAX_IMAGE_BYTES) return { problem: `is ${mb(size)}; Shopify accepts images up to ${mb(MAX_IMAGE_BYTES)}. Save it smaller (for the web, 2,000 to 3,000 pixels wide is plenty) and upload again`, warning: null };
  if (size === 0) return { problem: "is an empty file", warning: null };
  const info = head ? imageInfo(head) : { type: null as ImageInfo["type"] };
  if (head && !info.type) return { problem: "is not an image Shopify can use: its contents are not JPEG, PNG, WebP, GIF or HEIC, whatever its name says", warning: null };
  if (info.width && info.height) {
    if (info.width * info.height > MAX_IMAGE_PIXELS) {
      return { problem: `is ${info.width.toLocaleString("en")} × ${info.height.toLocaleString("en")} pixels; Shopify accepts up to 25 megapixels (5,000 × 5,000). Make it smaller and upload again`, warning: null };
    }
    if (Math.max(info.width, info.height) < SMALL_IMAGE_SIDE) return { problem: null, warning: `${name} is only ${info.width} × ${info.height} pixels and will look blurred on a product page` };
  }
  if (size > LARGE_IMAGE_BYTES) return { problem: null, warning: `${name} is ${mb(size)}: it will be accepted, but is much larger than a shop page needs` };
  return { problem: null, warning: null };
}

export interface UploadedFile {
  /** Path inside the upload ("images/barrel-1.jpg"). */
  name: string;
  size: number;
}

export interface LocalImages {
  /** Every cell that named a file: its parked address -> what was typed and the file found for it. */
  refs: Map<string, { typed: string; file: UploadedFile | null; problem: string | null }>;
  /** Image files of the upload no row uses. */
  unused: string[];
}

const tidy = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\/+/, "");
const norm = (p: string) => tidy(p).toLowerCase();
const base = (p: string) => norm(p).split("/").pop() ?? "";
const stem = (p: string) => base(p).replace(/\.[a-z0-9]+$/, "");

/**
 * Finds the cells of image columns that name a file instead of a link, and
 * parks each under an address of its own (so the import treats it like any
 * image link until the moment it is sent). `files` are the upload's image files.
 */
export function parkLocalImages(sheet: Sheet, files: UploadedFile[], into: LocalImages): number {
  const columns = IMAGE_COLUMNS.filter((c) => sheet.headers.includes(c));
  if (!columns.length) return 0;
  const byPath = new Map(files.map((f) => [norm(f.name), f]));
  const byBase = new Map<string, UploadedFile[]>();
  const byStem = new Map<string, UploadedFile[]>();
  for (const f of files) {
    (byBase.get(base(f.name)) ?? byBase.set(base(f.name), []).get(base(f.name))!).push(f);
    (byStem.get(stem(f.name)) ?? byStem.set(stem(f.name), []).get(stem(f.name))!).push(f);
  }
  let parked = 0;
  for (const row of sheet.rows) {
    for (const col of columns) {
      const typed = (row[col] ?? "").trim();
      if (!typed || isLink(typed)) continue;
      const exact = byPath.get(norm(typed));
      const named = exact ? [exact] : (byBase.get(base(typed)) ?? (/\.[a-z0-9]{2,5}$/i.test(typed) ? [] : (byStem.get(stem(typed)) ?? [])));
      let problem: string | null = null;
      if (!named.length) {
        problem = !files.length
          ? "is a file name, not a link, and no image files came with the sheet. To upload images with it, select them together with the sheet (or put everything in one ZIP) and keep the file names in this column"
          : OTHER_PICTURE.test(typed)
            ? `is a ${typed.split(".").pop()!.toUpperCase()} file; Shopify product images must be JPEG, PNG, WebP, GIF or HEIC. Save it as one of those`
            : `is not among the ${files.length.toLocaleString("en")} image files that came with the sheet. Check the spelling of the file name`;
      } else if (named.length > 1) {
        problem = `is in the upload ${named.length} times (${named.slice(0, 3).map((f) => f.name).join(", ")}). Write the folder too, for example ${named[0].name}`;
      }
      const file = named.length === 1 ? named[0] : null;
      // Folders stay folders in the address, so its last part is the file's own name (which is how images are compared).
      const address = LOCAL_PREFIX + tidy(file ? file.name : typed).split("/").map(encodeURIComponent).join("/").replace(/^$/, "file");
      into.refs.set(address, { typed, file, problem });
      row[col] = address;
      parked++;
    }
  }
  return parked;
}

/** Puts the file names back where they were parked (for the results file). */
export function unparkRow(row: Record<string, string>, images: LocalImages) {
  for (const col of IMAGE_COLUMNS) {
    const v = row[col];
    if (v && isLocalRef(v)) row[col] = images.refs.get(v)?.typed ?? localName(v);
  }
}

/** Replaces every parked address inside a mutation's variables with the address Shopify gave for the file. */
export async function sendLocalImages<T>(value: T, upload: (address: string) => Promise<string>): Promise<T> {
  if (typeof value === "string") return (isLocalRef(value) ? await upload(value) : value) as T;
  if (Array.isArray(value)) return (await Promise.all(value.map((v) => sendLocalImages(v, upload)))) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await sendLocalImages(v, upload);
    return out as T;
  }
  return value;
}

export const MIME: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic" };
