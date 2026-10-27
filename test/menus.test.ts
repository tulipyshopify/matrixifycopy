import { describe, expect, it } from "vitest";
import type { Row } from "../app/lib/core/types";
import { menusEntity } from "../app/lib/entities/menus";
import { exportCtx, hasSchema, importCtx, mockGql, runExport, schemaErrors } from "./_content_test_helpers";

const ok = { userErrors: [] };
const item = (id: number, title: string, type: string, extra: Record<string, any> = {}) => ({
  id: `gid://shopify/MenuItem/${id}`,
  title,
  type,
  resourceId: null,
  url: null,
  tags: [],
  items: [],
  ...extra,
});
const MENU = {
  id: "gid://shopify/Menu/1",
  handle: "main-menu",
  title: "Main menu",
  isDefault: true,
  items: [
    item(10, "Home", "FRONTPAGE", { url: "/" }),
    item(11, "Shop", "COLLECTION", {
      resourceId: "gid://shopify/Collection/5",
      url: "/collections/all",
      items: [item(12, "Shirts", "COLLECTION", { resourceId: "gid://shopify/Collection/6", tags: ["red"], items: [item(13, "Blog", "HTTP", { url: "https://x.com" })] })],
    }),
  ],
};
const page = (nodes: any[]) => ({ menus: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } });

describe("menus export", () => {
  it("one row per item with levels and paths", async () => {
    const m = mockGql({ MenusExport: page([MENU, { ...MENU, id: "gid://shopify/Menu/2", handle: "empty", title: "Empty", items: [] }]) });
    const { ctx } = exportCtx(m.gql);
    const rows = await runExport(menusEntity, ctx);
    expect(rows.map((r) => [r["Item: Title"], r["Item: Level"], r["Item: Path"]])).toEqual([
      ["Home", "1", "Home"],
      ["Shop", "1", "Shop"],
      ["Shirts", "2", "Shop > Shirts"],
      ["Blog", "3", "Shop > Shirts > Blog"],
      [undefined, undefined, undefined],
    ]);
    expect(rows[0]).toMatchObject({ ID: "1", Handle: "main-menu", Command: "MERGE", Title: "Main menu", "Item: ID": "10", "Item: Type": "FRONTPAGE", "Item: URL": "/" });
    expect(rows[2]).toEqual({
      ID: "1",
      Handle: "main-menu",
      "Item: ID": "12",
      "Item: Title": "Shirts",
      "Item: Type": "COLLECTION",
      "Item: Resource ID": "6",
      "Item: URL": "",
      "Item: Tags": "red",
      "Item: Level": "2",
      "Item: Path": "Shop > Shirts",
    });
    expect(rows[4]).toEqual({ ID: "2", Handle: "empty", Command: "MERGE", Title: "Empty" });
  });

  it.skipIf(!hasSchema)("export query matches the schema", async () => {
    const m = mockGql({ MenusExport: page([]) });
    const { ctx } = exportCtx(m.gql, [], { query: "title:x" });
    await runExport(menusEntity, ctx);
    expect(m.calls.length).toBe(1);
    for (const c of m.calls) expect(schemaErrors(c.query), c.query).toEqual([]);
  });
});

