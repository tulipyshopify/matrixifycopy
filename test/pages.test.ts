import { describe, expect, it } from "vitest";
import { pagesEntity } from "../app/lib/entities/pages";
import { exportCtx, hasSchema, importCtx, mockGql, runExport, schemaErrors } from "./_content_test_helpers";

const PAGE = {
  id: "gid://shopify/Page/11",
  handle: "about",
  title: "About us",
  body: "<p>Hi</p>",
  templateSuffix: "wide",
  isPublished: true,
  publishedAt: "2026-01-02T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-03T00:00:00Z",
  metafields: [{ id: "gid://shopify/Metafield/1", namespace: "custom", key: "tags", type: "list.single_line_text_field", value: '["a","b"]' }],
};

describe("pages export", () => {
  it("maps pages to rows", async () => {
    const { gql } = mockGql({});
    const { ctx, bulkQueries } = exportCtx(gql, [PAGE], { query: "title:About" });
    const rows = await runExport(pagesEntity, ctx);
    expect(bulkQueries[0]).toContain('pages(query: "(title:About)")');
    expect(rows).toEqual([
      {
        ID: "11",
        Handle: "about",
        Command: "MERGE",
        Title: "About us",
        "Body HTML": "<p>Hi</p>",
        "Template Suffix": "wide",
        Published: "TRUE",
        "Published At": "2026-01-02T00:00:00Z",
        "Created At": "2026-01-01T00:00:00Z",
        "Updated At": "2026-01-03T00:00:00Z",
        "Metafield: custom.tags [list.single_line_text_field]": "a\nb",
      },
    ]);
  });

  it.skipIf(!hasSchema)("export query matches the schema", async () => {
    const { gql } = mockGql({});
    const { ctx, bulkQueries } = exportCtx(gql, [], { query: "title:x", updatedAfter: "2026-01-01", groups: ["metafields"] });
    await runExport(pagesEntity, ctx);
    expect(bulkQueries.length).toBe(1);
    for (const q of bulkQueries) expect(schemaErrors(q), q).toEqual([]);
  });
});

