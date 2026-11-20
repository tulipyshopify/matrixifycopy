import { zipSync } from "fflate";

/** One ZIP of the sheet and its image files (stored, not compressed: images don't compress). */
export async function bundleUpload(sheet: File, pictures: File[]): Promise<File> {
  const entries: Record<string, [Uint8Array, { level: 0 }]> = { [sheet.name]: [new Uint8Array(await sheet.arrayBuffer()), { level: 0 }] };
  for (const p of pictures.slice(0, 5000)) {
    // Two files of the same name can't both be meant: the first is kept.
    const name = p.name.replace(/[\\/]+/g, "_");
    if (!(name in entries)) entries[name] = [new Uint8Array(await p.arrayBuffer()), { level: 0 }];
  }
  return new File([zipSync(entries) as BlobPart], `${sheet.name.replace(/\.[a-z]+$/i, "")}.zip`, { type: "application/zip" });
}
