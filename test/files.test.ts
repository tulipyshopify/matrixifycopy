import { describe, expect, it } from "vitest";
import { filesEntity } from "../app/lib/entities/files";
import { exportCtx, hasSchema, importCtx, mockGql, runExport, schemaErrors } from "./_content_test_helpers";

const ok = { userErrors: [] };
const IMAGE = {
  id: "gid://shopify/MediaImage/3",
  alt: "A cat",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  fileStatus: "READY",
  mimeType: "image/jpeg",
  image: { url: "https://cdn.shopify.com/s/files/1/0/files/cat.jpg?v=1" },
  originalSource: { fileSize: 1234 },
};
const PDF = {
  id: "gid://shopify/GenericFile/4",
  alt: "",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  fileStatus: "READY",
  url: "https://cdn.shopify.com/s/files/1/0/files/terms%20v2.pdf?v=2",
  mimeType: "application/pdf",
  originalFileSize: 99,
};
const VIDEO = {
  id: "gid://shopify/Video/5",
  alt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  fileStatus: "PROCESSING",
  filename: "intro.mp4",
  originalSource: { url: "https://cdn.shopify.com/videos/intro.mp4", mimeType: "video/mp4", fileSize: 500 },
};

describe("files export", () => {
  it("maps each file type to a row", async () => {
    const { gql } = mockGql({});
    const { ctx } = exportCtx(gql, [IMAGE, PDF, VIDEO]);
    const rows = await runExport(filesEntity, ctx);
    expect(rows[0]).toEqual({
      ID: "3",
      Command: "MERGE",
      "File Name": "cat.jpg",
      "Alt Text": "A cat",
      URL: "https://cdn.shopify.com/s/files/1/0/files/cat.jpg?v=1",
      Type: "Image",
      "MIME type": "image/jpeg",
      Size: "1234",
      Status: "Ready",
      "Created At": "2026-01-01T00:00:00Z",
      "Updated At": "2026-01-02T00:00:00Z",
    });
    expect(rows[1]).toMatchObject({ ID: "4", "File Name": "terms v2.pdf", Type: "Generic File", "MIME type": "application/pdf", Size: "99" });
    expect(rows[2]).toMatchObject({ ID: "5", "File Name": "intro.mp4", Type: "Video", Size: "500", Status: "Processing", "Alt Text": "" });
  });

  it.skipIf(!hasSchema)("export query matches the schema", async () => {
    const { gql } = mockGql({});
    const { ctx, bulkQueries } = exportCtx(gql, [], { query: "filename:x", updatedAfter: "2026-01-01" });
    await runExport(filesEntity, ctx);
    expect(bulkQueries.length).toBe(1);
    for (const q of bulkQueries) expect(schemaErrors(q), q).toEqual([]);
  });
});

