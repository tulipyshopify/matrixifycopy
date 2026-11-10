import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createExportJob, createSchedule, entityCatalog, parseExportConfig } from "../lib/jobs/jobs.server";
import { ExportForm, type ExportPayload } from "../components/ExportForm";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { entities: entityCatalog().filter((e) => e.canExport) };
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
  const { entities } = useLoaderData<typeof loader>();
  return (
    <s-page heading="New export" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      <ExportForm entities={entities} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
