/**
 * Core types shared by the import/export engine and every entity.
 *
 * A spreadsheet row is a flat map of column header -> cell text. Every entity
 * knows how to turn Shopify objects into rows (export) and groups of rows back
 * into API calls (import).
 */

export type Row = Record<string, string>;

export type Gql = <T = any>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

/** Runs a bulk operation query and yields reconstructed root objects. */
export type BulkRunner = (query: string) => AsyncIterable<any>;

export type Logger = (message: string) => void;

/** Commands supported in the "Command" column, Matrixify compatible. */
export type Command = "NEW" | "MERGE" | "UPDATE" | "REPLACE" | "DELETE" | "IGNORE";

export const COMMANDS: Command[] = ["NEW", "MERGE", "UPDATE", "REPLACE", "DELETE", "IGNORE"];

export type FilterType = "text" | "enum" | "number" | "date" | "boolean" | "id";

/** One filterable field of an entity, mapped to a Shopify search syntax field. */
export interface FilterField {
  /** Shopify search field, e.g. `vendor`, `financial_status`. */
  key: string;
  label: string;
  type: FilterType;
  /** Allowed values for enum fields. */
  options?: Array<{ value: string; label: string }>;
  help?: string;
}

export type FilterOp =
  | "is"
  | "is_not"
  | "starts_with"
  | "any_of"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between";

/** A filter row from the export form: `field op value [and value2]`. */
export interface FilterCondition {
  field: string;
  op: FilterOp;
  value: string;
  /** Upper bound for `between`; extra values for `any_of` are comma separated in `value`. */
  value2?: string;
}

/** Operators offered for each filter type. */
export const FILTER_OPS: Record<FilterType, FilterOp[]> = {
  text: ["is", "is_not", "starts_with"],
  enum: ["is", "is_not", "any_of"],
  number: ["is", "gt", "gte", "lt", "lte", "between"],
  date: ["gte", "lte", "between"],
  boolean: ["is"],
  id: ["is", "is_not"],
};

export interface ExportOptions {
  /** Raw Shopify search syntax, e.g. `status:active vendor:Acme` (advanced). */
  query?: string;
  /** Structured filters, combined with AND. */
  filters?: FilterCondition[];
  /** Static columns to include. Undefined means all. Key columns are always kept. */
  columns?: string[];
  /** Column groups to include. Undefined means the entity's defaults. */
  groups?: string[];
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  /** Hard cap on number of root items exported. */
  limit?: number;
}

export interface ExportContext {
  gql: Gql;
  bulk: BulkRunner;
  options: ExportOptions;
  log: Logger;
  cache: Map<string, unknown>;
  /** Report progress (number of root items processed so far). */
  progress: (done: number) => void;
}

export interface ImportOptions {
  /** Validate and report only, do not call write mutations. */
  dryRun?: boolean;
  /** Command used when the Command column is empty. Defaults to MERGE. */
  defaultCommand?: Command;
  /** Parallel items processed at once. */
  concurrency?: number;
}

export interface ImportContext {
  gql: Gql;
  options: ImportOptions;
  log: Logger;
  cache: Map<string, unknown>;
}

export type ResultStatus = "OK" | "Failed" | "Skipped";

export interface ItemResult {
  status: ResultStatus;
  command: Command;
  /** Resulting resource GID, if any. */
  id?: string;
  message?: string;
  /** Extra cells to write back into the rows of this item (e.g. new Variant IDs). */
  rowPatches?: Array<Row | undefined>;
}

export interface ColumnGroup {
  key: string;
  label: string;
  default: boolean;
}

export interface EntityImporter {
  /**
   * Columns identifying an item. Rows are grouped by the first non-empty key
   * column value; rows with every key empty continue the previous item.
   */
  keyColumns: string[];
  apply(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult>;
}

export interface Entity {
  key: string;
  /** Sheet name used for export and recognised on import. */
  sheet: string;
  /** Other sheet / file names recognised on import (lowercase). */
  aliases?: string[];
  description: string;
  /** Preferred column order; columns not listed are appended. */
  columns: string[];
  groups?: ColumnGroup[];
  /** Whether this entity supports the `query` filter in export options. */
  supportsQuery?: boolean;
  /** Structured filters offered in the export form (Shopify search fields). */
  filters?: FilterField[];
  export?: (ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) => Promise<void>;
  import?: EntityImporter;
}

export class ImportError extends Error {}
