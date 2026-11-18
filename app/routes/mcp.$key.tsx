import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleMcp } from "../lib/api/mcp.server";

/**
 * MCP server with the access key as the last part of the address, for
 * assistants whose connector settings take only a URL (no header).
 */
export const loader = ({ request, params }: LoaderFunctionArgs) => handleMcp(request, params.key ?? "");
export const action = ({ request, params }: ActionFunctionArgs) => handleMcp(request, params.key ?? "");
