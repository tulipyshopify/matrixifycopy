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
  ["UPDATE", "Only update existing items; rows for items that don't exist fail. Used when the Command column is empty, unless you choose another on the import screen."],
  ["MERGE", "Update the item if it exists, otherwise create it. New products start as drafts unless the Status column says otherwise."],
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
            Each sheet in an Excel file (or each CSV file) holds one data type. The app recognises the type from the
            columns, so the file and its sheets can be called anything. Only when the columns fit more than one type
            (Smart and Custom Collections, or a file with just ID and Title) does the name decide: use the names from
            exports, like "Products" or "Custom Collections". A sheet named exactly after a data type is always treated
            as that type. Only include the columns you want to
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
      <s-section heading="Stock columns (Products)">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            Stock is kept per location, so it has a column per location: <code>Inventory Available: Location name</code>, for example{" "}
            <code>Inventory Available: Warehouse</code>. A number in it sets the stock there. To add or take away instead, use{" "}
            <code>Inventory Available Adjust: Location name</code> with a number such as 5 or -3. The same pairs exist for On Hand, Damaged, Safety
            Stock and Quality Control; Committed, Reserved and Incoming are worked out by Shopify and are export-only.
          </s-paragraph>
          <s-paragraph>
            <code>Variant Inventory Qty</code> is the total over all locations and <code>Variant Inventory Adjust</code> changes it. They can be
            imported only when the store has exactly one location; with more, the import stops that row and names the per-location column to use,
            because a total can't be split between locations.
          </s-paragraph>
          <s-paragraph>
            The preview shows each stock change as the quantity now and after, with the location. Stock for a variant Shopify isn't tracking
            switches tracking on, and after an import the stock is read back to make sure it took.
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
