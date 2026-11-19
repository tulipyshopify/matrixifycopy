import type { Command, Entity, ExportContext, Gql, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import {
  assertNoUserErrors,
  boolCell,
  buildSearchQuery,
  cell,
  gidToId,
  gqlString,
  joinTags,
  metafieldsFromRow,
  metafieldsToRow,
  parseBool,
  parseSubCommand,
  splitTags,
  str,
  toGid,
} from "../core/util";
import { addTags, narrowToLimit, removeTags, writeMetafields } from "../core/lookups";
import { parseMetafieldColumn } from "../core/util";
import type { MetafieldsNow, RowComparison } from "./product_compare";
import { compareMetafields } from "./product_compare";

// --- Columns --------------------------------------------------------------------

const CUSTOMER_COLUMNS = [
  "ID",
  "Email",
  "Command",
  "First Name",
  "Last Name",
  "Phone",
  "State",
  "Verified Email",
  "Tax Exempt",
  "Tax Exemptions",
  "Note",
  "Tags",
  "Tags Command",
  "Language",
  "Accepts Email Marketing",
  "Email Marketing: Status",
  "Email Marketing: Level",
  "Email Marketing: Updated At",
  "Accepts SMS Marketing",
  "SMS Marketing: Status",
  "SMS Marketing: Level",
  "SMS Marketing: Updated At",
  "Created At",
  "Updated At",
  "Orders Count",
  "Total Spent",
];

/** Address column -> MailingAddressInput field. */
const ADDRESS_FIELDS: Record<string, string> = {
  "Address First Name": "firstName",
  "Address Last Name": "lastName",
  "Address Company": "company",
  "Address Phone": "phone",
  "Address Line 1": "address1",
  "Address Line 2": "address2",
  "Address City": "city",
  "Address Province Code": "provinceCode",
  "Address Country Code": "countryCode",
  "Address Zip": "zip",
};

const ADDRESS_COLUMNS = ["Address ID", "Address Command", ...Object.keys(ADDRESS_FIELDS), "Address Is Default"];

/** Marketing states a merchant can write. */
const EMAIL_STATES = ["SUBSCRIBED", "UNSUBSCRIBED", "NOT_SUBSCRIBED", "PENDING"];
const SMS_STATES = ["SUBSCRIBED", "UNSUBSCRIBED", "NOT_SUBSCRIBED", "PENDING"];
/**
 * States the API reports (and export writes) but which cannot be set:
 * CustomerEmailAddressMarketingState has INVALID, the consent enums have
 * REDACTED. Rows carrying them leave consent untouched.
 */
const READ_ONLY_STATES = ["INVALID", "REDACTED"];
const OPT_IN_LEVELS = ["SINGLE_OPT_IN", "CONFIRMED_OPT_IN", "UNKNOWN"];

function lower(v: string | null | undefined): string {
  return v ? v.toLowerCase() : "";
}

function parseEnum(v: string, allowed: string[], col: string): string {
  const s = v.trim().toUpperCase().replace(/[-\s]+/g, "_");
  if (!allowed.includes(s)) {
    throw new ImportError(`${col} "${v}" is not valid, expected one of ${allowed.map((a) => a.toLowerCase()).join(", ")}`);
  }
  return s;
}

/** SMS consent reads back as NEVER_SUBSCRIBED but is written as NOT_SUBSCRIBED. */
function smsState(s: string | null | undefined): string {
  return s === "NEVER_SUBSCRIBED" ? "NOT_SUBSCRIBED" : (s ?? "");
}

// --- Export ---------------------------------------------------------------------------

/** Customers search has no `created_at` filter; `customer_date` is the creation date. */
export function customersSearch(opts: ExportContext["options"]): string {
  const parts = [buildSearchQuery({ ...opts, createdAfter: undefined, createdBefore: undefined })];
  if (opts.createdAfter) parts.push(`customer_date:>='${opts.createdAfter}'`);
  if (opts.createdBefore) parts.push(`customer_date:<='${opts.createdBefore}'`);
  return parts.filter(Boolean).join(" AND ");
}

export function customersBulkQuery(search: string, groups: Set<string>): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  const metafields = `metafields { edges { node { id namespace key type value } } }`;
  const addresses = `addressesV2 { edges { node { id firstName lastName company phone address1 address2 city provinceCode countryCodeV2 zip } } }`;
  return `{
    customers${args} { edges { node {
      id firstName lastName state verifiedEmail taxExempt taxExemptions note tags locale createdAt updatedAt numberOfOrders
      amountSpent { amount }
      defaultEmailAddress { emailAddress marketingState marketingOptInLevel marketingUpdatedAt }
      defaultPhoneNumber { phoneNumber smsMarketingConsent { state optInLevel updatedAt } }
      defaultAddress { id }
      ${groups.has("addresses") ? addresses : ""}
      ${groups.has("metafields") ? metafields : ""}
    } } }
  }`;
}

