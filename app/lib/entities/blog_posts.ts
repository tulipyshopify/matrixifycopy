import type { Command, Entity, ExportContext, ImportContext, ItemResult, Row } from "../core/types";
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
  parseSubCommand,
  splitTags,
  toGid,
} from "../core/util";
import { writeMetafields } from "../core/lookups";
import { cachedPromise, publishFields, runCommand, searchTerm } from "./_content_helpers";

// --- Columns --------------------------------------------------------------------

const ARTICLE_COLUMNS = [
  "ID",
  "Handle",
  "Command",
  "Title",
  "Author",
  "Body HTML",
  "Summary HTML",
  "Tags",
  "Tags Command",
  "Created At",
  "Updated At",
  "Published",
  "Published At",
  "Template Suffix",
  "Image Src",
  "Image Alt Text",
  "Blog: ID",
  "Blog: Handle",
  "Blog: Title",
];

// --- Export -------------------------------------------------------------------------

export function blogPostsBulkQuery(search: string, groups: Set<string>): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  const metafields = `metafields { edges { node { id namespace key type value } } }`;
  return `{
    articles${args} { edges { node {
      id handle title body summary tags templateSuffix isPublished publishedAt createdAt updatedAt
      author { name }
      image { url altText }
      blog { id handle title }
      ${groups.has("metafields") ? metafields : ""}
    } } }
  }`;
}

export function articleToRow(a: any, groups: Set<string>): Row {
  const row: Row = {
    ID: gidToId(a.id),
    Handle: a.handle ?? "",
    Command: "MERGE",
    Title: a.title ?? "",
    Author: a.author?.name ?? "",
    "Body HTML": a.body ?? "",
    "Summary HTML": a.summary ?? "",
    Tags: joinTags(a.tags),
    "Tags Command": "REPLACE",
    "Created At": a.createdAt ?? "",
    "Updated At": a.updatedAt ?? "",
    Published: boolCell(a.isPublished),
    "Published At": a.publishedAt ?? "",
    "Template Suffix": a.templateSuffix ?? "",
    "Image Src": a.image?.url ?? "",
    "Image Alt Text": a.image?.altText ?? "",
    "Blog: ID": gidToId(a.blog?.id),
    "Blog: Handle": a.blog?.handle ?? "",
    "Blog: Title": a.blog?.title ?? "",
  };
  if (groups.has("metafields")) metafieldsToRow(row, a.metafields);
  return row;
}

