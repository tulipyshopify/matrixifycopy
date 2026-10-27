import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { resolveStored, verifyDownload } from "../lib/jobs/storage.server";

const TYPES: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
};

/** Streams a job's result or input file. Access is by signed, expiring link. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") ?? "";
  const jobId = params.jobId!;
  if (!verifyDownload(jobId, kind, url.searchParams.get("exp") ?? "", url.searchParams.get("sig") ?? "")) {
    return new Response("Link expired or invalid. Open the job in the app to get a new link.", { status: 403 });
  }
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  const stored = kind === "input" ? job?.inputFile : job?.resultFile;
  if (!stored) return new Response("Not found", { status: 404 });
  const file = resolveStored(stored);
  if (!fs.existsSync(file)) return new Response("File no longer available", { status: 410 });

  const stat = await fs.promises.stat(file);
  let name = path.basename(file);
  if (kind === "input") name = job?.inputName ?? name.replace(/^input-/, "");
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
    },
  });
};
