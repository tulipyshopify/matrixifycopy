import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PREVIEWS } from "../lib/previews.server";

/**
 * The Simple Profit design preview, shown inside the app. It is a
 * self-contained page of example data: it reads nothing from the store and
 * changes nothing. It runs in a sandboxed frame, apart from the app itself.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return PREVIEWS["simple-profit"];
};

export default function SimpleProfitPreview() {
  const { title, html } = useLoaderData<typeof loader>();
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ padding: "8px 16px", font: "13px/1.4 Inter, system-ui, sans-serif", color: "#616161", background: "#fff", borderBottom: "1px solid #e3e3e3" }}>
        Design preview with example data. Nothing here reads from or changes your store.
      </div>
      <iframe title={title} srcDoc={html} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" style={{ flex: 1, width: "100%", border: 0, background: "#f1f2f4" }} />
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
