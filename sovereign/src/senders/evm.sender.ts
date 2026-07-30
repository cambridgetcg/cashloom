/** EVM sender — Base mainnet. USDC (the spec's chosen cheap stablecoin rail)
 *  and native ETH. Signs locally with a vault key; broadcasts the SIGNED
 *  transaction through a public RPC — the private key never touches the
 *  network (PROTOCOL.md §5.2). Pass-through fees only: the network's gas,
 *  nothing else.
 */

import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  isAddress,
  isHex,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { revealForSigning } from "../vault.ts";
import {
  AmbiguousBroadcastError,
  type PaymentInstruction,
  type PaymentQuote,
  type PaymentReceipt,
  type PaymentSender,
  type SenderContext,
  type SendHooks,
} from "./types.ts";

// Native USDC on Base (Circle-issued), 6 decimals.
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_DECIMALS = 6;

// Public RPC by default — anyone can run this with zero accounts. Overridable
// for a paid/private endpoint. A URL, not a credential.
const rpcUrl = (): string =>
  process.env.CASHLOOM_BASE_RPC_URL?.trim() || "https://mainnet.base.org";

const publicClient = () => createPublicClient({ chain: base, transport: http(rpcUrl()) });

const AMOUNT_PATTERN = /^[1-9][0-9]*$/;
const QUANTITY_PATTERN = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const REQUOTE = " Ask for a fresh quote.";

type EvmAsset = "ETH" | "USDC";

interface EvmRequest {
  to: Address;
  value: bigint;
  data: Hex;
}

interface EvmSignRequest extends EvmRequest {
  chainId: number;
  type: "eip1559";
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
}

interface EvmDetail {
  v: 1;
  chainId: number;
  asset: EvmAsset;
  from: Address;
  recipient: Address;
  amountMinor: string;
  request: {
    to: Address;
    value: string;
    data: Hex;
    gas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  };
  feeWei: string;
}

/**
 * Narrow dependency seam for deterministic sender tests. Production
 * implementations remain local-signing + one raw-RPC dispatch.
 */
export interface EvmSenderDependencies {
  getSenderAddress(ctx: SenderContext): Promise<Address>;
  /** Independent payments.fee_minor value accepted by the confirm flow. */
  getAcceptedFeeMinor(ctx: SenderContext): Promise<string>;
  estimateGas(from: Address, request: EvmRequest): Promise<bigint>;
  estimateFeesPerGas(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }>;
  getPendingNonce(address: Address): Promise<number>;
  signTransaction(
    ctx: SenderContext,
    expectedFrom: Address,
    request: EvmSignRequest
  ): Promise<Hex>;
  sendRawTransaction(serializedTransaction: Hex): Promise<Hex>;
}

const parseInstruction = (instruction: PaymentInstruction) => {
  if (!isAddress(instruction.to)) {
    throw new Error(`"${instruction.to}" is not a valid EVM address.`);
  }
  if (!AMOUNT_PATTERN.test(instruction.amountMinor)) {
    throw new Error(
      "amountMinor must be a positive integer minor-unit string (no decimals, no zero)."
    );
  }
  const amount = BigInt(instruction.amountMinor);
  const asset = instruction.asset.trim().toUpperCase();
  if (asset !== "ETH" && asset !== "USDC") {
    throw new Error(`EVM sender moves ETH and USDC; got "${instruction.asset}".`);
  }
  return { to: instruction.to as Address, amount, asset: asset as EvmAsset };
};

/** The transaction intent shared by quote (estimate) and send (sign). */
const buildRequest = (to: Address, amount: bigint, asset: EvmAsset): EvmRequest =>
  asset === "ETH"
    ? { to, value: amount, data: "0x" }
    : {
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [to, amount],
        }),
      };

const sameAddress = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const sameHex = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const parseQuantity = (
  value: unknown,
  field: string,
  options: { positive?: boolean } = {}
): bigint => {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    throw new Error(`The stored EVM quote has a malformed ${field}.${REQUOTE}`);
  }
  const quantity = BigInt(value);
  if ((options.positive && quantity === 0n) || quantity > UINT256_MAX) {
    throw new Error(`The stored EVM quote has an invalid ${field}.${REQUOTE}`);
  }
  return quantity;
};

