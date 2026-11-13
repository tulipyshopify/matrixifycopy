import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createExportJob, createSchedule, editSchedule, entityCatalog, scheduleForEdit, latestExportPreset, listPresets, parseExportConfig } from "../lib/jobs/jobs.server";
import { ExportForm, type ExportPayload } from "../components/ExportForm";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const editId = params.get("schedule");
  const editing = editId ? await scheduleForEdit(session.shop, editId, "export") : null;
  if (editId && !editing) throw new Response("Schedule not found", { status: 404 });
  if (editing) {
    const { config, ...schedule } = editing;
    return {
      entities: entityCatalog().filter((e) => e.canExport),
      presets: await listPresets(session.shop),
      latest: { entities: config.entities ?? [], format: schedule.format },
      editing: schedule,
    };
  }
  return {
    editing: null,
    entities: entityCatalog().filter((e) => e.canExport),
    presets: await listPresets(session.shop),
    // "Edit and export again" on a job page opens the form with that job's set-up.
    latest: await latestExportPreset(session.shop, params.get("from") ?? undefined),
  };
};


export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const body = (await request.json()) as ExportPayload;
  try {
    const config = parseExportConfig(body);
    if (body.schedule) {
      const save = (input: Parameters<typeof createSchedule>[1]) =>
        body.scheduleId ? editSchedule(session.shop, body.scheduleId, input) : createSchedule(session.shop, input);
      await save({
        name: body.name,
        type: "export",
        config,
        format: body.format,
        uploadUrl: body.schedule.uploadUrl,
        publicLink: body.schedule.publicLink,
        runAt: body.schedule.runAt,
        timezone: body.schedule.timezone,
        weekday: body.schedule.weekday,
        intervalMinutes: body.schedule.intervalMinutes,
        startAt: body.schedule.startAt,
      });
      return redirect("/app/schedules");
    }
    const job = await createExportJob(session.shop, config, body.format, body.name);
    return redirect(`/app/jobs/${job.id}`);
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};

export default function NewExport() {
  const { entities, presets, latest, editing } = useLoaderData<typeof loader>();
  return (
    <s-page heading={editing ? `Edit schedule: ${editing.name}` : "New export"} inlineSize="large">
      <s-link slot="breadcrumb-actions" href={editing ? "/app/schedules" : "/app"}>
        {editing ? "Schedules" : "Home"}
      </s-link>
      <div className="bp-column">
        <ExportForm key={editing?.id ?? "new"} entities={entities} presets={presets} latest={latest} editing={editing} />
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
