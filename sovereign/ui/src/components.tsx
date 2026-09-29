import { Children, cloneElement, isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import { formatMinor, isNegativeMinor } from "./format";
import { onToast, type ToastMsg } from "./toast";

/* ── Amount ──────────────────────────────────────────────────────────
   Tabular mono numerals; the fractional part sits quieter than the
   whole — you read the pounds before the pennies. */
export function Amount({
  minor,
  decimals,
  currency,
  signed = false,
  size,
}: {
  minor: string;
  decimals: number;
  currency?: string;
  signed?: boolean;
  size?: "lg" | "xl";
}) {
  const formatted = formatMinor(minor, decimals);
  const neg = formatted.startsWith("-") || isNegativeMinor(minor);
  const bare = formatted.startsWith("-") ? formatted.slice(1) : formatted;
  const dot = bare.indexOf(".");
  const whole = dot === -1 ? bare : bare.slice(0, dot);
  const frac = dot === -1 ? null : bare.slice(dot);

  const cls = [
    "amt",
    size ? `amt-${size}` : "",
    signed ? (neg ? "amt-out" : "amt-in") : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={cls}>
      {signed && <span className="amt-sign">{neg ? "−" : "+"}</span>}
      {!signed && neg && <span className="amt-sign">−</span>}
      <span className="amt-whole">{whole}</span>
      {frac && <span className="amt-frac">{frac}</span>}
      {currency && <span className="amt-cur">{currency}</span>}
    </span>
  );
}

/* ── Badges ───────────────────────────────────────────────────────── */
export function RailBadge({ rail }: { rail: string }) {
  return (
    <span className="badge badge-rail" data-rail={rail}>
      {rail.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "gold" | "ember" | "dim";
}) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

/* ── CopyButton ───────────────────────────────────────────────────── */
export function CopyButton({
  text,
  label = "Copy",
  big = false,
}: {
  text: string;
  label?: string;
  big?: boolean;
}) {
  const [done, setDone] = useState(false);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Fallback for non-secure contexts (plain http on LAN)
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setDone(true);
      window.setTimeout(() => setDone(false), 1600);
    }
  }

  return (
    <button
      type="button"
      className={`btn btn-ghost btn-copy${big ? " btn-copy-big" : ""}${done ? " is-done" : ""}`}
      onClick={() => void copy()}
    >
      {done ? "Copied" : label}
    </button>
  );
}

/* ── Field ────────────────────────────────────────────────────────── */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  let firstControl: string | undefined;
  const controls = Children.map(children, (child, index) => {
    if (!isValidElement<{ id?: string; "aria-describedby"?: string }>(child)
      || typeof child.type !== "string" || !["input", "select", "textarea"].includes(child.type)) return child;
    const controlId = child.props.id ?? `${id}-${index}`;
    firstControl ??= controlId;
    return cloneElement(child, {
      id: controlId,
      "aria-describedby": [child.props["aria-describedby"], hint ? hintId : undefined].filter(Boolean).join(" ") || undefined,
    });
  });
  return (
    <div className="field" role={firstControl ? undefined : "group"} aria-labelledby={firstControl ? undefined : labelId}>
      {firstControl ? <label className="field-label" id={labelId} htmlFor={firstControl}>{label}</label>
        : <span className="field-label" id={labelId}>{label}</span>}
      {controls}
      {hint && <span className="field-hint" id={hintId}>{hint}</span>}
    </div>
  );
}

/* ── Empty / loading states ───────────────────────────────────────── */
export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function LoadingThreads({ label = "Fetching from your node…" }: { label?: string }) {
  return (
    <div className="loading-threads" role="status" aria-label={label}>
      <span />
      <span />
      <span />
      <em>{label}</em>
    </div>
  );
}

/* ── Section header with a thread rule ────────────────────────────── */
export function SectionTitle({
  children,
  aside,
}: {
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="section-title">
      <h2>{children}</h2>
      <span className="thread-rule" aria-hidden="true" />
      {aside && <span className="section-aside">{aside}</span>}
    </div>
  );
}

/* Shared service brand; the export name preserves existing callers. */
export function WeaveMark({ size = 40 }: { size?: number }) {
  return <span className="cashloom-brand-mark weave-mark" aria-hidden="true"
    style={{ width: size, height: size, fontSize: size * 1.125, borderRadius: size * 0.28 }}>c</span>;
}

/* ── Toasts ───────────────────────────────────────────────────────── */
export function Toasts() {
  const [items, setItems] = useState<ToastMsg[]>([]);

  useEffect(
    () =>
      onToast((t) => {
        setItems((xs) => [...xs, t]);
        window.setTimeout(() => {
          setItems((xs) => xs.filter((x) => x.id !== t.id));
        }, 5600);
      }),
    [],
  );

  if (items.length === 0) return null;
  return (
    <div className="toasts" role="status">
      {items.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
