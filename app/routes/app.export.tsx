import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { userOf } from "../lib/user.server";
import { createExportJob, createSchedule, editSchedule, entityCatalog, scheduleForEdit, latestExportPreset, listPresets, parseExportConfig } from "../lib/jobs/jobs.server";
import { ExportForm, type ExportPayload } from "../components/ExportForm";
import { askedExport } from "../lib/ai/assistant.server";
import { fixExport } from "../lib/check/check.server";
import { getTemplate } from "../lib/jobs/templates";
import { ALL_RULES } from "../lib/check/rules";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const { session } = auth;
  const user = userOf(auth);
  const params = new URL(request.url).searchParams;
  const editId = params.get("schedule");
  const editing = editId ? await scheduleForEdit(session.shop, editId, "export") : null;
  if (editId && !editing) throw new Response("Schedule not found", { status: 404 });
  if (editing) {
    const { config, ...schedule } = editing;
    return {
      entities: entityCatalog().filter((e) => e.canExport),
      presets: await listPresets(session.shop, user),
      latest: { entities: config.entities ?? [], format: schedule.format },
      editing: schedule,
    };
  }
  return {
    editing: null,
    entities: entityCatalog().filter((e) => e.canExport),
    presets: await listPresets(session.shop, user),
    // What the form starts from, by name, so "Preset" doesn't say "Latest export" for a template.
    startName: params.get("check")
      ? `Data check: ${ALL_RULES.find((r) => r.key === params.get("rule"))?.title ?? "products to fix"}`
      : getTemplate(params.get("template"))
        ? `Template: ${getTemplate(params.get("template"))!.title}`
        : params.get("ask")
          ? "Your request"
          : params.get("from")
            ? "The export you opened"
            : "Latest export (without its filters)",
    // "Edit and export again" on a job page opens the form with that job's set-up.
    // "Adjust first" from Ask Bulkport opens its set-up; "Edit and export again" a job's.
    latest: params.get("check")
      ? ((await fixExport(session.shop, params.get("check")!, params.get("rule") ?? "")) ?? (await latestExportPreset(session.shop)))
      : getTemplate(params.get("template"))
      ? { entities: parseExportConfig({ entities: getTemplate(params.get("template"))!.entities }).entities, format: "xlsx" }
      : params.get("ask")
      ? ((await askedExport(session.shop, params.get("ask")!)) ?? (await latestExportPreset(session.shop)))
      : params.get("from")
      ? await latestExportPreset(session.shop, params.get("from")!)
      : withoutFilters(await latestExportPreset(session.shop)),
  };
};


/**
 * A plain "New export" starts from the last export's data and columns, but
 * never from its filters: those belonged to whoever ran it, for that one job.
 */
function withoutFilters<T extends { entities: Array<{ entity: string; options: any }> } | null>(preset: T): T {
  if (!preset) return preset;
  return { ...preset, entities: preset.entities.map((e) => ({ ...e, options: { ...e.options, filters: undefined, dateRange: undefined, query: undefined, limit: undefined } })) };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const { session, redirect } = auth;
  const user = userOf(auth);
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
  const data = useLoaderData<typeof loader>();
  const { entities, presets, latest, editing } = data;
  return (
    <s-page heading={editing ? `Edit schedule: ${editing.name}` : "New export"} inlineSize="large">
      <s-link slot="breadcrumb-actions" href={editing ? "/app/schedules" : "/app"}>
        {editing ? "Schedules" : "Home"}
      </s-link>
      <div className="bp-column">
        <ExportForm key={editing?.id ?? "new"} entities={entities} presets={presets} latest={latest} editing={editing} startName={"startName" in data ? data.startName : undefined} />
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