const parseDetail = (
  raw: string | null | undefined,
  expected: { from: Address; to: Address; amount: bigint; asset: EvmAsset }
): {
  request: EvmRequest;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  feeWei: bigint;
} => {
  if (!raw) {
    throw new Error(`This payment has no stored EVM quote to sign.${REQUOTE}`);
  }

  let detail: EvmDetail;
  try {
    detail = JSON.parse(raw) as EvmDetail;
  } catch {
    throw new Error(`This payment's stored EVM quote is unreadable.${REQUOTE}`);
  }

  if (
    detail?.v !== 1 ||
    detail.chainId !== base.id ||
    detail.asset !== expected.asset ||
    typeof detail.from !== "string" ||
    !isAddress(detail.from) ||
    !sameAddress(detail.from, expected.from) ||
    typeof detail.recipient !== "string" ||
    !isAddress(detail.recipient) ||
    !sameAddress(detail.recipient, expected.to) ||
    detail.amountMinor !== expected.amount.toString()
  ) {
    throw new Error(`The stored EVM quote does not match this payment.${REQUOTE}`);
  }

  const stored = detail.request;
  if (
    !stored ||
    typeof stored.to !== "string" ||
    !isAddress(stored.to) ||
    typeof stored.data !== "string" ||
    !isHex(stored.data)
  ) {
    throw new Error(`The stored EVM quote has a malformed request.${REQUOTE}`);
  }

  const expectedRequest = buildRequest(expected.to, expected.amount, expected.asset);
  const value = parseQuantity(stored.value, "transaction value");
  if (
    !sameAddress(stored.to, expectedRequest.to) ||
    value !== expectedRequest.value ||
    stored.data !== expectedRequest.data
  ) {
    throw new Error(`The stored EVM request does not match this payment.${REQUOTE}`);
  }

  const gas = parseQuantity(stored.gas, "gas limit", { positive: true });
  const maxFeePerGas = parseQuantity(stored.maxFeePerGas, "maximum fee per gas", {
    positive: true,
  });
  const maxPriorityFeePerGas = parseQuantity(
    stored.maxPriorityFeePerGas,
    "maximum priority fee per gas"
  );
  const feeWei = parseQuantity(detail.feeWei, "total fee ceiling", { positive: true });

  if (maxPriorityFeePerGas > maxFeePerGas || gas * maxFeePerGas !== feeWei) {
    throw new Error(`The stored EVM fee ceiling does not reconcile.${REQUOTE}`);
  }

  return {
    request: { to: stored.to, value, data: stored.data },
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    feeWei,
  };
};

const senderAddress = async (ctx: SenderContext): Promise<Address> => {
  // Address is derivable public data; stored on the vault row at creation.
  const { db } = await import("../db.ts");
  const row = db
    .query("SELECT address FROM vault_keys WHERE id = ? AND kind = 'evm'")
    .get(ctx.vaultKeyId) as { address: string | null } | null;
  if (!row?.address || !isAddress(row.address)) {
    throw new Error(`No EVM vault key ${ctx.vaultKeyId}`);
  }
  return row.address;
};