export function customerToRows(c: any, groups: Set<string>): Row[] {
  const addresses: any[] = groups.has("addresses") ? (c.addresses ?? []) : [];
  const count = Math.max(1, addresses.length);
  const email = c.defaultEmailAddress;
  const sms = c.defaultPhoneNumber?.smsMarketingConsent;
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const row: Row = { ID: gidToId(c.id), Email: email?.emailAddress ?? "" };
    if (i === 0) {
      Object.assign(row, {
        Command: "MERGE",
        "First Name": c.firstName ?? "",
        "Last Name": c.lastName ?? "",
        Phone: c.defaultPhoneNumber?.phoneNumber ?? "",
        State: lower(c.state),
        "Verified Email": boolCell(c.verifiedEmail),
        "Tax Exempt": boolCell(c.taxExempt),
        "Tax Exemptions": (c.taxExemptions ?? []).join(", "),
        Note: c.note ?? "",
        Tags: joinTags(c.tags),
        "Tags Command": "REPLACE",
        Language: c.locale ?? "",
        "Accepts Email Marketing": email ? boolCell(email.marketingState === "SUBSCRIBED") : "",
        "Email Marketing: Status": lower(email?.marketingState),
        "Email Marketing: Level": lower(email?.marketingOptInLevel),
        "Email Marketing: Updated At": email?.marketingUpdatedAt ?? "",
        "Accepts SMS Marketing": sms ? boolCell(sms.state === "SUBSCRIBED") : "",
        "SMS Marketing: Status": lower(smsState(sms?.state)),
        "SMS Marketing: Level": lower(sms?.optInLevel),
        "SMS Marketing: Updated At": sms?.updatedAt ?? "",
        "Created At": c.createdAt ?? "",
        "Updated At": c.updatedAt ?? "",
        "Orders Count": str(c.numberOfOrders),
        "Total Spent": c.amountSpent?.amount ?? "",
      });
      if (groups.has("metafields")) metafieldsToRow(row, c.metafields);
    } else {
      // Repeat Phone so rows keyed by Phone (no email) stay grouped.
      if (!row.Email) row.Phone = c.defaultPhoneNumber?.phoneNumber ?? "";
    }
    const a = addresses[i];
    if (a) {
      Object.assign(row, {
        "Address ID": gidToId(a.id),
        "Address Command": "MERGE",
        "Address First Name": a.firstName ?? "",
        "Address Last Name": a.lastName ?? "",
        "Address Company": a.company ?? "",
        "Address Phone": a.phone ?? "",
        "Address Line 1": a.address1 ?? "",
        "Address Line 2": a.address2 ?? "",
        "Address City": a.city ?? "",
        "Address Province Code": a.provinceCode ?? "",
        "Address Country Code": a.countryCodeV2 ?? "",
        "Address Zip": a.zip ?? "",
        "Address Is Default": boolCell(!!c.defaultAddress?.id && a.id === c.defaultAddress.id),
      });
    }
    rows.push(row);
  }
  return rows;
}

