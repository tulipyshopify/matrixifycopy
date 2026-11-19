import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { usePolling } from "../components/usePolling";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { checkExclusions, getCheckSchedule, latestChecks, markCheckSeen, saveCheckExclusions, setWeeklyCheck, startAiFix, startCheck } from "../lib/check/check.server";
import { AI_FIXABLE, MAX_AI_PRODUCTS } from "../lib/check/aifix";
import { assistantAllowed } from "../lib/ai/assistant.server";
import { browserTimeZone } from "../components/ScheduleTime";
import { ALL_RULES, CHANNELS, channelScores } from "../lib/check/rules";
import { downloadLinks } from "../lib/jobs/jobs.server";
import { formatDate } from "../components/jobs";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { active, latest, previous, failed } = await latestChecks(session.shop);
  const schedule = await getCheckSchedule(session.shop);
  // Seeing this page clears the "score dropped" note on the home screen.
  await markCheckSeen(session.shop);
  return {
    weekly: schedule?.enabled ? { nextRunAt: schedule.nextRunAt } : null,
    aiEnabled: assistantAllowed(session.shop),
    aiMax: MAX_AI_PRODUCTS,
    excludeTags: (await checkExclusions(session.shop)).join(", "),
    active: active ? { progress: active.progress, status: active.status } : null,
    failed: failed ? (failed.error ?? "The check stopped with an error.") : null,
    previousScore: previous?.report?.score ?? null,
    latest: latest
      ? {
          id: latest.job.id,
          at: latest.job.finishedAt ?? latest.job.createdAt,
          link: downloadLinks({ id: latest.job.id, resultFile: latest.job.resultFile, inputFile: null }).result,
          products: latest.report!.products,
          ready: latest.report!.ready,
          score: latest.report!.score,
          channels: channelScores(latest.report!),
          weights: CHANNELS.map((c) => ({ label: c.label, rules: Object.entries(c.weights).sort((a, b) => b[1] - a[1]).map(([k, w]) => `${ALL_RULES.find((r) => r.key === k)?.title ?? k} ×${w}`).join(", ") })),
          rules: ALL_RULES.map((r) => {
            const res = latest.report!.rules.find((x) => x.key === r.key);
            return { key: r.key, title: r.title, severity: r.severity, why: r.why, ai: !!AI_FIXABLE[r.key], count: res?.count ?? 0, examples: res?.examples ?? [], more: (res?.count ?? 0) > (res?.ids.length ?? 0) };
          }),
        }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    if (form.get("intent") === "exclude") {
      await saveCheckExclusions(session.shop, String(form.get("tags") ?? ""));
      return { ok: true };
    }
    if (form.get("intent") === "weekly") {
      await setWeeklyCheck(session.shop, form.get("enabled") === "true", String(form.get("timezone") ?? ""));
      return { ok: true };
    }
    if (form.get("intent") === "ai") {
      const job = await startAiFix(session.shop, String(form.get("id")), String(form.get("rule")));
      return redirect(`/app/jobs/${job.id}`);
    }
    await startCheck(session.shop);
    return { ok: true };
  } catch (e: any) {
    if (e instanceof Response) throw e;
    return { error: e.message as string };
  }
};

/** "85%" of the catalogue, never rounding a real gap down to 0%. */
const share = (count: number, total: number) => {
  const pct = (count / total) * 100;
  return pct > 0 && pct < 1 ? "under 1%" : `${Math.round(pct)}%`;
};

