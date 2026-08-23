import type {
  AccountRef,
  AssetRef,
  PositionId,
} from "../domain/identities";
import type { Money } from "../domain/money";

export interface PositionObservation {
  readonly position_id: PositionId;
  readonly account: AccountRef;
  readonly asset: AssetRef;
  readonly total: Money;
  readonly available?: Money;
  readonly pending?: Money;
  readonly observed_at: string;
  readonly source_reference: string;
}

export interface BalanceSnapshot {
  readonly observation_id: string;
  readonly account: AccountRef;
  readonly positions: readonly PositionObservation[];
  readonly observed_at: string;
  readonly next_cursor?: string;
}

export type ActivityStatus =
  | "observed"
  | "pending"
  | "settled"
  | "reversed"
  | "reorged";

export interface ActivityEffect {
  readonly position_id: PositionId;
  readonly account: AccountRef;
  /** Signed exact delta: debit and credit direction is explicit. */
  readonly amount: Money;
}

export interface ActivityObservation {
  readonly observation_id: string;
  readonly external_id: string;
  readonly status: ActivityStatus;
  readonly effects: readonly ActivityEffect[];
  readonly observed_at: string;
  readonly source_reference: string;
}

export interface ActivityPage {
  readonly items: readonly ActivityObservation[];
  readonly next_cursor?: string;
  readonly exhausted: boolean;
}

export interface Observer {
  snapshot(
    account: AccountRef,
    assets?: readonly AssetRef[],
    signal?: AbortSignal,
  ): Promise<BalanceSnapshot>;

  activity(
    account: AccountRef,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ActivityPage>;
}

