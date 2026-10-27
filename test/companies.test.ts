import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { companiesEntity, companyToRows } from "../app/lib/entities/companies";
import type { ExportContext, ImportContext } from "../app/lib/core/types";

// --- Mock gql: answers by operation name and records every call. ---------------

type Handler = (vars: any) => any;

function mockGql(handlers: Record<string, Handler>) {
  const calls: Array<{ op: string; vars: any }> = [];
  const gql = async (query: string, vars?: any) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    calls.push({ op, vars });
    const h = handlers[op];
    if (!h) throw new Error(`Unexpected operation ${op}`);
    return h(vars ?? {});
  };
  const ctx: ImportContext = { gql: gql as any, options: {}, log: () => {}, cache: new Map() };
  const of = (op: string) => calls.filter((c) => c.op === op);
  return { ctx, calls, of };
}

const ok = { userErrors: [] };

const existing = {
  id: "gid://shopify/Company/3",
  name: "Acme",
  externalId: "ACME-1",
  locations: { nodes: [{ id: "gid://shopify/CompanyLocation/31", name: "HQ", externalId: null }] },
  contacts: { nodes: [{ id: "gid://shopify/CompanyContact/41", isMainContact: true, customer: { id: "gid://shopify/Customer/1" } }] },
};

// --- Export --------------------------------------------------------------------------

describe("companies export", () => {
  it("maps locations and contacts side by side", () => {
    const rows = companyToRows(
      {
        id: "gid://shopify/Company/3",
        externalId: "ACME-1",
        name: "Acme",
        note: "Big",
        customerSince: "2025-01-01T00:00:00Z",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        locations: [
          {
            id: "gid://shopify/CompanyLocation/31",
            name: "HQ",
            externalId: "L1",
            phone: "+1555",
            locale: "en",
            note: null,
            shippingAddress: { address1: "1 Main", city: "NYC", zoneCode: "NY", zip: "10001", countryCode: "US", recipient: "Desk" },
            billingAddress: { address1: "PO Box 1", city: "NYC", countryCode: "US" },
          },
        ],
        contacts: [
          { id: "gid://shopify/CompanyContact/42", isMainContact: false, customer: { id: "c2", defaultEmailAddress: { emailAddress: "b@x.com" } } },
          { id: "gid://shopify/CompanyContact/41", isMainContact: true, customer: { id: "c1", defaultEmailAddress: { emailAddress: "a@x.com" } } },
        ],
        metafields: [{ namespace: "custom", key: "tier", type: "single_line_text_field", value: "gold" }],
      },
      new Set(["locations", "contacts", "metafields"]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ID: "3",
      "External ID": "ACME-1",
      Command: "MERGE",
      Name: "Acme",
      Note: "Big",
      "Location: ID": "31",
      "Location: Name": "HQ",
      "Location: External ID": "L1",
      "Location: Shipping Address 1": "1 Main",
      "Location: Shipping Province Code": "NY",
      "Location: Shipping Recipient": "Desk",
      "Location: Billing Address 1": "PO Box 1",
      "Contact: Customer Email": "a@x.com",
      "Contact: Is Main": "TRUE",
      "Metafield: custom.tier [single_line_text_field]": "gold",
    });
    expect(rows[1]).toEqual({
      ID: "3",
      Name: "Acme",
      "Contact: Customer Email": "b@x.com",
      "Contact: Command": "MERGE",
      "Contact: Is Main": "FALSE",
    });
  });
});

// --- Import ---------------------------------------------------------------------------

