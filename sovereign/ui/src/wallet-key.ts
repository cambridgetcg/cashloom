import type { VaultKey } from "./types";

/** Record-signing keys have public material too, but no payment address. */
export function isAddressKey(key: VaultKey): boolean {
  return key.kind === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(key.address)
    : key.kind === "btc" && /^(bc1[02-9ac-hj-np-z]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(key.address);
}
