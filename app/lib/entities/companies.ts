import type { Command, Entity, ExportContext, Gql, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import {
  assertNoUserErrors,
  boolCell,
  buildSearchQuery,
  cell,
  gidToId,
  gqlString,
  metafieldsFromRow,
  metafieldsToRow,
  parseBool,
  parseSubCommand,
  toGid,
} from "../core/util";
import { writeMetafields } from "../core/lookups";
import { paginate } from "../core/gql";

/*
 * B2B companies. Import scope: create/update/delete the company, create/update/
 * delete its locations (with shipping and billing addresses) and assign
 * existing customers as contacts (optionally as main contact) or remove them.
 * Not handled on import: contact roles per location, catalogs, payment terms,
 * tax settings and staff assignments.
 */

// --- Columns --------------------------------------------------------------------

const COMPANY_COLUMNS = ["ID", "External ID", "Command", "Name", "Note", "Customer Since", "Created At", "Updated At"];

/** Address column suffix -> CompanyAddressInput field. */
const ADDRESS_FIELDS: Record<string, string> = {
  "First Name": "firstName",
  "Last Name": "lastName",
  Recipient: "recipient",
  Phone: "phone",
  "Address 1": "address1",
  "Address 2": "address2",
  City: "city",
  "Province Code": "zoneCode",
  Zip: "zip",
  "Country Code": "countryCode",
};

const addressColumns = (kind: "Shipping" | "Billing") => Object.keys(ADDRESS_FIELDS).map((k) => `Location: ${kind} ${k}`);

const LOCATION_COLUMNS = [
  "Location: ID",
  "Location: Command",
  "Location: Name",
  "Location: External ID",
  "Location: Phone",
  "Location: Locale",
  "Location: Note",
  ...addressColumns("Shipping"),
  ...addressColumns("Billing"),
];

const CONTACT_COLUMNS = ["Contact: Customer Email", "Contact: Command", "Contact: Is Main"];

/** Quotes a value for Shopify search syntax (used as a GraphQL variable). */
function searchValue(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// --- Export ---------------------------------------------------------------------------

export function companiesBulkQuery(search: string, groups: Set<string>): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  const metafields = `metafields { edges { node { id namespace key type value } } }`;
  const address = `firstName lastName recipient phone address1 address2 city zoneCode zip countryCode`;
  const locations = `locations { edges { node {
      id name externalId phone locale note
      shippingAddress { ${address} }
      billingAddress { ${address} }
    } } }`;
  const contacts = `contacts { edges { node { id isMainContact customer { id defaultEmailAddress { emailAddress } } } } }`;
  return `{
    companies${args} { edges { node {
      id externalId name note customerSince createdAt updatedAt
      ${groups.has("locations") ? locations : ""}
      ${groups.has("contacts") ? contacts : ""}
      ${groups.has("metafields") ? metafields : ""}
    } } }
  }`;
}

function addressToRow(row: Row, kind: "Shipping" | "Billing", a: any) {
  for (const [suffix, field] of Object.entries(ADDRESS_FIELDS)) row[`Location: ${kind} ${suffix}`] = a?.[field] ?? "";
}

export function companyToRows(c: any, groups: Set<string>): Row[] {
  const locations: any[] = c.locations ?? [];
  // Main contact first, so it is easy to spot.
  const contacts: any[] = [...(c.contacts ?? [])].sort((a, b) => Number(!!b.isMainContact) - Number(!!a.isMainContact));
  const count = Math.max(1, locations.length, contacts.length);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const row: Row = { ID: gidToId(c.id), Name: c.name ?? "" };
    if (i === 0) {
      Object.assign(row, {
        "External ID": c.externalId ?? "",
        Command: "MERGE",
        Note: c.note ?? "",
        "Customer Since": c.customerSince ?? "",
        "Created At": c.createdAt ?? "",
        "Updated At": c.updatedAt ?? "",
      });
      if (groups.has("metafields")) metafieldsToRow(row, c.metafields);
    }
    const l = locations[i];
    if (l) {
      Object.assign(row, {
        "Location: ID": gidToId(l.id),
        "Location: Command": "MERGE",
        "Location: Name": l.name ?? "",
        "Location: External ID": l.externalId ?? "",
        "Location: Phone": l.phone ?? "",
        "Location: Locale": l.locale ?? "",
        "Location: Note": l.note ?? "",
      });
      addressToRow(row, "Shipping", l.shippingAddress);
      addressToRow(row, "Billing", l.billingAddress);
    }
    const ct = contacts[i];
    if (ct) {
      Object.assign(row, {
        "Contact: Customer Email": ct.customer?.defaultEmailAddress?.emailAddress ?? "",
        "Contact: Command": "MERGE",
        "Contact: Is Main": boolCell(ct.isMainContact),
      });
    }
    rows.push(row);
  }
  return rows;
}

