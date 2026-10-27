import type { Command, Entity, ExportContext, ImportContext, ItemResult, Row } from "../core/types";
import { ImportError } from "../core/types";
import { assertNoUserErrors, buildSearchQuery, cell, gidToId, gidType, gqlString, str, toGid } from "../core/util";
import { fileNameFromUrl, runCommand, searchTerm } from "./_content_helpers";

// --- Columns --------------------------------------------------------------------

const FILE_COLUMNS = [
  "ID",
  "Command",
  "File Name",
  "Alt Text",
  "URL",
  "Type",
  "MIME type",
  "Size",
  "Status",
  "Created At",
  "Updated At",
];

/** File object type -> Type cell, and the FileContentType used on create. */
const TYPES: Array<{ typename: string; cell: string; contentType: string; aliases: string[] }> = [
  { typename: "MediaImage", cell: "Image", contentType: "IMAGE", aliases: ["image", "media image"] },
  { typename: "Video", cell: "Video", contentType: "VIDEO", aliases: ["video"] },
  { typename: "GenericFile", cell: "Generic File", contentType: "FILE", aliases: ["generic file", "file", "generic"] },
  { typename: "Model3d", cell: "3D Model", contentType: "MODEL_3D", aliases: ["3d model", "model3d", "model 3d", "model"] },
  { typename: "ExternalVideo", cell: "External Video", contentType: "EXTERNAL_VIDEO", aliases: ["external video", "youtube", "vimeo"] },
];

function contentTypeFromCell(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = TYPES.find((x) => x.aliases.includes(v.trim().toLowerCase()) || x.contentType === v.trim().toUpperCase());
  if (!t) throw new ImportError(`Unknown Type "${v}" (use ${TYPES.map((x) => x.cell).join(", ")})`);
  return t.contentType;
}

// Selection shared by export (bulk) and import lookups; every File implementation.
const FILE_SELECTION = `
  id alt createdAt updatedAt fileStatus
  ... on MediaImage { mimeType image { url } originalSource { fileSize } }
  ... on GenericFile { url mimeType originalFileSize }
  ... on Video { filename originalSource { url mimeType fileSize } }
  ... on Model3d { filename originalSource { url mimeType filesize } }
  ... on ExternalVideo { originUrl }
`;

/** Flattens any File implementation into the fields we use. */
export function fileInfo(f: any) {
  const typename: string = f.__typename ?? gidType(f.id);
  let url = "";
  let mimeType = "";
  let size: number | null = null;
  switch (typename) {
    case "MediaImage":
      url = f.image?.url ?? "";
      mimeType = f.mimeType ?? "";
      size = f.originalSource?.fileSize ?? null;
      break;
    case "GenericFile":
      url = f.url ?? "";
      mimeType = f.mimeType ?? "";
      size = f.originalFileSize ?? null;
      break;
    case "Video":
      url = f.originalSource?.url ?? "";
      mimeType = f.originalSource?.mimeType ?? "";
      size = f.originalSource?.fileSize ?? null;
      break;
    case "Model3d":
      url = f.originalSource?.url ?? "";
      mimeType = f.originalSource?.mimeType ?? "";
      size = f.originalSource?.filesize ?? null;
      break;
    case "ExternalVideo":
      url = f.originUrl ?? "";
      break;
  }
  const name: string = f.filename ?? (typename === "ExternalVideo" ? "" : fileNameFromUrl(url));
  return { id: f.id as string, typename, name, alt: (f.alt ?? "") as string, url, mimeType, size };
}

// --- Export -------------------------------------------------------------------------

export function filesBulkQuery(search: string): string {
  const args = search ? `(query: ${gqlString(search)})` : "";
  return `{
    files${args} { edges { node { ${FILE_SELECTION} } } }
  }`;
}

export function fileToRow(f: any): Row {
  const info = fileInfo(f);
  return {
    ID: gidToId(f.id),
    Command: "MERGE",
    "File Name": info.name,
    "Alt Text": info.alt,
    URL: info.url,
    Type: TYPES.find((t) => t.typename === info.typename)?.cell ?? info.typename,
    "MIME type": info.mimeType,
    Size: str(info.size),
    Status: f.fileStatus ? f.fileStatus[0] + f.fileStatus.slice(1).toLowerCase() : "",
    "Created At": f.createdAt ?? "",
    "Updated At": f.updatedAt ?? "",
  };
}

async function exportFiles(ctx: ExportContext, emit: (rows: Row[]) => Promise<void>) {
  const search = buildSearchQuery(ctx.options);
  let n = 0;
  for await (const f of ctx.bulk(filesBulkQuery(search))) {
    await emit([fileToRow(f)]);
    ctx.progress(++n);
    if (ctx.options.limit && n >= ctx.options.limit) break;
  }
}

// --- Import ---------------------------------------------------------------------

const FILE_BY_ID = `#graphql
  query ImportFileById($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on File {
        id alt
        ... on MediaImage { image { url } }
        ... on GenericFile { url }
        ... on Video { filename originalSource { url } }
        ... on Model3d { filename originalSource { url } }
        ... on ExternalVideo { originUrl }
      }
    }
  }
`;

