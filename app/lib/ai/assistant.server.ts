import Anthropic from "@anthropic-ai/sdk";
import prisma from "../../db.server";
import { shopTimezone } from "../core/lookups";
import type { Gql } from "../core/types";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import { DATE_PRESETS, DATE_UNITS, FILTER_OPS, opsFor } from "../core/types";
import { ENTITIES, getEntity } from "../entities";
import { parseExportConfig } from "../jobs/jobs.server";
import type { ExportConfig } from "../jobs/runner.server";
import type { ChangeSpec } from "./changes";
export { changeColumns } from "./changes";
export type { ChangeSpec } from "./changes";

/**
 * "Ask Bulkport": a sentence in, a checked plan out. Claude only fills in a
 * fixed form - the data type, filters, date range, columns and (for changes)
 * a short list of allowed actions. The app validates it exactly like a
 * hand-made export, and a change always runs as a preview first.
 */

const MODEL = "claude-opus-5-5";

export function assistantConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Which stores may use it (it has a running cost): ASSIST_SHOPS, "*" for all. */
export function assistantAllowed(shop: string): boolean {
  const list = (process.env.ASSIST_SHOPS ?? "*").split(/[,\s]+/).filter(Boolean);
  return assistantConfigured() && (list.includes("*") || list.includes(shop));
}

/** Data types a change can target: importable and found by ID. */
const CHANGEABLE = ENTITIES.filter((e) => e.import && e.export && e.import.keyColumns.includes("ID")).map((e) => e.key);

const Change = z.object({
  action: z.enum(["add_tags", "remove_tags", "set_column", "set_metafield"]),
  /** set_column: an importable column of the data type, e.g. "Vendor", "Status". */
  column: z.string().nullable(),
  /** Tags (comma separated), the column value, or the metafield value. */
  value: z.string(),
  /** set_metafield: "namespace.key". */
  metafield: z.string().nullable(),
  /** set_metafield: Shopify metafield type, e.g. single_line_text_field, number_decimal, boolean. */
  metafield_type: z.string().nullable(),
});

const Plan = z.object({
  /** "export": a file to download. "change": update items in the store. "unclear": ask again. */
  kind: z.enum(["export", "change", "unclear"]),
  /** One or two sentences, in plain English, of what will happen. */
  explanation: z.string(),
  entity: z.string(),
  filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.string(), value2: z.string().nullable() })),
  date_range: z
    .object({
      field: z.string(),
      preset: z.string(),
      amount: z.number().nullable(),
      unit: z.string().nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
    })
    .nullable(),
  /** Export only: the columns wanted, in order; null for every column. */
  columns: z.array(z.string()).nullable(),
  /** Change only. */
  changes: z.array(Change),
});

export type AssistantPlan = z.infer<typeof Plan>;

/** The fixed part of the prompt: what each data type has. Cached between requests. */
function catalog(): string {
  return ENTITIES.filter((e) => e.export)
    .map((e) => {
      const filters = (e.filters ?? [])
        .map((f) => {
          const ops = opsFor(f).join("|");
          const opts = f.options ? ` values: ${f.options.map((o) => o.value).join("|")}` : "";
          return `    - ${f.key} (${f.label}, ${f.type}; ops: ${ops}${opts}${f.help ? `; ${f.help}` : ""})`;
        })
        .join("\n");
      return `## ${e.key} ("${e.sheet}")${CHANGEABLE.includes(e.key) ? "" : " - export only"}\n  ${e.description}\n  Filters:\n${filters || "    (none)"}\n  Columns: ${e.columns.join(" | ")}`;
    })
    .join("\n\n");
}