async function exportCompanies(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? companiesEntity.groups!.filter((g) => g.default).map((g) => g.key));
  const search = buildSearchQuery(ctx.options);
  let n = 0;
  for await (const c of ctx.bulk(companiesBulkQuery(search, groups))) {
    await emit(companyToRows(c, groups));
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import: fetching existing companies ----------------------------------------------

const COMPANY_FIELDS = `#graphql
  fragment ImportCompany on Company {
    id name externalId
    locations(first: 250) { nodes { id name externalId } pageInfo { hasNextPage endCursor } }
    contacts(first: 250) { nodes { id isMainContact customer { id } } }
  }
`;

const COMPANY_LOCATIONS = `#graphql
  query ImportCompanyLocations($id: ID!, $after: String) {
    company(id: $id) {
      locations(first: 250, after: $after) { nodes { id name externalId } pageInfo { hasNextPage endCursor } }
    }
  }
`;

const COMPANY_BY_ID = `#graphql
  query ImportCompanyById($id: ID!) { company(id: $id) { ...ImportCompany } }
  ${COMPANY_FIELDS}
`;

/**
 * Search is fuzzy (prefix / token matching), so callers page through every
 * hit and compare exactly. Only identity fields here; details come by ID.
 */
const COMPANY_SEARCH = `#graphql
  query ImportCompanySearch($query: String!, $after: String) {
    companies(first: 100, after: $after, query: $query) {
      nodes { id name externalId }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CONTACT_CUSTOMER = `#graphql
  query ImportCompanyContactCustomer($email: String!) {
    customerByIdentifier(identifier: { emailAddress: $email }) { id }
  }
`;

interface ExistingLocation {
  id: string;
  name: string;
  externalId: string | null;
}

interface ExistingContact {
  id: string;
  isMainContact: boolean;
  customer: { id: string };
}

interface ExistingCompany {
  id: string;
  name: string;
  externalId: string | null;
  locations: { nodes: ExistingLocation[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
  contacts: { nodes: ExistingContact[] };
}

const sameName = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

async function companyById(gql: Gql, id: string): Promise<ExistingCompany | null> {
  const c: ExistingCompany | null = (await gql(COMPANY_BY_ID, { id })).company ?? null;
  if (c?.locations.pageInfo?.hasNextPage) {
    // More than one page of locations: load them all so name lookups are complete.
    const all: ExistingLocation[] = [];
    for await (const l of paginate<ExistingLocation>(gql, COMPANY_LOCATIONS, { id }, (d) => d.company.locations)) all.push(l);
    c.locations = { nodes: all };
  }
  return c;
}

/**
 * Pages through every search hit and returns the ID of the one exact match.
 * Throws `ambiguous` when more than one hit matches exactly.
 */
async function searchExact(
  gql: Gql,
  query: string,
  matches: (n: { id: string; name: string; externalId: string | null }) => boolean,
  ambiguous: string,
): Promise<string | null> {
  let found: string | null = null;
  for await (const n of paginate<{ id: string; name: string; externalId: string | null }>(
    gql,
    COMPANY_SEARCH,
    { query },
    (d) => d.companies,
  )) {
    if (!matches(n)) continue;
    if (found && found !== n.id) throw new ImportError(ambiguous);
    found = n.id;
  }
  return found;
}

async function fetchCompany(gql: Gql, by: { id?: string; externalId?: string; name?: string }): Promise<ExistingCompany | null> {
  if (by.id) {
    const c = await companyById(gql, by.id);
    if (c) return c;
  }
  if (by.externalId) {
    const id = await searchExact(
      gql,
      `external_id:${searchValue(by.externalId)}`,
      (n) => n.externalId === by.externalId,
      `Several companies have External ID "${by.externalId}"; use ID`,
    );
    if (id) return companyById(gql, id);
  }
  if (by.name) {
    const id = await searchExact(
      gql,
      `name:${searchValue(by.name)}`,
      (n) => sameName(n.name, by.name),
      `Several companies are named "${by.name}"; use ID or External ID`,
    );
    if (id) return companyById(gql, id);
  }
  return null;
}

async function customerIdByEmail(ctx: ImportContext, email: string): Promise<string | null> {
  const key = `customerByEmail:${email.toLowerCase()}`;
  if (!ctx.cache.has(key)) {
    ctx.cache.set(key, ctx.gql(CONTACT_CUSTOMER, { email }).then((d: any) => d.customerByIdentifier?.id ?? null));
  }
  return ctx.cache.get(key) as Promise<string | null>;
}

// --- Import: parsing rows ---------------------------------------------------------------

function companyFields(row: Row): Record<string, any> {
  const f: Record<string, any> = {};
  const name = cell(row, "Name");
  if (name) f.name = name;
  const ext = cell(row, "External ID");
  if (ext !== undefined) f.externalId = ext || null;
  const note = cell(row, "Note");
  if (note !== undefined) f.note = note;
  const since = cell(row, "Customer Since");
  if (since) f.customerSince = since;
  return f;
}

function addressFromRow(row: Row, kind: "Shipping" | "Billing"): Record<string, string> | undefined {
  const a: Record<string, string> = {};
  for (const [suffix, field] of Object.entries(ADDRESS_FIELDS)) {
    const v = cell(row, `Location: ${kind} ${suffix}`);
    if (v) a[field] = field === "countryCode" ? v.toUpperCase() : v;
  }
  return Object.keys(a).length ? a : undefined;
}

interface LocationSpec {
  rowIndex: number;
  id?: string;
  command: "MERGE" | "DELETE";
  /** CompanyLocationUpdateInput-compatible fields. */
  fields: Record<string, any>;
  shipping?: Record<string, string>;
  billing?: Record<string, string>;
}

function isLocationRow(row: Row): boolean {
  return LOCATION_COLUMNS.some((c) => c !== "Location: Command" && (cell(row, c) ?? "") !== "");
}

function parseLocations(rows: Row[]): LocationSpec[] {
  const specs: LocationSpec[] = [];
  rows.forEach((row, rowIndex) => {
    if (!isLocationRow(row)) return;
    const fields: Record<string, any> = {};
    const name = cell(row, "Location: Name");
    if (name) fields.name = name;
    const ext = cell(row, "Location: External ID");
    if (ext) fields.externalId = ext;
    const phone = cell(row, "Location: Phone");
    if (phone !== undefined) fields.phone = phone || null;
    const locale = cell(row, "Location: Locale");
    if (locale) fields.locale = locale;
    const note = cell(row, "Location: Note");
    if (note !== undefined) fields.note = note;
    specs.push({
      rowIndex,
      id: toGid("CompanyLocation", cell(row, "Location: ID")),
      command: parseSubCommand(cell(row, "Location: Command"), ["MERGE", "DELETE"] as const, "MERGE"),
      fields,
      shipping: addressFromRow(row, "Shipping"),
      billing: addressFromRow(row, "Billing"),
    });
  });
  return specs;
}

interface ContactSpec {
  rowIndex: number;
  email: string;
  command: "MERGE" | "DELETE";
  isMain: boolean;
}

function parseContacts(rows: Row[]): ContactSpec[] {
  const specs: ContactSpec[] = [];
  rows.forEach((row, rowIndex) => {
    const email = cell(row, "Contact: Customer Email");
    if (!email) return;
    specs.push({
      rowIndex,
      email,
      command: parseSubCommand(cell(row, "Contact: Command"), ["MERGE", "DELETE"] as const, "MERGE"),
      isMain: parseBool(cell(row, "Contact: Is Main")) === true,
    });
  });
  return specs;
}

/** CompanyLocationInput for creating a location. */
function locationCreateInput(spec: LocationSpec, companyName: string): Record<string, any> {
  const input: Record<string, any> = { ...spec.fields };
  if (!input.name) input.name = companyName;
  if (spec.shipping) input.shippingAddress = spec.shipping;
  if (spec.billing) input.billingAddress = spec.billing;
  else if (spec.shipping) input.billingSameAsShipping = true;
  return input;
}

// --- Import: mutations ------------------------------------------------------------------

const COMPANY_CREATE = `#graphql
  mutation ImportCompanyCreate($input: CompanyCreateInput!) {
    companyCreate(input: $input) {
      company {
        id name externalId
        locations(first: 250) { nodes { id name externalId } }
        contacts(first: 250) { nodes { id isMainContact customer { id } } }
      }
      userErrors { field message code }
    }
  }
`;

const COMPANY_UPDATE = `#graphql
  mutation ImportCompanyUpdate($companyId: ID!, $input: CompanyInput!) {
    companyUpdate(companyId: $companyId, input: $input) {
      company { id }
      userErrors { field message code }
    }
  }
`;

const COMPANY_DELETE = `#graphql
  mutation ImportCompanyDelete($id: ID!) {
    companyDelete(id: $id) {
      deletedCompanyId
      userErrors { field message code }
    }
  }
`;

const LOCATION_CREATE = `#graphql
  mutation ImportCompanyLocationCreate($companyId: ID!, $input: CompanyLocationInput!) {
    companyLocationCreate(companyId: $companyId, input: $input) {
      companyLocation { id name externalId }
      userErrors { field message code }
    }
  }
`;

const LOCATION_UPDATE = `#graphql
  mutation ImportCompanyLocationUpdate($companyLocationId: ID!, $input: CompanyLocationUpdateInput!) {
    companyLocationUpdate(companyLocationId: $companyLocationId, input: $input) {
      companyLocation { id }
      userErrors { field message code }
    }
  }
`;

const LOCATION_DELETE = `#graphql
  mutation ImportCompanyLocationDelete($companyLocationId: ID!) {
    companyLocationDelete(companyLocationId: $companyLocationId) {
      deletedCompanyLocationId
      userErrors { field message code }
    }
  }
`;

const LOCATION_ASSIGN_ADDRESS = `#graphql
  mutation ImportCompanyLocationAddress($locationId: ID!, $address: CompanyAddressInput!, $addressTypes: [CompanyAddressType!]!) {
    companyLocationAssignAddress(locationId: $locationId, address: $address, addressTypes: $addressTypes) {
      addresses { id }
      userErrors { field message code }
    }
  }
`;

const CONTACT_ASSIGN = `#graphql
  mutation ImportCompanyAssignContact($companyId: ID!, $customerId: ID!) {
    companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
      companyContact { id }
      userErrors { field message code }
    }
  }
