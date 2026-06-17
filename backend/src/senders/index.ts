// The sender registry: Account.connectorType -> PaymentSender. Mirrors the
// read-only connector registry. Additive so a test can override a type without
// touching built-ins.
import { BadRequestException } from "../utils/app-error";
import { PaymentSender } from "./types";
import { createMemorySender } from "./memory.sender";

const registry = new Map<string, () => PaymentSender>();

export const registerSender = (
  type: string,
  impl: PaymentSender | (() => PaymentSender)
): void => {
  registry.set(type, typeof impl === "function" ? (impl as () => PaymentSender) : () => impl);
};

export const getSender = (type: string): PaymentSender => {
  const factory = registry.get(type);
  if (!factory) {
    throw new BadRequestException(
      `Unknown payment sender "${type}": no sender is registered for it`
    );
  }
  return factory();
};

registerSender("memory", createMemorySender);