import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import {
  Amount,
  EmptyState,
  LoadingThreads,
  RailBadge,
  SectionTitle,
} from "../components";
import { formatDateTime, formatMinor, sumMinor } from "../format";
import type { Account, SummaryRow } from "../types";

interface CurrencyNet {
  currency: string;
  decimals: number;
  net: bigint;
  inn: bigint;
  out: bigint;
}

function netByCurrency(rows: SummaryRow[]): CurrencyNet[] {
  const map = new Map<string, CurrencyNet>();
  for (const r of rows) {
    let e = map.get(r.currency);
    if (!e) {
      e = { currency: r.currency, decimals: r.decimals, net: 0n, inn: 0n, out: 0n };
      map.set(r.currency, e);
    }
    e.net += sumMinor([r.balance_minor]);
    e.inn += sumMinor([r.in_minor]);
    e.out += sumMinor([r.out_minor]);
  }
  return [...map.values()];
}

export function Dashboard({ onGoto }: { onGoto: (view: string) => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [a, s] = await Promise.all([api.accounts(), api.summary()]);
        if (!live) return;
        setAccounts(a.accounts);
        setSummary(s.accounts);
      } catch (ex) {
        if (live) setErr(errorMessage(ex));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (err) return <EmptyState>{err}</EmptyState>;
  if (!accounts || !summary) return <LoadingThreads />;

  const active = accounts.filter((a) => a.status !== "archived");
  const byId = new Map(summary.map((s) => [s.id, s]));
  const nets = netByCurrency(summary);

  return (
    <div className="stagger">
      <SectionTitle aside={`${active.length} account${active.length === 1 ? "" : "s"} on the loom`}>
        Overview
      </SectionTitle>

      {active.length === 0 ? (
        <EmptyState>
          Nothing woven yet. Start by{" "}
          <button className="link-btn" onClick={() => onGoto("accounts")}>
            adding an account
          </button>{" "}
          — cash in a drawer counts.
        </EmptyState>
      ) : (
        <>
          <div className="net-strip">
            {nets.map((n) => (
              <div className="net-line" key={n.currency}>
                <span className="net-label">Net position</span>
                <Amount
                  minor={n.net.toString()}
                  decimals={n.decimals}
                  currency={n.currency}
                  size="lg"
                />
                <span className="net-flows">
                  <span className="flow-in">
                    ↑ {formatMinor(n.inn.toString(), n.decimals)}
                  </span>
                  <span className="flow-out">
                    ↓ {formatMinor(n.out.toString(), n.decimals)}
                  </span>
                </span>
              </div>
            ))}
          </div>

          <div className="card-grid">
            {active.map((a) => {
              const s = byId.get(a.id);
              return (
                <article className="card account-card" key={a.id}>
                  <header className="card-head">
                    <h3>{a.display_name}</h3>
                    <RailBadge rail={a.rail} />
                  </header>
                  <div className="card-balance">
                    <Amount
                      minor={a.balance_minor}
                      decimals={a.decimals}
                      currency={a.currency}
                      size="xl"
                    />
                  </div>
                  <footer className="card-foot">
                    {s && (
                      <span className="card-flows">
                        <span className="flow-in">
                          ↑ {formatMinor(s.in_minor, a.decimals)}
                        </span>
                        <span className="flow-out">
                          ↓ {formatMinor(s.out_minor, a.decimals)}
                        </span>
                        <span className="card-txcount">
                          {s.tx_count} entr{s.tx_count === 1 ? "y" : "ies"}
                        </span>
                      </span>
                    )}
                    {a.balance_as_of && (
                      <span className="card-asof">as of {formatDateTime(a.balance_as_of)}</span>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
