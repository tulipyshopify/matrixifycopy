import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { customerToRows, customersEntity, customersSearch } from "../app/lib/entities/customers";
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

const homeAddress = {
  id: "gid://shopify/MailingAddress/501",
  firstName: "Ann",
  lastName: "Lee",
  company: null,
  phone: null,
  address1: "1 High St",
  address2: null,
  city: "London",
  provinceCode: null,
  countryCodeV2: "GB",
  zip: "N1 1AA",
};

const workAddress = { ...homeAddress, id: "gid://shopify/MailingAddress/502", address1: "2 Work Rd", zip: "EC1 1AA" };

const existing = {
  id: "gid://shopify/Customer/7",
  firstName: "Ann",
  lastName: "Lee",
  tags: ["vip"],
  defaultEmailAddress: { emailAddress: "ann@example.com", marketingState: "NOT_SUBSCRIBED", marketingOptInLevel: null },
  defaultPhoneNumber: null,
  defaultAddress: { id: homeAddress.id },
  addressesV2: { nodes: [homeAddress, workAddress] },
};

// --- Export --------------------------------------------------------------------------

describe("customers export", () => {
  it("maps a customer to one row per address", () => {
    const rows = customerToRows(
      {
        id: "gid://shopify/Customer/7",
        firstName: "Ann",
        lastName: "Lee",
        state: "ENABLED",
        verifiedEmail: true,
        taxExempt: false,
        taxExemptions: ["CA_DIPLOMAT_EXEMPTION"],
        note: "hello",
        tags: ["vip", "wholesale"],
        locale: "en",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        numberOfOrders: "3",
        amountSpent: { amount: "99.5" },
        defaultEmailAddress: {
          emailAddress: "ann@example.com",
          marketingState: "SUBSCRIBED",
          marketingOptInLevel: "SINGLE_OPT_IN",
          marketingUpdatedAt: "2026-01-05T00:00:00Z",
        },
        defaultPhoneNumber: { phoneNumber: "+447700900000", smsMarketingConsent: { state: "NEVER_SUBSCRIBED", optInLevel: null, updatedAt: null } },
        defaultAddress: { id: workAddress.id },
        addresses: [homeAddress, workAddress],
        metafields: [{ namespace: "custom", key: "tier", type: "single_line_text_field", value: "gold" }],
      },
      new Set(["addresses", "metafields"]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ID: "7",
      Email: "ann@example.com",
      Command: "MERGE",
      Phone: "+447700900000",
      State: "enabled",
      "Verified Email": "TRUE",
      "Tax Exempt": "FALSE",
      "Tax Exemptions": "CA_DIPLOMAT_EXEMPTION",
      Tags: "vip, wholesale",
      Language: "en",
      "Accepts Email Marketing": "TRUE",
      "Email Marketing: Status": "subscribed",
      "Email Marketing: Level": "single_opt_in",
      "Accepts SMS Marketing": "FALSE",
      "SMS Marketing: Status": "not_subscribed",
      "Orders Count": "3",
      "Total Spent": "99.5",
      "Metafield: custom.tier [single_line_text_field]": "gold",
      "Address ID": "501",
      "Address Line 1": "1 High St",
      "Address Country Code": "GB",
      "Address Is Default": "FALSE",
    });
    expect(rows[1]).toMatchObject({ ID: "7", Email: "ann@example.com", "Address ID": "502", "Address Is Default": "TRUE" });
    expect(rows[1].Command).toBeUndefined();
  });

  it("uses customer_date for the created filter", () => {
    expect(customersSearch({ query: "tag:x", createdAfter: "2026-01-01", updatedAfter: "2026-02-01" })).toBe(
      "(tag:x) AND updated_at:>='2026-02-01' AND customer_date:>='2026-01-01'",
    );
  });
});

// --- Import ---------------------------------------------------------------------------

