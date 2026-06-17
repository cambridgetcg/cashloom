// A deterministic in-rail sender for tests + local dev. It moves NO money; it
// returns a unique receipt. Never used for a real rail — only reached when an
// Account's connectorType is "memory".
import { ConnectorContext } from "../connectors/types";
import { PaymentSender, PaymentInstruction, PaymentReceipt, SendStatus } from "./types";

let nonce = 0;
const nextId = (): string => {
  nonce += 1;
  return `mem_${Date.now().toString(36)}_${nonce}`;
};

export const createMemorySender = (): PaymentSender => ({
  type: "memory",
  async send(_ctx: ConnectorContext, _instruction: PaymentInstruction): Promise<PaymentReceipt> {
    return { externalId: nextId(), feeMinor: "0", status: SendStatus.COMPLETED };
  },
});