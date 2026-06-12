import { BadRequestException } from "../utils/app-error";
import { RailConnector } from "./types";
import { createStripeConnector } from "./stripe.connector";
import { gocardlessConnector } from "./gocardless.connector";

// The connector registry: Account.connectorType → RailConnector. Entries are
// FACTORIES because some rails need per-account construction (Stripe pins the
// account's currency at build time — its /v1/balance is multi-currency);
// singleton connectors (GoCardless) are wrapped so the lookup is uniform.
type ConnectorFactory = (accountCurrency: string) => RailConnector;

const registry = new Map<string, ConnectorFactory>();

// Register a connector under a type. Accepts either a ready-made RailConnector
// (singleton rails, fakes injected by tests) or a factory keyed on the
// account's currency. Registration is additive so a test can override a type
// without touching the built-ins' source.
export const registerConnector = (
  type: string,
  impl: RailConnector | ConnectorFactory
): void => {
  registry.set(type, typeof impl === "function" ? impl : () => impl);
};

registerConnector("stripe", (accountCurrency: string) =>
  createStripeConnector(accountCurrency)
);
registerConnector("gocardless", gocardlessConnector);

// Resolve the connector for an account. BadRequest (not 500) on an unknown
// type: it means the Account document carries a connectorType nothing here
// can serve — a data problem to surface to the caller, not a server fault.
export const getConnector = (
  connectorType: string,
  accountCurrency: string
): RailConnector => {
  const factory = registry.get(connectorType);
  if (!factory) {
    throw new BadRequestException(
      `Unknown connector type "${connectorType}": no connector is registered for it`
    );
  }
  return factory(accountCurrency);
};