async function exportCustomers(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? customersEntity.groups!.filter((g) => g.default).map((g) => g.key));
  let n = 0;
  const search = await narrowToLimit(ctx, "customers", customersSearch(ctx.options));
  for await (const c of ctx.bulk(customersBulkQuery(search, groups))) {
    await emit(customerToRows(c, groups));
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import: fetching existing customers -----------------------------------------------

const CUSTOMER_FIELDS = `#graphql
  fragment ImportCustomer on Customer {
    id firstName lastName displayName note locale taxExempt taxExemptions tags
    defaultEmailAddress { emailAddress marketingState marketingOptInLevel }
    defaultPhoneNumber { phoneNumber smsMarketingConsent { state optInLevel } }
    defaultAddress { id }
    addressesV2(first: 250) {
      nodes { id firstName lastName company phone address1 address2 city provinceCode countryCodeV2 zip }
    }
  }
`;

const CUSTOMER_BY_ID = `#graphql
  query ImportCustomerById($id: ID!) { customer(id: $id) { ...ImportCustomer } }
  ${CUSTOMER_FIELDS}
`;

const CUSTOMER_BY_IDENTIFIER = `#graphql
  query ImportCustomerByIdentifier($identifier: CustomerIdentifierInput!) {
    customerByIdentifier(identifier: $identifier) { ...ImportCustomer }
  }
  ${CUSTOMER_FIELDS}
`;

interface ExistingAddress {
  id: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  provinceCode: string | null;
  countryCodeV2: string | null;
  zip: string | null;
}

interface ExistingCustomer {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  note?: string | null;
  locale?: string | null;
  taxExempt?: boolean | null;
  taxExemptions?: string[] | null;
  tags: string[];
  defaultEmailAddress: { emailAddress: string; marketingState: string; marketingOptInLevel: string | null } | null;
  defaultPhoneNumber: { phoneNumber: string; smsMarketingConsent: { state: string; optInLevel: string | null } } | null;
  defaultAddress: { id: string } | null;
  addressesV2: { nodes: ExistingAddress[] };
}

async function fetchCustomer(
  gql: Gql,
  by: { id?: string; email?: string; phone?: string },
): Promise<ExistingCustomer | null> {
  let c: any = null;
  if (by.id) c = (await gql(CUSTOMER_BY_ID, { id: by.id })).customer;
  if (!c && by.email) c = (await gql(CUSTOMER_BY_IDENTIFIER, { identifier: { emailAddress: by.email } })).customerByIdentifier;
  if (!c && by.phone) c = (await gql(CUSTOMER_BY_IDENTIFIER, { identifier: { phoneNumber: by.phone } })).customerByIdentifier;
  return c ?? null;
}

// --- Import: parsing rows ------------------------------------------------------------

/** CustomerInput fields from the top row (no tags, metafields or consent). */
function customerFields(row: Row): Record<string, any> {
  const f: Record<string, any> = {};
  const email = cell(row, "Email");
  if (email) f.email = email;
  const phone = cell(row, "Phone");
  if (phone) f.phone = phone;
  const first = cell(row, "First Name");
  if (first !== undefined) f.firstName = first;
  const last = cell(row, "Last Name");
  if (last !== undefined) f.lastName = last;
  const note = cell(row, "Note");
  if (note !== undefined) f.note = note;
  const locale = cell(row, "Language");
  if (locale) f.locale = locale;
  const taxExempt = parseBool(cell(row, "Tax Exempt"));
  if (taxExempt !== undefined) f.taxExempt = taxExempt;
  const exemptions = cell(row, "Tax Exemptions");
  if (exemptions !== undefined) f.taxExemptions = splitTags(exemptions).map((e) => e.toUpperCase().replace(/[-\s]+/g, "_"));
  return f;
}

interface ConsentSpec {
  marketingState: string;
  marketingOptInLevel?: string;
  consentUpdatedAt?: string;
}

/** Normalises a status cell; NEVER_SUBSCRIBED (SMS read value) is written as NOT_SUBSCRIBED. */
function normState(v: string): string {
  return smsState(v.trim().toUpperCase().replace(/[-\s]+/g, "_"));
}

/**
 * Consent from "<Prefix>: Status" (wins) or "Accepts <X> Marketing". A FALSE
 * "Accepts" means UNSUBSCRIBED for existing customers, NOT_SUBSCRIBED for new.
 * Returns undefined when the row sets no consent, or when the status is a
 * read-only state (invalid / redacted) that cannot be written back.
 */
function consentFromRow(row: Row, kind: "Email" | "SMS", isNew: boolean): ConsentSpec | undefined {
  const status = cell(row, `${kind} Marketing: Status`);
  const accepts = parseBool(cell(row, `Accepts ${kind} Marketing`));
  let state: string | undefined;
  if (status) {
    const st = normState(status);
    if (READ_ONLY_STATES.includes(st)) return undefined;
    state = parseEnum(st === "NOT_SUBSCRIBED" ? st : status, kind === "Email" ? EMAIL_STATES : SMS_STATES, `${kind} Marketing: Status`);
  } else if (accepts !== undefined) state = accepts ? "SUBSCRIBED" : isNew ? "NOT_SUBSCRIBED" : "UNSUBSCRIBED";
  if (!state) return undefined;
  const spec: ConsentSpec = { marketingState: state };
  const level = cell(row, `${kind} Marketing: Level`);
  if (level) spec.marketingOptInLevel = parseEnum(level, OPT_IN_LEVELS, `${kind} Marketing: Level`);
  else if (state === "SUBSCRIBED") spec.marketingOptInLevel = "SINGLE_OPT_IN";
  const at = cell(row, `${kind} Marketing: Updated At`);
  if (at) spec.consentUpdatedAt = at;
  return spec;
}

interface AddressSpec {
  rowIndex: number;
  id?: string;
  command: "MERGE" | "DELETE" | "REPLACE";
  input: Record<string, string>;
  isDefault: boolean;
}

function isAddressRow(row: Row): boolean {
  return ["Address ID", ...Object.keys(ADDRESS_FIELDS)].some((c) => (cell(row, c) ?? "") !== "");
}

function parseAddresses(rows: Row[]): AddressSpec[] {
  const specs: AddressSpec[] = [];
  rows.forEach((row, rowIndex) => {
    if (!isAddressRow(row)) return;
    const input: Record<string, string> = {};
    for (const [col, field] of Object.entries(ADDRESS_FIELDS)) {
      const v = cell(row, col);
      if (v !== undefined) input[field] = field === "countryCode" ? v.toUpperCase() : v;
    }
    if (input.countryCode === "") delete input.countryCode; // enum: blank is not a value
    specs.push({
      rowIndex,
      id: toGid("MailingAddress", cell(row, "Address ID")),
      command: parseSubCommand(cell(row, "Address Command"), ["MERGE", "DELETE", "REPLACE"] as const, "MERGE"),
      input,
      isDefault: parseBool(cell(row, "Address Is Default")) === true,
    });
  });
  return specs;
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** Address identity when no Address ID is given: line 1, city, zip and country. */
function sameAddress(a: ExistingAddress, input: Record<string, string>): boolean {
  if (!input.address1) return false;
  return (
    norm(a.address1) === norm(input.address1) &&
    (input.city === undefined || norm(a.city) === norm(input.city)) &&
    (input.zip === undefined || norm(a.zip) === norm(input.zip)) &&
    (input.countryCode === undefined || norm(a.countryCodeV2) === norm(input.countryCode))
  );
}

function addressChanged(a: ExistingAddress, input: Record<string, string>): boolean {
  return Object.entries(input).some(([k, v]) => norm((a as any)[k === "countryCode" ? "countryCodeV2" : k]) !== norm(v));
}

// --- Import: mutations ------------------------------------------------------------------

const CUSTOMER_CREATE = `#graphql
  mutation ImportCustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const CUSTOMER_UPDATE = `#graphql
  mutation ImportCustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const CUSTOMER_DELETE = `#graphql
  mutation ImportCustomerDelete($id: ID!) {
    customerDelete(input: { id: $id }) {
      deletedCustomerId
      userErrors { field message }
    }
  }
`;

const EMAIL_CONSENT = `#graphql
  mutation ImportCustomerEmailConsent($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) {
      userErrors { field message }
    }
  }
`;

const SMS_CONSENT = `#graphql
  mutation ImportCustomerSmsConsent($input: CustomerSmsMarketingConsentUpdateInput!) {
    customerSmsMarketingConsentUpdate(input: $input) {
      userErrors { field message }
    }
  }
`;

const ADDRESS_CREATE = `#graphql
  mutation ImportCustomerAddressCreate($customerId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
    customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: $setAsDefault) {
      address { id }
      userErrors { field message }
    }
  }
`;

const ADDRESS_UPDATE = `#graphql
  mutation ImportCustomerAddressUpdate($customerId: ID!, $addressId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
    customerAddressUpdate(customerId: $customerId, addressId: $addressId, address: $address, setAsDefault: $setAsDefault) {
      address { id }
      userErrors { field message }
    }
  }
`;

const ADDRESS_DELETE = `#graphql
  mutation ImportCustomerAddressDelete($customerId: ID!, $addressId: ID!) {
    customerAddressDelete(customerId: $customerId, addressId: $addressId) {
      deletedAddressId
      userErrors { field message }
    }
  }
`;

const ADDRESS_DEFAULT = `#graphql
  mutation ImportCustomerAddressDefault($customerId: ID!, $addressId: ID!) {
    customerUpdateDefaultAddress(customerId: $customerId, addressId: $addressId) {
      userErrors { field message }
    }
  }
`;

/** Applies address rows; `existing` is empty for a new customer. */
async function applyAddresses(
  ctx: ImportContext,
  customerId: string,
  specs: AddressSpec[],
  existing: ExistingAddress[],
  defaultId: string | null,
): Promise<{ rowPatches: Array<Row | undefined>; notes: string[] }> {
  const rowPatches: Array<Row | undefined> = [];
  const notes: string[] = [];
  const matched = new Set<string>();
  const find = (s: AddressSpec) =>
    s.id ? existing.find((a) => a.id === s.id) : existing.find((a) => !matched.has(a.id) && sameAddress(a, s.input));

  // Deletes first, so REPLACE/DELETE never clash with creates of the same address.
  const live: Array<{ spec: AddressSpec; ex?: ExistingAddress }> = [];
  const toDelete = new Set<string>();
  for (const s of specs) {
    const ex = find(s);
    if (s.command === "DELETE") {
      if (ex) toDelete.add(ex.id);
      else notes.push(`Address on row ${s.rowIndex + 1} to delete not found`);
      continue;
    }
    if (s.id && !ex) throw new ImportError(`Address ID ${gidToId(s.id)} not found on this customer`);
    if (ex) matched.add(ex.id);
    live.push({ spec: s, ex });
  }
  if (specs.some((s) => s.command === "REPLACE")) {
    for (const a of existing) if (!matched.has(a.id)) toDelete.add(a.id);
  }
  for (const addressId of toDelete) {
    const d = await ctx.gql(ADDRESS_DELETE, { customerId, addressId });
    assertNoUserErrors(d.customerAddressDelete, "Delete address");
  }

  for (const { spec, ex } of live) {
    if (ex) {
      const changed = addressChanged(ex, spec.input);
      const makeDefault = spec.isDefault && ex.id !== defaultId;
      if (changed) {
        const d = await ctx.gql(ADDRESS_UPDATE, {
          customerId,
          addressId: ex.id,
          address: spec.input,
          setAsDefault: makeDefault || undefined,
        });
        assertNoUserErrors(d.customerAddressUpdate, "Update address");
      } else if (makeDefault) {
        const d = await ctx.gql(ADDRESS_DEFAULT, { customerId, addressId: ex.id });
        assertNoUserErrors(d.customerUpdateDefaultAddress, "Default address");
      }
      rowPatches[spec.rowIndex] = { "Address ID": gidToId(ex.id) };
    } else {
      const d = await ctx.gql(ADDRESS_CREATE, { customerId, address: spec.input, setAsDefault: spec.isDefault || undefined });
      assertNoUserErrors(d.customerAddressCreate, "Create address");
      rowPatches[spec.rowIndex] = { "Address ID": gidToId(d.customerAddressCreate.address.id) };
    }
  }
  if (toDelete.size) notes.push(`${toDelete.size} addresses deleted`);
  return { rowPatches, notes };
}

/**
 * Whether the sheet's consent differs from the customer's current consent.
 * A state derived only from "Accepts ... Marketing" FALSE is satisfied by any
 * current state that is not subscribed/pending (e.g. never subscribed, invalid,
 * redacted), so re-importing an export does not try to rewrite it.
 */
function consentChanged(
  row: Row,
  kind: "Email" | "SMS",
  spec: ConsentSpec,
  current: { state?: string | null; level?: string | null } | undefined,
): boolean {
  const cur = smsState(current?.state ?? "");
  const fromStatus = !!cell(row, `${kind} Marketing: Status`);
  let stateChanged = spec.marketingState !== cur;
  if (!fromStatus && spec.marketingState === "UNSUBSCRIBED") stateChanged = cur === "SUBSCRIBED" || cur === "PENDING";
  const levelChanged =
    !!spec.marketingOptInLevel && !!cell(row, `${kind} Marketing: Level`) && spec.marketingOptInLevel !== (current?.level ?? null);
  return stateChanged || levelChanged;
}

interface PreparedCustomer {
  input: Record<string, any>;
  addresses: AddressSpec[];
}

/** Builds and validates the full create input without writing anything. */
function prepareCreate(rows: Row[], top: Row): PreparedCustomer {
  const input: Record<string, any> = customerFields(top);
  if (!input.email && !input.phone && !input.firstName && !input.lastName) {
    throw new ImportError("Email, Phone, First Name or Last Name is required to create a customer");
  }
  const tags = cell(top, "Tags");
  if (tags) input.tags = splitTags(tags);
  const mf = metafieldsFromRow(top).set;
  if (mf.length) input.metafields = mf;
  const email = consentFromRow(top, "Email", true);
  if (email) input.emailMarketingConsent = email;
  const sms = consentFromRow(top, "SMS", true);
  if (sms) input.smsMarketingConsent = sms;
  // A new customer has no addresses yet: Address IDs (e.g. from an export being
  // REPLACEd) refer to the old record, so every address row is created.
  const addresses = parseAddresses(rows)
    .filter((s) => s.command !== "DELETE")
    .map((s) => ({ ...s, id: undefined }));
  return { input, addresses };
}

async function sendCreate(
  ctx: ImportContext,
  p: PreparedCustomer,
): Promise<{ id: string; rowPatches: Array<Row | undefined>; notes: string[] }> {
  const d = await ctx.gql(CUSTOMER_CREATE, { input: p.input });
  assertNoUserErrors(d.customerCreate, "Create customer");
  const id: string = d.customerCreate.customer.id;
  const r = await applyAddresses(ctx, id, p.addresses, [], null);
  return { id, ...r };
}

async function createCustomer(ctx: ImportContext, rows: Row[], top: Row): Promise<{ id: string; rowPatches: Array<Row | undefined>; notes: string[] }> {
  return sendCreate(ctx, prepareCreate(rows, top));
}

async function updateCustomer(
  ctx: ImportContext,
  existing: ExistingCustomer,
  rows: Row[],
  top: Row,
): Promise<{ rowPatches: Array<Row | undefined>; notes: string[] }> {
  const id = existing.id;
  const fields = customerFields(top);
  if (fields.email && norm(fields.email) === norm(existing.defaultEmailAddress?.emailAddress)) delete fields.email;
  if (fields.phone && fields.phone === existing.defaultPhoneNumber?.phoneNumber) delete fields.phone;
  const tagsCell = cell(top, "Tags");
  const tagsCommand = parseSubCommand(cell(top, "Tags Command"), ["REPLACE", "MERGE", "DELETE"] as const, "REPLACE");
  if (tagsCell !== undefined && tagsCommand === "REPLACE") fields.tags = splitTags(tagsCell);
  if (Object.keys(fields).length) {
    const d = await ctx.gql(CUSTOMER_UPDATE, { input: { id, ...fields } });
    assertNoUserErrors(d.customerUpdate, "Update customer");
  }
  if (tagsCell && tagsCommand === "MERGE") await addTags(ctx.gql, id, splitTags(tagsCell));
  if (tagsCell && tagsCommand === "DELETE") await removeTags(ctx.gql, id, splitTags(tagsCell));

  const mf = metafieldsFromRow(top);
  await writeMetafields(ctx.gql, id, mf.set, mf.blank);

  // Consent has dedicated mutations; only call them when something changes.
  const email = consentFromRow(top, "Email", false);
  const curEmail = existing.defaultEmailAddress;
  if (email && consentChanged(top, "Email", email, { state: curEmail?.marketingState, level: curEmail?.marketingOptInLevel })) {
    const d = await ctx.gql(EMAIL_CONSENT, { input: { customerId: id, emailMarketingConsent: email } });
    assertNoUserErrors(d.customerEmailMarketingConsentUpdate, "Email marketing consent");
  }
  const sms = consentFromRow(top, "SMS", false);
  const curSms = existing.defaultPhoneNumber?.smsMarketingConsent;
  if (sms && consentChanged(top, "SMS", sms, { state: curSms?.state, level: curSms?.optInLevel })) {
    const d = await ctx.gql(SMS_CONSENT, { input: { customerId: id, smsMarketingConsent: sms } });
    assertNoUserErrors(d.customerSmsMarketingConsentUpdate, "SMS marketing consent");
  }

  const specs = parseAddresses(rows);
  if (!specs.length) return { rowPatches: [], notes: [] };
  return applyAddresses(ctx, id, specs, existing.addressesV2.nodes, existing.defaultAddress?.id ?? null);
}

async function deleteCustomer(gql: Gql, id: string) {
  const d = await gql(CUSTOMER_DELETE, { id });
  assertNoUserErrors(d.customerDelete, "Delete customer");
}

const CUSTOMER_METAFIELDS_NOW = `#graphql
  query ImportCustomerMetafieldsNow($id: ID!, $keys: [String!]) {
    customer(id: $id) { metafields(first: 250, keys: $keys) { nodes { namespace key type value } } }
  }
`;

const digits = (v: string | null | undefined) => (v ?? "").replace(/[^\d+]/g, "");

/** Problems with a customer row that can be told from the file alone. */
function customerProblems(top: Row, isNew: boolean): string[] {
  const errors: string[] = [];
  const attempt = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof ImportError)) throw e;
      errors.push(e.message);
    }
  };
  const email = cell(top, "Email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`Email "${email}" is not an email address`);
  const phone = cell(top, "Phone");
  if (phone && !/^\+?\d{7,15}$/.test(phone.replace(/[\s().-]/g, ""))) {
    errors.push(`Phone "${phone}" is not a full phone number. Write it with the country code, for example +447911123456`);
  }
  attempt(() => customerFields(top));
  attempt(() => consentFromRow(top, "Email", isNew));
  attempt(() => consentFromRow(top, "SMS", isNew));
  attempt(() => parseSubCommand(cell(top, "Tags Command"), ["REPLACE", "MERGE", "DELETE"] as const, "REPLACE"));
  const mfErrors: string[] = [];
  metafieldsFromRow(top, "Metafield", mfErrors);
  errors.push(...mfErrors);
  return errors;
}

