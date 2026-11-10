// @shopify/app-bridge-types declares its elements on the global JSX namespace,
// which React 19 no longer reads; expose the app nav on React.JSX as well.
import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": globalThis.JSX.IntrinsicElements["s-app-nav"];
    }
  }
}
