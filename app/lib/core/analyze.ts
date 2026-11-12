import type { Command, Entity } from "./types";
import { COMMANDS } from "./types";
import { cell } from "./util";
import { COMMENT_COLUMN, RESULT_COLUMN, groupRows } from "./importer";
import { detectEntity } from "./registry";
import type { Sheet } from "./sheets";

/** Column prefixes whose names are dynamic (metafields, per-location stock…). */
const DYNAMIC_PREFIXES = ["Metafield:", "Variant Metafield:", "Inventory Available:", "Inventory Available Adjust:", "Field:"];

export interface SheetAnalysis {
  sheet: string;
  /** Entity key, or null when the sheet name isn't recognised. */
  entity: string | null;
  entityName: string | null;
  canImport: boolean;
  rows: number;
  items: number;
  /** Items per command, after applying the default command to blank cells. */
  commands: Partial<Record<Command | "INVALID", number>>;
  recognised: string[];
  /** Columns that will be ignored. */
  unknown: string[];
  /** Columns used to match items that are present in the sheet. */
  keyColumns: string[];
  warnings: string[];
}

/**
 * Describes what an import would do without calling Shopify: which sheets map
 * to which data types, item counts per command and which columns are used.
 */
export function analyzeSheets(sheets: Sheet[], entities: Entity[], defaultCommand: Command = "MERGE"): SheetAnalysis[] {
  return sheets.map((sheet) => {
    const entity = detectEntity(sheet, entities);
    const base: SheetAnalysis = {
      sheet: sheet.name,
      entity: entity?.key ?? null,
      entityName: entity?.sheet ?? null,
      canImport: !!entity?.import,
      rows: sheet.rows.length,
      items: 0,
      commands: {},
      recognised: [],
      unknown: [],
      keyColumns: [],
      warnings: [],
    };
    if (!entity) {
      base.warnings.push("Sheet name not recognised; this sheet will be skipped.");
      return base;
    }
    if (!entity.import) {
      base.warnings.push(`${entity.sheet} can only be exported; this sheet will be skipped.`);
      return base;
    }
    const known = new Set([...entity.columns, "ID", "Command", RESULT_COLUMN, COMMENT_COLUMN]);
    for (const h of sheet.headers) {
      if (known.has(h) || DYNAMIC_PREFIXES.some((p) => h.startsWith(p))) base.recognised.push(h);
      else base.unknown.push(h);
    }
    base.keyColumns = entity.import.keyColumns.filter((k) => sheet.headers.includes(k));
    if (!base.keyColumns.length) {
      base.warnings.push(`No ${entity.import.keyColumns.join(" / ")} column: every row is treated as a new item.`);
    }
    const items = groupRows(sheet.rows, entity.import.keyColumns);
    base.items = items.length;
    for (const item of items) {
      const raw = (cell(item.rows[0], "Command") ?? "").trim().toUpperCase();
      const command = raw ? ((COMMANDS as string[]).includes(raw) ? (raw as Command) : "INVALID") : defaultCommand;
      base.commands[command] = (base.commands[command] ?? 0) + 1;
    }
    if (base.commands.INVALID) base.warnings.push(`${base.commands.INVALID} item(s) have an unknown Command and will fail.`);
    if (base.commands.DELETE) base.warnings.push(`${base.commands.DELETE} item(s) will be deleted.`);
    if (base.commands.REPLACE) base.warnings.push(`${base.commands.REPLACE} item(s) will be deleted and re-created (new IDs).`);
    if (base.unknown.length) base.warnings.push(`${base.unknown.length} column(s) not recognised and will be ignored.`);
    return base;
  });
}
