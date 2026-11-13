import { describe, expect, it } from "vitest";
import { jobRow } from "../app/components/jobs";

const base = {
  id: "cmabc123xyz9k2p4q",
  status: "finished",
  format: "csv",
  name: "",
  inputName: null,
  progress: 0,
  total: 0,
  startedAt: "2026-11-13T10:00:00Z",
  finishedAt: "2026-11-13T10:02:05Z",
};

describe("job history rows", () => {
  it("summarises a finished export", () => {
    const row = jobRow({
      ...base,
      type: "export",
      config: JSON.stringify({ entities: [{ entity: "orders", options: {} }, { entity: "draft_orders", options: {} }] }),
      stats: JSON.stringify([{ entity: "orders", items: 912, rows: 2300 }, { entity: "draft_orders", items: 3, rows: 3 }]),
    });
    expect(row).toMatchObject({ number: "9K2P4Q", kind: "Export", title: "Orders, Draft orders", format: "CSV", took: "2 min 5 sec" });
    expect(row.counts.map((c) => c.label)).toEqual(["Exported: 915", "Rows: 2,303"]);
  });

  it("summarises an import with failures", () => {
    const row = jobRow({
      ...base,
      type: "import",
      format: "xlsx",
      inputName: "prices.csv",
      config: JSON.stringify({ options: {} }),
      stats: JSON.stringify([{ sheet: "Products", entity: "products", items: 10, ok: 7, failed: 2, skipped: 1, byCommand: {} }]),
    });
    expect(row).toMatchObject({ kind: "Import", title: "Products", format: "CSV" });
    expect(row.counts.map((c) => `${c.tone}|${c.label}`)).toEqual(["neutral|Total: 10", "success|OK: 7", "critical|Failed: 2", "neutral|Skipped: 1"]);
  });

  it("shows progress while running and survives unreadable data", () => {
    const row = jobRow({ ...base, type: "export", status: "running", progress: 50, total: 200, finishedAt: null, config: "{", stats: "oops", name: "Nightly" });
    expect(row.title).toBe("Nightly");
    expect(row.counts.map((c) => c.label)).toEqual(["50 / 200 (25%)"]);
    expect(row.took).toBe("");
  });
});