`;

const CONTACT_MAIN = `#graphql
  mutation ImportCompanyMainContact($companyId: ID!, $companyContactId: ID!) {
    companyAssignMainContact(companyId: $companyId, companyContactId: $companyContactId) {
      company { id }
      userErrors { field message code }
    }
  }
`;

const CONTACT_REMOVE = `#graphql
  mutation ImportCompanyRemoveContact($companyContactId: ID!) {
    companyContactRemoveFromCompany(companyContactId: $companyContactId) {
      removedCompanyContactId
      userErrors { field message code }
    }
  }
`;

interface SubResult {
  rowPatches: Array<Row | undefined>;
  notes: string[];
}

function findLocation(existing: ExistingLocation[], spec: LocationSpec): ExistingLocation | undefined {
  if (spec.id) return existing.find((l) => l.id === spec.id);
  if (spec.fields.externalId) {
    const l = existing.find((x) => x.externalId === spec.fields.externalId);
    if (l) return l;
  }
  if (spec.fields.name) {
    const named = existing.filter((l) => sameName(l.name, spec.fields.name));
    if (named.length > 1) {
      throw new ImportError(
        `Several locations are named "${spec.fields.name}" (row ${spec.rowIndex + 1}); use Location: ID or Location: External ID`,
      );
    }
    return named[0];
  }
  return undefined;
}

async function assignAddresses(gql: Gql, locationId: string, spec: LocationSpec) {
  const jobs: Array<{ address: Record<string, string>; addressTypes: string[] }> = [];
  const same = spec.shipping && spec.billing && JSON.stringify(spec.shipping) === JSON.stringify(spec.billing);
  if (same) jobs.push({ address: spec.shipping!, addressTypes: ["SHIPPING", "BILLING"] });
  else {
    if (spec.shipping) jobs.push({ address: spec.shipping, addressTypes: ["SHIPPING"] });
    if (spec.billing) jobs.push({ address: spec.billing, addressTypes: ["BILLING"] });
  }
  for (const j of jobs) {
    const d = await gql(LOCATION_ASSIGN_ADDRESS, { locationId, ...j });
    assertNoUserErrors(d.companyLocationAssignAddress, "Location address");
  }
}

async function applyLocations(
  ctx: ImportContext,
  companyId: string,
  companyName: string,
  specs: LocationSpec[],
  existing: ExistingLocation[],
  command: Command,
  out: SubResult,
) {
  for (const spec of specs) {
    const ex = findLocation(existing, spec);
    if (spec.command === "DELETE") {
      if (!ex) {
        out.notes.push(`Location on row ${spec.rowIndex + 1} to delete not found`);
        continue;
      }
      const d = await ctx.gql(LOCATION_DELETE, { companyLocationId: ex.id });
      assertNoUserErrors(d.companyLocationDelete, "Delete location");
      continue;
    }
    if (ex) {
      if (Object.keys(spec.fields).length) {
        const d = await ctx.gql(LOCATION_UPDATE, { companyLocationId: ex.id, input: spec.fields });
        assertNoUserErrors(d.companyLocationUpdate, "Update location");
      }
      await assignAddresses(ctx.gql, ex.id, spec);
      out.rowPatches[spec.rowIndex] = { "Location: ID": gidToId(ex.id) };
      continue;
    }
    if (spec.id) throw new ImportError(`Location ID ${gidToId(spec.id)} not found on this company`);
    if (command === "UPDATE") {
      out.notes.push(`Location on row ${spec.rowIndex + 1} not found (UPDATE does not create locations)`);
      continue;
    }
    const d = await ctx.gql(LOCATION_CREATE, { companyId, input: locationCreateInput(spec, companyName) });
    assertNoUserErrors(d.companyLocationCreate, "Create location");
    const loc = d.companyLocationCreate.companyLocation;
    existing.push(loc);
    out.rowPatches[spec.rowIndex] = { "Location: ID": gidToId(loc.id) };
  }
}

async function applyContacts(ctx: ImportContext, companyId: string, specs: ContactSpec[], existing: ExistingContact[], out: SubResult) {
  for (const spec of specs) {
    const customerId = await customerIdByEmail(ctx, spec.email);
    if (!customerId) {
      out.notes.push(`Contact customer "${spec.email}" not found`);
      continue;
    }
    let contact = existing.find((c) => c.customer.id === customerId);
    if (spec.command === "DELETE") {
      if (!contact) continue;
      const d = await ctx.gql(CONTACT_REMOVE, { companyContactId: contact.id });
      assertNoUserErrors(d.companyContactRemoveFromCompany, "Remove contact");
      continue;
    }
    if (!contact) {
      const d = await ctx.gql(CONTACT_ASSIGN, { companyId, customerId });
      assertNoUserErrors(d.companyAssignCustomerAsContact, "Assign contact");
      contact = { id: d.companyAssignCustomerAsContact.companyContact.id, isMainContact: false, customer: { id: customerId } };
      existing.push(contact);
    }
    if (spec.isMain && !contact.isMainContact) {
      const d = await ctx.gql(CONTACT_MAIN, { companyId, companyContactId: contact.id });
      assertNoUserErrors(d.companyAssignMainContact, "Main contact");
      for (const c of existing) c.isMainContact = c === contact;
    }
  }
}

interface PreparedCompany {
  input: Record<string, any>;
  name: string;
  first?: LocationSpec;
  locations: LocationSpec[];
  contacts: ContactSpec[];
  metafields: ReturnType<typeof metafieldsFromRow>["set"];
}

/**
 * Builds and validates everything needed to create the company, including
 * contact customer lookups, without writing. REPLACE runs this before deleting.
 */
async function prepareCreate(ctx: ImportContext, rows: Row[], top: Row): Promise<PreparedCompany> {
  const company = companyFields(top);
  if (!company.name) throw new ImportError("Name is required to create a company");
  if (company.externalId === null) delete company.externalId;
  // A new company has no locations yet: Location IDs (e.g. from an export being
  // REPLACEd) refer to the old record, so every location row is created.
  const locations = parseLocations(rows)
    .filter((l) => l.command !== "DELETE")
    .map((l) => ({ ...l, id: undefined }));
  const input: Record<string, any> = { company };
  const first = locations.shift();
  if (first) input.companyLocation = locationCreateInput(first, company.name);
  const contacts = parseContacts(rows);
  // Resolve contacts now (cached), so lookup failures happen before any write.
  for (const c of contacts) await customerIdByEmail(ctx, c.email);
  return { input, name: company.name, first, locations, contacts, metafields: metafieldsFromRow(top).set };
}

async function sendCreate(ctx: ImportContext, p: PreparedCompany, command: Command): Promise<{ id: string } & SubResult> {
  const d = await ctx.gql(COMPANY_CREATE, { input: p.input });
  assertNoUserErrors(d.companyCreate, "Create company");
  const created = d.companyCreate.company;
  const out: SubResult = { rowPatches: [], notes: [] };
  if (p.first && created.locations.nodes[0]) out.rowPatches[p.first.rowIndex] = { "Location: ID": gidToId(created.locations.nodes[0].id) };

  if (p.metafields.length) await writeMetafields(ctx.gql, created.id, p.metafields);
  await applyLocations(ctx, created.id, p.name, p.locations, [...created.locations.nodes], command, out);
  await applyContacts(ctx, created.id, p.contacts, [...created.contacts.nodes], out);
  return { id: created.id, ...out };
}

async function createCompany(ctx: ImportContext, rows: Row[], top: Row, command: Command): Promise<{ id: string } & SubResult> {
  return sendCreate(ctx, await prepareCreate(ctx, rows, top), command);
}

async function updateCompany(ctx: ImportContext, existing: ExistingCompany, rows: Row[], top: Row, command: Command): Promise<SubResult> {
  const fields = companyFields(top);
  if (fields.name === existing.name) delete fields.name;
  if (fields.externalId === existing.externalId) delete fields.externalId;
  if (Object.keys(fields).length) {
    const d = await ctx.gql(COMPANY_UPDATE, { companyId: existing.id, input: fields });
    assertNoUserErrors(d.companyUpdate, "Update company");
  }
  const mf = metafieldsFromRow(top);
  await writeMetafields(ctx.gql, existing.id, mf.set, mf.blank);

  const out: SubResult = { rowPatches: [], notes: [] };
  const name = fields.name ?? existing.name;
  await applyLocations(ctx, existing.id, name, parseLocations(rows), [...existing.locations.nodes], command, out);
  await applyContacts(ctx, existing.id, parseContacts(rows), existing.contacts.nodes.map((c) => ({ ...c })), out);
  return out;
}

async function deleteCompany(gql: Gql, id: string) {
  const d = await gql(COMPANY_DELETE, { id });
  assertNoUserErrors(d.companyDelete, "Delete company");
}

export async function importCompany(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const top = rows[0];
  const id = toGid("Company", cell(top, "ID"));
  const externalId = cell(top, "External ID");
  const name = cell(top, "Name");
  const existing = id || externalId || name ? await fetchCompany(ctx.gql, { id, externalId, name }) : null;

  switch (command) {
    case "DELETE": {
      if (!existing) return { status: "Failed", command, message: "Company not found" };
      await deleteCompany(ctx.gql, existing.id);
      return { status: "OK", command, id: existing.id, message: "Deleted" };
    }
    case "NEW": {
      if (existing) return { status: "Failed", command, id: existing.id, message: `Company "${existing.name}" already exists` };
      const r = await createCompany(ctx, rows, top, command);
      return { status: "OK", command, id: r.id, message: ["Created", ...r.notes].join("; "), rowPatches: r.rowPatches };
    }
    case "REPLACE": {
      // Validate everything (incl. contact lookups) before deleting anything.
      const prepared = await prepareCreate(ctx, rows, top);
      if (existing) await deleteCompany(ctx.gql, existing.id);
      const r = await sendCreate(ctx, prepared, command);
      return { status: "OK", command, id: r.id, message: [existing ? "Replaced" : "Created", ...r.notes].join("; "), rowPatches: r.rowPatches };
    }
    case "UPDATE":
    case "MERGE": {
      if (!existing) {
        if (command === "UPDATE") return { status: "Failed", command, message: "Company not found" };
        const r = await createCompany(ctx, rows, top, command);
        return { status: "OK", command, id: r.id, message: ["Created", ...r.notes].join("; "), rowPatches: r.rowPatches };
      }
      const r = await updateCompany(ctx, existing, rows, top, command);
      return { status: "OK", command, id: existing.id, message: ["Updated", ...r.notes].join("; "), rowPatches: r.rowPatches };
    }
    default:
      return { status: "Skipped", command };
  }
}

export const companiesEntity: Entity = {
  key: "companies",
  sheet: "Companies",
  aliases: ["company", "b2b companies"],
  description: "B2B companies with their locations (addresses) and customer contacts.",
  columns: [...COMPANY_COLUMNS, ...LOCATION_COLUMNS, ...CONTACT_COLUMNS],
  supportsQuery: true,
  groups: [
    { key: "locations", label: "Locations", default: true },
    { key: "contacts", label: "Contacts", default: true },
    { key: "metafields", label: "Metafields", default: true },
  ],
  export: exportCompanies,
  import: { keyColumns: ["ID", "External ID", "Name"], apply: importCompany },
};

// Exported for tests.
export const _internal = { companyFields, parseLocations, parseContacts };
