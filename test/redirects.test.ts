import { describe, expect, it } from "vitest";
import { redirectsEntity } from "../app/lib/entities/redirects";
import { exportCtx, hasSchema, importCtx, mockGql, runExport, schemaErrors } from "./_content_test_helpers";

const ok = { userErrors: [] };
const R = { id: "gid://shopify/UrlRedirect/7", path: "/old", target: "/new" };

describe("redirects export", () => {
  it("maps redirects to rows", async () => {
    const { gql } = mockGql({});
    const { ctx, bulkQueries } = exportCtx(gql, [R]);
    const rows = await runExport(redirectsEntity, ctx);
    expect(bulkQueries[0]).toContain("urlRedirects {");
    expect(rows).toEqual([{ ID: "7", Path: "/old", Command: "MERGE", Target: "/new" }]);
  });

  it.skipIf(!hasSchema)("export query matches the schema", async () => {
    const { gql } = mockGql({});
    const { ctx, bulkQueries } = exportCtx(gql, [], { query: "path:/x", updatedAfter: "2026-01-01" });
    await runExport(redirectsEntity, ctx);
    expect(bulkQueries.length).toBe(1);
    for (const q of bulkQueries) expect(schemaErrors(q), q).toEqual([]);
  });
});

describe("redirects import", () => {
  it("creates when the path is unknown (adds leading slash)", async () => {
    const m = mockGql({
      ImportRedirectByPath: { urlRedirects: { nodes: [{ ...R, path: "/old-ish" }] } },
      ImportRedirectCreate: { urlRedirectCreate: { ...ok, urlRedirect: { ...R, id: "gid://shopify/UrlRedirect/8" } } },
    });
    const r = await redirectsEntity.import!.apply(importCtx(m.gql), [{ Path: "old", Target: "/new" }], "MERGE");
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/UrlRedirect/8", message: "Created" });
    expect(m.call("ImportRedirectByPath")!.vars).toEqual({ query: 'path:"/old"' });
    expect(m.call("ImportRedirectCreate")!.vars).toEqual({ urlRedirect: { path: "/old", target: "/new" } });
  });

  it("updates the target of a redirect found by path", async () => {
    const m = mockGql({
      ImportRedirectByPath: { urlRedirects: { nodes: [R] } },
      ImportRedirectUpdate: { urlRedirectUpdate: { ...ok, urlRedirect: R } },
    });
    const r = await redirectsEntity.import!.apply(importCtx(m.gql), [{ Path: "/old/", Target: "/newer" }], "UPDATE");
    expect(r).toMatchObject({ status: "OK", message: "Updated" });
    expect(m.call("ImportRedirectUpdate")!.vars).toEqual({ id: R.id, urlRedirect: { target: "/newer" } });
  });

  it("changes the path of a redirect found by ID", async () => {
    const m = mockGql({
      ImportRedirectById: { urlRedirect: R },
      ImportRedirectUpdate: { urlRedirectUpdate: { ...ok, urlRedirect: R } },
    });
    await redirectsEntity.import!.apply(importCtx(m.gql), [{ ID: "7", Path: "/older", Target: "/new" }], "MERGE");
    expect(m.call("ImportRedirectUpdate")!.vars).toEqual({ id: R.id, urlRedirect: { path: "/older" } });
  });

  it("NEW fails when it exists; DELETE deletes", async () => {
    const m = mockGql({
      ImportRedirectById: { urlRedirect: R },
      ImportRedirectDelete: { urlRedirectDelete: { ...ok, deletedUrlRedirectId: R.id } },
    });
    expect((await redirectsEntity.import!.apply(importCtx(m.gql), [{ ID: "7" }], "NEW")).status).toBe("Failed");
    const r = await redirectsEntity.import!.apply(importCtx(m.gql), [{ ID: "7" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted" });
    expect(m.call("ImportRedirectDelete")!.vars).toEqual({ id: R.id });
  });

  it("requires a target to create", async () => {
    const m = mockGql({ ImportRedirectByPath: { urlRedirects: { nodes: [] } } });
    await expect(redirectsEntity.import!.apply(importCtx(m.gql), [{ Path: "/x" }], "NEW")).rejects.toThrow(/Target/);
  });
});
