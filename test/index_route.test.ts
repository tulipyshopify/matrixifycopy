import { describe, expect, it } from "vitest";
import { loader } from "../app/routes/_index/route";

const go = async (url: string) => {
  try {
    await loader({ request: new Request(url), params: {}, context: {} } as any);
  } catch (r) {
    return (r as Response).headers.get("Location");
  }
  return null;
};

describe("bare app address", () => {
  it("always leads into the app, with or without Shopify's parameters", async () => {
    expect(await go("https://bulk.example.com/")).toBe("/app");
    expect(await go("https://bulk.example.com/?shop=x.myshopify.com&host=abc&embedded=1")).toBe("/app?shop=x.myshopify.com&host=abc&embedded=1");
  });
});