describe("pages import", () => {
  const ok = { userErrors: [] };

  it("creates a page with metafields when missing (MERGE)", async () => {
    const m = mockGql({
      ImportPageByHandle: { pages: { nodes: [{ id: "gid://shopify/Page/9", handle: "about-old", title: "x" }] } },
      ImportPageCreate: { pageCreate: { ...ok, page: { id: "gid://shopify/Page/12", handle: "about" } } },
    });
    const r = await pagesEntity.import!.apply(
      importCtx(m.gql),
      [{ Handle: "about", Title: "About", "Body HTML": "<p>x</p>", Published: "TRUE", "Metafield: custom.a": "1" }],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Page/12", message: "Created" });
    expect(m.call("ImportPageByHandle")!.vars).toEqual({ query: 'handle:"about"' });
    expect(m.call("ImportPageCreate")!.vars.page).toEqual({
      title: "About",
      body: "<p>x</p>",
      handle: "about",
      isPublished: true,
      metafields: [{ namespace: "custom", key: "a", type: "single_line_text_field", value: "1" }],
    });
  });

  it("NEW fails when the page exists", async () => {
    const m = mockGql({ ImportPageById: { page: { id: "gid://shopify/Page/12", handle: "about", title: "About" } } });
    const r = await pagesEntity.import!.apply(importCtx(m.gql), [{ ID: "12", Title: "About" }], "NEW");
    expect(r.status).toBe("Failed");
    expect(m.ops()).toEqual(["ImportPageById"]);
  });

  it("updates by ID, renames handle with redirect and deletes blank metafields", async () => {
    const m = mockGql({
      ImportPageById: { page: { id: "gid://shopify/Page/12", handle: "about", title: "About" } },
      ImportPageUpdate: { pageUpdate: { ...ok, page: { id: "gid://shopify/Page/12", handle: "about-us" } } },
      MetafieldsDelete: { metafieldsDelete: ok },
    });
    const r = await pagesEntity.import!.apply(
      importCtx(m.gql),
      [{ ID: "12", Handle: "about-us", "Template Suffix": "", Published: "FALSE", "Published At": "2026-01-01", "Metafield: custom.a [number_integer]": "" }],
      "UPDATE",
    );
    expect(r).toMatchObject({ status: "OK", message: "Updated" });
    expect(m.call("ImportPageUpdate")!.vars).toEqual({
      id: "gid://shopify/Page/12",
      page: { handle: "about-us", redirectNewHandle: true, templateSuffix: null, isPublished: false },
    });
    expect(m.call("MetafieldsDelete")!.vars.metafields).toEqual([{ ownerId: "gid://shopify/Page/12", namespace: "custom", key: "a" }]);
  });

  it("UPDATE fails when missing", async () => {
    const m = mockGql({ ImportPageByHandle: { pages: { nodes: [] } } });
    const r = await pagesEntity.import!.apply(importCtx(m.gql), [{ Handle: "nope", Title: "x" }], "UPDATE");
    expect(r).toMatchObject({ status: "Failed", message: "Page not found" });
  });

  it("deletes", async () => {
    const m = mockGql({
      ImportPageById: { page: { id: "gid://shopify/Page/12", handle: "about", title: "About" } },
      ImportPageDelete: { pageDelete: { ...ok, deletedPageId: "gid://shopify/Page/12" } },
    });
    const r = await pagesEntity.import!.apply(importCtx(m.gql), [{ ID: "12" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted" });
    expect(m.call("ImportPageDelete")!.vars).toEqual({ id: "gid://shopify/Page/12" });
  });

  it("REPLACE without a Title column fails before deleting the page", async () => {
    const m = mockGql({ ImportPageById: { page: { id: "gid://shopify/Page/12", handle: "about", title: "About" } } });
    await expect(pagesEntity.import!.apply(importCtx(m.gql), [{ ID: "12", "Body HTML": "<p>new</p>" }], "REPLACE")).rejects.toThrow(
      /Title is required/,
    );
    expect(m.ops()).toEqual(["ImportPageById"]);
  });

  it("REPLACE deletes then creates once the input is valid", async () => {
    const m = mockGql({
      ImportPageById: { page: { id: "gid://shopify/Page/12", handle: "about", title: "About" } },
      ImportPageDelete: { pageDelete: { ...ok, deletedPageId: "gid://shopify/Page/12" } },
      ImportPageCreate: { pageCreate: { ...ok, page: { id: "gid://shopify/Page/13", handle: "about" } } },
    });
    const r = await pagesEntity.import!.apply(importCtx(m.gql), [{ ID: "12", Handle: "about", Title: "About" }], "REPLACE");
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Page/13", message: "Replaced" });
    expect(m.ops()).toEqual(["ImportPageById", "ImportPageDelete", "ImportPageCreate"]);
  });

  it("handle lookup pages past prefix matches to the exact handle", async () => {
    const pageOf = (nodes: any[], next: string | null) => ({ pages: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next } } });
    const m = mockGql({
      ImportPageByHandle: (v: any) =>
        v.after === "c1"
          ? pageOf([{ id: "gid://shopify/Page/2", handle: "about", title: "About" }], null)
          : pageOf([{ id: "gid://shopify/Page/1", handle: "about-us", title: "About us" }], "c1"),
      ImportPageUpdate: { pageUpdate: { ...ok, page: { id: "gid://shopify/Page/2", handle: "about" } } },
    });
    const r = await pagesEntity.import!.apply(importCtx(m.gql), [{ Handle: "about", Title: "New" }], "UPDATE");
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Page/2" });
    expect(m.calls.filter((c) => c.op === "ImportPageByHandle").map((c) => c.vars.after)).toEqual([undefined, "c1"]);
  });

  it("handle lookup fails on several exact matches", async () => {
    const p = { id: "gid://shopify/Page/2", handle: "about", title: "About" };
    const m = mockGql({ ImportPageByHandle: { pages: { nodes: [p, { ...p, id: "gid://shopify/Page/3" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    await expect(pagesEntity.import!.apply(importCtx(m.gql), [{ Handle: "about", Title: "x" }], "MERGE")).rejects.toThrow(/Several pages/);
    expect(m.ops()).toEqual(["ImportPageByHandle"]);
  });
});