const FILES_BY_NAME = `#graphql
  query ImportFilesByName($query: String!) {
    files(first: 25, query: $query) {
      nodes {
        __typename id alt
        ... on MediaImage { image { url } }
        ... on GenericFile { url }
        ... on Video { filename originalSource { url } }
        ... on Model3d { filename originalSource { url } }
        ... on ExternalVideo { originUrl }
      }
    }
  }
`;

const FILE_CREATE = `#graphql
  mutation ImportFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id alt fileStatus }
      userErrors { field message code }
    }
  }
`;

const FILE_UPDATE = `#graphql
  mutation ImportFileUpdate($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files { id alt fileStatus }
      userErrors { field message code }
    }
  }
`;

const FILE_DELETE = `#graphql
  mutation ImportFileDelete($fileIds: [ID!]!) {
    fileDelete(fileIds: $fileIds) {
      deletedFileIds
      userErrors { field message code }
    }
  }
`;

type ExistingFile = ReturnType<typeof fileInfo>;

/**
 * Candidate GIDs for the ID cell. File IDs are typed (MediaImage, GenericFile,
 * ...): the Type column picks one, otherwise every File type is tried.
 */
function candidateIds(idCell: string | undefined, typeCell: string | undefined): string[] {
  if (!idCell) return [];
  if (idCell.startsWith("gid://")) return [idCell];
  const ct = contentTypeFromCell(typeCell);
  const types = ct ? TYPES.filter((t) => t.contentType === ct) : TYPES;
  return types.map((t) => toGid(t.typename, idCell)!);
}

/** Lookup by ID, then by file name (File Name, or the name in the URL). */
async function fetchFile(ctx: ImportContext, row: Row): Promise<ExistingFile | null> {
  const ids = candidateIds(cell(row, "ID"), cell(row, "Type"));
  if (ids.length) {
    const nodes: any[] = (await ctx.gql(FILE_BY_ID, { ids })).nodes;
    const n = nodes.find((x) => x?.id);
    if (n) return fileInfo(n);
  }
  const name = cell(row, "File Name") || fileNameFromUrl(cell(row, "URL"));
  if (!name) return null;
  const nodes: any[] = (await ctx.gql(FILES_BY_NAME, { query: searchTerm("filename", name) })).files.nodes;
  const matches = nodes.map(fileInfo).filter((f) => f.name.toLowerCase() === name.toLowerCase());
  return matches[0] ?? null;
}

async function createFile(ctx: ImportContext, row: Row): Promise<string> {
  const url = cell(row, "URL");
  if (!url) throw new ImportError("URL is required to create a file");
  const input: Record<string, any> = { originalSource: url };
  const name = cell(row, "File Name");
  if (name) input.filename = name;
  const alt = cell(row, "Alt Text");
  if (alt) input.alt = alt;
  const contentType = contentTypeFromCell(cell(row, "Type"));
  if (contentType) input.contentType = contentType;
  const d = await ctx.gql(FILE_CREATE, { files: [input] });
  assertNoUserErrors(d.fileCreate, "Create file");
  return d.fileCreate.files[0].id;
}

async function updateFile(ctx: ImportContext, existing: ExistingFile, row: Row): Promise<string[]> {
  const input: Record<string, any> = { id: existing.id };
  const alt = cell(row, "Alt Text");
  if (alt !== undefined && alt !== existing.alt) input.alt = alt;
  const name = cell(row, "File Name");
  if (name && name !== existing.name) input.filename = name;
  // A URL whose file name differs from the current file replaces the content;
  // re-importing an exported (or the original source) URL changes nothing.
  const url = cell(row, "URL");
  if (url && url !== existing.url && fileNameFromUrl(url).toLowerCase() !== existing.name.toLowerCase()) {
    input.originalSource = url;
  }
  if (Object.keys(input).length === 1) return ["No changes"];
  const d = await ctx.gql(FILE_UPDATE, { files: [input] });
  assertNoUserErrors(d.fileUpdate, "Update file");
  return input.originalSource ? ["File content replaced"] : [];
}

export async function importFile(ctx: ImportContext, rows: Row[], command: Command): Promise<ItemResult> {
  const row = rows[0];
  const existing = await fetchFile(ctx, row);
  return runCommand(command, existing, {
    what: "File",
    idOf: (f) => f.id,
    create: async () => ({ id: await createFile(ctx, row) }),
    update: async (f) => ({ id: f.id, notes: await updateFile(ctx, f, row) }),
    remove: async (f) => {
      const d = await ctx.gql(FILE_DELETE, { fileIds: [f.id] });
      assertNoUserErrors(d.fileDelete, "Delete file");
    },
  });
}

export const filesEntity: Entity = {
  key: "files",
  sheet: "Files",
  aliases: ["file"],
  description: "Files from Content > Files: images, videos, 3D models and generic files. Import creates files from URLs.",
  columns: FILE_COLUMNS,
  supportsQuery: true,
  export: exportFiles,
  import: { keyColumns: ["ID", "File Name", "URL"], apply: importFile },
};

// Exported for tests.
export const _internal = { contentTypeFromCell, fileInfo, candidateIds };
