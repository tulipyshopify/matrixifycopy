import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createExportJob, createSchedule, entityCatalog, latestExportPreset, listPresets, parseExportConfig } from "../lib/jobs/jobs.server";
import { ExportForm, type ExportPayload } from "../components/ExportForm";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return {
    entities: entityCatalog().filter((e) => e.canExport),
    presets: await listPresets(session.shop),
    latest: await latestExportPreset(session.shop),
  };
};


export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const body = (await request.json()) as ExportPayload;
  try {
    const config = parseExportConfig(body);
    if (body.schedule) {
      await createSchedule(session.shop, {
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
  const { entities, presets, latest } = useLoaderData<typeof loader>();
  return (
    <s-page heading="New export" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      <div className="bp-column">
        <ExportForm entities={entities} presets={presets} latest={latest} />
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
