import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createKey, listKeys, revokeKey } from "../lib/api/keys.server";
import { alertWebhookSet, saveAlertWebhook, sendAlert } from "../lib/jobs/alerts.server";
import { formatDate } from "../components/jobs";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const keys = await listKeys(session.shop);
  return {
    appUrl: (process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, ""),
    alerts: await alertWebhookSet(session.shop),
    keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, canImport: k.canImport, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    if (form.get("intent") === "alerts") {
      await saveAlertWebhook(session.shop, String(form.get("url") ?? ""));
      if (!String(form.get("url") ?? "").trim()) return { saved: "Alerts outside the app are off." };
      const sent = await sendAlert(session.shop, `Bulkport, ${session.shop.replace(/\.myshopify\.com$/, "")}: alerts are set up. Failed scheduled jobs and backups will be posted here.`);
      if (!sent) throw new Error("The address was saved, but the test message was not accepted. Check that it is an incoming-webhook address.");
      return { saved: "Saved. A test message was posted." };
    }
    if (form.get("intent") === "revoke") {
      await revokeKey(session.shop, String(form.get("id")));
      return { ok: true as const };
    }
    const { key, row } = await createKey(session.shop, String(form.get("name") ?? ""), form.get("canImport") === "true");
    return { created: { key, name: row.name, canImport: row.canImport } };
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <s-button
      variant="tertiary"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "Copied" : label}
    </s-button>
  );
}

function Code({ text }: { text: string }) {
  return (
    <div className="bp-code">
      <pre>{text}</pre>
      <Copy text={text} />
    </div>
  );
}

