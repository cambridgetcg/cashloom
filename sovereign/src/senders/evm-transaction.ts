/**
 * Exact Base EIP-1559 transaction verification.
 *
 * A signer response is hostile input even when the signer is local. Parse the
 * returned bytes, compare every execution field, require a canonical encoding,
 * and recover the source account before any byte can reach an RPC.
 */

import {
  hexToBytes,
  isAddress,
  isHex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
} from "viem";
import { sha256 } from "@noble/hashes/sha2.js";

const MAX_SERIALIZED_TRANSACTION_BYTES = 131_072;
// EIP-2 canonical signatures require s <= secp256k1n / 2.
const SECP256K1_HALF_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export interface ExactEip1559Transaction {
  chainId: number;
  type: "eip1559";
  to: Address;
  value: bigint;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
}

export interface ExactSignedEip1559Evidence {
  unsignedPayload: Hex;
  unsignedPayloadSha256: `sha256:${string}`;
  signedPayload: Hex;
  signedPayloadSha256: `sha256:${string}`;
  txHash: Hex;
}

const sameAddress = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const sameHex = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const refused = (): Error =>
  new Error("Local EVM signing returned bytes that do not match the exact accepted transaction.");

const sha256Id = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${Buffer.from(sha256(bytes)).toString("hex")}`;

export const serializeExactEip1559Unsigned = (
  expected: ExactEip1559Transaction,
): Hex =>
  serializeTransaction({
    ...expected,
    accessList: [],
  });

export const assertExactSignedEip1559Transaction = async (
  serializedTransaction: Hex,
  expectedFrom: Address,
  expected: ExactEip1559Transaction,
): Promise<ExactSignedEip1559Evidence> => {
  if (
    !isAddress(expectedFrom)
    || !isHex(serializedTransaction)
    || serializedTransaction === "0x"
    || serializedTransaction.length % 2 !== 0
    || !serializedTransaction.toLowerCase().startsWith("0x02")
    || (serializedTransaction.length - 2) / 2 > MAX_SERIALIZED_TRANSACTION_BYTES
  ) {
    throw refused();
  }

  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(serializedTransaction);
  } catch {
    throw refused();
  }

  const accessList = parsed.accessList ?? [];
  const data = parsed.data ?? "0x";
  if (
    parsed.type !== "eip1559"
    || parsed.chainId !== expected.chainId
    || parsed.nonce !== expected.nonce
    || parsed.gas !== expected.gas
    || parsed.maxFeePerGas !== expected.maxFeePerGas
    || parsed.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas
    || parsed.to === null
    || parsed.to === undefined
    || !sameAddress(parsed.to, expected.to)
    || (parsed.value ?? 0n) !== expected.value
    || !sameHex(data, expected.data)
    || accessList.length !== 0
    || parsed.r === undefined
    || parsed.s === undefined
    || parsed.yParity === undefined
    || BigInt(parsed.s) > SECP256K1_HALF_N
  ) {
    throw refused();
  }

  let canonicalSigned: Hex;
  try {
    canonicalSigned = serializeTransaction(
      {
        ...expected,
        accessList: [],
      },
      {
        r: parsed.r,
        s: parsed.s,
        yParity: parsed.yParity,
      },
    );
  } catch {
    throw refused();
  }
  if (!sameHex(canonicalSigned, serializedTransaction)) {
    throw refused();
  }

  let recovered: Address;
  try {
    recovered = await recoverTransactionAddress({
      serializedTransaction: serializedTransaction as `0x02${string}`,
    });
  } catch {
    throw refused();
  }
  if (!sameAddress(recovered, expectedFrom)) {
    throw refused();
  }

  const unsignedPayload = serializeExactEip1559Unsigned(expected);
  return {
    unsignedPayload,
    unsignedPayloadSha256: sha256Id(hexToBytes(unsignedPayload)),
    signedPayload: serializedTransaction,
    signedPayloadSha256: sha256Id(hexToBytes(serializedTransaction)),
    txHash: keccak256(serializedTransaction),
  };
};