describe("menus import", () => {
  const rows: Row[] = [
    { Handle: "footer", Title: "Footer", "Item: Title": "About", "Item: Type": "Page", "Item: Resource ID": "7", "Item: Level": "1" },
    { Handle: "footer", "Item: Title": "Team", "Item: Type": "http", "Item: URL": "/team", "Item: Level": "2" },
    { Handle: "footer", "Item: Title": "Search", "Item: Type": "SEARCH", "Item: URL": "/search", "Item: Tags": "a, b" },
  ];

  it("creates a menu with nested items and writes item IDs back", async () => {
    const m = mockGql({
      ImportMenusByHandle: page([{ ...MENU, handle: "footer-2" }]),
      ImportMenuCreate: {
        menuCreate: {
          ...ok,
          menu: {
            id: "gid://shopify/Menu/3",
            handle: "footer",
            title: "Footer",
            isDefault: false,
            items: [item(20, "About", "PAGE", { items: [item(21, "Team", "HTTP")] }), item(22, "Search", "SEARCH")],
          },
        },
      },
    });
    const r = await menusEntity.import!.apply(importCtx(m.gql), rows, "MERGE");
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Menu/3", message: "Created" });
    expect(r.rowPatches).toEqual([{ "Item: ID": "20" }, { "Item: ID": "21" }, { "Item: ID": "22" }]);
    expect(m.call("ImportMenusByHandle")!.vars).toMatchObject({ query: 'handle:"footer"' });
    expect(m.call("ImportMenuCreate")!.vars).toEqual({
      title: "Footer",
      handle: "footer",
      items: [
        {
          title: "About",
          type: "PAGE",
          resourceId: "gid://shopify/Page/7",
          items: [{ title: "Team", type: "HTTP", url: "/team", items: [] }],
        },
        { title: "Search", type: "SEARCH", url: "/search", tags: ["a", "b"], items: [] },
      ],
    });
  });

  it("updates by ID, replacing the item tree and keeping known item IDs", async () => {
    const m = mockGql({
      ImportMenuById: { menu: MENU },
      ImportMenuUpdate: { menuUpdate: { ...ok, menu: { ...MENU, items: [item(11, "Shop", "COLLECTION")] } } },
    });
    const r = await menusEntity.import!.apply(
      importCtx(m.gql),
      [
        { ID: "1", Title: "", "Item: ID": "11", "Item: Title": "Shop", "Item: Type": "COLLECTION", "Item: Resource ID": "5", "Item: Level": "1" },
        { ID: "1", "Item: ID": "999", "Item: Title": "Sale", "Item: Type": "COLLECTION", "Item: Resource ID": "gid://shopify/Collection/8", "Item: Level": "2" },
      ],
      "UPDATE",
    );
    expect(r).toMatchObject({ status: "OK", message: "Updated; Menu items replaced" });
    expect(m.call("ImportMenuUpdate")!.vars).toEqual({
      id: MENU.id,
      title: "Main menu",
      items: [
        {
          id: "gid://shopify/MenuItem/11",
          title: "Shop",
          type: "COLLECTION",
          resourceId: "gid://shopify/Collection/5",
          items: [{ title: "Sale", type: "COLLECTION", resourceId: "gid://shopify/Collection/8", items: [] }],
        },
      ],
    });
  });

  it("keeps existing items when the sheet has no item columns", async () => {
    const m = mockGql({ ImportMenuById: { menu: MENU }, ImportMenuUpdate: { menuUpdate: { ...ok, menu: MENU } } });
    await menusEntity.import!.apply(importCtx(m.gql), [{ ID: "1", Title: "Main" }], "MERGE");
    const vars = m.call("ImportMenuUpdate")!.vars;
    expect(vars.title).toBe("Main");
    expect(vars.items[1]).toMatchObject({ id: "gid://shopify/MenuItem/11", resourceId: "gid://shopify/Collection/5" });
    expect(vars.items[1].items[0].items[0]).toMatchObject({ id: "gid://shopify/MenuItem/13", url: "https://x.com" });
  });

  it("rejects a level 3 item without a level 2 parent", async () => {
    const m = mockGql({});
    await expect(
      menusEntity.import!.apply(importCtx(m.gql), [{ Handle: "x", "Item: Title": "A", "Item: Type": "HTTP", "Item: URL": "/", "Item: Level": "3" }], "NEW"),
    ).rejects.toThrow(/level 3/);
  });

  it("deletes a menu; REPLACE on a default menu updates instead", async () => {
    const m = mockGql({
      ImportMenuById: (v: any) => ({ menu: v.id === MENU.id ? MENU : { ...MENU, id: v.id, isDefault: false } }),
      ImportMenuDelete: { menuDelete: { ...ok, deletedMenuId: "gid://shopify/Menu/2" } },
      ImportMenuUpdate: { menuUpdate: { ...ok, menu: MENU } },
    });
    const r = await menusEntity.import!.apply(importCtx(m.gql), [{ ID: "2" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted" });
    expect(m.call("ImportMenuDelete")!.vars).toEqual({ id: "gid://shopify/Menu/2" });
    const r2 = await menusEntity.import!.apply(importCtx(m.gql), [{ ID: "1", Title: "Main" }], "REPLACE");
    expect(r2.message).toMatch(/default menu cannot be deleted/);
    expect(m.ops().filter((o) => o === "ImportMenuDelete").length).toBe(1);
  });
});
