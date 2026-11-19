import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ApiError, bearerKey, checkKey } from "../lib/api/keys.server";
import {
  MAX_API_UPLOAD_MB,
  applyPreview,
  cancel,
  jobView,
  listJobViews,
  previewItems,
  resultFile,
  sheetList,
  startExport,
  startImport,
} from "../lib/api/service.server";

/**
 * The Bulkport API (v1). Sign in with "Authorization: Bearer <access key>".
 *
 *   GET  /api/v1/sheets                what can be exported and imported
 *   GET  /api/v1/sheets/<name>         columns, groups and filters of one sheet
 *   GET  /api/v1/jobs                  recent jobs
 *   GET  /api/v1/jobs/<id>             one job
 *   GET  /api/v1/jobs/<id>/result      the result file
 *   GET  /api/v1/jobs/<id>/preview     what an import preview would change
 *   POST /api/v1/exports               start an export (JSON)
 *   POST /api/v1/imports               preview or run an import (file, CSV text or link)
 *   POST /api/v1/jobs/<id>/apply       run a finished preview for real
 *   POST /api/v1/jobs/<id>/cancel
 */

const TYPES: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

function fail(e: any) {
  if (e instanceof ApiError) return json({ error: e.message }, e.status);
  if (e instanceof Response) return e;
  console.error("[api]", e);
  return json({ error: "Something went wrong on our side" }, 500);
}

const parts = (params: { "*"?: string }) => (params["*"] ?? "").split("/").filter(Boolean);

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const auth = await checkKey(bearerKey(request));
    const [a, b, c] = parts(params);
    const url = new URL(request.url);
    if (a === "sheets" && !c) return json(b ? sheetList(decodeURIComponent(b)) : { sheets: sheetList() });
    if (a === "jobs" && !b) return json({ jobs: await listJobViews(auth.shop, Number(url.searchParams.get("limit") ?? 20)) });
    if (a === "jobs" && b && !c) return json(await jobView(auth.shop, b));
    if (a === "jobs" && c === "preview") return json({ sheets: await previewItems(auth.shop, b, Number(url.searchParams.get("limit") ?? 50)) });
    if (a === "jobs" && c === "result") {
      const { file, name } = await resultFile(auth.shop, b);
      const stat = await fs.promises.stat(file);
      return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
        headers: {
          "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "Content-Length": String(stat.size),
          "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    throw new ApiError(404, "No such address. See /api/v1/sheets, /api/v1/jobs, /api/v1/exports, /api/v1/imports");
  } catch (e) {
    return fail(e);
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    const auth = await checkKey(bearerKey(request));
    if (request.method !== "POST") throw new ApiError(405, "Use POST");
    const [a, b, c] = parts(params);
    const type = request.headers.get("content-type") ?? "";
    const body = async () => {
      if (!type.includes("json")) return {};
      try {
        return (await request.json()) ?? {};
      } catch {
        throw new ApiError(400, "The request body is not valid JSON");
      }
    };
    if (a === "exports" && !b) return json(await startExport(auth, (await body()) as any), 201);
    if (a === "imports" && !b) {
      if (Number(request.headers.get("content-length") ?? 0) > MAX_API_UPLOAD_MB * 1024 * 1024) throw new ApiError(413, `The file is larger than ${MAX_API_UPLOAD_MB} MB`);
      if (type.includes("multipart/form-data")) {
        const form = await request.formData();
        const file = form.get("file");
        return json(
          await startImport(auth, {
            file: file instanceof File ? file : undefined,
            url: form.get("url") ? String(form.get("url")) : undefined,
            command: form.get("command") ? String(form.get("command")) : undefined,
            apply: String(form.get("apply") ?? "") === "true",
            batch: String(form.get("batch") ?? "") === "true",
            concurrency: form.get("concurrency") ? Number(form.get("concurrency")) : undefined,
          }),
          201,
        );
      }
      const b2 = (await body()) as any;
      return json(await startImport(auth, { csv: b2.csv, fileName: b2.file_name, url: b2.url, command: b2.command, apply: b2.apply === true, batch: b2.batch === true, concurrency: b2.concurrency }), 201);
    }
    if (a === "jobs" && b && c === "apply") return json(await applyPreview(auth, b, ((await body()) as any).confirm_deletes === true), 201);
    if (a === "jobs" && b && c === "cancel") return json(await cancel(auth, b));
    throw new ApiError(404, "No such address");
  } catch (e) {
    return fail(e);
  }
};