const who = (c: ExistingCustomer) => [c.displayName, c.defaultEmailAddress?.emailAddress].filter(Boolean).join(", ") || `ID ${gidToId(c.id)}`;
const addressLine = (a: Record<string, any>) => [a.address1, a.city, a.zip, a.countryCodeV2 ?? a.countryCode].filter(Boolean).join(", ") || "(no street)";

/**
 * What a row would change on a customer who exists, field by field, without
 * writing anything: the file's cells against what the store holds now.
 */
async function previewUpdate(ctx: ImportContext, existing: ExistingCustomer, rows: Row[], top: Row, command: Command): Promise<ItemResult> {
  const errors = customerProblems(top, false);
  const changes: string[] = [];
  const warnings: string[] = [];
  const clears: string[] = [];
  let deletes = 0;
  const line = (label: string, old: string, next: string) => changes.push(`${label}: ${old === "" ? "(empty)" : old} → ${next === "" ? "(cleared)" : next}`);
  const text = (col: string, now: string | null | undefined, blank: "clears" | "leaves", same = (a: string, b: string) => a === b) => {
    const v = cell(top, col);
    const cur = now ?? "";
    if (v === undefined) return;
    if (v === "") {
      if (blank === "clears" && cur !== "") {
        line(col, cur, "");
        clears.push(col);
      }
      return;
    }
    if (!same(v, cur)) line(col, cur, v);
  };
  const caseless = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  text("Email", existing.defaultEmailAddress?.emailAddress, "leaves", caseless);
  text("Phone", existing.defaultPhoneNumber?.phoneNumber, "leaves", (a, b) => digits(a) === digits(b));
  text("First Name", existing.firstName, "clears");
  text("Last Name", existing.lastName, "clears");
  text("Note", existing.note, "clears");
  text("Language", existing.locale, "leaves", caseless);

  let taxExempt: boolean | undefined;
  try {
    taxExempt = parseBool(cell(top, "Tax Exempt"));
  } catch {
    taxExempt = undefined; // listed among the errors
  }
  if (taxExempt !== undefined && existing.taxExempt !== undefined && existing.taxExempt !== null && taxExempt !== existing.taxExempt) {
    line("Tax Exempt", existing.taxExempt ? "yes" : "no", taxExempt ? "yes" : "no");
    warnings.push(taxExempt ? "the customer becomes tax exempt: no tax is charged on their orders" : "the customer stops being tax exempt: tax is charged on their orders again");
  }
  const exemptions = cell(top, "Tax Exemptions");
  if (exemptions !== undefined) {
    const want = splitTags(exemptions).map((e) => e.toUpperCase().replace(/[-\s]+/g, "_")).sort();
    const now = [...(existing.taxExemptions ?? [])].sort();
    if (want.join(",") !== now.join(",")) {
      line("Tax Exemptions", now.join(", ").toLowerCase(), want.join(", ").toLowerCase());
      if (!want.length) clears.push("Tax Exemptions");
      else warnings.push("the customer's tax exemptions change");
    }
  }

  const tagsCell = cell(top, "Tags");
  if (tagsCell !== undefined) {
    let tagsCommand: "REPLACE" | "MERGE" | "DELETE" = "REPLACE";
    try {
      tagsCommand = parseSubCommand(cell(top, "Tags Command"), ["REPLACE", "MERGE", "DELETE"] as const, "REPLACE");
    } catch {
      // listed among the errors
    }
    const now = existing.tags ?? [];
    const want = splitTags(tagsCell);
    const low = (t: string) => t.normalize("NFC").toLowerCase();
    const has = new Set(now.map(low));
    const wanted = new Set(want.map(low));
    const added = want.filter((t) => !has.has(low(t)));
    const removedByReplace = now.filter((t) => !wanted.has(low(t)));
    if (tagsCommand === "REPLACE" && (added.length || removedByReplace.length)) {
      if (!want.length) {
        changes.push(`Tags: ${joinTags(now)} → (cleared: all ${now.length} tags removed)`);
        clears.push("Tags");
      } else changes.push(`Tags: ${joinTags(now) || "(empty)"} → ${joinTags(want)}${removedByReplace.length ? ` (removes: ${joinTags(removedByReplace)})` : ""}${added.length ? ` (adds: ${joinTags(added)})` : ""}`);
    } else if (tagsCommand === "MERGE" && added.length) changes.push(`Tags: ${joinTags(now) || "(empty)"} → adds ${joinTags(added)}`);
    else if (tagsCommand === "DELETE") {
      const removed = now.filter((t) => wanted.has(low(t)));
      if (removed.length) {
        changes.push(`Tags: ${joinTags(now)} → removes ${joinTags(removed)}`);
        if (removed.length === now.length) clears.push("Tags");
      }
    }
  }

  // Marketing consent is the customer's own decision: any change is pointed out.
  for (const kind of ["Email", "SMS"] as const) {
    let spec: ConsentSpec | undefined;
    try {
      spec = consentFromRow(top, kind, false);
    } catch {
      spec = undefined; // listed among the errors
    }
    if (!spec) continue;
    const cur =
      kind === "Email"
        ? { state: existing.defaultEmailAddress?.marketingState, level: existing.defaultEmailAddress?.marketingOptInLevel }
        : { state: existing.defaultPhoneNumber?.smsMarketingConsent?.state, level: existing.defaultPhoneNumber?.smsMarketingConsent?.optInLevel };
    if (!consentChanged(top, kind, spec, cur)) continue;
    const words = (v: string | null | undefined) => (v ? smsState(v).toLowerCase().replace(/_/g, " ") : "not set");
    const label = `${kind === "Email" ? "Email" : "SMS"} marketing`;
    if (spec.marketingState !== smsState(cur.state ?? "")) line(label, words(cur.state), words(spec.marketingState));
    else line(`${label} opt-in level`, words(cur.level), words(spec.marketingOptInLevel));
    warnings.push(
      spec.marketingState === "SUBSCRIBED" || spec.marketingState === "PENDING"
        ? `the customer is set to receive ${kind === "Email" ? "email" : "text message"} marketing (now: ${words(cur.state)}). Only do this if they agreed to it: sending marketing without consent can break the law`
        : `the customer's ${kind === "Email" ? "email" : "text message"} marketing consent changes (${words(cur.state)} → ${words(spec.marketingState)})`,
    );
  }

  // Addresses, matched the way the import matches them.
  let specs: AddressSpec[] = [];
  try {
    specs = parseAddresses(rows);
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
    errors.push(e.message);
  }
  const addresses = existing.addressesV2?.nodes ?? [];
  const matched = new Set<string>();
  for (const s of specs) {
    const ex = s.id ? addresses.find((a) => a.id === s.id) : addresses.find((a) => !matched.has(a.id) && sameAddress(a, s.input));
    if (s.id && !ex && s.command !== "DELETE") {
      errors.push(`Address ID ${gidToId(s.id)} not found on this customer`);
      continue;
    }
    if (s.command === "DELETE") {
      if (ex) {
        changes.push(`Deletes the address ${addressLine(ex)}`);
        deletes++;
        matched.add(ex.id);
      }
      continue;
    }
    if (!ex) {
      changes.push(`New address: ${addressLine(s.input)}${s.isDefault ? " (becomes the default)" : ""}`);
      continue;
    }
    matched.add(ex.id);
    for (const [k, v] of Object.entries(s.input)) {
      const cur = (ex as any)[k === "countryCode" ? "countryCodeV2" : k] ?? "";
      if (norm(cur) !== norm(v)) line(`Address (${addressLine(ex)}) ${Object.entries(ADDRESS_FIELDS).find(([, f]) => f === k)?.[0].replace(/^Address /, "") ?? k}`, String(cur), v);
    }
    if (s.isDefault && ex.id !== existing.defaultAddress?.id) changes.push(`Default address: becomes ${addressLine(ex)}`);
  }
  if (specs.some((s) => s.command === "REPLACE")) {
    const gone = addresses.filter((a) => !matched.has(a.id));
    if (gone.length) {
      changes.push(`Deletes ${gone.length} other address${gone.length === 1 ? "" : "es"} not in the file: ${gone.slice(0, 3).map(addressLine).join("; ")}${gone.length > 3 ? "…" : ""}`);
      deletes += gone.length;
    }
  }

  // Metafields against their current values.
  const keys = Object.keys(top).map((h) => parseMetafieldColumn(h, "Metafield")).filter(Boolean).map((c) => `${c!.namespace}.${c!.key}`);
  if (keys.length) {
    let now: MetafieldsNow | null = null;
    try {
      const nodes: any[] = (await ctx.gql(CUSTOMER_METAFIELDS_NOW, { id: existing.id, keys }))?.customer?.metafields?.nodes ?? [];
      now = new Map(nodes.map((n) => [n.key.includes(".") && n.key.startsWith(`${n.namespace}.`) ? n.key : `${n.namespace}.${n.key}`, { type: n.type, value: n.value }]));
    } catch {
      now = null;
    }
    const cmp: RowComparison = { changes: [], seen: {}, changed: new Set(), old: {}, errors: [] };
    compareMetafields(top, "Metafield", now, "", cmp);
    for (const c of cmp.changes) {
      changes.push(`${c.label}: ${c.old} → ${c.next}`);
      if (c.clears) clears.push(c.label);
    }
  }

  const title = who(existing);
  if (errors.length) return { status: "Failed", command, id: existing.id, title, message: errors.join("; "), errors };
  return {
    status: "OK",
    command,
    id: existing.id,
    title,
    preview: { action: changes.length ? "update" : "none", changes, warnings, ...(clears.length ? { clears } : {}), ...(deletes ? { deletes } : {}) },
  };
}

