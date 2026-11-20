import prisma from "../../db.server";
import type { ChangeSpec } from "../ai/changes";
import type { FilterCondition } from "../core/types";
import { getEntity } from "../entities";
import { parseFilters } from "./jobs.server";

/**
 * Quick changes: common bulk edits made without a spreadsheet. Each one picks
 * products with the export filters, builds its change file from what the
 * products hold now, and opens the normal import preview: nothing changes
 * until that preview is applied, and it can be undone like any import.
 */

export const TEXT_COLUMNS = ["Title", "Body HTML", "SEO Title", "SEO Description", "Vendor", "Type"] as const;
export const FIELD_CHOICES: Array<{ column: string; label: string; options?: string[] }> = [
  { column: "Status", label: "Status", options: ["Active", "Draft", "Archived"] },
  { column: "Vendor", label: "Vendor" },
  { column: "Type", label: "Product type" },
  { column: "Template Suffix", label: "Theme template" },
  { column: "Variant Taxable", label: "Charge tax (every variant)", options: ["TRUE", "FALSE"] },
  { column: "Variant Inventory Policy", label: "When out of stock (every variant)", options: ["deny", "continue"] },
];
/** Ways to pick the products, in the order shown. */
export const PICK_FIELDS: Array<{ key: string; label: string; op: FilterCondition["op"]; options?: string[]; hint?: string }> = [
  { key: "vendor", label: "Vendor is", op: "is" },
  { key: "product_type", label: "Product type is", op: "is" },
  { key: "tag", label: "Has the tag", op: "is" },
  { key: "status", label: "Status is", op: "is", options: ["active", "draft", "archived"] },
  { key: "title", label: "Title contains", op: "contains" },
  { key: "collection_id", label: "In collection (ID)", op: "is", hint: "The number at the end of the collection's address in Shopify admin" },
  { key: "sku", label: "Variant SKU is", op: "is" },
  { key: "is_price_reduced", label: "On sale (compare-at price set)", op: "is", options: ["true", "false"] },
];

export interface TaskInput {
  task: "prices" | "end_sale" | "replace" | "tags" | "field";
  /** Which products: every condition must hold. Empty = all products (needs `all`). */
  pick?: Array<{ field: string; value: string }>;
  /** Said outright when no condition is given: every product in the store. */
  all?: boolean;
  direction?: "up" | "down";
  by?: "percent" | "amount";
  number?: string;
  ending?: string;
  showOldPrice?: boolean;
  restorePrice?: boolean;
  column?: string;
  find?: string;
  replace?: string;
  matchCase?: boolean;
  tagAction?: "add" | "remove";
  tags?: string;
  value?: string;
}

const clean = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);

/** Checks a quick change and returns what it does, in words, and as a change to generate. */
export function planTask(input: TaskInput): { name: string; filters: FilterCondition[]; changes: ChangeSpec[] } {
  const products = getEntity("products")!;
  const picked = (input.pick ?? []).filter((p) => clean(p.value) !== "");
  if (!picked.length && !input.all) throw new Error('Choose which products to change, or tick "Every product in the store".');
  const filters = parseFilters(
    products,
    picked.map((p) => {
      const spec = PICK_FIELDS.find((f) => f.key === p.field);
      if (!spec) throw new Error("Unknown way to choose products");
      return { field: spec.key, op: spec.op, value: clean(p.value) };
    }),
  );
  const which = picked.length ? picked.map((p) => `${PICK_FIELDS.find((f) => f.key === p.field)!.label.toLowerCase()} ${clean(p.value)}`).join(", ") : "every product";
  let changes: ChangeSpec[];
  let what: string;
  switch (input.task) {
    case "prices": {
      const n = Number(clean(input.number).replace(",", ".").replace(/[%£$€]/g, ""));
      if (!Number.isFinite(n) || n <= 0) throw new Error("Enter by how much to change the prices, as a number above zero.");
      const down = input.direction === "down";
      const percent = input.by !== "amount";
      if (percent && down && n >= 100) throw new Error("A price can't go down by 100% or more.");
      if (percent && n > 500) throw new Error("That is more than 500%. Check the number.");
      const ending = clean(input.ending, 2).replace(/\D/g, "");
      changes = [{ action: "adjust_price", value: "", ...(percent ? { percent: down ? -n : n } : { amount: down ? -n : n }), ...(ending ? { ending } : {}), compareAt: down && input.showOldPrice ? "old_price" : "keep" }];
      what = `${down ? "Lower" : "Raise"} prices by ${percent ? `${n}%` : n.toFixed(2)}${ending ? `, ending in .${ending.padEnd(2, "0")}` : ""}${down && input.showOldPrice ? ", old price shown as compare-at" : ""}`;
      break;
    }
    case "end_sale":
      changes = [{ action: "end_sale", value: "", restorePrice: !!input.restorePrice }];
      what = input.restorePrice ? "End sale: prices back to the compare-at price" : "Clear compare-at prices";
      break;
    case "replace": {
      const column = clean(input.column);
      if (!(TEXT_COLUMNS as readonly string[]).includes(column)) throw new Error("Choose where to look for the text.");
      const find = String(input.find ?? "").slice(0, 500);
      if (!find.trim()) throw new Error("Enter the text to find.");
      const replace = String(input.replace ?? "").slice(0, 2000);
      changes = [{ action: "replace_text", column, find, value: replace, matchCase: !!input.matchCase }];
      what = `In ${column === "Body HTML" ? "descriptions" : column.toLowerCase()}: replace "${find}" with "${replace}"`;
      break;
    }
    case "tags": {
      const tags = clean(input.tags, 1000).split(",").map((t) => t.trim()).filter(Boolean);
      if (!tags.length) throw new Error("Enter at least one tag.");
      const remove = input.tagAction === "remove";
      changes = tags.map((t) => ({ action: remove ? ("remove_tags" as const) : ("add_tags" as const), value: t }));
      what = `${remove ? "Remove" : "Add"} tag${tags.length === 1 ? "" : "s"} ${tags.join(", ")}`;
      break;
    }
    case "field": {
      const choice = FIELD_CHOICES.find((f) => f.column === clean(input.column));
      if (!choice) throw new Error("Choose what to set.");
      const value = clean(input.value, 255);
      if (choice.options && !choice.options.includes(value)) throw new Error(`Choose a value for ${choice.label.toLowerCase()}.`);
      if (!choice.options && !value && choice.column !== "Template Suffix") throw new Error(`Enter the new ${choice.label.toLowerCase()}.`);
      changes = [{ action: "set_column", column: choice.column, value }];
      what = `Set ${choice.label.toLowerCase()} to ${value || "(default)"}`;
      break;
    }
    default:
      throw new Error("Unknown quick change");
  }
  return { name: `${what} (${which})`.slice(0, 180), filters, changes };
}

/** Starts the preview of a quick change. Nothing in the store changes until that preview is applied. */
export async function startTask(shop: string, input: TaskInput) {
  const plan = planTask(input);
  return prisma.job.create({
    data: {
      shop,
      type: "import",
      name: `Quick change: ${plan.name}`,
      config: JSON.stringify({
        options: { dryRun: true, defaultCommand: "UPDATE" },
        generate: { entity: "products", options: { filters: plan.filters }, changes: plan.changes, prompt: plan.name },
      }),
    },
  });
}