const SYSTEM = () => `You turn a Shopify merchant's request into a plan for Bulkport, a bulk export/import app. You only fill in the plan; the app checks it and shows it to the merchant before anything runs.

Rules:
- kind "export" when they want data out (a file, a list, a report). kind "change" when they want to update items in the store. kind "unclear" when the request is ambiguous, asks for something outside these options (deleting items, prices maths, anything you can't express), or names a data type that doesn't exist; then say in "explanation" what to clarify, and leave the other fields minimal.
- Use only the data types, filter fields, operators and column names listed below, spelled exactly. Changes are possible only on data types not marked "export only".
- Filters are combined with AND. "is one of" is op "any_of" with comma-separated values. Dates in filters are YYYY-MM-DD. For relative periods use date_range: preset one of ${DATE_PRESETS.map((p) => p.value).join(", ")}; "last_n" needs amount and unit (${DATE_UNITS.join(", ")}); "custom" needs from/to (YYYY-MM-DD).
- For exports, list only the columns the request needs (always include ID, plus the name/title column), or null when they want everything.
- For changes: add_tags/remove_tags take comma-separated tags; set_column takes an existing column name and its new value as it would appear in an import file; set_metafield takes "namespace.key", its value and its Shopify type. Never invent an action. Changes apply to every item the filters match, so the filters must narrow it exactly to what was asked.
- Write "explanation" for the merchant: short, plain English, no field names in code form.

Data types:

${catalog()}`;

let client: Anthropic | null = null;

/** Asks Claude for a plan. `now` and `timezone` let it resolve "last week" etc. */
export async function askForPlan(prompt: string, ctx: { now: Date; timezone: string }, anthropic?: Pick<Anthropic, "beta">): Promise<AssistantPlan> {
  const text = prompt.trim().slice(0, 2000);
  if (!text) throw new Error("Type what you want to do");
  const api = anthropic ?? (client ??= new Anthropic());
  const response = await api.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    // Retried on another model if this one declines.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(Plan) },
    system: [{ type: "text", text: SYSTEM(), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Today is ${ctx.now.toISOString().slice(0, 10)} (store time zone ${ctx.timezone}).\n\nRequest: ${text}` }],
  });
  if (response.stop_reason === "refusal") throw new Error("That request can't be turned into a plan. Try wording it as an export or a change to items.");
  if (!response.parsed_output) throw new Error("Couldn't understand that. Try saying which data (products, orders…) and what to do with it.");
  return response.parsed_output;
}

/** What the app accepts from a plan, after the same checks as a hand-made set-up. */
export interface CheckedPlan {
  kind: "export" | "change";
  explanation: string;
  entity: string;
  config: ExportConfig;
  changes: ChangeSpec[];
}

/** Validates a plan. Throws with a message the merchant can act on. */
export function checkPlan(plan: AssistantPlan): CheckedPlan {
  if (plan.kind === "unclear") throw new Error(plan.explanation || "Please say a bit more about what you want.");
  const e = getEntity(plan.entity);
  if (!e?.export) throw new Error(`"${plan.entity}" isn't a data type Bulkport can work with`);
  const options: Record<string, unknown> = {
    filters: plan.filters.map((f) => ({ field: f.field, op: f.op, value: f.value, ...(f.value2 ? { value2: f.value2 } : {}) })),
  };
  if (plan.date_range) {
    const r = plan.date_range;
    options.dateRange = { field: r.field, preset: r.preset, ...(r.amount ? { amount: r.amount } : {}), ...(r.unit ? { unit: r.unit } : {}), ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}) };
  }
  for (const f of plan.filters) {
    const field = e.filters?.find((x) => x.key === f.field);
    if (field && !FILTER_OPS[field.type].includes(f.op as any)) throw new Error(`Can't filter ${field.label} that way`);
  }
  if (plan.kind === "export" && plan.columns?.length) options.columns = plan.columns;
  // parseExportConfig checks every field, operator, value, date and column.
  const config = parseExportConfig({ entities: [{ entity: e.key, options }] });

  if (plan.kind === "export") return { kind: "export", explanation: plan.explanation, entity: e.key, config, changes: [] };

  if (!CHANGEABLE.includes(e.key)) throw new Error(`${e.sheet} can only be exported, not changed in bulk`);
  if (!plan.changes.length) throw new Error("The request didn't say what to change");
  if (plan.changes.length > 10) throw new Error("Too many changes at once; split the request");
  const changes: ChangeSpec[] = plan.changes.map((c) => {
    if (c.action === "add_tags" || c.action === "remove_tags") {
      if (!e.columns.includes("Tags")) throw new Error(`${e.sheet} have no tags`);
      if (!c.value.trim()) throw new Error("No tags given");
      return { action: c.action, value: c.value.trim() };
    }
    if (c.action === "set_column") {
      const column = c.column ?? "";
      if (!e.columns.includes(column) || column === "ID" || column === "Command") throw new Error(`"${column}" isn't a column that can be changed`);
      return { action: c.action, column, value: c.value };
    }
    const m = /^([\w-]+)\.([\w-]+)$/.exec(c.metafield ?? "");
    if (!m) throw new Error(`"${c.metafield}" isn't a metafield (namespace.key)`);
    if (!/^[a-z_.]+$/.test(c.metafield_type ?? "")) throw new Error(`Unknown metafield type "${c.metafield_type}"`);
    return { action: c.action, metafield: c.metafield!, metafieldType: c.metafield_type!, value: c.value };
  });
  return { kind: "change", explanation: plan.explanation, entity: e.key, config, changes };
}


