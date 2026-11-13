import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

/**
 * The bare address always leads into the app. Shopify admin opens "/" when
 * the app's name is clicked while the app is already open (without the usual
 * ?shop=… parameters), so this must not depend on them.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { search } = new URL(request.url);
  throw redirect(`/app${search}`);
};

export default function Index() {
  return null;
}
