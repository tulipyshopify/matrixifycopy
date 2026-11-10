import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { LoaderFunctionArgs } from "react-router";
import { latestPublicFile } from "../lib/jobs/jobs.server";
import { resolveStored } from "../lib/jobs/storage.server";

const TYPES: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
};

/**
 * Permanent link of a scheduled export. The address never changes; each run of
 * the schedule replaces what it serves. Access is by the secret token only.
 * An optional extension (/files/<token>.csv) is accepted for tools that need one.
 */
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const token = (params.token ?? "").replace(/\.(xlsx|csv|zip)$/i, "");
  const found = await latestPublicFile(token);
  if (!found) return new Response("Not found", { status: 404 });
  if (!found.job?.resultFile) {
    return new Response("This export has not finished its first run yet. Try again shortly.", { status: 404 });
  }
  const file = resolveStored(found.job.resultFile);
  if (!fs.existsSync(file)) return new Response("File no longer available", { status: 410 });
  const stat = await fs.promises.stat(file);
  const ext = path.extname(file).toLowerCase();
  // Stable file name (no timestamp) so downloads overwrite the previous copy.
  const name = `${(found.schedule.name || "Export").replace(/[^\w.-]+/g, "_")}${ext}`;
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${name}"`,
      "Last-Modified": stat.mtime.toUTCString(),
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
};
