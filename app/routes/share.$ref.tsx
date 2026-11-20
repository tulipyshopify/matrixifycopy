import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { replyToShare, sharedPreview } from "../lib/jobs/share.server";

/**
 * A preview shared by link: read only, outside Shopify admin, for someone who
 * checks it and answers. It can't apply anything.
 */
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const preview = await sharedPreview(params.ref ?? "");
  if (!preview) throw new Response("This link is wrong, has been stopped or has expired. Ask the person who sent it for a new one.", { status: 404, headers: { "X-Robots-Tag": "noindex" } });
  return preview;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const form = await request.formData();
  try {
    const reply = await replyToShare(params.ref ?? "", { verdict: String(form.get("verdict")), name: String(form.get("name") ?? ""), note: String(form.get("note") ?? "") });
    return { reply };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
};

export const headers: HeadersFunction = () => ({
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'",
});

export const meta = () => [{ title: "Preview to check" }, { name: "robots", content: "noindex" }];

const LABEL: Record<string, string> = { create: "Create", update: "Update", delete: "Delete", replace: "Delete and re-create", failed: "Can't apply", none: "No change", skipped: "Skipped" };
const when = (d: string | Date) => new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function Change({ text }: { text: string }) {
  const m = /^(.*?): (.*) → (.*)$/s.exec(text);
  if (!m) return <div>{text}</div>;
  return (
    <div>
      <span className="bp-diff-label">{m[1]}:</span> <span className={/^\(.*\)$/.test(m[2]) ? "bp-diff-label" : "bp-diff-old"}>{m[2]}</span> → <span className={/\(cleared|\(deleted|\(removed/.test(m[3]) ? "bp-diff-new bp-diff-gone" : "bp-diff-new"}>{m[3]}</span>
    </div>
  );
}

export default function Shared() {
  const p = useLoaderData<typeof loader>();
  const done = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const replies = p.replies;
  return (
    <main className="bp-share">
      <header>
        <small>Preview to check · store {p.store}</small>
        <h1>{p.name}</h1>
        <p>
          This is what an import <b>would</b> change. Nothing has been changed yet, and this page can't change anything: it is here for you to check and answer. Made {when(p.madeAt)}; the link works until {when(p.expiresAt)}.
        </p>
        {p.personal ? <p className="bp-diff-label">People's names, emails, phone numbers and addresses are hidden on this page. It shows what kind of change each row makes; the store sees the details.</p> : null}
        <ul className="bp-share-totals">
          <li>
            <b>{p.totals.changes.toLocaleString("en")}</b> would change
          </li>
          {p.totals.creates ? (
            <li>
              <b>{p.totals.creates.toLocaleString("en")}</b> new
            </li>
          ) : null}
          {p.totals.deletes ? (
            <li className="bp-share-bad">
              <b>{p.totals.deletes.toLocaleString("en")}</b> deleted
            </li>
          ) : null}
          <li>
            <b>{p.totals.unchanged.toLocaleString("en")}</b> stay as they are
          </li>
          {p.totals.failing ? (
            <li className="bp-share-bad">
              <b>{p.totals.failing.toLocaleString("en")}</b> can't be applied
            </li>
          ) : null}
        </ul>
      </header>

      {p.sheets.map((s) => (
        <section key={s.sheet}>
          {p.sheets.length > 1 ? <h2>{s.sheet}</h2> : null}
          {s.items.length ? (
            <div className="bp-rows" role="list">
              {s.items.map((i) => (
                <div key={`${i.row}${i.item}`} role="listitem" className={`bp-row bp-hist bp-row-${i.action === "failed" ? "failed" : i.action === "delete" || i.action === "replace" ? "delete" : i.action === "create" ? "create" : i.warnings.length ? "look" : "update"}`}>
                  <div className="bp-row-item">
                    <b>{i.title}</b>
                    {i.item === i.title && /^Row \d+$/.test(i.title) ? null : <span className="bp-diff-label">{i.item === i.title ? `Row ${i.row}` : i.item}</span>}
                  </div>
                  <div className="bp-row-what">
                    {i.errors.map((e, k) => (
                      <div key={`e${k}`} className="bp-diff-gone">
                        ✕ {e}
                      </div>
                    ))}
                    {i.changes.map((c, k) => (
                      <Change key={k} text={c} />
                    ))}
                    {i.more ? <div className="bp-diff-label">…and {i.more} more changes on this item</div> : null}
                    {i.warnings.map((w, k) => (
                      <div key={`w${k}`} className="bp-share-warn">
                        ! {w}
                      </div>
                    ))}
                  </div>
                  <div className="bp-row-do">
                    <span className={`bp-share-tag bp-share-${i.action}`}>{LABEL[i.action] ?? i.action}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="bp-diff-label">Nothing in this sheet would change.</p>
          )}
          {s.more ? <p className="bp-diff-label">…and {s.more.toLocaleString("en")} more items that would change. Ask for the results file to see every row.</p> : null}
        </section>
      ))}

      <section className="bp-share-answer">
        <h2>Your answer</h2>
        {replies.length || done?.reply ? (
          <ul>
            {[...replies, ...(done?.reply && !replies.some((r) => r.at === done.reply!.at) ? [done.reply] : [])].map((r) => (
              <li key={r.at}>
                <b>{r.name}</b> {r.verdict === "approve" ? "approved this" : "asked for changes"} on {when(r.at)}
                {r.note ? `: “${r.note}”` : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {done?.reply ? (
          <p className="bp-share-ok">Thank you. Your answer is on the import's page for the store to see.</p>
        ) : (
          <Form method="post">
            {done?.error ? <p className="bp-diff-gone">{done.error}</p> : null}
            <label>
              Your name
              <input name="name" required maxLength={80} autoComplete="name" />
            </label>
            <label>
              A note (optional)
              <textarea name="note" rows={3} maxLength={1000} placeholder="What should be changed, or anything the store should know" />
            </label>
            <div className="bp-share-buttons">
              <button type="submit" name="verdict" value="approve" disabled={busy} className="bp-share-yes">
                Looks right: approve
              </button>
              <button type="submit" name="verdict" value="changes" disabled={busy}>
                Please change something
              </button>
            </div>
            <small>Approving does not apply the import. The store still does that itself.</small>
          </Form>
        )}
      </section>
    </main>
  );
}
