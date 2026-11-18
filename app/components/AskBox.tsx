import { useState } from "react";
import { useFetcher } from "react-router";

type AskResult = {
  error?: string;
  id?: string;
  kind?: "export" | "change";
  explanation?: string;
  dataType?: string;
  filters?: string[];
  columns?: number;
  changes?: string[];
};

const EXAMPLES = [
  "Orders fulfilled in the last 21 days with courier metafields",
  "Products from vendor Woven Wood that are out of stock, with SKU and inventory",
  "Add the tag 'Winter sale' to all active products of type Planters",
];

/** Plain-English requests: becomes an export set-up or a change that is previewed first. */
export function AskBox({ enabled }: { enabled: boolean }) {
  const fetcher = useFetcher<AskResult>();
  const act = useFetcher<{ error?: string }>();
  const [prompt, setPrompt] = useState("");
  const busy = fetcher.state !== "idle";
  const r = fetcher.data;

  if (!enabled) return null;
  return (
    <s-section heading="Ask Bulkport">
      <s-stack direction="block" gap="base">
        <s-text-area
          label="What do you want to export or change?"
          labelAccessibilityVisibility="exclusive"
          rows={2}
          placeholder={`e.g. ${EXAMPLES[0]}`}
          value={prompt}
          onInput={(ev: any) => setPrompt(ev.currentTarget.value)}
        />
        <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small">
            {EXAMPLES.slice(1).map((ex) => (
              <s-button key={ex} variant="tertiary" onClick={() => setPrompt(ex)}>
                {ex.length > 46 ? `${ex.slice(0, 44)}…` : ex}
              </s-button>
            ))}
          </s-stack>
          <s-button
            variant="primary"
            icon="wand"
            loading={busy}
            disabled={busy || !prompt.trim()}
            onClick={() => fetcher.submit({ intent: "ask", prompt }, { method: "post", action: "/app/ask" })}
          >
            Ask
          </s-button>
        </s-stack>
        {r?.error ? (
          <s-banner tone="warning" heading="Not sure what to do">
            {r.error}
          </s-banner>
        ) : r?.id ? (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text type="strong">{r.explanation}</s-text>
              <s-text>
                {r.kind === "export" ? "Export" : "Change"} · {r.dataType}
                {r.kind === "export" ? ` · ${r.columns} columns` : ""}
              </s-text>
              {r.filters?.length ? <s-text tone="neutral">Only: {r.filters.join("; ")}</s-text> : <s-text tone="neutral">All {r.dataType?.toLowerCase()}</s-text>}
              {r.changes?.map((c) => (
                <s-text key={c}>→ {c}</s-text>
              ))}
              {act.data?.error ? <s-text tone="critical">{act.data.error}</s-text> : null}
              <s-stack direction="inline" gap="small">
                {r.kind === "export" ? (
                  <>
                    <s-button
                      variant="primary"
                      loading={act.state !== "idle"}
                      onClick={() => act.submit({ intent: "export", id: r.id! }, { method: "post", action: "/app/ask" })}
                    >
                      Export now
                    </s-button>
                    <s-button href={`/app/export?ask=${r.id}`}>Adjust first</s-button>
                  </>
                ) : (
                  <>
                    <s-button
                      variant="primary"
                      icon="view"
                      loading={act.state !== "idle"}
                      onClick={() => act.submit({ intent: "preview", id: r.id! }, { method: "post", action: "/app/ask" })}
                    >
                      Preview the change
                    </s-button>
                    <s-text tone="neutral">Nothing changes until you check the preview and press "Import for real".</s-text>
                  </>
                )}
              </s-stack>
            </s-stack>
          </s-box>
        ) : (
          <s-text tone="neutral">Describe it in your own words. You see what it understood before anything runs; changes are always previewed first.</s-text>
        )}
      </s-stack>
    </s-section>
  );
}