async function exportBlogPosts(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const groups = new Set(ctx.options.groups ?? blogPostsEntity.groups!.filter((g) => g.default).map((g) => g.key));
  const search = buildSearchQuery(ctx.options);
  let n = 0;
  for await (const a of ctx.bulk(blogPostsBulkQuery(search, groups))) {
    await emit([articleToRow(a, groups)]);
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import: blogs --------------------------------------------------------------

const BLOG_BY_ID = `#graphql
  query ImportBlogById($id: ID!) {
    blog(id: $id) { id handle title }
  }
`;

const BLOGS_SEARCH = `#graphql
  query ImportBlogsSearch($query: String, $first: Int!) {
    blogs(first: $first, query: $query) { nodes { id handle title } }
  }
`;

const BLOG_CREATE = `#graphql
  mutation ImportBlogCreate($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog { id handle title }
      userErrors { field message code }
    }
  }
`;

interface BlogRef {
  id: string;
  handle: string;
  title: string;
}

interface BlogSpec {
  id?: string;
  handle?: string;
  title?: string;
}

function blogSpec(row: Row): BlogSpec | null {
  const spec: BlogSpec = {
    id: toGid("Blog", cell(row, "Blog: ID")),
    handle: cell(row, "Blog: Handle") || undefined,
    title: cell(row, "Blog: Title") || undefined,
  };
  return spec.id || spec.handle || spec.title ? spec : null;
}

/** Finds a blog by ID, then handle, then title (case-insensitive). Cached per job. */
async function findBlog(ctx: ImportContext, spec: BlogSpec): Promise<BlogRef | null> {
  if (spec.id) {
    const id = spec.id;
    const b = await cachedPromise(ctx.cache, `blog:id:${id}`, async () => (await ctx.gql(BLOG_BY_ID, { id })).blog as BlogRef | null);
    if (b) return b;
  }
  if (spec.handle) {
    const handle = spec.handle;
    const b = await cachedPromise(ctx.cache, `blog:handle:${handle}`, async () => {
      const nodes: BlogRef[] = (await ctx.gql(BLOGS_SEARCH, { query: searchTerm("handle", handle), first: 10 })).blogs.nodes;
      return nodes.find((x) => x.handle === handle) ?? null;
    });
    if (b) return b;
  }
  if (spec.title) {
    const title = spec.title;
    const b = await cachedPromise(ctx.cache, `blog:title:${title.toLowerCase()}`, async () => {
      const nodes: BlogRef[] = (await ctx.gql(BLOGS_SEARCH, { query: searchTerm("title", title), first: 10 })).blogs.nodes;
      return nodes.find((x) => x.title.toLowerCase() === title.toLowerCase()) ?? null;
    });
    if (b) return b;
  }
  return null;
}

/** Finds the blog for a row, creating it when missing. No blog columns: the shop's first blog. */
async function ensureBlog(ctx: ImportContext, spec: BlogSpec | null): Promise<BlogRef> {
  if (!spec) {
    const b = await cachedPromise(ctx.cache, "blog:default", async () => {
      const nodes: BlogRef[] = (await ctx.gql(BLOGS_SEARCH, { query: null, first: 1 })).blogs.nodes;
      return nodes[0] ?? null;
    });
    if (!b) throw new ImportError("The shop has no blog; fill in Blog: Title to create one");
    return b;
  }
  const found = await findBlog(ctx, spec);
  if (found) return found;
  if (spec.id && !spec.handle && !spec.title) throw new ImportError(`Blog ID ${gidToId(spec.id)} not found`);
  // One creation per blog even when several posts of it are imported concurrently.
  const key = `blog:create:${(spec.handle ?? spec.title!).toLowerCase()}`;
  return cachedPromise(ctx.cache, key, async () => {
    const blog: Record<string, string> = { title: spec.title ?? spec.handle! };
    if (spec.handle) blog.handle = spec.handle;
    const d = await ctx.gql(BLOG_CREATE, { blog });
    assertNoUserErrors(d.blogCreate, "Create blog");
    ctx.log(`Created blog "${d.blogCreate.blog.title}"`);
    return d.blogCreate.blog as BlogRef;
  });
}

// --- Import: articles -------------------------------------------------------------

const ARTICLE_FIELDS = `#graphql
  fragment ImportArticle on Article {
    id handle title tags
    image { url altText }
    blog { id handle title }
  }
`;

const ARTICLE_BY_ID = `#graphql
  query ImportArticleById($id: ID!) {
    article(id: $id) { ...ImportArticle }
  }
  ${ARTICLE_FIELDS}
`;

const ARTICLES_SEARCH = `#graphql
  query ImportArticlesSearch($query: String!) {
    articles(first: 50, query: $query) { nodes { ...ImportArticle } }
  }
  ${ARTICLE_FIELDS}
`;

const SHOP_NAME = `#graphql
  query ImportBlogPostShopName { shop { name } }
`;

const ARTICLE_CREATE = `#graphql
  mutation ImportArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id handle }
      userErrors { field message code }
    }
  }
`;

const ARTICLE_UPDATE = `#graphql
  mutation ImportArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id handle }
      userErrors { field message code }
    }
  }
`;

const ARTICLE_DELETE = `#graphql
  mutation ImportArticleDelete($id: ID!) {
    articleDelete(id: $id) {
      deletedArticleId
      userErrors { field message code }
    }
  }
`;

interface ExistingArticle {
  id: string;
  handle: string;
  title: string;
  tags: string[];
  image: { url: string; altText: string | null } | null;
  blog: BlogRef;
}

/** Lookup by ID, else by blog + article handle (or handle alone when unambiguous). */
async function fetchArticle(ctx: ImportContext, row: Row): Promise<ExistingArticle | null> {
  const id = toGid("Article", cell(row, "ID"));
  if (id) {
    const a = (await ctx.gql(ARTICLE_BY_ID, { id })).article;
    if (a) return a;
  }
  const handle = cell(row, "Handle");
  if (!handle) return null;
  const spec = blogSpec(row);
  const blog = spec ? await findBlog(ctx, spec) : null;
  if (spec && !blog) return null; // blog missing, so is the article
  // Blog.articles cannot be searched, so search all posts and filter by blog.
  const nodes: ExistingArticle[] = (await ctx.gql(ARTICLES_SEARCH, { query: searchTerm("handle", handle) })).articles.nodes;
  const matches = nodes.filter((a) => a.handle === handle && (!blog || a.blog.id === blog.id));
  if (matches.length > 1) {
    throw new ImportError(`Several blogs have a post with handle "${handle}"; fill in Blog: Handle`);
  }
  return matches[0] ?? null;
}

function articleFields(row: Row): Record<string, any> {
  const f: Record<string, any> = {};
  const title = cell(row, "Title");
  if (title) f.title = title;
  const author = cell(row, "Author");
  if (author) f.author = { name: author };
  const body = cell(row, "Body HTML");
  if (body !== undefined) f.body = body;
  const summary = cell(row, "Summary HTML");
  if (summary !== undefined) f.summary = summary;
  const handle = cell(row, "Handle");
  if (handle) f.handle = handle;
  const tpl = cell(row, "Template Suffix");
  if (tpl !== undefined) f.templateSuffix = tpl || null;
  Object.assign(f, publishFields(row));
  return f;
}

/** Image input; blank Image Src leaves the current image as is. */
function imageInput(row: Row, existing?: ExistingArticle["image"]): Record<string, any> | undefined {
  const src = cell(row, "Image Src");
  const alt = cell(row, "Image Alt Text");
  if (src) {
    // Same image as exported: only send the alt text so it is not re-uploaded.
    if (existing && existing.url === src) {
      return alt !== undefined && alt !== (existing.altText ?? "") ? { altText: alt } : undefined;
    }
    return { url: src, ...(alt ? { altText: alt } : {}) };
  }
  if (src === undefined && alt !== undefined && existing && alt !== (existing.altText ?? "")) return { altText: alt };
  return undefined;
}

async function defaultAuthor(ctx: ImportContext): Promise<string> {
  return cachedPromise(ctx.cache, "shop:name", async () => (await ctx.gql(SHOP_NAME)).shop.name as string);
}

async function createArticle(ctx: ImportContext, row: Row): Promise<string> {
  const article = articleFields(row);
  if (!article.title) throw new ImportError("Title is required to create a blog post");
  if (!article.author) article.author = { name: await defaultAuthor(ctx) };
  const blog = await ensureBlog(ctx, blogSpec(row));
  article.blogId = blog.id;
  const tags = cell(row, "Tags");
  if (tags) article.tags = splitTags(tags);
  const image = imageInput(row);
  if (image) article.image = image;
  const mf = metafieldsFromRow(row).set;
  if (mf.length) article.metafields = mf;
  const d = await ctx.gql(ARTICLE_CREATE, { article });
  assertNoUserErrors(d.articleCreate, "Create blog post");
  return d.articleCreate.article.id;
}

async function updateArticle(ctx: ImportContext, existing: ExistingArticle, row: Row) {
  const article = articleFields(row);
  if (article.handle === existing.handle) delete article.handle;
  else if (article.handle) article.redirectNewHandle = true;

  // Tags: REPLACE (default) sets the list; MERGE adds; DELETE removes.
  const tagsCell = cell(row, "Tags");
  if (tagsCell !== undefined) {
    const cmd = parseSubCommand(cell(row, "Tags Command"), ["REPLACE", "MERGE", "DELETE"] as const, "REPLACE");
    const given = splitTags(tagsCell);
    const lower = new Set(given.map((t) => t.toLowerCase()));
    if (cmd === "REPLACE") article.tags = given;
    else if (cmd === "MERGE" && given.length) {
      const have = new Set(existing.tags.map((t) => t.toLowerCase()));
      article.tags = [...existing.tags, ...given.filter((t) => !have.has(t.toLowerCase()))];
    } else if (cmd === "DELETE" && given.length) article.tags = existing.tags.filter((t) => !lower.has(t.toLowerCase()));
  }

  const image = imageInput(row, existing.image);
  if (image) article.image = image;

  // Moving the post to another blog (created if missing).
  const spec = blogSpec(row);
  if (spec) {
    const blog = await ensureBlog(ctx, spec);
    if (blog.id !== existing.blog.id) article.blogId = blog.id;
  }

  if (Object.keys(article).length) {
    const d = await ctx.gql(ARTICLE_UPDATE, { id: existing.id, article });
    assertNoUserErrors(d.articleUpdate, "Update blog post");
  }
  const mf = metafieldsFromRow(row);
  await writeMetafields(ctx.gql, existing.id, mf.set, mf.blank);
}

export async function importBlogPost(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const top = rows[0];
  const existing = await fetchArticle(ctx, top);
  return runCommand(command, existing, {
    what: "Blog post",
    idOf: (a) => a.id,
    create: async () => ({ id: await createArticle(ctx, top) }),
    update: async (a) => {
      await updateArticle(ctx, a, top);
      return { id: a.id };
    },
    remove: async (a) => {
      const d = await ctx.gql(ARTICLE_DELETE, { id: a.id });
      assertNoUserErrors(d.articleDelete, "Delete blog post");
    },
  });
}

export const blogPostsEntity: Entity = {
  key: "blog_posts",
  sheet: "Blog Posts",
  aliases: ["blog post", "blogposts", "articles", "article"],
  description: "Blog posts (articles) with their blog, author, tags, image and metafields. Missing blogs are created on import.",
  columns: ARTICLE_COLUMNS,
  supportsQuery: true,
  groups: [{ key: "metafields", label: "Metafields", default: true }],
  export: exportBlogPosts,
  import: { keyColumns: ["ID", "Handle"], apply: importBlogPost },
};

// Exported for tests.
export const _internal = { articleFields, imageInput, ensureBlog };
