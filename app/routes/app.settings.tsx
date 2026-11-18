import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { emailConfigured, getSettings, saveSettings, sendTestAlert } from "../lib/jobs/alerts.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const s = await getSettings(session.shop);
  return { alertEmail: s.alertEmail ?? "", alertScope: s.alertScope, emailReady: emailConfigured() };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    if (form.get("intent") === "test") {
      await sendTestAlert(session.shop);
      return { ok: "Test email sent. Check the inbox (and spam folder)." };
    }
    await saveSettings(session.shop, { alertEmail: String(form.get("alertEmail") ?? ""), alertScope: String(form.get("alertScope") ?? "") });
    return { ok: "Saved" };
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok?: string; error?: string }>();
  const [email, setEmail] = useState(data.alertEmail);
  const [scope, setScope] = useState(data.alertScope);
  const busy = fetcher.state !== "idle";
  const intent = fetcher.formData?.get("intent");

  return (
    <s-page heading="Settings" inlineSize="base">
      {fetcher.data?.error ? (
        <s-banner tone="critical" heading="Not saved">
          {fetcher.data.error}
        </s-banner>
      ) : fetcher.data?.ok ? (
        <s-banner tone="success" heading={fetcher.data.ok} />
      ) : null}
      <s-section heading="Failure alerts">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Every job that fails or finishes with problems is flagged on the home screen until you open it. You can also be emailed, which
            matters most for scheduled jobs that run at night.
          </s-paragraph>
          <s-email-field
            label="Email alerts to"
            details="Up to 5 addresses, separated by commas. Leave empty for no emails."
            value={email}
            onInput={(ev: any) => setEmail(ev.currentTarget.value)}
          />
          <s-choice-list label="Email me about" values={[scope]} onChange={(ev: any) => setScope(ev.currentTarget.values[0])}>
            <s-choice value="scheduled">Scheduled jobs only</s-choice>
            <s-choice value="all">Every job, including the ones I start myself</s-choice>
          </s-choice-list>
          {!data.emailReady ? (
            <s-banner tone="warning" heading="Email isn't set up on the server yet">
              Your address is saved, but emails can't be sent until the server has an email account (SMTP) configured. Problems are still
              flagged in the app.
            </s-banner>
          ) : null}
          <s-stack direction="inline" gap="small" justifyContent="end">
            <s-button
              disabled={busy || !data.alertEmail || !data.emailReady}
              loading={busy && intent === "test"}
              onClick={() => fetcher.submit({ intent: "test" }, { method: "post" })}
            >
              Send a test email
            </s-button>
            <s-button
              variant="primary"
              disabled={busy}
              loading={busy && intent === "save"}
              onClick={() => fetcher.submit({ intent: "save", alertEmail: email, alertScope: scope }, { method: "post" })}
            >
              Save
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
