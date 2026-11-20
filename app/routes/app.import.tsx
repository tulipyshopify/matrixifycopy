import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { bundleUpload } from "../lib/jobs/bundle";
import {
  createImportJob,
  discardJob,
  sameUploadBefore,
  createSchedule,
  createUrlImportJob,
  editSchedule,
  scheduleForEdit,
  entityCatalog,
  parseImportOptions,
} from "../lib/jobs/jobs.server";
import { assertFitsInMemory } from "../lib/jobs/runner.server";
import { ImportForm } from "../components/ImportForm";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 200);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const editId = new URL(request.url).searchParams.get("schedule");
  const found = editId ? await scheduleForEdit(session.shop, editId, "import") : null;
  if (editId && !found) throw new Response("Schedule not found", { status: 404 });
  const editing = found
    ? {
        id: found.id,
        name: found.name,
        intervalMinutes: found.intervalMinutes,
        runAt: found.runAt,
        timezone: found.timezone,
        weekday: found.weekday,
        sourceUrl: found.sourceUrl,
        defaultCommand: String(found.config?.options?.defaultCommand ?? "MERGE"),
        dryRun: !!found.config?.options?.dryRun,
        concurrency: Number(found.config?.options?.concurrency ?? 4),
        batch: !!found.config?.options?.batch,
        hold: !!found.config?.options?.hold,
      }
    : null;
  return { editing, scheduleFirst: new URL(request.url).searchParams.get("scheduled") === "1", entities: entityCatalog().filter((e) => e.canImport), maxUploadMb: MAX_UPLOAD_MB };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_UPLOAD_MB * 1024 * 1024) return { error: `File is larger than ${MAX_UPLOAD_MB} MB` };
  const form = await request.formData();
  try {
    const options = parseImportOptions(JSON.parse(String(form.get("options") ?? "{}")));
    const source = String(form.get("source"));
    if (source === "url") {
      let url = String(form.get("url") ?? "").trim();
      // The sign-in comes in fields of its own, so it never sits in a visible link.
      const username = String(form.get("username") ?? "");
      const password = String(form.get("password") ?? "");
      if (username || password) {
        try {
          const u = new URL(url);
          if (username && !password && u.password === "****") throw new Error("Enter the password as well as the user name (the saved one belongs to the old sign-in)");
          if (username) u.username = encodeURIComponent(username);
          if (password) u.password = encodeURIComponent(password);
          url = u.toString();
        } catch (e: any) {
          throw new Error(/password/.test(e?.message ?? "") ? e.message : "Enter a link starting with https://, ftp://, sftp:// or webdavs://");
        }
      }
      const interval = Number(form.get("intervalMinutes") ?? 0);
      const scheduleId = form.get("scheduleId") ? String(form.get("scheduleId")) : null;
      if (scheduleId && !(interval > 0)) throw new Error("Choose how often the import repeats");
      if (interval > 0) {
        const save = (input: Parameters<typeof createSchedule>[1]) =>
          scheduleId ? editSchedule(session.shop, scheduleId, input) : createSchedule(session.shop, input);
        await save({
          name: String(form.get("name") ?? ""),
          type: "import",
          config: { options },
          sourceUrl: url,
          intervalMinutes: interval,
          runAt: form.get("runAt") ? String(form.get("runAt")) : undefined,
          timezone: form.get("timezone") ? String(form.get("timezone")) : undefined,
          weekday: form.get("weekday") ? Number(form.get("weekday")) : undefined,
        });
        return redirect("/app/schedules");
      }
      if (!/^(https?|ftps?|sftp|webdavs?|davs?):\/\//i.test(url)) throw new Error("Enter a link starting with https://, ftp://, sftp:// or webdavs://");
      const job = await createUrlImportJob(session.shop, url, options);
      return redirect(`/app/jobs/${job.id}`);
    }
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Choose a file to import");
    // Other spreadsheet formats are let through to the reader, which says how to save each as one that is read.
    if (!/\.(xlsx|xlsm|csv|tsv|txt|zip|xls|xlsb|ods|numbers)$/i.test(file.name)) throw new Error("Upload an Excel file (.xlsx), a CSV or tab-separated file (.csv, .tsv, .txt), or a ZIP of those");
    // Image files selected with the sheet travel with it as one ZIP, which the import reads like any other.
    const pictures = form.getAll("image").filter((p): p is File => p instanceof File && p.size > 0);
    if (pictures.length) {
      if (/\.zip$/i.test(file.name)) throw new Error("Put the image files inside the ZIP, or select the sheet itself together with the images.");
      const job = await createImportJob(session.shop, await bundleUpload(file, pictures), options);
      return redirect(await afterUpload(session.shop, job));
    }
    const job = await createImportJob(session.shop, file, options);
    return redirect(await afterUpload(session.shop, job));
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};

/**
 * Straight after an upload: a file that is too large is refused now (not after waiting in the queue),
 * and the same file sent twice in a row opens the job that is already there.
 */
async function afterUpload(shop: string, job: { id: string; config: string; inputFile: string | null; inputName: string | null }): Promise<string> {
  try {
    if (job.inputFile) await assertFitsInMemory(job.inputFile, job.inputName ?? job.inputFile);
  } catch (e) {
    await discardJob(shop, job.id);
    throw e;
  }
  const same = await sameUploadBefore(shop, job).catch(() => null);
  if (same) {
    await discardJob(shop, job.id);
    return `/app/jobs/${same.id}?same=1`;
  }
  return `/app/jobs/${job.id}`;
}

export default function NewImport() {
  const { entities, maxUploadMb, editing, scheduleFirst } = useLoaderData<typeof loader>();
  return (
    <s-page heading={editing ? `Edit schedule: ${editing.name}` : scheduleFirst ? "New scheduled import" : "New import"} inlineSize="base">
      <s-link slot="breadcrumb-actions" href={editing ? "/app/schedules" : "/app"}>
        {editing ? "Schedules" : "Home"}
      </s-link>
      <ImportForm key={editing?.id ?? "new"} maxUploadMb={maxUploadMb} editing={editing} scheduleFirst={scheduleFirst} />
      <s-section heading="Recognised sheets" slot="aside">
        <s-paragraph>
          The data type is recognised from the columns, so the file can have any name. Export first to get a file in the right layout. These sheet names are always recognised:
        </s-paragraph>
        <s-unordered-list>
          {entities.map((e) => (
            <s-list-item key={e.key}>{e.sheet}</s-list-item>
          ))}
        </s-unordered-list>
        <s-link href="/app/help">Column reference</s-link>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
