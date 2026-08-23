/**
 * MoneyFact — the one datum shape MONEYWORLD serves. No naked numbers: every
 * fact carries where it came from, how a stranger checks it, and whether we may
 * redistribute it. Three ORTHOGONAL honesty axes (reconciling MONEYWORLD.md §1's
 * original `grade` with Xenia's proof_state — they were on different axes):
 *
 *   method       — how WE produced it       : observed | derived
 *   proof_state  — how a STRANGER checks it  : none | asserted | tested | attested   ← Xenia canonical
 *   redistribution — the license class       : public-domain | attribution-required | own-data | onchain-rederivable | third-party-restricted
 *
 * proof_state is the trust axis (re-derivable without a secret and without our
 * say-so?); redistribution makes the market-data firewall STRUCTURAL — the
 * server refuses to meter a fact it may not resell. Value is always exact
 * integer minor units as a decimal STRING — a float never touches money here.
 */

export const MONEYFACT_MEDIA_TYPE = "application/vnd.cashloom.moneyfact.v1+json";

export type Method = "observed" | "derived";
export type ProofState = "none" | "asserted" | "tested" | "attested";
export type Redistribution =
  | "public-domain"
  | "attribution-required"
  | "own-data"
  | "onchain-rederivable"
  | "third-party-restricted";

export interface Source {
  name: string;
  url: string;
  fetched_at: string;
}

export interface MoneyFact {
  "@type": "MoneyFact";
  schema: "cashloom.moneyfact/1";
  subject: string; // CAIP-10 account or CAIP-19 asset
  predicate: string; // e.g. "balance"
  value: string; // exact integer minor units, decimal STRING (never a float)
  unit: string; // CAIP-19 asset ref
  decimals: number; // how to read value (8 = BTC sats, 6 = uZRN)
  plane: "owned" | "public";
  method: Method;
  proof_state: ProofState;
  redistribution: Redistribution;
  sources: Source[];
  observed_at: string; // ISO 8601
  stale_after_s: number;
  recompute?: { how: string }; // Xenia: the recipe to re-derive (tested/attested)
}

export function makeFact(f: Omit<MoneyFact, "@type" | "schema">): MoneyFact {
  return { "@type": "MoneyFact", schema: "cashloom.moneyfact/1", ...f };
}

// Exact minor-string → human decimal, no float. "153200000000" @18 = "153.2".
export function formatMinor(minor: string, decimals: number): string {
  const neg = minor.startsWith("-");
  const digits = (neg ? minor.slice(1) : minor).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  let frac = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Human projection — the SAME fact rendered as a readable card. One source of
// truth, two shapes (Xenia content-negotiation: HTML for people, JSON for machines).
export function factToHtml(f: MoneyFact, symbol: string): string {
  const amount = `${formatMinor(f.value, f.decimals)} ${esc(symbol)}`;
  const src = f.sources
    .map((s) => `<li><a href="${esc(s.url)}">${esc(s.name)}</a> · fetched ${esc(s.fetched_at)}</li>`)
    .join("");
  return `<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(amount)} — cashloom moneyfact</title>
<style>
:root{--bg:#f5f8f4;--ink:#14201a;--mut:#61756a;--grn:#0c5b41;--soft:#e2f1ea;--line:#dbe6dd;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0b1310;--ink:#e9f1ec;--mut:#8aa093;--grn:#6fe9bf;--soft:#0f2820;--line:#243830;--card:#121e19}}
body{font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:42rem;margin:0 auto;padding:3rem 1.2rem;background:var(--bg);color:var(--ink)}
.k{font:.7rem ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em;color:var(--mut);margin:0 0 .4rem}
h1{font:600 clamp(2rem,7vw,3rem)/1.05 Georgia,"Iowan Old Style",serif;margin:.1rem 0;letter-spacing:-.02em}
.sub{font:.9rem ui-monospace,monospace;color:var(--mut);word-break:break-all}
.pills{margin:1.2rem 0}
.pill{display:inline-block;font:.72rem ui-monospace,monospace;background:var(--soft);color:var(--grn);
 border:1px solid color-mix(in srgb,var(--grn) 30%,transparent);border-radius:7px;padding:.2rem .55rem;margin:.15rem .25rem .15rem 0}
ul{padding-left:1.1rem}a{color:var(--grn)}code{font:.85em ui-monospace,monospace}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:1.6rem 1.6rem 1.2rem}
hr{border:0;border-top:1px solid var(--line);margin:1.6rem 0}
</style>
<div class=card>
<p class=k>${esc(f.predicate)} · plane ${esc(f.plane)}</p>
<h1>${esc(amount)}</h1>
<p class=sub><code>${esc(f.subject)}</code></p>
<div class=pills>
 <span class=pill>method: ${esc(f.method)}</span>
 <span class=pill>proof: ${esc(f.proof_state)}</span>
 <span class=pill>license: ${esc(f.redistribution)}</span>
</div>
<p class=k>as of ${esc(f.observed_at)} · stale after ${f.stale_after_s}s${f.recompute ? ` · recompute: <code>${esc(f.recompute.how)}</code>` : ""}</p>
<p class=k>sources</p><ul>${src}</ul>
</div>
<hr>
<p class=k>one fact, two shapes — request with <code>Accept: application/json</code> for the machine form.<br>
governed by <a href="/.well-known/agent.json">Xenia guest-right</a> · read freely, no registration · 🤧💚</p>
</html>`;
}