describe("files import", () => {
  it("creates from URL without a name lookup when there is no File Name column", async () => {
    const m = mockGql({
      ImportFilesByName: { files: { nodes: [{ __typename: "MediaImage", ...IMAGE, image: { url: "https://cdn.shopify.com/x/dog.png" } }] } },
      ImportFileCreate: { fileCreate: { ...ok, files: [{ id: "gid://shopify/MediaImage/10", alt: "Dog", fileStatus: "UPLOADED" }] } },
    });
    const r = await filesEntity.import!.apply(
      importCtx(m.gql),
      [{ URL: "https://example.com/img/dog.png", "Alt Text": "Dog", Type: "Image" }],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/MediaImage/10", message: "Created" });
    // An unrelated existing dog.png must not be matched by the URL's file name.
    expect(m.ops()).toEqual(["ImportFileCreate"]);
    expect(m.call("ImportFileCreate")!.vars).toEqual({
      files: [{ originalSource: "https://example.com/img/dog.png", alt: "Dog", contentType: "IMAGE" }],
    });
  });

  it("updates alt text and file name of a file found by numeric ID", async () => {
    const m = mockGql({
      ImportFileById: { nodes: [null, { __typename: "GenericFile", ...PDF }, null, null, null] },
      ImportFileUpdate: { fileUpdate: { ...ok, files: [{ id: PDF.id }] } },
    });
    const r = await filesEntity.import!.apply(
      importCtx(m.gql),
      [{ ID: "4", "File Name": "terms.pdf", "Alt Text": "Terms", URL: PDF.url }],
      "UPDATE",
    );
    expect(r).toMatchObject({ status: "OK", id: PDF.id, message: "Updated" });
    expect(m.call("ImportFileById")!.vars.ids).toEqual([
      "gid://shopify/MediaImage/4",
      "gid://shopify/Video/4",
      "gid://shopify/GenericFile/4",
      "gid://shopify/Model3d/4",
      "gid://shopify/ExternalVideo/4",
    ]);
    expect(m.call("ImportFileUpdate")!.vars).toEqual({ files: [{ id: PDF.id, alt: "Terms", filename: "terms.pdf" }] });
  });

  it("replaces content when the URL points to a different file; Type narrows the ID", async () => {
    const m = mockGql({
      ImportFileById: { nodes: [{ __typename: "MediaImage", ...IMAGE }] },
      ImportFileUpdate: { fileUpdate: { ...ok, files: [{ id: IMAGE.id }] } },
    });
    const r = await filesEntity.import!.apply(importCtx(m.gql), [{ ID: "3", Type: "Image", URL: "https://e.com/cat-new.jpg" }], "MERGE");
    expect(m.call("ImportFileById")!.vars.ids).toEqual(["gid://shopify/MediaImage/3"]);
    expect(m.call("ImportFileUpdate")!.vars).toEqual({ files: [{ id: IMAGE.id, originalSource: "https://e.com/cat-new.jpg" }] });
    expect(r.message).toBe("Updated; File content replaced");
  });

  it("deletes by file name; DELETE of a missing file fails", async () => {
    const m = mockGql({
      ImportFilesByName: (v: any) => ({ files: { nodes: v.query.includes("cat.jpg") ? [{ __typename: "MediaImage", ...IMAGE }] : [] } }),
      ImportFileDelete: { fileDelete: { ...ok, deletedFileIds: [IMAGE.id] } },
    });
    const r = await filesEntity.import!.apply(importCtx(m.gql), [{ "File Name": "cat.jpg" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted", id: IMAGE.id });
    expect(m.call("ImportFileDelete")!.vars).toEqual({ fileIds: [IMAGE.id] });
    const r2 = await filesEntity.import!.apply(importCtx(m.gql), [{ "File Name": "nope.jpg" }], "DELETE");
    expect(r2.status).toBe("Failed");
  });

  it("DELETE with only a URL does not delete a same-named file", async () => {
    const m = mockGql({ ImportFilesByName: { files: { nodes: [{ __typename: "MediaImage", ...IMAGE }] } } });
    const r = await filesEntity.import!.apply(importCtx(m.gql), [{ URL: "https://example.com/cat.jpg" }], "DELETE");
    expect(r).toMatchObject({ status: "Failed", message: "File not found" });
    expect(m.ops()).toEqual([]);
  });

  it("File Name lookup pages to the exact name and fails on several exact matches", async () => {
    const pg = (nodes: any[], next: string | null) => ({ files: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next } } });
    const other = { __typename: "MediaImage", ...IMAGE, id: "gid://shopify/MediaImage/1", image: { url: "https://cdn.shopify.com/s/files/cat.jpg.png" } };
    const m = mockGql({
      ImportFilesByName: (v: any) => (v.after === "c1" ? pg([{ __typename: "MediaImage", ...IMAGE }], null) : pg([other], "c1")),
      ImportFileDelete: { fileDelete: { ...ok, deletedFileIds: [IMAGE.id] } },
    });
    const r = await filesEntity.import!.apply(importCtx(m.gql), [{ "File Name": "cat.jpg" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", id: IMAGE.id });

    const m2 = mockGql({
      ImportFilesByName: pg([{ __typename: "MediaImage", ...IMAGE }, { __typename: "MediaImage", ...IMAGE, id: "gid://shopify/MediaImage/8" }], null),
    });
    await expect(filesEntity.import!.apply(importCtx(m2.gql), [{ "File Name": "cat.jpg" }], "DELETE")).rejects.toThrow(/Several files/);
    expect(m2.ops()).toEqual(["ImportFilesByName"]);
  });

  it("REPLACE of an exported row (own CDN URL) is refused without deleting", async () => {
    const m = mockGql({ ImportFileById: { nodes: [{ __typename: "MediaImage", ...IMAGE }] } });
    const r = await filesEntity.import!.apply(
      importCtx(m.gql),
      [{ ID: "3", Type: "Image", "File Name": "cat.jpg", URL: "https://cdn.shopify.com/s/files/1/0/files/cat.jpg?v=1" }],
      "REPLACE",
    );
    expect(r).toMatchObject({ status: "Failed", id: IMAGE.id });
    expect(r.message).toMatch(/use MERGE/);
    expect(m.ops()).toEqual(["ImportFileById"]);
  });

  it("REPLACE without a URL fails before deleting; with new content deletes then creates", async () => {
    const m = mockGql({
      ImportFileById: { nodes: [{ __typename: "MediaImage", ...IMAGE }] },
      ImportFileDelete: { fileDelete: { ...ok, deletedFileIds: [IMAGE.id] } },
      ImportFileCreate: { fileCreate: { ...ok, files: [{ id: "gid://shopify/MediaImage/30", alt: "", fileStatus: "UPLOADED" }] } },
    });
    await expect(filesEntity.import!.apply(importCtx(m.gql), [{ ID: "3", Type: "Image", URL: "" }], "REPLACE")).rejects.toThrow(/URL is required/);
    expect(m.ops()).toEqual(["ImportFileById"]);
    const r = await filesEntity.import!.apply(importCtx(m.gql), [{ ID: "3", Type: "Image", URL: "https://e.com/cat.jpg" }], "REPLACE");
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/MediaImage/30", message: "Replaced" });
    expect(m.ops().slice(1)).toEqual(["ImportFileById", "ImportFileDelete", "ImportFileCreate"]);
  });
});
