import { describe, expect, it } from "vitest";
import { blogPostsEntity } from "../app/lib/entities/blog_posts";
import { exportCtx, hasSchema, importCtx, mockGql, runExport, schemaErrors } from "./_content_test_helpers";

const BLOG = { id: "gid://shopify/Blog/5", handle: "news", title: "News" };
const ARTICLE = {
  id: "gid://shopify/Article/21",
  handle: "hello",
  title: "Hello",
  body: "<p>b</p>",
  summary: "<p>s</p>",
  tags: ["a", "b"],
  templateSuffix: null,
  isPublished: false,
  publishedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  author: { name: "Jo" },
  image: { url: "https://cdn.shopify.com/x.jpg", altText: "alt" },
  blog: BLOG,
  metafields: [{ namespace: "custom", key: "x", type: "single_line_text_field", value: "y" }],
};
const ok = { userErrors: [] };
const existing = { id: ARTICLE.id, handle: "hello", title: "Hello", tags: ["a", "b"], image: ARTICLE.image, blog: BLOG };

describe("blog posts export", () => {
  it("maps articles to rows", async () => {
    const { gql } = mockGql({});
    const { ctx } = exportCtx(gql, [ARTICLE]);
    const rows = await runExport(blogPostsEntity, ctx);
    expect(rows).toEqual([
      {
        ID: "21",
        Handle: "hello",
        Command: "MERGE",
        Title: "Hello",
        Author: "Jo",
        "Body HTML": "<p>b</p>",
        "Summary HTML": "<p>s</p>",
        Tags: "a, b",
        "Tags Command": "REPLACE",
        "Created At": "2026-01-01T00:00:00Z",
        "Updated At": "2026-01-02T00:00:00Z",
        Published: "FALSE",
        "Published At": "",
        "Template Suffix": "",
        "Image Src": "https://cdn.shopify.com/x.jpg",
        "Image Alt Text": "alt",
        "Blog: ID": "5",
        "Blog: Handle": "news",
        "Blog: Title": "News",
        "Metafield: custom.x [single_line_text_field]": "y",
      },
    ]);
  });

  it.skipIf(!hasSchema)("export query matches the schema", async () => {
    const { gql } = mockGql({});
    const { ctx, bulkQueries } = exportCtx(gql, [], { query: "title:x", updatedAfter: "2026-01-01", groups: ["metafields"] });
    await runExport(blogPostsEntity, ctx);
    expect(bulkQueries.length).toBe(1);
    for (const q of bulkQueries) expect(schemaErrors(q), q).toEqual([]);
  });
});

