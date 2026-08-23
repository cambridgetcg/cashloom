import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  hashBoundSignRequest,
  parseBoundSignRequest,
} from "./signing";

const HASH_A = `sha256:${"11".repeat(32)}`;
const HASH_B = `sha256:${"22".repeat(32)}`;
const COMMON = {
  schema_version: "cashloom.sign-request/1",
  request_id: "sign_01J123",
  intent_hash: HASH_A,
  authorization_id: "auth_01J123",
  expires_at: "2026-08-21T12:05:00.000Z",
} as const;

const ethRequest = {
  ...COMMON,
  kind: "evm-transaction",
  chain_id: "eip155:1",
  signer_account_id: "eip155:1:0xAbCDEF0123456789AbcdEF0123456789aBCDEF01",
  to_account_id: "eip155:1:0x1111111111111111111111111111111111111111",
  nonce: "7",
  value_atomic: "1000000000000000000",
  data: "0x",
  gas_limit: "21000",
  fee: {
    kind: "eip1559",
    max_fee_per_gas_atomic: "30000000000",
    max_priority_fee_per_gas_atomic: "1000000000",
  },
} as const;

const digest = (bytes: Uint8Array): string =>
  `sha256:${bytesToHex(sha256(bytes))}`;

describe("bound sign requests", () => {
  it("validates and hashes an exact EVM request", () => {
    const parsed = parseBoundSignRequest(ethRequest);
    expect(parsed.kind).toBe("evm-transaction");
    const first = hashBoundSignRequest(ethRequest);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashBoundSignRequest({ ...ethRequest })).toBe(first);
    expect(hashBoundSignRequest({ ...ethRequest, nonce: "8" })).not.toBe(first);
  });

  it("rejects wrong-chain EVM accounts and incoherent EIP-1559 fees", () => {
    expect(() =>
      parseBoundSignRequest({
        ...ethRequest,
        signer_account_id: "eip155:8453:0xAbCDEF0123456789AbcdEF0123456789aBCDEF01",
      }),
    ).toThrow(/account is on/);
    expect(() =>
      parseBoundSignRequest({
        ...ethRequest,
        fee: {
          kind: "eip1559",
          max_fee_per_gas_atomic: "1",
          max_priority_fee_per_gas_atomic: "2",
        },
      }),
    ).toThrow(/priority fee/);
  });

  it("requires EIP-712 primary types and lossless string integers", () => {
    const typed = {
      ...COMMON,
      kind: "eip712",
      chain_id: "eip155:1",
      signer_account_id: ethRequest.signer_account_id,
      domain: { name: "CashLoom", version: "1", chainId: "1" },
      types: {
        Transfer: [
          { name: "amount", type: "uint256" },
          { name: "recipient", type: "address" },
        ],
      },
      primary_type: "Transfer",
      message: { amount: "1000000000000000000", recipient: "0x1111" },
    } as const;
    expect(parseBoundSignRequest(typed).kind).toBe("eip712");
    expect(() => parseBoundSignRequest({ ...typed, primary_type: "Missing" })).toThrow(
      /not declared/,
    );
    expect(() =>
      parseBoundSignRequest({ ...typed, message: { ...typed.message, amount: 1 } }),
    ).toThrow();
  });

  it("checks PSBT bytes, digest, exact fee, and visible recipients", () => {
    const psbtBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x00]);
    const request = {
      ...COMMON,
      kind: "bitcoin-psbt",
      chain_id: "bip122:000000000019d6689c085ae165831e93",
      signer_account_id:
        "bip122:000000000019d6689c085ae165831e93:bc1qcashloomwatchaddress",
      psbt_base64: base64.encode(psbtBytes),
      psbt_sha256: digest(psbtBytes),
      inputs: [
        {
          txid: "ab".repeat(32),
          output_index: "0",
          value_atomic: "10000",
        },
      ],
      outputs: [
        {
          script_pubkey: "0x0014aabb",
          address: "bc1qrecipient",
          value_atomic: "9000",
          role: "recipient",
        },
      ],
      fee_atomic: "1000",
    } as const;
    expect(parseBoundSignRequest(request).kind).toBe("bitcoin-psbt");
    expect(() => parseBoundSignRequest({ ...request, psbt_sha256: HASH_B })).toThrow(
      /hash mismatch/,
    );
    expect(() => parseBoundSignRequest({ ...request, fee_atomic: "999" })).toThrow(
      /input total minus output total/,
    );
  });

  it("checks Solana transaction bytes and every account chain", () => {
    const transactionBytes = new Uint8Array([1, 2, 3, 4]);
    const chain = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    const signer = `${chain}:7dHbWXadK9nS7uJ2rVMYQ5KXj7ZUiFQLhsoxZcS3iQkL`;
    const program = `${chain}:11111111111111111111111111111111`;
    const request = {
      ...COMMON,
      kind: "solana-transaction",
      chain_id: chain,
      signer_account_id: signer,
      fee_payer_account_id: signer,
      transaction_base64: base64.encode(transactionBytes),
      transaction_sha256: digest(transactionBytes),
      recent_blockhash: "11111111111111111111111111111111",
      last_valid_block_height: "12345678901234567890",
      instructions: [
        {
          program_account_id: program,
          account_ids: [signer],
          data_base64: base64.encode(new Uint8Array([0])),
        },
      ],
    } as const;
    expect(parseBoundSignRequest(request).kind).toBe("solana-transaction");
    expect(() =>
      parseBoundSignRequest({ ...request, transaction_sha256: HASH_B }),
    ).toThrow(/hash mismatch/);
  });
});

