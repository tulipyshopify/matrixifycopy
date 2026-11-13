import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  createImportJob,
  createSchedule,
  createUrlImportJob,
  editSchedule,
  scheduleForEdit,
  entityCatalog,
  parseImportOptions,
} from "../lib/jobs/jobs.server";
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
      }
    : null;
  return { editing, entities: entityCatalog().filter((e) => e.canImport), maxUploadMb: MAX_UPLOAD_MB };
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
      const url = String(form.get("url") ?? "").trim();
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
      if (!/^(https?|ftps?):\/\//i.test(url)) throw new Error("Enter an http(s):// or ftp:// URL");
      const job = await createUrlImportJob(session.shop, url, options);
      return redirect(`/app/jobs/${job.id}`);
    }
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Choose a file to import");
    if (!/\.(xlsx|csv|zip)$/i.test(file.name)) throw new Error("Upload an .xlsx, .csv or .zip file");
    const job = await createImportJob(session.shop, file, options);
    return redirect(`/app/jobs/${job.id}`);
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};

export default function NewImport() {
  const { entities, maxUploadMb, editing } = useLoaderData<typeof loader>();
  return (
    <s-page heading={editing ? `Edit schedule: ${editing.name}` : "New import"} inlineSize="base">
      <s-link slot="breadcrumb-actions" href={editing ? "/app/schedules" : "/app"}>
        {editing ? "Schedules" : "Home"}
      </s-link>
      <ImportForm key={editing?.id ?? "new"} maxUploadMb={maxUploadMb} editing={editing} />
      <s-section heading="Recognised sheets" slot="aside">
        <s-paragraph>
          Sheet (or CSV file) names decide what is imported. Export first to get a file in the right layout.
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
