import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import crypto from "node:crypto";
import fs from "node:fs";
import { EXPIRY_CHOICES, createKey, listKeys, revokeKeyAndSignIn, type KeyScope } from "../lib/api/keys.server";
import { alertEmails, alertWebhookSet, emailAvailable, saveAlertEmails, saveAlertWebhook, sendAlert } from "../lib/jobs/alerts.server";
import { HISTORY_CHOICES, failStopPercent, historyDays, undoOnStop } from "../lib/jobs/jobs.server";
import prisma from "../db.server";
import { approveConnection, listConnections, removeConnection } from "../lib/api/oauth.server";
import { deleteLayout, listLayouts } from "../lib/jobs/layouts.server";

/** SHA-256 of the command-line file as this server hands it out, to check a download against. */
function cliChecksum(): string {
  for (const p of ["build/client/cli/bulkport.mjs", "public/cli/bulkport.mjs"]) {
    try {
      return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    } catch {
      // try the next place
    }
  }
  return "";
}
import { formatDate } from "../components/jobs";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const keys = await listKeys(session.shop);
  return {
    appUrl: (process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, ""),
    alerts: await alertWebhookSet(session.shop),
    emails: (await alertEmails(session.shop)).join(", "),
    emailAvailable: emailAvailable(),
    failStop: await failStopPercent(session.shop),
    undoOnStop: await undoOnStop(session.shop),
    history: await historyDays(session.shop),
    historyChoices: HISTORY_CHOICES,
    expiryChoices: EXPIRY_CHOICES,
    cliSha: cliChecksum(),
    connections: await listConnections(session.shop),
    layouts: (await listLayouts(session.shop)).map((l) => ({ id: l.id, name: l.name, entity: l.entity, columns: Object.values(l.map).filter(Boolean).length, savedAt: l.savedAt })),
    keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, canImport: k.canImport, readOnly: k.readOnly, expiresAt: k.expiresAt, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
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
    if (form.get("intent") === "approve") {
      const name = await approveConnection(session.shop, String(form.get("code") ?? ""));
      return { saved: `Approved. ${name} is now connected; go back to its tab, which continues by itself.` };
    }
    if (form.get("intent") === "delete-layout") {
      await deleteLayout(session.shop, String(form.get("id")));
      return { saved: "Removed." };
    }
    if (form.get("intent") === "disconnect") {
      await removeConnection(session.shop, String(form.get("id")));
      return { saved: "Disconnected." };
    }
    if (form.get("intent") === "emails") {
      const list = await saveAlertEmails(session.shop, String(form.get("emails") ?? ""));
      return { saved: list.length ? `Alerts will be emailed to ${list.join(", ")}.` : "Email alerts are off." };
    }
    if (form.get("intent") === "defaults") {
      const failStopPercent = [0, 5, 10, 25].includes(Number(form.get("failStop"))) ? Number(form.get("failStop")) : 5;
      const days = HISTORY_CHOICES.includes(Number(form.get("history"))) ? Number(form.get("history")) : 90;
      await prisma.shopSetting.upsert({ where: { shop: session.shop }, create: { shop: session.shop, failStopPercent, historyDays: days, undoOnStop: form.get("undoOnStop") === "true" }, update: { failStopPercent, historyDays: days, undoOnStop: form.get("undoOnStop") === "true" } });
      return { saved: "Saved." };
    }
    if (form.get("intent") === "revoke") {
      await revokeKeyAndSignIn(session.shop, String(form.get("id")));
      return { ok: true as const };
    }
    const scope = (["read", "preview", "full"].includes(String(form.get("scope"))) ? String(form.get("scope")) : "preview") as KeyScope;
    const { key, row } = await createKey(session.shop, String(form.get("name") ?? ""), scope, Number(form.get("expires")) || 0);
    return { created: { key, name: row.name, canImport: row.canImport, readOnly: row.readOnly } };
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
  const { keys, appUrl, alerts, emails, emailAvailable: canEmail, failStop, history, historyChoices, expiryChoices, cliSha, undoOnStop: undoSaved, connections, layouts } = useLoaderData<typeof loader>();
  const [code, setCode] = useState("");
  const [undoStop, setUndoStop] = useState(undoSaved);
  const [emailList, setEmailList] = useState(emails);
  const [stopAt, setStopAt] = useState(String(failStop));
  const [days, setDays] = useState(String(history));
  const [scope, setScope] = useState("preview");
  const [expires, setExpires] = useState("90");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const sk = mounted ? "c" : "s";
  const [webhook, setWebhook] = useState("");
  const fetcher = useFetcher<typeof action>();
  const [name, setName] = useState("");
  const data = fetcher.data;
  const created = data && "created" in data ? data.created : null;
  const error = data && "error" in data ? data.error : null;
  const saved = data && "saved" in data ? data.saved : null;
  const key = created?.key ?? "bp_YOUR_KEY";

  return (
    <s-page heading="Settings" inlineSize="base">
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
              : created.readOnly
                ? "This key can export and read results only."
                : "This key can export, and can prepare import previews. Imports are applied from the preview in the app."}
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Access keys">
        {keys.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Key</s-table-header>
              <s-table-header>Can</s-table-header>
              <s-table-header>Expires</s-table-header>
              <s-table-header>Last used</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {keys.map((k) => (
                <s-table-row key={k.id}>
                  <s-table-cell>{k.name}</s-table-cell>
                  <s-table-cell>{k.prefix}…</s-table-cell>
                  <s-table-cell>{k.canImport ? <s-badge tone="warning">Import for real</s-badge> : k.readOnly ? <s-badge>Read only</s-badge> : <s-badge tone="info">Export and preview</s-badge>}</s-table-cell>
                  <s-table-cell>{k.expiresAt ? formatDate(k.expiresAt) : "Never"}</s-table-cell>
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
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-select key={`scope-${sk}`} label="What it may do" value={scope} onChange={(ev: any) => setScope(ev.currentTarget.value)}>
              <s-option value="read">Read only: export and read results</s-option>
              <s-option value="preview">Export, and prepare import previews</s-option>
              <s-option value="full">Full: also import for real, unattended</s-option>
            </s-select>
            <s-select key={`exp-${sk}`} label="Expires" value={expires} onChange={(ev: any) => setExpires(ev.currentTarget.value)}>
              {expiryChoices.map((d) => (
                <s-option key={d} value={String(d)}>
                  {d ? `After ${d} days` : "Never"}
                </s-option>
              ))}
            </s-select>
          </s-grid>
          <s-button
            variant="primary"
            disabled={!name.trim() || fetcher.state !== "idle"}
            onClick={() => {
              fetcher.submit({ intent: "create", name, scope, expires }, { method: "post" });
              setName("");
            }}
          >
            Create key
          </s-button>
        </s-stack>
        <s-paragraph>
          <s-text color="subdued">A key gives access to this store's data. Treat it like a password, and revoke it here if it leaks or is no longer used.</s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="Import safety and history">
        <s-stack direction="block" gap="base">
          <s-unordered-list>
            <s-list-item>Every import starts as a preview; risky rows start as Skip.</s-list-item>
            <s-list-item>Rows only update existing items unless you choose MERGE or NEW. New products are drafts.</s-list-item>
            <s-list-item>Deletions need the word DELETE typed. Product imports can be undone for 90 days.</s-list-item>
          </s-unordered-list>
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-select key={`stop-${sk}`} label="Stop an import when rows fail unexpectedly" details="Rows the preview already said would fail don't count." value={stopAt} onChange={(ev: any) => setStopAt(ev.currentTarget.value)}>
              <s-option value="5">When more than 5% fail</s-option>
              <s-option value="10">When more than 10% fail</s-option>
              <s-option value="25">When more than 25% fail</s-option>
              <s-option value="0">Never stop</s-option>
            </s-select>
            <s-select key={`hist-${sk}`} label="Keep exports in the job history for" details="Their files are cleared with them." value={days} onChange={(ev: any) => setDays(ev.currentTarget.value)}>
              {historyChoices.map((d) => (
                <s-option key={d} value={String(d)}>
                  {d} days
                </s-option>
              ))}
            </s-select>
          </s-grid>
          <s-checkbox
            label="When an import is stopped, also put back what it had changed"
            details="Product imports only. Off: the import stops and you choose whether to undo it."
            checked={undoStop}
            disabled={stopAt === "0"}
            onChange={(ev: any) => setUndoStop(!!ev.currentTarget.checked)}
          />
          <s-stack direction="inline">
            <s-button disabled={fetcher.state !== "idle" || (stopAt === String(failStop) && days === String(history) && undoStop === undoSaved)} onClick={() => fetcher.submit({ intent: "defaults", failStop: stopAt, history: days, undoOnStop: String(undoStop) }, { method: "post" })}>
              Save
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Saved column matchings">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>How files from suppliers and other systems are read: which of their columns is which of ours. A file whose columns fit one of these is read that way automatically. Make one with "Match columns" on a preview.</s-paragraph>
          {layouts.length ? (
            layouts.map((l) => (
              <s-stack key={l.id} direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-text>
                  <b>{l.name}</b> · {l.entity.replace(/_/g, " ")} · {l.columns} columns matched · saved {new Date(l.savedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                </s-text>
                <s-button variant="tertiary" tone="critical" onClick={() => fetcher.submit({ intent: "delete-layout", id: l.id }, { method: "post" })}>
                  Remove
                </s-button>
              </s-stack>
            ))
          ) : (
            <s-text color="subdued">None saved yet.</s-text>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Alerts by email">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>Failed or partly failed scheduled jobs and backups, and scheduled imports held for approval, can be emailed.</s-paragraph>
          {canEmail ? null : <s-text tone="caution">Email alerts aren't switched on for this app yet. You can save the addresses now; alerts start arriving once it is. Until then, use Slack or Teams below.</s-text>}
          <div className="bp-url-row">
            <s-text-field label="Email addresses" labelAccessibilityVisibility="exclusive" placeholder="you@example.com, team@example.com" value={emailList} onInput={(ev: any) => setEmailList(ev.currentTarget.value)} />
            <s-button disabled={fetcher.state !== "idle" || emailList.trim() === emails} onClick={() => fetcher.submit({ intent: "emails", emails: emailList }, { method: "post" })}>
              Save
            </s-button>
          </div>
        </s-stack>
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
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Add Bulkport as a custom connector (an MCP server). The assistant can then export data, read results and prepare import previews when you ask. It cannot change your store: you apply a preview yourself in the app.
          </s-paragraph>
          <s-paragraph>Connector address:</s-paragraph>
          <Code text={`${appUrl}/mcp`} />
          <s-unordered-list>
            <s-list-item>Claude: Settings → Connectors → Add custom connector, and paste the address.</s-list-item>
            <s-list-item>ChatGPT: Settings → Apps & Connectors → Developer mode → Create, paste the address, authentication "OAuth".</s-list-item>
            <s-list-item>The assistant opens a page with a code. Type that code here to approve it:</s-list-item>
          </s-unordered-list>
          <div className="bp-url-row">
            <s-text-field label="Approve a connection" placeholder="ABCD-EFGH" details="The code is shown by the assistant when it connects, and works for 15 minutes." value={code} onInput={(ev: any) => setCode(ev.currentTarget.value)} />
            <s-button variant="primary" disabled={code.replace(/[^A-Za-z0-9]/g, "").length !== 8 || fetcher.state !== "idle"} onClick={() => (fetcher.submit({ intent: "approve", code }, { method: "post" }), setCode(""))}>
              Approve
            </s-button>
          </div>
          {saved ? <s-text tone="success">{saved}</s-text> : null}
          {connections.length ? (
            <s-table>
              <s-table-header-row>
                <s-table-header>Connected assistant</s-table-header>
                <s-table-header>Approved</s-table-header>
                <s-table-header>Last used</s-table-header>
                <s-table-header></s-table-header>
              </s-table-header-row>
              <s-table-body>
                {connections.map((c) => (
                  <s-table-row key={c.id}>
                    <s-table-cell>{c.name}</s-table-cell>
                    <s-table-cell>{c.approvedAt ? formatDate(c.approvedAt) : "—"}</s-table-cell>
                    <s-table-cell>{c.lastUsedAt ? formatDate(c.lastUsedAt) : "Never"}</s-table-cell>
                    <s-table-cell>
                      <s-button variant="tertiary" tone="critical" onClick={() => fetcher.submit({ intent: "disconnect", id: c.id }, { method: "post" })}>
                        Disconnect
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          ) : null}
          <s-text tone="neutral">
            For a tool that can't sign in this way: create an access key above and either send it as the header <code>Authorization: Bearer {key.slice(0, 3)}…</code> to <code>{appUrl}/mcp</code>, or, as a last resort, use the address <code>{appUrl}/mcp/{key.slice(0, 3)}…</code> with the key in it (anyone who has that address can read the store's data).
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Command line">
        <s-paragraph>One file, needs Node 18 or newer. Download it, sign in once, then export and import from the terminal or a scheduled script.</s-paragraph>
        {cliSha ? (
          <s-paragraph>
            <s-text tone="neutral">To check the download, its SHA-256 should be </s-text>
            <code>{cliSha}</code>
            <s-text tone="neutral"> (run: shasum -a 256 bulkport.mjs).</s-text>
          </s-paragraph>
        ) : null}
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
