/**
 * Closed Bitcoin-mainnet profile used by the first human Pay Link workflow.
 *
 * The manifest is a local assertion signed by the sovereign node, not a
 * registry entry or a claim that a human identity was verified.
 */

import { assertTimestamp } from "@agenttool/wallet";
import { Address, NETWORK } from "@scure/btc-signer";
import {
  ASSET_TRUST_MANIFEST_SCHEMA,
  parseAssetTrustManifest,
  type AssetTrustManifest,
} from "./asset-trust.ts";

export const BITCOIN_MAINNET_CHAIN_ID =
  "bip122:000000000019d6689c085ae165831e93" as const;
export const BITCOIN_MAINNET_ASSET_ID =
  `${BITCOIN_MAINNET_CHAIN_ID}/slip44:0` as const;
export const BITCOIN_MAINNET_RAIL = "bitcoin-mainnet" as const;
export const BITCOIN_MAX_SATOSHIS = 2_100_000_000_000_000n;
export const BITCOIN_PAY_LINK_MAX_FEE_SATOSHIS = 100_000_000n;

const SATOSHIS = /^[1-9][0-9]*$/u;
const NON_NEGATIVE_SATOSHIS = /^(0|[1-9][0-9]*)$/u;
const DESTINATION_DUST_SATS: Readonly<Record<string, bigint>> = Object.freeze({
  wpkh: 294n,
  wsh: 330n,
  tr: 330n,
  sh: 540n,
  pkh: 546n,
});

export interface BitcoinPaymentTerms {
  readonly destination: string;
  readonly amount_sats: string;
}

export function bitcoinMainnetTrustManifest(
  assessedAt: string,
): AssetTrustManifest {
  assertTimestamp(assessedAt, "assessedAt");
  return parseAssetTrustManifest({
    schema: ASSET_TRUST_MANIFEST_SCHEMA,
    rail: BITCOIN_MAINNET_RAIL,
    asset_id: BITCOIN_MAINNET_ASSET_ID,
    chain_id: BITCOIN_MAINNET_CHAIN_ID,
    provenance: {
      kind: "unsigned-local-assertion",
      assessed_at: assessedAt,
    },
    settlement: {
      model: "layer-1-proof-of-work",
      finality: "probabilistic",
      single_sequencer: false,
    },
    regulated_provider: { required: false, role: "none" },
    issuer_controls: {
      mint: false,
      freeze: false,
      denylist: false,
      pause: false,
      upgrade: false,
    },
    bridge_dependency: "none",
    identity_requirement: "none",
    custody: "self-custody-capable",
    infrastructure: {
      self_hostable_read: true,
      self_hostable_broadcast: true,
    },
    data_egress: {
      categories: ["public-ledger", "peer-network"],
    },
    evidence: [],
  });
}

export function parseBitcoinMainnetAddress(destinationValue: string): string {
  if (typeof destinationValue !== "string") {
    throw new TypeError("destination must be a Bitcoin mainnet address.");
  }
  let destination = destinationValue.trim();
  if (
    destination.startsWith("BC1")
    && destination === destination.toUpperCase()
  ) {
    destination = destination.toLowerCase();
  }

  let decoded: NonNullable<ReturnType<ReturnType<typeof Address>["decode"]>>;
  try {
    const value = Address(NETWORK).decode(destination);
    if (!value) throw new Error("undecodable");
    decoded = value;
  } catch {
    throw new TypeError(
      "destination must be a valid Bitcoin mainnet address.",
    );
  }
  if (DESTINATION_DUST_SATS[decoded.type] === undefined) {
    throw new TypeError(
      `Bitcoin output type ${decoded.type} is not supported by this Pay Link profile.`,
    );
  }
  return destination;
}

export function parseBitcoinSatoshis(
  amountValue: string,
  path = "amount_sats",
): string {
  if (typeof amountValue !== "string" || !SATOSHIS.test(amountValue)) {
    throw new TypeError(
      `${path} must be a positive canonical satoshi integer.`,
    );
  }
  const amount = BigInt(amountValue);
  if (amount > BITCOIN_MAX_SATOSHIS) {
    throw new TypeError(`${path} exceeds the maximum Bitcoin supply.`);
  }
  return amountValue;
}

export function parseBitcoinPayLinkMaxFeeSatoshis(
  amountValue: string,
): string {
  if (
    typeof amountValue !== "string"
    || !NON_NEGATIVE_SATOSHIS.test(amountValue)
  ) {
    throw new TypeError(
      "max_fee_sats must be a canonical non-negative satoshi integer.",
    );
  }
  if (BigInt(amountValue) > BITCOIN_PAY_LINK_MAX_FEE_SATOSHIS) {
    throw new TypeError(
      "max_fee_sats exceeds the 100,000,000-sat Pay Link safety ceiling.",
    );
  }
  return amountValue;
}

export function parseBitcoinPaymentTerms(
  destinationValue: string,
  amountValue: string,
): Readonly<BitcoinPaymentTerms> {
  const destination = parseBitcoinMainnetAddress(destinationValue);
  const amountSats = parseBitcoinSatoshis(amountValue);
  const decoded = Address(NETWORK).decode(destination);
  if (!decoded) {
    throw new TypeError(
      "destination must be a valid Bitcoin mainnet address.",
    );
  }
  const amount = BigInt(amountSats);
  const dust = DESTINATION_DUST_SATS[decoded.type];
  if (dust === undefined) throw new TypeError("Unsupported Bitcoin output type.");
  if (amount < dust) {
    throw new TypeError(
      `amount_sats is below the ${dust}-sat relay floor for this destination.`,
    );
  }

  return Object.freeze({ destination, amount_sats: amountSats });
}