describe("blog posts import", () => {
  it("creates the blog when missing, then the post (default author = shop name)", async () => {
    const m = mockGql({
      ImportBlogsSearch: { blogs: { nodes: [] } },
      ImportBlogCreate: { blogCreate: { ...ok, blog: { id: "gid://shopify/Blog/9", handle: "journal", title: "Journal" } } },
      ImportBlogPostShopName: { shop: { name: "Acme" } },
      ImportArticleCreate: { articleCreate: { ...ok, article: { id: "gid://shopify/Article/30", handle: "hi" } } },
    });
    const r = await blogPostsEntity.import!.apply(
      importCtx(m.gql),
      [{ Handle: "hi", Title: "Hi", Tags: "x, y", "Image Src": "https://e.com/a.png", "Blog: Handle": "journal", "Blog: Title": "Journal" }],
      "MERGE",
    );
    expect(r).toMatchObject({ status: "OK", id: "gid://shopify/Article/30", message: "Created" });
    expect(m.ops()).toEqual(["ImportBlogsSearch", "ImportBlogsSearch", "ImportBlogPostShopName", "ImportBlogCreate", "ImportArticleCreate"]);
    expect(m.calls[0].vars).toEqual({ query: 'handle:"journal"', first: 50 });
    expect(m.call("ImportBlogCreate")!.vars).toEqual({ blog: { title: "Journal", handle: "journal" } });
    expect(m.call("ImportArticleCreate")!.vars.article).toEqual({
      title: "Hi",
      handle: "hi",
      author: { name: "Acme" },
      blogId: "gid://shopify/Blog/9",
      tags: ["x", "y"],
      image: { url: "https://e.com/a.png" },
    });
  });

  it("updates by blog handle + article handle, merging tags and alt text only", async () => {
    const m = mockGql({
      ImportBlogsSearch: { blogs: { nodes: [BLOG] } },
      ImportArticlesSearch: { articles: { nodes: [{ ...existing, id: "gid://shopify/Article/99", blog: { ...BLOG, id: "gid://shopify/Blog/8" } }, existing] } },
      ImportArticleUpdate: { articleUpdate: { ...ok, article: { id: ARTICLE.id, handle: "hello" } } },
    });
    const r = await blogPostsEntity.import!.apply(
      importCtx(m.gql),
      [
        {
          Handle: "hello",
          Author: "Sam",
          Tags: "B, c",
          "Tags Command": "MERGE",
          "Image Src": "https://cdn.shopify.com/x.jpg",
          "Image Alt Text": "new alt",
          "Blog: Handle": "news",
        },
      ],
      "UPDATE",
    );
    expect(r).toMatchObject({ status: "OK", id: ARTICLE.id, message: "Updated" });
    expect(m.call("ImportArticlesSearch")!.vars).toEqual({ query: 'handle:"hello"' });
    expect(m.call("ImportArticleUpdate")!.vars).toEqual({
      id: ARTICLE.id,
      article: { author: { name: "Sam" }, tags: ["a", "b", "c"], image: { altText: "new alt" } },
    });
  });

  it("moves a post to another blog by ID lookup", async () => {
    const m = mockGql({
      ImportArticleById: { article: existing },
      ImportBlogById: { blog: { id: "gid://shopify/Blog/6", handle: "other", title: "Other" } },
      ImportArticleUpdate: { articleUpdate: { ...ok, article: { id: ARTICLE.id, handle: "hello" } } },
    });
    await blogPostsEntity.import!.apply(importCtx(m.gql), [{ ID: "21", "Blog: ID": "6", Tags: "a", "Tags Command": "DELETE" }], "MERGE");
    expect(m.call("ImportArticleUpdate")!.vars.article).toEqual({ tags: ["b"], blogId: "gid://shopify/Blog/6" });
  });

  it("deletes; fails when missing", async () => {
    const m = mockGql({
      ImportArticleById: (v: any) => ({ article: v.id === ARTICLE.id ? existing : null }),
      ImportArticleDelete: { articleDelete: { ...ok, deletedArticleId: ARTICLE.id } },
    });
    const r = await blogPostsEntity.import!.apply(importCtx(m.gql), [{ ID: "21" }], "DELETE");
    expect(r).toMatchObject({ status: "OK", message: "Deleted" });
    expect(m.call("ImportArticleDelete")!.vars).toEqual({ id: ARTICLE.id });
    const r2 = await blogPostsEntity.import!.apply(importCtx(m.gql), [{ ID: "99" }], "DELETE");
    expect(r2.status).toBe("Failed");
  });

  it("refuses an ambiguous handle without blog columns", async () => {
    const m = mockGql({
      ImportArticlesSearch: { articles: { nodes: [existing, { ...existing, id: "gid://shopify/Article/22", blog: { ...BLOG, id: "x" } }] } },
    });
    await expect(blogPostsEntity.import!.apply(importCtx(m.gql), [{ Handle: "hello" }], "MERGE")).rejects.toThrow(/Blog: Handle/);
  });

  it("REPLACE fails before deleting when the blog cannot be resolved", async () => {
    const m = mockGql({
      ImportArticleById: { article: ARTICLE },
      ImportBlogById: { blog: null },
    });
    await expect(
      blogPostsEntity.import!.apply(importCtx(m.gql), [{ ID: "21", Title: "Hello", Author: "Me", "Blog: ID": "404" }], "REPLACE"),
    ).rejects.toThrow(/Blog ID 404 not found/);
    expect(m.ops()).not.toContain("ImportArticleDelete");
  });

  it("REPLACE without a Title column fails before deleting", async () => {
    const m = mockGql({ ImportArticleById: { article: ARTICLE } });
    await expect(blogPostsEntity.import!.apply(importCtx(m.gql), [{ ID: "21", "Body HTML": "x" }], "REPLACE")).rejects.toThrow(/Title/);
    expect(m.ops()).toEqual(["ImportArticleById"]);
  });

  it("article lookup pages past prefix matches to the exact handle", async () => {
    const m = mockGql({
      ImportArticlesSearch: (v: any) => ({
        articles:
          v.after === "c1"
            ? { nodes: [ARTICLE], pageInfo: { hasNextPage: false, endCursor: null } }
            : { nodes: [{ ...ARTICLE, id: "gid://shopify/Article/1", handle: ARTICLE.handle + "-2" }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      }),
      ImportArticleDelete: { articleDelete: { ...ok, deletedArticleId: ARTICLE.id } },
    });
    const r = await blogPostsEntity.import!.apply(importCtx(m.gql), [{ Handle: ARTICLE.handle }], "DELETE");
    expect(r).toMatchObject({ status: "OK", id: ARTICLE.id });
  });
});
