import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

/** Any address under the app that isn't a page: say so inside the app, with the ways on. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return data(null, { status: 404 });
};

export default function NotFound() {
  return (
    <s-page heading="Page not found" inlineSize="base">
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>There is nothing at this address. It may be an old link, or a job that has been cleared from the history.</s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-button variant="primary" href="/app">
              Home
            </s-button>
            <s-button href="/app/jobs">Jobs</s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
