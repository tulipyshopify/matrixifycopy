export interface PickField {
  key: string;
  label: string;
  options?: string[];
  hint?: string;
}
export type Pick = Array<{ field: string; value: string }>;

/** "Which products": up to four conditions that must all hold, or every product. */
export function ProductPicker({
  fields,
  pick,
  setPick,
  all,
  setAll,
  count,
  counting,
}: {
  fields: PickField[];
  pick: Pick;
  setPick: (next: Pick) => void;
  all: boolean;
  setAll: (v: boolean) => void;
  count?: { n: number; exact: boolean } | null;
  counting?: boolean;
}) {
  const setAt = (i: number, p: Partial<Pick[number]>) => setPick(pick.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const chosen = pick.some((p) => p.value.trim() !== "");
  return (
    <s-stack direction="block" gap="base">
      {all ? null : (
        <>
          {pick.map((p, i) => {
            const spec = fields.find((f) => f.key === p.field) ?? fields[0];
            return (
              <s-grid key={i} gridTemplateColumns={pick.length > 1 ? "minmax(0, 1fr) minmax(0, 1fr) auto" : "minmax(0, 1fr) minmax(0, 1fr)"} gap="small" alignItems="end">
                <s-select
                  label={i === 0 ? "Products where" : "and"}
                  value={p.field}
                  onChange={(ev: any) => {
                    const key = String(ev.currentTarget.value);
                    setAt(i, { field: key, value: fields.find((f) => f.key === key)?.options?.[0] ?? "" });
                  }}
                >
                  {fields.map((f) => (
                    <s-option key={f.key} value={f.key}>
                      {f.label}
                    </s-option>
                  ))}
                </s-select>
                {spec.options ? (
                  <s-select label="Value" labelAccessibilityVisibility="exclusive" value={p.value} onChange={(ev: any) => setAt(i, { value: String(ev.currentTarget.value) })}>
                    {spec.options.map((o) => (
                      <s-option key={o} value={o}>
                        {o === "true" ? "Yes" : o === "false" ? "No" : o[0].toUpperCase() + o.slice(1)}
                      </s-option>
                    ))}
                  </s-select>
                ) : (
                  <s-text-field label="Value" labelAccessibilityVisibility="exclusive" details={spec.hint} value={p.value} onInput={(ev: any) => setAt(i, { value: String(ev.currentTarget.value) })} />
                )}
                {pick.length > 1 ? <s-button variant="tertiary" icon="delete" accessibilityLabel="Remove this condition" onClick={() => setPick(pick.filter((_, j) => j !== i))} /> : null}
              </s-grid>
            );
          })}
          {pick.length < 4 ? (
            <div>
              <s-button variant="tertiary" icon="plus" onClick={() => setPick([...pick, { field: fields.find((f) => !pick.some((c) => c.field === f.key))?.key ?? "tag", value: "" }])}>
                Add a condition
              </s-button>
            </div>
          ) : null}
        </>
      )}
      <s-checkbox label="Every product in the store" checked={all} onChange={(ev: any) => setAll(!!ev.currentTarget.checked)} />
      {count ? (
        <s-text type="strong">
          {count.exact ? "" : "About "}
          {count.n.toLocaleString("en")} {count.n === 1 ? "product matches" : "products match"}
          {count.n === 0 ? ". Check the spelling: values must match exactly." : ""}
        </s-text>
      ) : (all || chosen) && counting ? (
        <s-text color="subdued">Counting…</s-text>
      ) : null}
    </s-stack>
  );
}
