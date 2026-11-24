import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/** The change history moved under "Jobs and history": older links still arrive. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { redirect } = await authenticate.admin(request);
  return redirect(`/app/jobs/history${new URL(request.url).search}`);
};