describe("companies import", () => {
  it("MERGE creates a company with its first location, extra locations and contacts", async () => {
    const m = mockGql({
      ImportCompanySearch: () => ({ companies: { nodes: [] } }),
      ImportCompanyCreate: () => ({
        companyCreate: {
          company: {
            id: "gid://shopify/Company/9",
            name: "NewCo",
            externalId: "N1",
            locations: { nodes: [{ id: "gid://shopify/CompanyLocation/91", name: "Main", externalId: null }] },
            contacts: { nodes: [] },
          },
          ...ok,
        },
      }),
      ImportCompanyLocationCreate: () => ({ companyLocationCreate: { companyLocation: { id: "gid://shopify/CompanyLocation/92", name: "Depot", externalId: null }, ...ok } }),
      ImportCompanyContactCustomer: (v) => ({ customerByIdentifier: v.email === "boss@x.com" ? { id: "gid://shopify/Customer/5" } : null }),
      ImportCompanyAssignContact: () => ({ companyAssignCustomerAsContact: { companyContact: { id: "gid://shopify/CompanyContact/55" }, ...ok } }),
      ImportCompanyMainContact: () => ({ companyAssignMainContact: { company: { id: "x" }, ...ok } }),
    });
    const r = await companiesEntity.import!.apply(
      m.ctx,
      [
        {
          Name: "NewCo",
          "External ID": "N1",
          "Location: Name": "Main",
          "Location: Shipping Address 1": "1 Road",
          "Location: Shipping Country Code": "us",
          "Contact: Customer Email": "boss@x.com",
          "Contact: Is Main": "TRUE",
        },
        { Name: "NewCo", "Location: Name": "Depot", "Location: Phone": "+1", "Contact: Customer Email": "ghost@x.com" },
      ],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Company/9", message: 'Created; Contact customer "ghost@x.com" not found' });
    expect(r.rowPatches).toEqual([{ "Location: ID": "91" }, { "Location: ID": "92" }]);
    expect(m.of("ImportCompanySearch").map((c) => c.vars.query)).toEqual(['external_id:"N1"', 'name:"NewCo"']);
    expect(m.of("ImportCompanyCreate")[0].vars.input).toEqual({
      company: { name: "NewCo", externalId: "N1" },
      companyLocation: { name: "Main", shippingAddress: { address1: "1 Road", countryCode: "US" }, billingSameAsShipping: true },
    });
    expect(m.of("ImportCompanyLocationCreate")[0].vars).toEqual({ companyId: "gid://shopify/Company/9", input: { name: "Depot", phone: "+1" } });
    expect(m.of("ImportCompanyAssignContact")[0].vars).toEqual({ companyId: "gid://shopify/Company/9", customerId: "gid://shopify/Customer/5" });
    expect(m.of("ImportCompanyMainContact")[0].vars).toEqual({ companyId: "gid://shopify/Company/9", companyContactId: "gid://shopify/CompanyContact/55" });
  });

  it("MERGE updates the company, an existing location and removes a contact", async () => {
    const m = mockGql({
      ImportCompanyById: () => ({ company: existing }),
      ImportCompanyUpdate: () => ({ companyUpdate: { company: { id: existing.id }, ...ok } }),
      ImportCompanyLocationUpdate: () => ({ companyLocationUpdate: { companyLocation: { id: "x" }, ...ok } }),
      ImportCompanyLocationAddress: () => ({ companyLocationAssignAddress: { addresses: [], ...ok } }),
      ImportCompanyContactCustomer: () => ({ customerByIdentifier: { id: "gid://shopify/Customer/1" } }),
      ImportCompanyRemoveContact: () => ({ companyContactRemoveFromCompany: { removedCompanyContactId: "x", ...ok } }),
    });
    const r = await companiesEntity.import!.apply(
      m.ctx,
      [
        {
          ID: "3",
          Name: "Acme Inc",
          Note: "n",
          "Location: Name": "hq",
          "Location: Locale": "fr",
          "Location: Billing Address 1": "PO Box 9",
          "Location: Billing Country Code": "CA",
          "Contact: Customer Email": "a@x.com",
          "Contact: Command": "DELETE",
        },
      ],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", message: "Updated" });
    expect(m.of("ImportCompanyUpdate")[0].vars).toEqual({ companyId: existing.id, input: { name: "Acme Inc", note: "n" } });
    expect(m.of("ImportCompanyLocationUpdate")[0].vars).toEqual({
      companyLocationId: "gid://shopify/CompanyLocation/31",
      input: { name: "hq", locale: "fr" },
    });
    expect(m.of("ImportCompanyLocationAddress")[0].vars).toEqual({
      locationId: "gid://shopify/CompanyLocation/31",
      address: { address1: "PO Box 9", countryCode: "CA" },
      addressTypes: ["BILLING"],
    });
    expect(m.of("ImportCompanyRemoveContact")[0].vars).toEqual({ companyContactId: "gid://shopify/CompanyContact/41" });
  });

  it("Location: Command DELETE removes a location", async () => {
    const m = mockGql({
      ImportCompanyById: () => ({ company: existing }),
      ImportCompanyLocationDelete: () => ({ companyLocationDelete: { deletedCompanyLocationId: "x", ...ok } }),
    });
    const r = await companiesEntity.import!.apply(m.ctx, [{ ID: "3", "Location: ID": "31", "Location: Command": "DELETE" }], "UPDATE");
    expect(r.status).toBe("OK");
    expect(m.of("ImportCompanyUpdate")).toHaveLength(0);
    expect(m.of("ImportCompanyLocationDelete")[0].vars).toEqual({ companyLocationId: "gid://shopify/CompanyLocation/31" });
  });

  it("DELETE removes an existing company; fails when missing", async () => {
    const m = mockGql({
      ImportCompanyById: (v) => ({ company: v.id === existing.id ? existing : null }),
      ImportCompanyDelete: () => ({ companyDelete: { deletedCompanyId: existing.id, ...ok } }),
    });
    const r = await companiesEntity.import!.apply(m.ctx, [{ ID: "3" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted" });
    expect(m.of("ImportCompanyDelete")[0].vars).toEqual({ id: existing.id });
    const r2 = await companiesEntity.import!.apply(m.ctx, [{ ID: "4" }], "DELETE");
    expect(r2.status).toBe("Failed");
  });

  it("refuses an ambiguous name lookup", async () => {
    const m = mockGql({ ImportCompanySearch: () => ({ companies: { nodes: [existing, { ...existing, id: "gid://shopify/Company/4" }] } }) });
    await expect(companiesEntity.import!.apply(m.ctx, [{ Name: "acme" }], "MERGE")).rejects.toThrow(/Several companies/);
  });
});

// --- Schema validation of the bulk export query --------------------------------------------

const SCHEMA_FILE = path.resolve(".cache/schema/admin_2026-10.json.gz");

describe.skipIf(!fs.existsSync(SCHEMA_FILE))("companies bulk query matches the schema", () => {
  it("validates", async () => {
    const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(SCHEMA_FILE)).toString("utf8"));
    const schema = buildClientSchema(json.data ?? json);
    const queries: string[] = [];
    const ctx: ExportContext = {
      gql: async () => {
        throw new Error("STOP");
      },
      bulk: (q) => {
        queries.push(q);
        return (async function* () {})();
      },
      options: { groups: companiesEntity.groups?.map((g) => g.key), query: "name:x", updatedAfter: "2026-01-01" },
      log: () => {},
      cache: new Map(),
      progress: () => {},
    };
    await companiesEntity.export!(ctx, async () => {});
    expect(queries).toHaveLength(1);
    expect(validate(schema, parse(queries[0])).map((e) => e.message)).toEqual([]);
  });
});
