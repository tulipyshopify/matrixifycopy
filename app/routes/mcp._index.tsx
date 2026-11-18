import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleMcp } from "../lib/api/mcp.server";

/** MCP server, access key sent as "Authorization: Bearer <key>". */
export const loader = ({ request }: LoaderFunctionArgs) => handleMcp(request);
export const action = ({ request }: ActionFunctionArgs) => handleMcp(request);