export default function DataCheck() {
  const { active, latest, previousScore, failed, weekly, aiEnabled, aiMax, excludeTags } = useLoaderData<typeof loader>();
  const [exclude, setExclude] = useState(excludeTags);
  const fetcher = useFetcher<{ error?: string }>();
  const intent = fetcher.state !== "idle" ? String(fetcher.formData?.get("intent") ?? "") : "";
  const aiRule = intent === "ai" ? String(fetcher.formData?.get("rule")) : "";
  const busy = !!active || intent === "run";

  usePolling(!!active, 3000);

  const tone = (score: number) => (score >= 60 ? "brand" : "critical");
  const trend = latest && previousScore !== null ? latest.score - previousScore : 0;
  const groups = [
    { key: "critical", heading: "Fix first", note: "Products with these problems are likely to be skipped or misdescribed." },
    { key: "recommended", heading: "Worth improving", note: "These make products easier to find and compare." },
  ] as const;

  return (
    <s-page heading="Catalogue health" inlineSize="base">
      <s-button slot="primary-action" variant="primary" loading={busy} disabled={busy} onClick={() => fetcher.submit({ intent: "run" }, { method: "post" })}>
        {latest ? "Check again" : "Run the check"}
      </s-button>

      {fetcher.data?.error ? (
        <s-banner tone="critical" heading="That didn't work">
          {fetcher.data.error}
        </s-banner>
      ) : null}
      {failed && !active ? (
        <s-banner tone="critical" heading="The last check didn't finish">
          {failed}
        </s-banner>
      ) : null}

      <s-section>
        <s-stack direction="block" gap="small">
          <s-heading>Is your catalogue ready for AI shopping?</s-heading>
          <s-paragraph>
            AI assistants and shopping agents recommend products from their data: description, category, images, identifiers, price. They don't
            see your storefront design. This check reads every active product and shows what's missing. It changes nothing in your store.
          </s-paragraph>
          <s-switch
            label="Check every week"
            details={
              weekly
                ? `Next check: ${formatDate(weekly.nextRunAt)}. The home screen tells you if the score drops.`
                : "Runs every Monday at 06:00 and tells you on the home screen if the score drops, for example after new products are added."
            }
            checked={!!weekly}
            onChange={(ev: any) => fetcher.submit({ intent: "weekly", enabled: String(ev.currentTarget.checked), timezone: browserTimeZone() }, { method: "post" })}
          />
          <div className="bp-url-row">
            <s-text-field
              label="Leave out products tagged"
              details="Comma separated, for example: internal, placeholder, damaged-stock. Products with any of these tags are not checked or counted, from the next check on."
              placeholder="internal, placeholder"
              value={exclude}
              onInput={(ev: any) => setExclude(ev.currentTarget.value)}
            />
            <s-button disabled={exclude.trim() === excludeTags || intent === "exclude"} loading={intent === "exclude"} onClick={() => fetcher.submit({ intent: "exclude", tags: exclude }, { method: "post" })}>
              Save
            </s-button>
          </div>
          {active ? (
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-spinner size="base" accessibilityLabel="Checking" />
              <s-text tone="neutral">
                Checking… {active.progress ? `${active.progress.toLocaleString("en")} products read so far.` : active.status === "queued" ? "waiting to start." : "Shopify is preparing the products."} This page updates by itself.
              </s-text>
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>

      {latest ? (
        <>
          <div className="bp-tiles" role="list">
            <div role="listitem">
              <div className={`bp-tile bp-tile-${tone(latest.score)}`}>
                <span className="bp-tile-label">Readiness score</span>
                <span className="bp-tile-value">{latest.score} / 100</span>
                <span className="bp-tile-note">{trend ? `${trend > 0 ? "+" : ""}${trend} since the check before` : `checked ${formatDate(latest.at)}`}</span>
              </div>
            </div>
            <div role="listitem">
              <div className="bp-tile">
                <span className="bp-tile-label">Ready products</span>
                <span className="bp-tile-value">{latest.ready.toLocaleString("en")}</span>
                <span className="bp-tile-note">of {latest.products.toLocaleString("en")} active, with no critical problem</span>
              </div>
            </div>
            <div role="listitem">
              <div className={`bp-tile${latest.products - latest.ready ? " bp-tile-critical" : " bp-tile-ok"}`}>
                <span className="bp-tile-label">Need fixing</span>
                <span className="bp-tile-value">{(latest.products - latest.ready).toLocaleString("en")}</span>
                <span className="bp-tile-note">{latest.products - latest.ready ? "have at least one critical problem" : "nothing critical"}</span>
              </div>
            </div>
          </div>

          <s-section heading="By channel">
            <s-stack direction="block" gap="base">
              <div className="bp-tiles" role="list">
                {latest.channels.map((c) => (
                  <div role="listitem" key={c.key}>
                    <div className={`bp-tile bp-tile-${c.score >= 80 ? "brand" : c.score >= 60 ? "warn" : "critical"}`}>
                      <span className="bp-tile-label">{c.label}</span>
                      <span className="bp-tile-value">{c.score} / 100</span>
                      <span className="bp-tile-note">{c.worst.length ? `Held back most by: ${c.worst.map((w) => `${w.title.toLowerCase()} (${w.count.toLocaleString("en")})`).join("; ")}` : "Nothing holding it back"}</span>
                    </div>
                  </div>
                ))}
              </div>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13 }}>What each channel's score counts</summary>
                <s-stack direction="block" gap="small">
                  {latest.channels.map((c, i) => (
                    <s-text key={c.key} tone="neutral">
                      <s-text type="strong">{c.label}.</s-text> {c.note} Weights: {latest.weights[i].rules}.
                    </s-text>
                  ))}
                  <s-text tone="neutral">These are Bulkport's reading of each channel's product-data rules, not figures from the channels themselves. ×3 means a listing is usually refused or hidden without it.</s-text>
                </s-stack>
              </details>
            </s-stack>
          </s-section>

          <s-section>
            <s-text tone="neutral">
              How the overall score works: each rule below counts by the share of products that pass it, and a "Fix first" rule counts three times as much as a "Worth improving" one. So a gap on most of the catalogue lowers the score more than the same gap on a few products, and the percentage beside each rule shows how much of the catalogue it affects. "Ready products" is a separate count: products with no "Fix first" problem.
            </s-text>
          </s-section>

          {groups.map((g) => {
            const rules = latest.rules.filter((r) => r.severity === g.key);
            const open = rules.filter((r) => r.count > 0);
            return (
              <s-section key={g.key} heading={`${g.heading} (${open.length} of ${rules.length})`}>
                <s-stack direction="block" gap="base">
                  <s-text tone="neutral">{g.note}</s-text>
                  {rules.map((r) => (
                    <div className="bp-rule" key={r.key}>
                      <div className="bp-rule-main">
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-badge tone={r.count === 0 ? "success" : g.key === "critical" ? "critical" : "warning"}>
                            {r.count === 0 ? "OK" : `${r.count.toLocaleString("en")} ${r.count === 1 ? "product" : "products"}${latest.products ? ` · ${share(r.count, latest.products)}` : ""}`}
                          </s-badge>
                          <s-text type="strong">{r.title}</s-text>
                        </s-stack>
                        <s-text tone="neutral">{r.why}</s-text>
                        {r.examples.length ? (
                          <s-text tone="neutral">
                            e.g.{" "}
                            {r.examples.map((e, i) => (
                              <span key={e.id}>
                                {i ? ", " : ""}
                                <s-link href={`shopify://admin/products/${e.id}`} target="_top">
                                  {e.title || e.id}
                                </s-link>
                              </span>
                            ))}
                          </s-text>
                        ) : null}
                      </div>
                      {r.count ? (
                        <div className="bp-rule-side">
                          {r.ai && aiEnabled ? (
                            <s-button
                              variant="primary"
                              icon="wand"
                              loading={aiRule === r.key}
                              disabled={intent === "ai"}
                              onClick={() => fetcher.submit({ intent: "ai", id: latest.id, rule: r.key }, { method: "post" })}
                            >
                              Draft with AI
                            </s-button>
                          ) : null}
                          <s-button href={`/app/export?check=${latest.id}&rule=${r.key}`}>Export to fix</s-button>
                          {r.ai && aiEnabled && r.count > aiMax ? <s-text tone="neutral">AI: first {aiMax} per run</s-text> : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </s-stack>
              </s-section>
            );
          })}

          <s-section heading="How to fix in bulk">
            <s-stack direction="block" gap="small">
              {aiEnabled ? (
                <s-paragraph>
                  "Draft with AI" writes the missing text for up to {aiMax} products at a time, using only each product's own details. You
                  see every draft in a preview, can download and edit the file, and nothing is saved to the store until you press "Import
                  for real".
                </s-paragraph>
              ) : null}
              <s-paragraph>
                "Export to fix" opens an export of just those products, with only the columns that need filling. Fill them in Excel or Google
                Sheets, then import the file with Preview first.
              </s-paragraph>
              {latest.link ? (
                <s-link href={latest.link} target="_blank">
                  Download the full list of products with problems
                </s-link>
              ) : null}
            </s-stack>
          </s-section>
        </>
      ) : !active ? (
        <s-section>
          <s-text tone="neutral">No check has been run yet. Press "Run the check"; a few thousand products take a minute or two.</s-text>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
