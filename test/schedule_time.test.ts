import { describe, expect, it } from "vitest";
import { describeSchedule, nextRun, zonedTimeToUtc } from "../app/lib/jobs/schedule-time";
import { isLineRow } from "../app/lib/entities/order_common";
import { orderToRows, ordersBulkQuery } from "../app/lib/entities/orders";

const iso = (d: Date) => d.toISOString();
const london = (runAt: string, intervalMinutes = 1440, weekday: number | null = null) => ({ intervalMinutes, runAt, timezone: "Europe/London", weekday });

describe("schedule times", () => {
  it("converts a local time to the right instant in winter and summer", () => {
    expect(iso(zonedTimeToUtc(2026, 11, 13, 7, 30, "Europe/London"))).toBe("2026-11-13T07:30:00.000Z"); // GMT
    expect(iso(zonedTimeToUtc(2026, 7, 1, 7, 30, "Europe/London"))).toBe("2026-07-01T06:30:00.000Z"); // BST
    expect(iso(zonedTimeToUtc(2026, 7, 1, 7, 30, "America/New_York"))).toBe("2026-07-01T11:30:00.000Z");
  });

  it("daily: the next 07:30 local time, today if still ahead, else tomorrow", () => {
    expect(iso(nextRun(london("07:30"), new Date("2026-11-12T06:00:00Z")))).toBe("2026-11-12T07:30:00.000Z");
    expect(iso(nextRun(london("07:30"), new Date("2026-11-12T07:30:00Z")))).toBe("2026-11-13T07:30:00.000Z");
    expect(iso(nextRun(london("07:30"), new Date("2026-11-12T16:00:00Z")))).toBe("2026-11-13T07:30:00.000Z");
  });

  it("keeps the same local time when the clocks change", () => {
    // UK clocks go forward on 29 March 2026 and back on 25 October 2026.
    expect(iso(nextRun(london("07:30"), new Date("2026-03-28T08:00:00Z")))).toBe("2026-03-29T06:30:00.000Z");
    expect(iso(nextRun(london("07:30"), new Date("2026-10-24T08:00:00Z")))).toBe("2026-10-25T07:30:00.000Z");
  });

  it("weekly: the chosen weekday at that time", () => {
    // 12 Nov 2026 is a Thursday; Monday = 1.
    expect(iso(nextRun(london("09:00", 10080, 1), new Date("2026-11-12T12:00:00Z")))).toBe("2026-11-16T09:00:00.000Z");
    expect(iso(nextRun(london("09:00", 10080, 4), new Date("2026-11-12T08:00:00Z")))).toBe("2026-11-12T09:00:00.000Z");
    expect(iso(nextRun(london("09:00", 10080, 4), new Date("2026-11-12T10:00:00Z")))).toBe("2026-11-19T09:00:00.000Z");
  });

  it("without an exact time, repeats on a fixed cadence that doesn't drift or pile up", () => {
    const hourly = { intervalMinutes: 60 };
    // Job fired a little late: next run stays on the hour.
    expect(iso(nextRun(hourly, new Date("2026-11-12T10:00:40Z"), new Date("2026-11-12T10:00:00Z")))).toBe("2026-11-12T11:00:00.000Z");
    // Server was off for 5 hours: one next run, in the future.
    expect(iso(nextRun(hourly, new Date("2026-11-12T15:20:00Z"), new Date("2026-11-12T10:00:00Z")))).toBe("2026-11-12T16:00:00.000Z");
    // An exact time is ignored for hourly schedules.
    expect(iso(nextRun({ intervalMinutes: 60, runAt: "07:30", timezone: "Europe/London" }, new Date("2026-11-12T10:00:00Z")))).toBe("2026-11-12T11:00:00.000Z");
  });

  it("describes schedules", () => {
    expect(describeSchedule(london("07:30"))).toBe("Daily at 07:30 (Europe/London)");
    expect(describeSchedule(london("09:00", 10080, 1))).toBe("Every Monday at 09:00 (Europe/London)");
    expect(describeSchedule({ intervalMinutes: 360 })).toBe("Every 6 hours");
  });
});