/** What a row would create, checked in full without writing anything. */
function previewCreate(rows: Row[], top: Row, command: Command, replacing?: ExistingCustomer): ItemResult {
  const errors = customerProblems(top, true);
  let prepared: PreparedCustomer | null = null;
  try {
    prepared = prepareCreate(rows, top);
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
    if (!errors.includes(e.message)) errors.push(e.message);
  }
  const title = [cell(top, "First Name"), cell(top, "Last Name")].filter(Boolean).join(" ") || cell(top, "Email") || undefined;
  if (errors.length || !prepared) return { status: "Failed", command, title, message: errors.join("; "), errors };
  const i = prepared.input;
  const changes = [
    ...(replacing ? [`Deletes the customer ${who(replacing)} and creates them again from this file. Their order history stays, but anything not in the file is lost.`] : []),
    `New customer: ${[[i.firstName, i.lastName].filter(Boolean).join(" "), i.email, i.phone].filter(Boolean).join(", ")}`,
    ...(i.tags?.length ? [`Tags: ${joinTags(i.tags)}`] : []),
    ...(i.taxExempt ? ["Tax Exempt: yes"] : []),
    ...(prepared.addresses.length ? [`${prepared.addresses.length} address${prepared.addresses.length === 1 ? "" : "es"}`] : []),
    ...(i.metafields?.length ? [`${i.metafields.length} metafield${i.metafields.length === 1 ? "" : "s"}`] : []),
  ];
  const warnings: string[] = [];
  if (i.emailMarketingConsent?.marketingState === "SUBSCRIBED") warnings.push("the new customer is set to receive email marketing. Only do this if they agreed to it");
  if (i.smsMarketingConsent?.marketingState === "SUBSCRIBED") warnings.push("the new customer is set to receive text message marketing. Only do this if they agreed to it");
  if (i.taxExempt) warnings.push("the new customer is tax exempt: no tax is charged on their orders");
  return { status: "OK", command, title, preview: { action: replacing ? "replace" : "create", changes, warnings, creates: 1, ...(replacing ? { deletes: 1 } : {}) } };
}

