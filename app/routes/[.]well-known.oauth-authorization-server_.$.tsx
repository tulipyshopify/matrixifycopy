import { serverMetadata, oauthJson } from "../lib/api/oauth.server";

/** OAuth metadata, where MCP clients look for how to sign in. */
export const loader = () => oauthJson(serverMetadata());