describe("shipping lines as rows", () => {
  const bag = (a: string) => ({ shopMoney: { amount: a } });
  const order = {
    id: "gid://shopify/Order/1", name: "#1001",
    lineItems: [{ id: "gid://shopify/LineItem/1", title: "Tee", sku: "T1", quantity: 2, originalUnitPriceSet: bag("10.00") }],
    shippingLines: [
      { id: "gid://shopify/ShippingLine/1", title: "DHL Next Day", code: "dhl-nd", isRemoved: false, originalPriceSet: bag("7.99") },
      { id: "gid://shopify/ShippingLine/2", title: "Old rate", code: "old", isRemoved: true, originalPriceSet: bag("4.99") },
    ],
  };

  it("adds one row per shipping line after the line items", () => {
    const rows = orderToRows(order, new Set(["line_items", "shipping_lines"]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ "Line: Type": "Line Item", "Line: SKU": "T1", "Line: Quantity": "2" });
    expect(rows[1]).toMatchObject({ ID: "1", Name: "#1001", "Line: Type": "Shipping Line", "Line: Title": "DHL Next Day", "Line: Price": "7.99" });
    expect(rows[1]["Line: Quantity"]).toBeUndefined();
    expect(rows[1]["Line: SKU"]).toBeUndefined();
  });

  it("is left out when the section is unticked", () => {
    expect(orderToRows(order, new Set(["line_items"]))).toHaveLength(1);
    // Shipping lines have no ID, so they are never requested as a bulk connection.
    expect(ordersBulkQuery("", new Set(["line_items", "shipping_lines"]))).not.toMatch(/shippingLines/);
  });

  it("the export adds the order's shipping line, and looks up the lines only when the totals differ", async () => {
    const { ordersEntity } = await import("../app/lib/entities/orders");
    const lookups: string[] = [];
    const rows: any[] = [];
    const simple = { id: "gid://shopify/Order/1", name: "#1", totalShippingPriceSet: bag("7.99"), shippingLine: { title: "DHL", code: "dhl", originalPriceSet: bag("7.99") }, lineItems: [{ id: "gid://shopify/LineItem/1", title: "Tee", quantity: 1, originalUnitPriceSet: bag("10.00") }] };
    const multi = { id: "gid://shopify/Order/2", name: "#2", totalShippingPriceSet: bag("12.98"), shippingLine: { title: "DHL", code: "dhl", originalPriceSet: bag("7.99") }, lineItems: [] };
    const free = { id: "gid://shopify/Order/3", name: "#3", totalShippingPriceSet: bag("0.0"), shippingLine: null, lineItems: [] };
    await ordersEntity.export!(
      {
        gql: (async (_q: string, v: any) => {
          lookups.push(v.id);
          return { order: { shippingLines: { nodes: [{ title: "DHL", code: "dhl", isRemoved: false, originalPriceSet: bag("7.99") }, { title: "Pallet", code: "pal", isRemoved: false, originalPriceSet: bag("4.99") }] } } };
        }) as any,
        bulk: async function* () { yield simple; yield multi; yield free; },
        options: { groups: ["line_items", "shipping_lines"] },
        log: () => {}, cache: new Map(), progress: () => {},
      },
      async (r) => void rows.push(...r),
    );
    const ship = rows.filter((r) => r["Line: Type"] === "Shipping Line").map((r) => `${r.Name} ${r["Line: Title"]} ${r["Line: Price"]}`);
    expect(ship).toEqual(["#1 DHL 7.99", "#2 DHL 7.99", "#2 Pallet 4.99"]);
    expect(lookups).toEqual(["gid://shopify/Order/2"]); // only the order whose totals differed
    expect(rows.filter((r) => r.Name === "#3")).toHaveLength(1); // no shipping, no extra row
  });

  it("is its own option, not tied to the Shipping address columns", async () => {
    const { getEntity } = await import("../app/lib/entities");
    const g = getEntity("orders")!.groups!.find((x) => x.key === "shipping_lines")!;
    expect(g).toMatchObject({ default: true, standalone: true });
  });

  it("shipping rows are not mistaken for line items on import", () => {
    expect(isLineRow({ "Line: Type": "Shipping Line", "Line: Title": "DHL", "Line: Price": "7.99" })).toBe(false);
    expect(isLineRow({ "Line: Type": "Line Item", "Line: Title": "Tee", "Line: Price": "10" })).toBe(true);
    expect(isLineRow({ "Line: Title": "Tee", "Line: Price": "10" })).toBe(true); // older files without the column
  });
});