// --- Requests ---------------------------------------------------------------------


/** Asks, checks and records one request. Returns the log entry and what to show. */
export async function ask(shop: string, prompt: string, gql: Gql, anthropic?: Pick<Anthropic, "beta">) {
  if (!assistantAllowed(shop)) throw new Error("Ask Bulkport isn't switched on for this store");
  // A few requests a minute is plenty; this also caps the cost.
  const recent = await prisma.askLog.count({ where: { shop, createdAt: { gte: new Date(Date.now() - 60_000) } } });
  if (recent >= 6) throw new Error("Too many requests in a minute. Wait a moment and try again.");
  const timezone = await shopTimezone(gql).catch(() => "UTC");
  let checked: CheckedPlan | null = null;
  let error: string | null = null;
  try {
    checked = checkPlan(await askForPlan(prompt, { now: new Date(), timezone }, anthropic));
  } catch (e: any) {
    error = e instanceof Anthropic.APIError ? "The assistant is unavailable right now. Try again in a minute." : (e?.message ?? String(e));
    if (e instanceof Anthropic.APIError) console.error("[ask] Claude API error", e.status, e.message);
  }
  const entry = await prisma.askLog.create({
    data: { shop, prompt: prompt.trim().slice(0, 2000), kind: checked?.kind ?? "error", result: JSON.stringify(checked ?? { error }) },
  });
  return { id: entry.id, plan: checked, error };
}

/** A recorded export plan, as the export form's starting set-up. */
export async function askedExport(shop: string, id: string) {
  const entry = await prisma.askLog.findFirst({ where: { id, shop, kind: "export" } });
  if (!entry) return null;
  const plan = JSON.parse(entry.result) as CheckedPlan;
  return { entities: plan.config.entities, format: "xlsx", prompt: entry.prompt };
}

/** Starts the preview of a recorded change. */
export async function startChangePreview(shop: string, id: string) {
  const entry = await prisma.askLog.findFirst({ where: { id, shop, kind: "change" } });
  if (!entry) throw new Error("That request can't be found any more. Ask again.");
  const plan = JSON.parse(entry.result) as CheckedPlan;
  return prisma.job.create({
    data: {
      shop,
      type: "import",
      name: `Change: ${entry.prompt.slice(0, 80)}`,
      config: JSON.stringify({
        options: { dryRun: true, defaultCommand: "UPDATE" },
        generate: { entity: plan.entity, options: plan.config.entities[0].options, changes: plan.changes, prompt: entry.prompt },
      }),
    },
  });
}
