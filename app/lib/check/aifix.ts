import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import Papa from "papaparse";
import * as z from "zod/v4";
import type { BulkRunner, Gql, Logger, Row } from "../core/types";
import { getEntity } from "../entities";

/**
 * AI-drafted fixes for the data check: Claude writes the missing description
 * or search title/description for the flagged products, from the product's
 * own data only. The drafts become an import file that is previewed first;
 * nothing reaches the store until "Import for real".
 */

const MODEL = "claude-opus-5-5";

/** Rules whose fix is text Claude can draft, and the columns it fills. */
export const AI_FIXABLE: Record<string, { columns: string[]; what: string }> = {
  no_description: { columns: ["Body HTML"], what: "descriptions" },
  short_description: { columns: ["Body HTML"], what: "descriptions" },
  no_seo: { columns: ["SEO Title", "SEO Description"], what: "search titles and descriptions" },
};

/** Products drafted per run: keeps a run quick, reviewable and cheap. */
export const MAX_AI_PRODUCTS = 40;
const BATCH = 10;

export interface AiFixSpec {
  rule: string;
  ids: string[];
}

const Drafts = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      /** HTML: one or two short <p> paragraphs. Null when not asked for. */
      description_html: z.string().nullable(),
      seo_title: z.string().nullable(),
      seo_description: z.string().nullable(),
    }),
  ),
});

const SYSTEM = `You write product copy for a Shopify store's catalogue. The text is read by shoppers and by AI shopping agents (ChatGPT, Copilot, Shop), which match products to what people ask for.

Rules:
- Use only the facts given for each product: title, vendor, type, category, tags, options, and any existing text. Never invent materials, dimensions, weights, certifications, guarantees, compatibility or anything else that isn't there. If little is known, write less.
- Plain and specific: what it is, who or what it's for, and the options it comes in. No hype ("premium", "perfect", "must-have"), no exclamation marks, no emojis.
- Write in the language and spelling of the product's existing text and title (British English stays British).
- description_html: 50 to 110 words in one or two <p> paragraphs. HTML tags allowed: <p> only.
- seo_title: at most 60 characters, the product name first, then the brand if it fits.
- seo_description: at most 155 characters, one sentence that would make sense as a search result.
- Return every product id you were given, exactly as given. Fill only the fields asked for and set the others to null.`;

interface ProductFacts {
  id: string;
  title: string;
  vendor: string;
  type: string;
  category: string;
  tags: string;
  options: string[];
  description: string;
  bodyHtml: string;
  seoTitle: string;
  seoDescription: string;
}

const plain = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function facts(rows: Row[]): ProductFacts | null {
  const top = rows.find((r) => /^true$/i.test(r["Top Row"] ?? "")) ?? rows[0];
  if (!top?.ID) return null;
  const options = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const n of [1, 2, 3]) {
      const name = r[`Option${n} Name`];
      const value = r[`Option${n} Value`];
      if (!name || !value || /^(title|default title)$/i.test(value)) continue;
      if (!options.has(name)) options.set(name, new Set());
      options.get(name)!.add(value);
    }
  }
  return {
    id: top.ID,
    title: top.Title ?? "",
    vendor: top.Vendor ?? "",
    type: top.Type ?? "",
    category: top["Category: Name"] ?? "",
    tags: top.Tags ?? "",
    options: [...options].map(([n, v]) => `${n}: ${[...v].slice(0, 12).join(", ")}`),
    description: plain(top["Body HTML"] ?? "").slice(0, 1500),
    bodyHtml: top["Body HTML"] ?? "",
    seoTitle: top["SEO Title"] ?? "",
    seoDescription: top["SEO Description"] ?? "",
  };
}

let client: Anthropic | null = null;

/** Builds the import file of drafts for a rule's flagged products. */
export async function generateAiFixFile(
  spec: AiFixSpec,
  deps: { gql: Gql; bulk: BulkRunner; log: Logger; isCancelled?: () => Promise<boolean>; anthropic?: Pick<Anthropic, "beta"> },
  dir: string,
): Promise<{ file: string; name: string; items: number }> {
  const fix = AI_FIXABLE[spec.rule];
  if (!fix) throw new Error("This problem can't be drafted by AI");
  const ids = spec.ids.filter((id) => /^\d+$/.test(id)).slice(0, MAX_AI_PRODUCTS);
  if (!ids.length) throw new Error("No products to draft for");
  const products = getEntity("products")!;
  const found: ProductFacts[] = [];
  deps.log(`Reading ${ids.length} products`);
  await products.export!(
    {
      gql: deps.gql,
      bulk: deps.bulk,
      options: { groups: ["variants", "seo"], filters: [{ field: "id", op: "any_of", value: ids.join(",") }] },
      log: deps.log,
      cache: new Map(),
      progress: () => {},
    },
    async (rows) => {
      const f = facts(rows);
      if (f && ids.includes(f.id)) found.push(f);
    },
  );
  if (!found.length) throw new Error("None of those products could be read");

  const api = deps.anthropic ?? (client ??= new Anthropic());
  const wantsBody = fix.columns.includes("Body HTML");
  const drafts = new Map<string, z.infer<typeof Drafts>["products"][number]>();
  for (let i = 0; i < found.length; i += BATCH) {
    if (deps.isCancelled && (await deps.isCancelled())) throw new Error("Cancelled");
    const batch = found.slice(i, i + BATCH);
    deps.log(`Drafting ${fix.what} for products ${i + 1}-${i + batch.length} of ${found.length}`);
    const ask = batch.map((p) => ({
      id: p.id,
      title: p.title,
      vendor: p.vendor,
      type: p.type,
      category: p.category,
      tags: p.tags,
      options: p.options,
      existing_description: p.description,
      write: wantsBody ? ["description_html"] : [...(p.seoTitle ? [] : ["seo_title"]), ...(p.seoDescription ? [] : ["seo_description"])],
    }));
    const response = await api.beta.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(Drafts) },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Write the fields listed under "write" for each product.\n\n${JSON.stringify(ask, null, 1)}` }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      deps.log(`  No drafts came back for this group; those products are left out`);
      continue;
    }
    for (const d of response.parsed_output.products) if (batch.some((p) => p.id === d.id)) drafts.set(d.id, d);
  }

  // A blank cell in an included column would clear that value on import, so every
  // cell carries either the draft or the product's current value.
  const rows: string[][] = [];
  for (const p of found) {
    const d = drafts.get(p.id);
    if (!d) continue;
    const cells: Record<string, string> = {
      "Body HTML": (d.description_html ?? "").trim() || p.bodyHtml,
      "SEO Title": p.seoTitle || (d.seo_title ?? "").trim().slice(0, 70),
      "SEO Description": p.seoDescription || (d.seo_description ?? "").trim().slice(0, 320),
    };
    // Nothing usable drafted for this product: leave it out.
    if (fix.columns.every((c) => !cells[c] || (c === "Body HTML" && cells[c] === p.bodyHtml))) continue;
    rows.push([p.id, "UPDATE", p.title, ...fix.columns.map((c) => cells[c])]);
  }
  if (!rows.length) throw new Error("No drafts could be written for these products");
  deps.log(`${rows.length} drafts written. Review them in the preview, or download the file to edit them, before importing.`);
  const name = "Products.csv";
  const file = path.join(dir, "input-Products.csv");
  // Title is there for the reader; it is the product's own title, so importing it changes nothing.
  await fs.promises.writeFile(file, "﻿" + Papa.unparse({ fields: ["ID", "Command", "Title", ...fix.columns], data: rows }, { newline: "\r\n" }));
  return { file, name, items: rows.length };
}