const defaultDependencies: EvmSenderDependencies = {
  getSenderAddress: senderAddress,

  async getAcceptedFeeMinor(ctx) {
    if (!ctx.paymentId) {
      throw new Error("An EVM send requires a persisted payment quote.");
    }
    const { db } = await import("../db.ts");
    const row = db
      .query("SELECT fee_minor FROM payments WHERE id = ?")
      .get(ctx.paymentId) as { fee_minor: string | null } | null;
    if (!row?.fee_minor) {
      throw new Error(`No persisted fee exists for EVM payment ${ctx.paymentId}.`);
    }
    return String(row.fee_minor);
  },

  async estimateGas(from, request) {
    return publicClient().estimateGas({ account: from, ...request });
  },

  async estimateFeesPerGas() {
    const fees = await publicClient().estimateFeesPerGas();
    return {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  },

  async getPendingNonce(address) {
    return publicClient().getTransactionCount({ address, blockTag: "pending" });
  },

  async signTransaction(ctx, expectedFrom, request) {
    // Reveal lives for exactly this scope: derive the signer, sign, done.
    const account = privateKeyToAccount(
      (await revealForSigning(ctx.vaultKeyId)) as Hex
    );
    if (!sameAddress(account.address, expectedFrom)) {
      throw new Error("The revealed EVM key does not match the quoted sending address.");
    }
    return account.signTransaction(request);
  },

  async sendRawTransaction(serializedTransaction) {
    return publicClient().sendRawTransaction({ serializedTransaction });
  },
};

export const createEvmSender = (
  dependencies: EvmSenderDependencies
): PaymentSender => ({
  type: "evm-base",
  assets: ["ETH", "USDC"],

  async quote(ctx: SenderContext, instruction: PaymentInstruction): Promise<PaymentQuote> {
    const { to, amount, asset } = parseInstruction(instruction);
    const from = await dependencies.getSenderAddress(ctx);
    const request = buildRequest(to, amount, asset);

    const [gas, fees] = await Promise.all([
      dependencies.estimateGas(from, request),
      dependencies.estimateFeesPerGas(),
    ]);
    if (
      gas <= 0n ||
      gas > UINT256_MAX ||
      fees.maxFeePerGas <= 0n ||
      fees.maxFeePerGas > UINT256_MAX ||
      fees.maxPriorityFeePerGas < 0n ||
      fees.maxPriorityFeePerGas > fees.maxFeePerGas
    ) {
      throw new Error("The Base RPC returned an invalid EVM gas or fee estimate.");
    }

    // Disclose and persist the upper bound. send() reuses these exact fields;
    // a busier chain may delay/refuse the transaction, never silently raise it.
    const feeWei = gas * fees.maxFeePerGas;
    if (feeWei > UINT256_MAX) {
      throw new Error("The Base RPC returned an EVM fee estimate outside uint256 range.");
    }
    const detail: EvmDetail = {
      v: 1,
      chainId: base.id,
      asset,
      from,
      recipient: to,
      amountMinor: amount.toString(),
      request: {
        to: request.to,
        value: request.value.toString(),
        data: request.data,
        gas: gas.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      },
      feeWei: feeWei.toString(),
    };
    const amountHuman =
      asset === "USDC"
        ? `${formatUnits(amount, USDC_DECIMALS)} USDC`
        : `${amount} wei`;
    return {
      feeMinor: feeWei.toString(),
      feeAsset: "ETH(wei)",
      summary: `Send ${amountHuman} on Base to ${to} — network fee at most ${feeWei} wei (~${formatEther(feeWei)} ETH). No CashLoom fee, ever.`,
      detail: JSON.stringify(detail),
    };
  },

  async send(
    ctx: SenderContext,
    instruction: PaymentInstruction,
    hooks?: SendHooks
  ): Promise<PaymentReceipt> {
    const { to, amount, asset } = parseInstruction(instruction);
    const from = await dependencies.getSenderAddress(ctx);
    const { request, gas, maxFeePerGas, maxPriorityFeePerGas } = parseDetail(
      instruction.detail,
      { from, to, amount, asset }
    );
    const acceptedFeeMinor = await dependencies.getAcceptedFeeMinor(ctx);
    if (
      !QUANTITY_PATTERN.test(acceptedFeeMinor) ||
      BigInt(acceptedFeeMinor) !== gas * maxFeePerGas
    ) {
      throw new Error(
        `The stored EVM fee ceiling differs from the accepted payment fee.${REQUOTE}`
      );
    }

    // Re-estimation is validation only: if state changed enough that the
    // accepted gas limit is now insufficient, fail before signing. Never
    // replace the user's accepted gas or fee ceiling with fresh higher values.
    const requiredGas = await dependencies.estimateGas(from, request);
    if (requiredGas <= 0n || requiredGas > gas) {
      throw new Error(
        `The accepted EVM gas limit is no longer sufficient.${REQUOTE}`
      );
    }

    const nonce = await dependencies.getPendingNonce(from);
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new Error("The Base RPC returned an invalid pending nonce.");
    }

    const serializedTransaction = await dependencies.signTransaction(ctx, from, {
      chainId: base.id,
      type: "eip1559",
      to: request.to,
      value: request.value,
      data: request.data,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
    });
    if (
      !isHex(serializedTransaction) ||
      serializedTransaction === "0x" ||
      serializedTransaction.length % 2 !== 0
    ) {
      throw new Error("Local EVM signing returned a malformed transaction.");
    }

    // EVM transaction hashes are keccak256(signed serialized bytes), stable
    // before any RPC sees them. A persistence failure is pre-dispatch and
    // remains an ordinary failure; the network has heard nothing.
    const hash = keccak256(serializedTransaction);
    hooks?.onSigned?.(hash);

    let submittedHash: Hex;
    try {
      // One attempt only. Once this call begins, every error is ambiguous:
      // the RPC may have accepted and relayed the exact signed bytes.
      submittedHash = await dependencies.sendRawTransaction(serializedTransaction);
    } catch {
      throw new AmbiguousBroadcastError(
        `Signed EVM transaction ${hash} was submitted, but the RPC outcome is unknown. Do not retry; reconcile this hash on Base.`,
        hash
      );
    }
    if (!HASH_PATTERN.test(submittedHash) || !sameHex(submittedHash, hash)) {
      throw new AmbiguousBroadcastError(
        `The Base RPC did not acknowledge signed EVM transaction ${hash} consistently. Do not retry; reconcile this hash on Base.`,
        hash
      );
    }

    return { externalId: hash, status: "broadcast" };
  },
});

export const evmSender: PaymentSender = createEvmSender(defaultDependencies);