describe("customers import", () => {
  it("MERGE creates a missing customer with consent and addresses", async () => {
    const m = mockGql({
      ImportCustomerByIdentifier: () => ({ customerByIdentifier: null }),
      ImportCustomerCreate: () => ({ customerCreate: { customer: { id: "gid://shopify/Customer/99" }, ...ok } }),
      ImportCustomerAddressCreate: () => ({ customerAddressCreate: { address: { id: "gid://shopify/MailingAddress/900" }, ...ok } }),
    });
    const r = await customersEntity.import!.apply(
      m.ctx,
      [
        {
          Email: "new@example.com",
          "First Name": "New",
          Tags: "a, b",
          "Accepts Email Marketing": "TRUE",
          "Tax Exemptions": "ca diplomat exemption",
          "Address Line 1": "5 Road",
          "Address City": "Leeds",
          "Address Country Code": "gb",
          "Address Is Default": "TRUE",
        },
      ],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Customer/99", message: "Created" });
    expect(r.rowPatches?.[0]).toEqual({ "Address ID": "900" });
    expect(m.of("ImportCustomerByIdentifier")[0].vars).toEqual({ identifier: { emailAddress: "new@example.com" } });
    expect(m.of("ImportCustomerCreate")[0].vars.input).toEqual({
      email: "new@example.com",
      firstName: "New",
      taxExemptions: ["CA_DIPLOMAT_EXEMPTION"],
      tags: ["a", "b"],
      emailMarketingConsent: { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" },
    });
    expect(m.of("ImportCustomerAddressCreate")[0].vars).toEqual({
      customerId: "gid://shopify/Customer/99",
      address: { address1: "5 Road", city: "Leeds", countryCode: "GB" },
      setAsDefault: true,
    });
  });

  it("MERGE updates fields, tags, consent and addresses", async () => {
    const m = mockGql({
      ImportCustomerById: () => ({ customer: existing }),
      ImportCustomerUpdate: () => ({ customerUpdate: { customer: { id: existing.id }, ...ok } }),
      TagsAdd: () => ({ tagsAdd: ok }),
      ImportCustomerEmailConsent: () => ({ customerEmailMarketingConsentUpdate: ok }),
      ImportCustomerAddressUpdate: () => ({ customerAddressUpdate: { address: { id: homeAddress.id }, ...ok } }),
      ImportCustomerAddressDelete: () => ({ customerAddressDelete: { deletedAddressId: workAddress.id, ...ok } }),
      ImportCustomerAddressCreate: () => ({ customerAddressCreate: { address: { id: "gid://shopify/MailingAddress/777" }, ...ok } }),
    });
    const r = await customersEntity.import!.apply(
      m.ctx,
      [
        {
          ID: "7",
          Email: "ann@example.com",
          "Last Name": "Smith",
          Tags: "gold",
          "Tags Command": "MERGE",
          "Accepts Email Marketing": "TRUE",
          "Address ID": "501",
          "Address City": "Bristol",
        },
        { ID: "7", "Address ID": "502", "Address Command": "DELETE" },
        { ID: "7", "Address Line 1": "9 New St", "Address City": "York", "Address Country Code": "GB" },
      ],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", id: existing.id, message: "Updated; 1 addresses deleted" });
    expect(m.of("ImportCustomerUpdate")[0].vars.input).toEqual({ id: existing.id, lastName: "Smith" });
    expect(m.of("TagsAdd")[0].vars).toEqual({ id: existing.id, tags: ["gold"] });
    expect(m.of("ImportCustomerEmailConsent")[0].vars).toEqual({
      input: { customerId: existing.id, emailMarketingConsent: { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" } },
    });
    expect(m.of("ImportCustomerAddressDelete")[0].vars).toEqual({ customerId: existing.id, addressId: workAddress.id });
    expect(m.of("ImportCustomerAddressUpdate")[0].vars).toMatchObject({
      customerId: existing.id,
      addressId: homeAddress.id,
      address: { city: "Bristol" },
    });
    expect(m.of("ImportCustomerAddressCreate")[0].vars).toMatchObject({
      customerId: existing.id,
      address: { address1: "9 New St", city: "York", countryCode: "GB" },
    });
    expect(r.rowPatches).toEqual([{ "Address ID": "501" }, undefined, { "Address ID": "777" }]);
  });

  it("Address Command REPLACE deletes addresses not in the sheet and matches by content", async () => {
    const m = mockGql({
      ImportCustomerByIdentifier: () => ({ customerByIdentifier: existing }),
      ImportCustomerAddressDelete: () => ({ customerAddressDelete: ok }),
      ImportCustomerAddressDefault: () => ({ customerUpdateDefaultAddress: ok }),
    });
    const r = await customersEntity.import!.apply(
      m.ctx,
      [{ Email: "ANN@example.com", "Address Command": "REPLACE", "Address Line 1": "2 work rd", "Address Zip": "EC1 1AA", "Address Is Default": "TRUE" }],
      "UPDATE",
    );
    expect(r.status).toBe("OK");
    expect(m.of("ImportCustomerUpdate")).toHaveLength(0);
    expect(m.of("ImportCustomerAddressDelete").map((c) => c.vars.addressId)).toEqual([homeAddress.id]);
    expect(m.of("ImportCustomerAddressDefault")[0].vars).toEqual({ customerId: existing.id, addressId: workAddress.id });
  });

  it("DELETE removes an existing customer; UPDATE fails when missing", async () => {
    const m = mockGql({
      ImportCustomerById: (v) => ({ customer: v.id === existing.id ? existing : null }),
      ImportCustomerByIdentifier: () => ({ customerByIdentifier: null }),
      ImportCustomerDelete: () => ({ customerDelete: { deletedCustomerId: existing.id, ...ok } }),
    });
    const r = await customersEntity.import!.apply(m.ctx, [{ ID: "7" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted" });
    expect(m.of("ImportCustomerDelete")[0].vars).toEqual({ id: existing.id });
    const r2 = await customersEntity.import!.apply(m.ctx, [{ ID: "8", Phone: "+15550000" }], "UPDATE");
    expect(r2).toMatchObject({ status: "Failed", message: "Customer not found" });
    expect(m.of("ImportCustomerByIdentifier").at(-1)!.vars).toEqual({ identifier: { phoneNumber: "+15550000" } });
  });

  it("NEW fails when the customer exists", async () => {
    const m = mockGql({ ImportCustomerByIdentifier: () => ({ customerByIdentifier: existing }) });
    const r = await customersEntity.import!.apply(m.ctx, [{ Email: "ann@example.com" }], "NEW");
    expect(r.status).toBe("Failed");
  });
});

describe("customers REPLACE validates before deleting", () => {
  it("REPLACE with an invalid enum / boolean fails without deleting the customer", async () => {
    const m = mockGql({
      ImportCustomerById: () => ({ customer: existing }),
      ImportCustomerDelete: () => ({ customerDelete: { deletedCustomerId: existing.id, ...ok } }),
      ImportCustomerCreate: () => ({ customerCreate: { customer: { id: "gid://shopify/Customer/99" }, ...ok } }),
    });
    await expect(
      customersEntity.import!.apply(m.ctx, [{ ID: "7", Email: "ann@example.com", "Email Marketing: Level": "bogus", "Accepts Email Marketing": "TRUE" }], "REPLACE"),
    ).rejects.toThrow(/Level/);
    await expect(
      customersEntity.import!.apply(m.ctx, [{ ID: "7", Email: "ann@example.com", "Address Line 1": "1 Road", "Address Command": "WAT" }], "REPLACE"),
    ).rejects.toThrow(/Unknown command/);
    expect(m.of("ImportCustomerDelete")).toHaveLength(0);
    expect(m.of("ImportCustomerCreate")).toHaveLength(0);
  });

  it("REPLACE of an exported customer deletes, then recreates with its addresses", async () => {
    const m = mockGql({
      ImportCustomerById: () => ({ customer: existing }),
      ImportCustomerDelete: () => ({ customerDelete: { deletedCustomerId: existing.id, ...ok } }),
      ImportCustomerCreate: () => ({ customerCreate: { customer: { id: "gid://shopify/Customer/99" }, ...ok } }),
      ImportCustomerAddressCreate: () => ({ customerAddressCreate: { address: { id: "gid://shopify/MailingAddress/900" }, ...ok } }),
    });
    const r = await customersEntity.import!.apply(
      m.ctx,
      [{ ID: "7", Email: "ann@example.com", "First Name": "Ann", "Address ID": "501", "Address Line 1": "1 High St", "Address City": "London" }],
      "REPLACE",
    );
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Customer/99", message: "Replaced" });
    expect(m.calls.map((c) => c.op)).toEqual(["ImportCustomerById", "ImportCustomerDelete", "ImportCustomerCreate", "ImportCustomerAddressCreate"]);
    expect(r.rowPatches?.[0]).toEqual({ "Address ID": "900" });
  });
});

describe("customers marketing consent round-trip", () => {
  const exportedRow = (email: string, sms: string, acceptsEmail = "FALSE") => ({
    ID: "7",
    Email: "ann@example.com",
    "Accepts Email Marketing": acceptsEmail,
    "Email Marketing: Status": email,
    "Accepts SMS Marketing": "FALSE",
    "SMS Marketing: Status": sms,
  });

  it("re-importing exported invalid / redacted states skips consent instead of failing", async () => {
    const cur = {
      ...existing,
      defaultEmailAddress: { emailAddress: "ann@example.com", marketingState: "INVALID", marketingOptInLevel: null },
      defaultPhoneNumber: { phoneNumber: "+447700900000", smsMarketingConsent: { state: "REDACTED", optInLevel: null } },
    };
    const m = mockGql({ ImportCustomerById: () => ({ customer: cur }) });
    const r = await customersEntity.import!.apply(m.ctx, [exportedRow("invalid", "redacted")], "MERGE");
    expect(r).toMatchObject({ status: "OK", message: "Updated" });
    expect(m.of("ImportCustomerEmailConsent")).toHaveLength(0);
    expect(m.of("ImportCustomerSmsConsent")).toHaveLength(0);

    const r2 = await customersEntity.import!.apply(m.ctx, [exportedRow("redacted", "redacted")], "MERGE");
    expect(r2.status).toBe("OK");
  });

  it("creating from an exported row with a read-only state omits that consent", async () => {
    const m = mockGql({
      ImportCustomerByIdentifier: () => ({ customerByIdentifier: null }),
      ImportCustomerById: () => ({ customer: null }),
      ImportCustomerCreate: () => ({ customerCreate: { customer: { id: "gid://shopify/Customer/99" }, ...ok } }),
    });
    const r = await customersEntity.import!.apply(m.ctx, [{ ...exportedRow("invalid", "never-subscribed"), ID: "" }], "MERGE");
    expect(r.status).toBe("OK");
    const input = m.of("ImportCustomerCreate")[0].vars.input;
    expect(input.emailMarketingConsent).toBeUndefined();
    expect(input.smsMarketingConsent).toEqual({ marketingState: "NOT_SUBSCRIBED" });
  });

  it("does not send consent when it matches the current state", async () => {
    const cur = {
      ...existing,
      defaultEmailAddress: { emailAddress: "ann@example.com", marketingState: "NOT_SUBSCRIBED", marketingOptInLevel: null },
      defaultPhoneNumber: { phoneNumber: "+447700900000", smsMarketingConsent: { state: "NEVER_SUBSCRIBED", optInLevel: null } },
    };
    const m = mockGql({ ImportCustomerById: () => ({ customer: cur }) });
    const r = await customersEntity.import!.apply(m.ctx, [exportedRow("not_subscribed", "not_subscribed")], "MERGE");
    expect(r.status).toBe("OK");
    // "Accepts" FALSE alone is already satisfied by a never-subscribed customer.
    await customersEntity.import!.apply(m.ctx, [{ ID: "7", "Accepts Email Marketing": "FALSE", "Accepts SMS Marketing": "FALSE" }], "MERGE");
    expect(m.of("ImportCustomerEmailConsent")).toHaveLength(0);
    expect(m.of("ImportCustomerSmsConsent")).toHaveLength(0);
  });

  it("still rejects an unknown marketing status", async () => {
    const m = mockGql({ ImportCustomerById: () => ({ customer: existing }) });
    await expect(customersEntity.import!.apply(m.ctx, [exportedRow("subscribd", "")], "MERGE")).rejects.toThrow(/not valid/);
  });
});

// --- Schema validation of the bulk export query --------------------------------------------

const SCHEMA_FILE = path.resolve(".cache/schema/admin_2026-10.json.gz");

describe.skipIf(!fs.existsSync(SCHEMA_FILE))("customers bulk query matches the schema", () => {
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
      options: { groups: customersEntity.groups?.map((g) => g.key), query: "tag:x", createdAfter: "2026-01-01" },
      log: () => {},
      cache: new Map(),
      progress: () => {},
    };
    await customersEntity.export!(ctx, async () => {});
    expect(queries).toHaveLength(1);
    expect(validate(schema, parse(queries[0])).map((e) => e.message)).toEqual([]);
  });
});
