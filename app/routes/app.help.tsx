import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { entityCatalog } from "../lib/jobs/jobs.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { entities: entityCatalog() };
};

const COMMANDS: Array<[string, string]> = [
  ["MERGE", "Update the item if it exists, otherwise create it. Default when the Command column is empty."],
  ["UPDATE", "Only update existing items; rows for items that don't exist fail."],
  ["NEW", "Only create; fails if an item with the same ID/handle already exists."],
  ["REPLACE", "Delete the existing item and create it again from the file (it gets a new ID)."],
  ["DELETE", "Delete the item."],
  ["IGNORE", "Skip these rows."],
];

export default function Help() {
  const { entities } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Sheet reference">
      <s-section heading="How files work">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Each sheet in an Excel file (or each CSV file) holds one data type. The sheet name decides the type, so keep
            the names used in exports, like "Products" or "Custom Collections". Only include the columns you want to
            change: missing columns are left untouched, while an empty cell in an included column clears that value.
          </s-paragraph>
          <s-paragraph>
            Items can span several rows (variants, images, addresses, line items…). Rows belong together when they share
            the same key column value (for example the product ID or Handle). Item-level columns are read from the
            item's first row.
          </s-paragraph>
          <s-paragraph>
            Metafields use columns named <code>Metafield: namespace.key [type]</code>, for example{" "}
            <code>Metafield: custom.material [single_line_text_field]</code>. List values go one per line in the cell.
          </s-paragraph>
        </s-stack>
      </s-section>
      <s-section heading="Commands">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Command</s-table-header>
            <s-table-header>Effect</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {COMMANDS.map(([c, d]) => (
              <s-table-row key={c}>
                <s-table-cell>
                  <code>{c}</code>
                </s-table-cell>
                <s-table-cell>{d}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
      {entities.map((e) => (
        <s-section key={e.key} heading={e.sheet}>
          <s-stack direction="block" gap="small">
            <s-paragraph>{e.description}</s-paragraph>
            <s-stack direction="inline" gap="small">
              {e.canExport ? <s-badge tone="info">Export</s-badge> : null}
              {e.canImport ? <s-badge tone="success">Import</s-badge> : <s-badge>Export only</s-badge>}
            </s-stack>
            {e.keyColumns.length ? (
              <s-text>
                Matched by: <code>{e.keyColumns.join(", then ")}</code>
              </s-text>
            ) : null}
            <s-text tone="neutral">Columns: {e.columns.join(" · ")}</s-text>
          </s-stack>
        </s-section>
      ))}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
