import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect } from "react";
import { Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  // Shopify admin's own loading bar while a page of the app is loading, so a click is always answered at once.
  const navigating = useNavigation().state !== "idle";
  useEffect(() => {
    try {
      (globalThis as any).shopify?.loading?.(navigating);
    } catch {
      // outside Shopify admin there is no bar to show
    }
  }, [navigating]);

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/import">Import</s-link>
        <s-link href="/app/export">Export</s-link>
        <s-link href="/app/tasks">Edit products</s-link>
        <s-link href="/app/jobs">Jobs and history</s-link>
        <s-link href="/app/schedules">Automations</s-link>
        <s-link href="/app/backups">Backups</s-link>
        <s-link href="/app/check">Catalogue health</s-link>
        <s-link href="/app/connect">Settings</s-link>
        <s-link href="/app/help">Help</s-link>
        <s-link href="/app/simple-profit">Simple Profit (preview)</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError() as any;
  // The server not answering (a restart for an update, a dropped connection): say so plainly, and
  // above all that nothing can be assumed to have started. Everything else keeps Shopify's handling.
  const status = Number(error?.status ?? 0);
  const unreachable = status === 502 || status === 503 || status === 504 || /failed to fetch|networkerror|load failed|turbo-stream|unable to decode/i.test(String(error?.message ?? error ?? ""));
  if (unreachable) {
    return (
      <div style={{ maxWidth: 560, margin: "12vh auto", padding: "0 20px", font: "15px/1.5 Inter, system-ui, sans-serif", color: "#202223" }}>
        <h1 style={{ fontSize: 20 }}>Bulkport didn't answer just now</h1>
        <p>
          The app was restarting, most likely for an update. <b>Your last click may not have gone through:</b> do not assume the import, export or delete was started.
        </p>
        <p>Wait a few seconds, then open the job list. If the job you wanted is not there, start it again; if it is, it is running as normal.</p>
        <p>
          <a href="/app/jobs" style={{ display: "inline-block", padding: "8px 14px", borderRadius: 8, background: "#202223", color: "#fff", textDecoration: "none", fontWeight: 600 }}>
            Open the job list
          </a>
        </p>
      </div>
    );
  }
  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
