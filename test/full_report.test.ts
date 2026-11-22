import { describe, expect, it } from "vitest";
import { runImport } from "../app/lib/core/importer";
import { leaveBlanks } from "../app/lib/core/util";
import { ENTITIES } from "../app/lib/entities";
import { diffRows, sameCell } from "../app/lib/entities/_content_helpers";
import { discountWarnings } from "../app/lib/entities/discounts";

/** Replays the full test report of 20 Nov 2026: B7 (content compared field by field) and B8 (open-ended discounts). */
const sheet = (name: string, headers: string[], ...rows: string[][]) => [{ name, headers, rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) }];
const preview = async (sheets: any[], gql: any, options: Record<string, unknown> = {}) => {
  const stats = await runImport({ ctx: { gql, options: { dryRun: true, defaultCommand: "MERGE", ...options } as any, log: () => {}, cache: new Map() } as any, sheets, entities: ENTITIES, log: () => {} });
  return { stats, items: stats.flatMap((s) => s.preview ?? []) };
};

describe("full report B7: comparing cells", () => {
  it("treats two spellings of one value as the same", () => {
    expect(sameCell("TRUE", "true")).toBe(true);
    expect(sameCell("10", "10.0")).toBe(true);
    expect(sameCell("2026-11-20T00:00:00Z", "2026-11-20T00:00:00+00:00")).toBe(true);
    expect(sameCell("Active", "active")).toBe(true);
    expect(sameCell("3, 1, 2", "1,2,3")).toBe(true);
    expect(sameCell("About us", "About you")).toBe(false);
  });

  it("lists only what the file would change, old value first", () => {
    const store = { ID: "1", Handle: "about", Title: "About", "Body HTML": "<p>Hi</p>", Published: "TRUE", "Updated At": "2026-01-01", "Metafield: custom.note [single_line_text_field]": "old" };
    const same = diffRows({ ID: "1", Handle: "about", Title: "About", "Body HTML": "<p>Hi</p>", Published: "true", "Updated At": "2025-01-01" }, store);
    expect(same.changes).toEqual([]);
    const d = diffRows({ Handle: "about", Title: "About us", "Body HTML": "", "Metafield: custom.note": "new" }, store, { metafields: true });
    expect(d.changes).toEqual(["Title: About → About us", "Body HTML: <p>Hi</p> → (empty)", "Metafield: custom.note: old → new"]);
    expect(d.clears).toEqual(["Body HTML"]);
  });

  it("a blank that is left alone is not a change; [clear] is", () => {
    const store = { Handle: "about", Title: "About", "Body HTML": "<p>Hi</p>" };
    const rows = [{ Handle: "about", Title: "", "Body HTML": "[clear]" }];
    leaveBlanks(rows);
    expect(diffRows(rows[0], store)).toEqual({ changes: ["Body HTML: <p>Hi</p> → (empty)"], clears: ["Body HTML"] });
  });

  it("tags follow the Tags Command", () => {
    const store = { Tags: "news, oak" };
    expect(diffRows({ Tags: "oak, news" }, store).changes).toEqual([]);
    expect(diffRows({ Tags: "sale", "Tags Command": "MERGE" }, store).changes).toEqual(["Tags: adds sale"]);
    expect(diffRows({ Tags: "sale" }, store).changes).toEqual(["Tags: adds sale; removes news, oak"]);
  });
});

describe("full report B7: pages and discounts in a preview", () => {
  const page = { id: "gid://shopify/Page/7", handle: "about", title: "About", body: "<p>Hi</p>", templateSuffix: null, isPublished: true, publishedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", metafields: { nodes: [] } };
  const gql = (async (q: string) => {
    if (/^\s*#graphql\s+mutation|^\s*mutation/.test(q)) throw new Error("a preview must not write");
    if (/ImportPageById|ImportPageNow/.test(q)) return { page };
    if (/ImportPageByHandle/.test(q)) return { pages: { nodes: [page], pageInfo: { hasNextPage: false } } };
    throw new Error(`unexpected query ${q.slice(0, 60)}`);
  }) as any;
  const cols = ["ID", "Handle", "Command", "Title", "Body HTML", "Published"];

  it("an exported page imported unchanged is no change", async () => {
    const { stats, items } = await preview(sheet("Pages", cols, ["7", "about", "MERGE", "About", "<p>Hi</p>", "TRUE"]), gql);
    expect(stats[0]).toMatchObject({ ok: 1, failed: 0 });
    expect(items[0]).toMatchObject({ action: "none", changes: [] });
  });

  it("a changed page shows old → new, and hiding a live page is warned about", async () => {
    const { items } = await preview(sheet("Pages", cols, ["7", "about", "MERGE", "About us", "<p>Hi</p>", "FALSE"]), gql);
    expect(items[0].action).toBe("update");
    expect(items[0].changes).toEqual(["Title: About → About us", "Published: TRUE → FALSE"]);
    expect(items[0].warnings?.join(" ")).toMatch(/hidden from the shop/);
  });

  it("deleting and creating are named as such", async () => {
    const del = await preview(sheet("Pages", cols, ["7", "about", "DELETE", "", "", ""]), gql);
    expect(del.items[0]).toMatchObject({ action: "delete" });
    const none = (async (q: string) => (/ImportPageByHandle/.test(q) ? { pages: { nodes: [], pageInfo: { hasNextPage: false } } } : { page: null })) as any;
    const made = await preview(sheet("Pages", cols, ["", "new-page", "MERGE", "New page", "<p>x</p>", "TRUE"]), none);
    expect(made.items[0].action).toBe("create");
    expect(made.items[0].changes).toContain("Title: New page");
    const bad = await preview(sheet("Pages", cols, ["", "untitled", "MERGE", "", "<p>x</p>", ""]), none);
    expect(bad.stats[0]).toMatchObject({ ok: 0, failed: 1 });
  });
});

describe("full report B8: discounts open to everyone", () => {
  const row = (r: Record<string, string>) => r;
  it("warns on 100% off for everyone with no end date", () => {
    const w = discountWarnings(row({ Title: "ZZTEST100", Code: "ZZTEST100", "Value Type": "percentage", Value: "100", "Starts At": "2026-11-20T00:00:00Z" }), null, "Basic");
    expect(w.join(" ")).toMatch(/100% off everything for every customer/);
    expect(w.join(" ")).toMatch(/no end date/);
  });
  it("stays quiet for an ordinary or a bounded discount", () => {
    expect(discountWarnings(row({ "Value Type": "percentage", Value: "10" }), null, "Basic")).toEqual([]);
    expect(discountWarnings(row({ "Value Type": "percentage", Value: "100", "Ends At": "2027-01-01", "Usage Limit": "1" }), null, "Basic")).toEqual([]);
    expect(discountWarnings(row({ "Value Type": "percentage", Value: "100", "Customer Selection": "customers" }), null, "Basic")).toEqual([]);
  });
  it("uses the store's values for what the file leaves out", () => {
    const store = { "Value Type": "percentage", Value: "100", "Customer Selection": "all", "Ends At": "2027-01-01T00:00:00Z", "Usage Limit": "5", Status: "active" };
    const rows = [row({ "Ends At": "[clear]", "Usage Limit": "[clear]" })];
    leaveBlanks(rows);
    expect(discountWarnings(rows[0], store, "Basic").join(" ")).toMatch(/100% off/);
  });
});