export default function Connect() {
  const { keys, appUrl, alerts } = useLoaderData<typeof loader>();
  const [webhook, setWebhook] = useState("");
  const fetcher = useFetcher<typeof action>();
  const [name, setName] = useState("");
  const [canImport, setCanImport] = useState(false);
  const data = fetcher.data;
  const created = data && "created" in data ? data.created : null;
  const error = data && "error" in data ? data.error : null;
  const saved = data && "saved" in data ? data.saved : null;
  const key = created?.key ?? "bp_YOUR_KEY";

  return (
    <s-page heading="Connect" inlineSize="base">
      <s-section heading="Use Bulkport from other tools">
        <s-paragraph>
          Run exports and imports from an AI assistant (Claude, ChatGPT), the command line, Google Sheets or your own scripts. Each tool signs in with an access key you create here.
        </s-paragraph>
      </s-section>

      {error ? (
        <s-banner tone="critical" heading="That didn't work">
          {error}
        </s-banner>
      ) : null}

      {created ? (
        <s-banner tone="success" heading={`Key "${created.name}" created. Copy it now: it is not shown again.`}>
          <Code text={created.key} />
          <s-paragraph>
            {created.canImport
              ? "This key can run imports for real from the command line, Google Sheets and the API. AI assistants can still only make previews."
              : "This key can export, and can prepare import previews. Imports are applied by pressing \"Import for real\" in the app."}
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Access keys">
        {keys.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Key</s-table-header>
              <s-table-header>Imports</s-table-header>
              <s-table-header>Last used</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {keys.map((k) => (
                <s-table-row key={k.id}>
                  <s-table-cell>{k.name}</s-table-cell>
                  <s-table-cell>{k.prefix}…</s-table-cell>
                  <s-table-cell>{k.canImport ? <s-badge tone="warning">Can import for real</s-badge> : <s-badge>Preview only</s-badge>}</s-table-cell>
                  <s-table-cell>{k.lastUsedAt ? formatDate(k.lastUsedAt) : "Never"}</s-table-cell>
                  <s-table-cell>
                    <s-button variant="tertiary" tone="critical" onClick={() => fetcher.submit({ intent: "revoke", id: k.id }, { method: "post" })}>
                      Revoke
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>No keys yet.</s-paragraph>
        )}
        <s-stack gap="small-200">
          <s-text-field label="New key: what will use it?" placeholder="Claude, my laptop, stock sheet…" value={name} onInput={(ev: any) => setName(ev.currentTarget.value)} />
          <s-checkbox
            label="Allow this key to run imports for real"
            details="Leave off unless a script or sheet must import unattended. Without it, imports stop at the preview and you press Import for real in the app."
            checked={canImport}
            onChange={(ev: any) => setCanImport(ev.currentTarget.checked)}
          />
          <s-button
            variant="primary"
            disabled={!name.trim() || fetcher.state !== "idle"}
            onClick={() => {
              fetcher.submit({ intent: "create", name, canImport: String(canImport) }, { method: "post" });
              setName("");
              setCanImport(false);
            }}
          >
            Create key
          </s-button>
        </s-stack>
        <s-paragraph>
          <s-text color="subdued">A key gives access to this store's data. Treat it like a password, and revoke it here if it leaks or is no longer used.</s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="Alerts to Slack or Teams">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            The home screen always flags jobs that need attention. To also be told outside the app when a scheduled export or import, or a backup, fails or finishes with problems, paste an incoming-webhook address from Slack or Microsoft Teams.
          </s-paragraph>
          {saved ? <s-text tone="success">{saved}</s-text> : null}
          <s-text tone="neutral">{alerts ? "Alerts are on. The address is stored encrypted and not shown again; paste a new one to replace it." : "Alerts outside the app are off."}</s-text>
          <div className="bp-url-row">
            <s-url-field label="Incoming webhook address" labelAccessibilityVisibility="exclusive" placeholder="https://hooks.slack.com/services/…" value={webhook} onInput={(ev: any) => setWebhook(ev.currentTarget.value)} />
            <s-button disabled={!webhook.trim() || fetcher.state !== "idle"} onClick={() => (fetcher.submit({ intent: "alerts", url: webhook }, { method: "post" }), setWebhook(""))}>
              Save and test
            </s-button>
            {alerts ? (
              <s-button variant="tertiary" tone="critical" onClick={() => fetcher.submit({ intent: "alerts", url: "" }, { method: "post" })}>
                Turn off
              </s-button>
            ) : null}
          </div>
        </s-stack>
      </s-section>

      <s-section heading="AI assistants: Claude and ChatGPT">
        <s-paragraph>
          Add Bulkport as a custom connector (an MCP server). The assistant can then export data, read results and prepare import previews when you ask. It cannot change your store: you apply a preview yourself in the app.
        </s-paragraph>
        <s-paragraph>Connector address (the key is part of it, so keep the address private):</s-paragraph>
        <Code text={`${appUrl}/mcp/${key}`} />
        <s-unordered-list>
          <s-list-item>Claude: Settings → Connectors → Add custom connector, and paste the address.</s-list-item>
          <s-list-item>ChatGPT: Settings → Apps & Connectors → turn on Developer mode → Create, paste the address, authentication "None".</s-list-item>
          <s-list-item>
            Tools that can send a header instead: address <code>{appUrl}/mcp</code> with header <code>Authorization: Bearer {key.slice(0, 3)}…</code>
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Command line">
        <s-paragraph>One file, needs Node 18 or newer. Download it, sign in once, then export and import from the terminal or a scheduled script.</s-paragraph>
        <Code
          text={[
            `curl -o bulkport.mjs ${appUrl}/cli/bulkport.mjs`,
            `node bulkport.mjs login ${appUrl} ${key}`,
            `node bulkport.mjs export Products --columns "ID,Title,Tags" -o products.csv`,
            `node bulkport.mjs import products.csv          # preview, changes nothing`,
            `node bulkport.mjs help`,
          ].join("\n")}
        />
      </s-section>

      <s-section heading="Google Sheets">
        <s-paragraph>Export into a tab, edit, and import the tab back with a preview first.</s-paragraph>
        <s-ordered-list>
          <s-list-item>In your spreadsheet choose Extensions → Apps Script.</s-list-item>
          <s-list-item>
            Replace the contents of Code.gs with <s-link href={`${appUrl}/sheets/Code.gs.txt`} target="_blank">this file</s-link>.
          </s-list-item>
          <s-list-item>
            Add an HTML file named Sidebar and paste <s-link href={`${appUrl}/sheets/Sidebar.html.txt`} target="_blank">this file</s-link> into it.
          </s-list-item>
          <s-list-item>Save, reload the spreadsheet, and choose Bulkport → Open from the menu. Google asks you to allow it the first time.</s-list-item>
          <s-list-item>Enter the app address and an access key:</s-list-item>
        </s-ordered-list>
        <Code text={appUrl} />
      </s-section>

      <s-section heading="Your own scripts (API)">
        <Code
          text={[
            `curl -H "Authorization: Bearer ${key}" ${appUrl}/api/v1/sheets`,
            `curl -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\`,
            `  -d '{"sheets":[{"sheet":"Products","limit":10}]}' ${appUrl}/api/v1/exports`,
            `curl -H "Authorization: Bearer ${key}" ${appUrl}/api/v1/jobs/JOB_ID`,
            `curl -H "Authorization: Bearer ${key}" -OJ ${appUrl}/api/v1/jobs/JOB_ID/result`,
            `curl -H "Authorization: Bearer ${key}" -F file=@products.csv ${appUrl}/api/v1/imports   # preview`,
          ].join("\n")}
        />
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
