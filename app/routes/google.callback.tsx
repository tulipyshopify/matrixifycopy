import type { LoaderFunctionArgs } from "react-router";
import { connectDrive } from "../lib/jobs/drive.server";

const page = (title: string, text: string, ok: boolean) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;color:#202223"><h1 style="font-size:20px;color:${ok ? "#047b5d" : "#8e1f0b"}">${title}</h1><p>${text}</p></body>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Where Google sends the merchant back after they allow (or refuse) Drive access. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return page("Google Drive was not connected", "You didn't allow access, so nothing was changed. You can close this tab.", false);
  try {
    await connectDrive(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
    return page("Google Drive is connected", 'Each backup will also be saved to the "Bulkport backups" folder in your Drive. You can close this tab and go back to the app.', true);
  } catch (e: any) {
    return page("Google Drive was not connected", esc(e?.message ?? "Something went wrong."), false);
  }
};