export async function importCustomer(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const top = rows[0];
  const id = toGid("Customer", cell(top, "ID"));
  const email = cell(top, "Email");
  const phone = cell(top, "Phone");
  const existing = id || email || phone ? await fetchCustomer(ctx.gql, { id, email, phone }) : null;
  const dry = !!ctx.options.dryRun;
  const notFound = `Customer not found${id ? ` (ID ${gidToId(id)})` : email ? ` (${email})` : ""}. ${command === "UPDATE" ? "Rows only update customers that exist; to create this customer, set Command to MERGE or NEW" : ""}`.trim();

  switch (command) {
    case "DELETE": {
      if (!existing) return { status: "Failed", command, message: notFound };
      if (dry) return { status: "OK", command, id: existing.id, title: who(existing), preview: { action: "delete", changes: [`Deletes the customer ${who(existing)}. This cannot be undone.`], warnings: [], deletes: 1 } };
      await deleteCustomer(ctx.gql, existing.id);
      return { status: "OK", command, id: existing.id, message: "Deleted" };
    }
    case "NEW": {
      if (existing) return { status: "Failed", command, id: existing.id, message: "Customer already exists" };
      if (dry) return previewCreate(rows, top, command);
      const problems = customerProblems(top, true);
      if (problems.length) return { status: "Failed", command, message: problems.join("; "), errors: problems };
      const r = await createCustomer(ctx, rows, top);
      return { status: "OK", command, id: r.id, message: ["Created", ...r.notes].join("; "), rowPatches: r.rowPatches };
    }
    case "REPLACE": {
      if (dry) return previewCreate(rows, top, command, existing ?? undefined);
      const problems = customerProblems(top, true);
      if (problems.length) return { status: "Failed", command, message: problems.join("; "), errors: problems };
      // Validate everything before deleting anything.
      const prepared = prepareCreate(rows, top);
      if (existing) await deleteCustomer(ctx.gql, existing.id);
      const r = await sendCreate(ctx, prepared);
      return { status: "OK", command, id: r.id, message: [existing ? "Replaced" : "Created", ...r.notes].join("; "), rowPatches: r.rowPatches };
    }
    case "UPDATE":
    case "MERGE": {
      if (!existing) {
        if (command === "UPDATE") return { status: "Failed", command, message: notFound };
        if (dry) return previewCreate(rows, top, command);
        const problems = customerProblems(top, true);
        if (problems.length) return { status: "Failed", command, message: problems.join("; "), errors: problems };
        const r = await createCustomer(ctx, rows, top);
        return { status: "OK", command, id: r.id, message: ["Created", ...r.notes].join("; "), rowPatches: r.rowPatches };
      }
      if (dry) return previewUpdate(ctx, existing, rows, top, command);
      const problems = customerProblems(top, false);
      if (problems.length) return { status: "Failed", command, id: existing.id, message: problems.join("; "), errors: problems };
      const r = await updateCustomer(ctx, existing, rows, top);
      return { status: "OK", command, id: existing.id, message: ["Updated", ...r.notes].join("; "), rowPatches: r.rowPatches };
    }
    default:
      return { status: "Skipped", command };
  }
}

export const customersEntity: Entity = {
  key: "customers",
  sheet: "Customers",
  aliases: ["customer"],
  description: "Customers with addresses, marketing consent, tags, tax settings and metafields.",
  columns: [...CUSTOMER_COLUMNS, ...ADDRESS_COLUMNS],
  supportsQuery: true,
  groups: [
    { key: "addresses", label: "Addresses", default: true },
    { key: "metafields", label: "Metafields", default: true },
  ],
  export: exportCustomers,
  import: { keyColumns: ["ID", "Email", "Phone"], apply: importCustomer },
};

// Exported for tests.
export const _internal = { customerFields, consentFromRow, parseAddresses };
