// The outbound seam — parallel to the read-only RailConnector. Nothing here
// reads balances; everything here moves money on explicit user intent. A
// read-only connector must NEVER implement this interface.
import { ConnectorContext } from "../connectors/types";

export enum SendStatus {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

// amountMinor is a SIGNED integer minor-unit string (no floats — crypto needs
// 18-decimal precision). asset is the on-rail symbol ("BTC", "USDC", "USD").
export interface PaymentInstruction {
  to: string;
  amountMinor: string;
  asset: string;
}

// externalId is the rail's own stable id (on-chain txhash, Stripe transfer id) —
// the dedupe key. feeMinor is the rail's pass-through fee in the same minor
// units; CashLoom adds none.
export interface PaymentReceipt {
  externalId: string;
  feeMinor: string;
  status: keyof typeof SendStatus;
}

export interface PaymentSender {
  type: string;
  send(ctx: ConnectorContext, instruction: PaymentInstruction): Promise<PaymentReceipt>;
}