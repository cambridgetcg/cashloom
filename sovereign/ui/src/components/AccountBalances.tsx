import { Amount } from "../components";
import { formatDateTime } from "../format";

export interface BalanceSnapshot {
  currency: string;
  decimals: number;
  balance_minor: string;
  balance_as_of: string | null;
  balance_kind?: string;
  available_minor?: string | null;
  pending_minor?: string | null;
  held_minor?: string | null;
  account_type?: string | null;
}

export const isCreditAccount = (account: { account_type?: string | null }): boolean => account.account_type?.split(":")[0] === "credit";

export function AccountBalances({ account }: { account: BalanceSnapshot }) {
  const value = (minor: string | null | undefined) => minor == null
    ? <span className="balance-unknown">Not supplied</span>
    : <Amount minor={minor} decimals={account.decimals} currency={account.currency} />;
  return <div className="money-balances">
    <dl>
      <div><dt>{isCreditAccount(account) ? "Amount owed" : `${account.balance_kind === "current" ? "Current" : account.balance_kind === "total" ? "Total" : "Recorded"} balance`}</dt>
        <dd>{account.balance_as_of ? value(account.balance_minor) : <span className="balance-unknown">Not checked</span>}</dd></div>
      <div><dt>{isCreditAccount(account) ? "Available credit" : "Available"}</dt><dd>{value(account.available_minor)}</dd></div>
      <div><dt>Pending</dt><dd>{value(account.pending_minor)}</dd></div>
      <div><dt>Held</dt><dd>{value(account.held_minor)}</dd></div>
    </dl>
    <p>Balance observed {account.balance_as_of ? <time dateTime={account.balance_as_of}>{formatDateTime(account.balance_as_of)}</time> : "— no observation yet"}. Missing values are unknown, not zero.</p>
    {isCreditAccount(account) && <p>Credit availability is borrowing capacity, not cash you hold.</p>}
  </div>;
}
