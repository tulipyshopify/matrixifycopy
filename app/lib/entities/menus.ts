import type { Command, Entity, ExportContext, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import { paginate } from "../core/gql";
import { assertNoUserErrors, buildSearchQuery, cell, gidToId, joinTags, parseInt10, splitTags, toGid } from "../core/util";
import { runCommand, searchTerm } from "./_content_helpers";

// --- Columns --------------------------------------------------------------------

const MENU_COLUMNS = ["ID", "Handle", "Command", "Title"];

const ITEM_COLUMNS = [
  "Item: ID",
  "Item: Title",
  "Item: Type",
  "Item: Resource ID",
  "Item: URL",
  "Item: Tags",
  "Item: Level",
  "Item: Path", // export-only, e.g. "Shop > Shirts"
];

/** Columns that, when non-blank, make a row describe a menu item. */
const ITEM_SIGNAL_COLUMNS = ["Item: ID", "Item: Title", "Item: Type", "Item: Resource ID", "Item: URL"];

/** Online store menus nest at most 3 levels deep. */
const MAX_LEVEL = 3;

const ITEM_TYPES = [
  "ARTICLE",
  "BLOG",
  "CATALOG",
  "COLLECTION",
  "COLLECTIONS",
  "CUSTOMER_ACCOUNT_PAGE",
  "FRONTPAGE",
  "HTTP",
  "METAOBJECT",
  "PAGE",
  "PRODUCT",
  "SEARCH",
  "SHOP_POLICY",
];

/** Item type -> GID type of its resource, for numeric "Item: Resource ID" cells. */
const RESOURCE_GID_TYPES: Record<string, string> = {
  ARTICLE: "Article",
  BLOG: "Blog",
  COLLECTION: "Collection",
  CUSTOMER_ACCOUNT_PAGE: "CustomerAccountPage",
  METAOBJECT: "Metaobject",
  PAGE: "Page",
  PRODUCT: "Product",
  SHOP_POLICY: "ShopPolicy",
};

// Three nested levels of items, shared by export and import queries.
const MENU_FIELDS = `#graphql
  fragment MenuTree on Menu {
    id handle title isDefault
    items {
      id title type resourceId url tags
      items {
        id title type resourceId url tags
        items { id title type resourceId url tags }
      }
    }
  }
`;

interface MenuItemNode {
  id: string;
  title: string;
  type: string;
  resourceId: string | null;
  url: string | null;
  tags: string[];
  items?: MenuItemNode[];
}

interface MenuNode {
  id: string;
  handle: string;
  title: string;
  isDefault: boolean;
  items: MenuItemNode[];
}

// --- Export -------------------------------------------------------------------------

const MENUS_EXPORT = `#graphql
  query MenusExport($after: String, $query: String) {
    menus(first: 25, after: $after, query: $query) {
      nodes { ...MenuTree }
      pageInfo { hasNextPage endCursor }
    }
  }
  ${MENU_FIELDS}
`;

/** One row per item, depth first; a menu without items still gets one row. */
export function menuToRows(menu: MenuNode): Row[] {
  const rows: Row[] = [];
  const base = (): Row => ({ ID: gidToId(menu.id), Handle: menu.handle });
  const walk = (items: MenuItemNode[] | undefined, level: number, path: string[]) => {
    for (const it of items ?? []) {
      const p = [...path, it.title];
      rows.push({
        ...base(),
        "Item: ID": gidToId(it.id),
        "Item: Title": it.title,
        "Item: Type": it.type,
        "Item: Resource ID": it.resourceId ? gidToId(it.resourceId) : "",
        "Item: URL": it.url ?? "",
        "Item: Tags": joinTags(it.tags),
        "Item: Level": String(level),
        "Item: Path": p.join(" > "),
      });
      walk(it.items, level + 1, p);
    }
  };
  walk(menu.items, 1, []);
  if (!rows.length) rows.push(base());
  Object.assign(rows[0], { Command: "MERGE", Title: menu.title });
  return rows;
}

async function exportMenus(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  // Menus are not exported with a bulk operation: their items are nested lists,
  // and shops have few menus, so plain pagination is enough.
  const query = buildSearchQuery(ctx.options) || null;
  let n = 0;
  for await (const m of paginate<MenuNode>(ctx.gql, MENUS_EXPORT, { query }, (d) => d.menus)) {
    await emit(menuToRows(m));
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import ---------------------------------------------------------------------

const MENU_BY_ID = `#graphql
  query ImportMenuById($id: ID!) {
    menu(id: $id) { ...MenuTree }
  }
  ${MENU_FIELDS}
`;

const MENUS_BY_HANDLE = `#graphql
  query ImportMenusByHandle($query: String!, $after: String) {
    menus(first: 25, after: $after, query: $query) {
      nodes { ...MenuTree }
      pageInfo { hasNextPage endCursor }
    }
  }
  ${MENU_FIELDS}
`;

const MENU_CREATE = `#graphql
  mutation ImportMenuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu { ...MenuTree }
      userErrors { field message code }
    }
  }
  ${MENU_FIELDS}
`;

const MENU_UPDATE = `#graphql
  mutation ImportMenuUpdate($id: ID!, $title: String!, $handle: String, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
      menu { ...MenuTree }
      userErrors { field message code }
    }
  }
  ${MENU_FIELDS}
`;

const MENU_DELETE = `#graphql
  mutation ImportMenuDelete($id: ID!) {
    menuDelete(id: $id) {
      deletedMenuId
      userErrors { field message code }
    }
  }
`;

async function fetchMenu(ctx: ImportContext, row: Row): Promise<MenuNode | null> {
  const id = toGid("Menu", cell(row, "ID"));
  if (id) {
    const m = (await ctx.gql(MENU_BY_ID, { id })).menu;
    if (m) return m;
  }
  const handle = cell(row, "Handle");
  if (!handle) return null;
  // Search may be fuzzy; only an exact handle counts.
  for await (const m of paginate<MenuNode>(ctx.gql, MENUS_BY_HANDLE, { query: searchTerm("handle", handle) }, (d) => d.menus)) {
    if (m.handle === handle) return m;
  }
  return null;
}

interface ItemSpec {
  rowIndex: number;
  id?: string;
  input: Record<string, any>;
  children: ItemSpec[];
}

function itemType(v: string | undefined, url: string | undefined): string {
  if (!v) {
    if (url) return "HTTP";
    throw new ImportError("Item: Type is required");
  }
  const t = v.trim().toUpperCase().replace(/[\s-]+/g, "_");
  const norm = t === "URL" || t === "LINK" ? "HTTP" : t === "POLICY" ? "SHOP_POLICY" : t;
  if (!ITEM_TYPES.includes(norm)) throw new ImportError(`Unknown Item: Type "${v}" (use one of ${ITEM_TYPES.join(", ")})`);
  return norm;
}

function itemInput(row: Row): Record<string, any> {
  const title = cell(row, "Item: Title");
  if (!title) throw new ImportError("Item: Title is required");
  const url = cell(row, "Item: URL") || undefined;
  const type = itemType(cell(row, "Item: Type"), url);
  const input: Record<string, any> = { title, type };
  const res = cell(row, "Item: Resource ID");
  if (res) {
    if (res.startsWith("gid://")) input.resourceId = res;
    else {
      const gidTypeName = RESOURCE_GID_TYPES[type];
      if (!gidTypeName) throw new ImportError(`Item: Type ${type} does not take an Item: Resource ID`);
      input.resourceId = toGid(gidTypeName, res);
    }
  }
  // The URL of resource items is derived by Shopify; only send it for links.
  if (url && (type === "HTTP" || !input.resourceId)) input.url = url;
  const tags = cell(row, "Item: Tags");
  if (tags) input.tags = splitTags(tags);
  return input;
}

function isItemRow(row: Row): boolean {
  return ITEM_SIGNAL_COLUMNS.some((c) => (cell(row, c) ?? "") !== "");
}

/** Builds the item tree from rows in order, using Item: Level (1..3) for nesting. */
function parseItems(rows: Row[]): ItemSpec[] {
  const roots: ItemSpec[] = [];
  const stack: ItemSpec[] = []; // stack[i] = last item at level i + 1
  rows.forEach((row, rowIndex) => {
    if (!isItemRow(row)) return;
    const level = parseInt10(cell(row, "Item: Level")) ?? 1;
    if (level < 1 || level > MAX_LEVEL) throw new ImportError(`Row ${rowIndex + 1}: Item: Level must be 1 to ${MAX_LEVEL}`);
    if (level > stack.length + 1) {
      throw new ImportError(`Row ${rowIndex + 1}: level ${level} item must follow a level ${level - 1} item`);
    }
    const idCell = cell(row, "Item: ID");
    const spec: ItemSpec = { rowIndex, id: idCell ? toGid("MenuItem", idCell) : undefined, input: itemInput(row), children: [] };
    if (level === 1) roots.push(spec);
    else stack[level - 2].children.push(spec);
    stack.length = level - 1;
    stack.push(spec);
  });
  return roots;
}

function hasItemColumns(rows: Row[]): boolean {
  return rows.some((r) => Object.keys(r).some((k) => k.startsWith("Item: ") && k !== "Item: Path"));
}

function createInputs(items: ItemSpec[]): any[] {
  return items.map((s) => ({ ...s.input, items: createInputs(s.children) }));
}

/** Update inputs keep an item's ID only if it is still in this menu. */
function updateInputs(items: ItemSpec[], known: Set<string>): any[] {
  return items.map((s) => ({
    ...(s.id && known.has(s.id) ? { id: s.id } : {}),
    ...s.input,
    items: updateInputs(s.children, known),
  }));
}

/** The current tree as update inputs (used when the sheet has no item columns). */
function existingInputs(items: MenuItemNode[] | undefined): any[] {
  return (items ?? []).map((it) => ({
    id: it.id,
    title: it.title,
    type: it.type,
    ...(it.resourceId ? { resourceId: it.resourceId } : { url: it.url }),
    tags: it.tags,
    items: existingInputs(it.items),
  }));
}

function itemIds(items: MenuItemNode[] | undefined, into = new Set<string>()): Set<string> {
  for (const it of items ?? []) {
    into.add(it.id);
    itemIds(it.items, into);
  }
  return into;
}

/** Writes the saved item IDs back to their rows (both trees are in the same order). */
function itemPatches(specs: ItemSpec[], saved: MenuItemNode[] | undefined, patches: Array<Row | undefined> = []) {
  specs.forEach((s, i) => {
    const node = saved?.[i];
    if (!node) return;
    patches[s.rowIndex] = { "Item: ID": gidToId(node.id) };
    itemPatches(s.children, node.items, patches);
  });
  return patches;
}

export async function importMenu(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const top = rows[0];
  const title = cell(top, "Title");
  const handle = cell(top, "Handle");
  const specs = parseItems(rows);
  const withItems = hasItemColumns(rows);
  const existing = await fetchMenu(ctx, top);

  const create = async () => {
    if (!title) throw new ImportError("Title is required to create a menu");
    if (!handle) throw new ImportError("Handle is required to create a menu");
    const d = await ctx.gql(MENU_CREATE, { title, handle, items: createInputs(specs) });
    assertNoUserErrors(d.menuCreate, "Create menu");
    const menu: MenuNode = d.menuCreate.menu;
    return { id: menu.id, rowPatches: itemPatches(specs, menu.items) };
  };

  // menuUpdate replaces the whole item tree: items missing from the sheet are removed.
  const update = async (m: MenuNode) => {
    const vars: Record<string, any> = {
      id: m.id,
      title: title || m.title,
      items: withItems ? updateInputs(specs, itemIds(m.items)) : existingInputs(m.items),
    };
    if (handle && handle !== m.handle) vars.handle = handle;
    const d = await ctx.gql(MENU_UPDATE, vars);
    assertNoUserErrors(d.menuUpdate, "Update menu");
    const menu: MenuNode = d.menuUpdate.menu;
    return {
      id: menu.id,
      notes: withItems ? ["Menu items replaced"] : [],
      rowPatches: withItems ? itemPatches(specs, menu.items) : undefined,
    };
  };

  return runCommand(command, existing, {
    what: "Menu",
    idOf: (m) => m.id,
    create,
    update,
    remove: async (m) => {
      const d = await ctx.gql(MENU_DELETE, { id: m.id });
      assertNoUserErrors(d.menuDelete, "Delete menu");
    },
    // Default menus (main menu, footer) cannot be deleted: replace their items instead.
    replace: async (m) => {
      if (m.isDefault) return { ...(await update(m)), message: "Replaced items (default menu cannot be deleted)" };
      const d = await ctx.gql(MENU_DELETE, { id: m.id });
      assertNoUserErrors(d.menuDelete, "Delete menu");
      return { ...(await create()), message: "Replaced" };
    },
  });
}

export const menusEntity: Entity = {
  key: "menus",
  sheet: "Menus",
  aliases: ["menu", "navigation"],
  description:
    "Navigation menus, one row per menu item with up to 3 nesting levels (Item: Level). Importing items replaces the menu's whole item tree.",
  columns: [...MENU_COLUMNS, ...ITEM_COLUMNS],
  supportsQuery: true,
  export: exportMenus,
  import: { keyColumns: ["ID", "Handle"], apply: importMenu },
};

// Exported for tests.
export const _internal = { parseItems, itemInput };
