import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createGql } from "../lib/core/gql";
import { ask, startChangePreview } from "../lib/ai/assistant.server";
import { dateRangeText, filterText } from "../components/ExportDetails";
import { createExportJob, entityCatalog } from "../lib/jobs/jobs.server";

/** "Ask Bulkport": turns a sentence into an export set-up or a change preview. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "ask");
  try {
    if (intent === "preview") {
      const job = await startChangePreview(session.shop, String(form.get("id")));
      return redirect(`/app/jobs/${job.id}`);
    }
    if (intent === "export") {
      const { askedExport } = await import("../lib/ai/assistant.server");
      const plan = await askedExport(session.shop, String(form.get("id")));
      if (!plan) throw new Error("That request can't be found any more. Ask again.");
      const job = await createExportJob(session.shop, { entities: plan.entities }, "xlsx", "");
      return redirect(`/app/jobs/${job.id}`);
    }
    const gql = createGql(async (query, variables) => (await admin.graphql(query, { variables })).json());
    const { id, plan, error } = await ask(session.shop, String(form.get("prompt") ?? ""), gql);
    if (!plan) return { error: error ?? "Couldn't understand that" };
    const e = entityCatalog().find((x) => x.key === plan.entity)!;
    const o = plan.config.entities[0].options;
    return {
      id,
      kind: plan.kind,
      explanation: plan.explanation,
      dataType: e.sheet,
      filters: [...(o.dateRange ? [dateRangeText(e, o.dateRange)] : []), ...(o.filters ?? []).map((f) => filterText(e, f))],
      columns: o.columns ? o.columns.length : e.columns.length,
      changes: plan.changes.map((c) =>
        c.action === "add_tags"
          ? `Add tags: ${c.value}`
          : c.action === "remove_tags"
            ? `Remove tags: ${c.value}`
            : c.action === "set_column"
              ? `Set ${c.column} to "${c.value}"`
              : `Set metafield ${c.metafield} to "${c.value}"`,
      ),
    };
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};
