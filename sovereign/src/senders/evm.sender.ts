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
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { estimateTotalFee } from "viem/op-stack";
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
import {
  assertExactSignedEip1559Transaction,
  type ExactSignedEip1559Evidence,
  type ExactEip1559Transaction,
} from "./evm-transaction.ts";

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

type EvmSignRequest = ExactEip1559Transaction;

interface EvmDetail {
  v: 2;
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
  l2ExecutionFeeCeilingWei: string;
  estimatedTotalFeeWei: string;
}

/**
 * Narrow dependency seam for deterministic sender tests. Production
 * implementations remain local-signing + one raw-RPC dispatch.
 */
export interface EvmSenderDependencies {
  getSenderAddress(ctx: SenderContext): Promise<Address>;
  /** Independent payments.fee_minor value accepted by the confirm flow. */
  getAcceptedFeeMinor(ctx: SenderContext): Promise<string>;
  /** Persisted EIP-1559 execution ceiling accepted with the quote. */
  getAcceptedExecutionFeeCeilingMinor(ctx: SenderContext): Promise<string>;
  estimateGas(from: Address, request: EvmRequest): Promise<bigint>;
  estimateFeesPerGas(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }>;
  /** Current OP Stack total estimate: L1 data + L2 execution + operator fee. */
  estimateTotalFee(from: Address, request: EvmRequest): Promise<bigint>;
  getPendingNonce(address: Address): Promise<number>;
  reserveNonce(
    ctx: SenderContext,
    address: Address,
    pendingNonce: number
  ): Promise<number>;
  markNonceSigned(
    ctx: SenderContext,
    address: Address,
    nonce: number,
    evidence: ExactSignedEip1559Evidence,
  ): Promise<void>;
  markNonceSubmitting(
    ctx: SenderContext,
    address: Address,
    nonce: number,
    txHash: Hex
  ): Promise<void>;
  markNonceSubmitted(
    ctx: SenderContext,
    address: Address,
    nonce: number,
    txHash: Hex
  ): Promise<void>;
  markNonceSubmissionUnknown(
    ctx: SenderContext,
    address: Address,
    nonce: number,
    txHash: Hex
  ): Promise<void>;
  releaseNoncePreSubmit(
    ctx: SenderContext,
    address: Address,
    nonce: number
  ): Promise<void>;
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
  l2ExecutionFeeCeilingWei: bigint;
  estimatedTotalFeeWei: bigint;
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
    detail?.v !== 2 ||
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
  const l2ExecutionFeeCeilingWei = parseQuantity(
    detail.l2ExecutionFeeCeilingWei,
    "L2 execution fee ceiling",
    { positive: true },
  );
  const estimatedTotalFeeWei = parseQuantity(
    detail.estimatedTotalFeeWei,
    "estimated total fee",
    { positive: true },
  );

  if (
    maxPriorityFeePerGas > maxFeePerGas
    || gas * maxFeePerGas !== l2ExecutionFeeCeilingWei
  ) {
    throw new Error(`The stored EVM L2 execution fee ceiling does not reconcile.${REQUOTE}`);
  }

  return {
    request: { to: stored.to, value, data: stored.data },
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    l2ExecutionFeeCeilingWei,
    estimatedTotalFeeWei,
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

  async getAcceptedExecutionFeeCeilingMinor(ctx) {
    if (!ctx.paymentId) {
      throw new Error("An EVM send requires a persisted payment quote.");
    }
    const { db } = await import("../db.ts");
    const row = db
      .query("SELECT execution_fee_ceiling_minor FROM payments WHERE id = ?")
      .get(ctx.paymentId) as { execution_fee_ceiling_minor: string | null } | null;
    if (!row?.execution_fee_ceiling_minor) {
      throw new Error(
        `No persisted L2 execution fee ceiling exists for EVM payment ${ctx.paymentId}.`,
      );
    }
    return String(row.execution_fee_ceiling_minor);
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

  async estimateTotalFee(from, request) {
    return estimateTotalFee(publicClient(), {
      account: from,
      ...request,
    });
  },

  async getPendingNonce(address) {
    return publicClient().getTransactionCount({ address, blockTag: "pending" });
  },

  async reserveNonce(ctx, address, pendingNonce) {
    if (!ctx.paymentId) {
      throw new Error("An EVM send requires a persisted payment before nonce reservation.");
    }
    const { reserveEvmNonce } = await import("./evm-nonce.ts");
    return reserveEvmNonce({
      paymentId: ctx.paymentId,
      chainId: base.id,
      fromAddress: address,
      pendingNonce,
    });
  },

  async markNonceSigned(ctx, address, nonce, evidence) {
    if (!ctx.paymentId) throw new Error("EVM nonce state requires a payment id.");
    const { markEvmNonceSigned } = await import("./evm-nonce.ts");
    const { hexToBytes } = await import("viem");
    markEvmNonceSigned({
      paymentId: ctx.paymentId,
      chainId: base.id,
      fromAddress: address,
      nonce,
      txHash: evidence.txHash,
      unsignedPayload: hexToBytes(evidence.unsignedPayload),
      unsignedPayloadSha256: evidence.unsignedPayloadSha256,
      signedPayload: hexToBytes(evidence.signedPayload),
      signedPayloadSha256: evidence.signedPayloadSha256,
    });
  },

  async markNonceSubmitting(ctx, address, nonce, txHash) {
    if (!ctx.paymentId) throw new Error("EVM nonce state requires a payment id.");
    const { markEvmNonceSubmitting } = await import("./evm-nonce.ts");
    markEvmNonceSubmitting({
      paymentId: ctx.paymentId,
      chainId: base.id,
      fromAddress: address,
      nonce,
      txHash,
    });
  },

  async markNonceSubmitted(ctx, address, nonce, txHash) {
    if (!ctx.paymentId) throw new Error("EVM nonce state requires a payment id.");
    const { markEvmNonceSubmitted } = await import("./evm-nonce.ts");
    markEvmNonceSubmitted({
      paymentId: ctx.paymentId,
      chainId: base.id,
      fromAddress: address,
      nonce,
      txHash,
    });
  },

  async markNonceSubmissionUnknown(ctx, address, nonce, txHash) {
    if (!ctx.paymentId) throw new Error("EVM nonce state requires a payment id.");
    const { markEvmNonceSubmissionUnknown } = await import("./evm-nonce.ts");
    markEvmNonceSubmissionUnknown({
      paymentId: ctx.paymentId,
      chainId: base.id,
      fromAddress: address,
      nonce,
      txHash,
    });
  },

  async releaseNoncePreSubmit(ctx, address, nonce) {
    if (!ctx.paymentId) throw new Error("EVM nonce state requires a payment id.");
    const { releaseEvmNoncePreSubmit } = await import("./evm-nonce.ts");
    releaseEvmNoncePreSubmit({
      paymentId: ctx.paymentId,
      chainId: base.id,
      fromAddress: address,
      nonce,
    });
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

    const [gas, fees, estimatedTotalFeeWei] = await Promise.all([
      dependencies.estimateGas(from, request),
      dependencies.estimateFeesPerGas(),
      dependencies.estimateTotalFee(from, request),
    ]);
    if (
      gas <= 0n ||
      gas > UINT256_MAX ||
      fees.maxFeePerGas <= 0n ||
      fees.maxFeePerGas > UINT256_MAX ||
      fees.maxPriorityFeePerGas < 0n ||
      fees.maxPriorityFeePerGas > fees.maxFeePerGas ||
      estimatedTotalFeeWei <= 0n ||
      estimatedTotalFeeWei > UINT256_MAX
    ) {
      throw new Error("The Base RPC returned an invalid EVM gas or fee estimate.");
    }

    // Persist both distinct facts: the EIP-1559 fields hard-cap only L2
    // execution, while the current OP Stack estimate also includes L1 data
    // and operator fees that the transaction format cannot hard-cap.
    const l2ExecutionFeeCeilingWei = gas * fees.maxFeePerGas;
    if (l2ExecutionFeeCeilingWei > UINT256_MAX) {
      throw new Error("The Base RPC returned an EVM fee estimate outside uint256 range.");
    }
    const detail: EvmDetail = {
      v: 2,
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
      l2ExecutionFeeCeilingWei: l2ExecutionFeeCeilingWei.toString(),
      estimatedTotalFeeWei: estimatedTotalFeeWei.toString(),
    };
    const amountHuman =
      asset === "USDC"
        ? `${formatUnits(amount, USDC_DECIMALS)} USDC`
        : `${amount} wei`;
    return {
      feeMinor: estimatedTotalFeeWei.toString(),
      executionFeeCeilingMinor: l2ExecutionFeeCeilingWei.toString(),
      feeAsset: "ETH(wei)",
      summary:
        `Send ${amountHuman} on Base to ${to} — current total network-fee estimate `
        + `${estimatedTotalFeeWei} wei (~${formatEther(estimatedTotalFeeWei)} ETH); `
        + `signed L2 execution ceiling ${l2ExecutionFeeCeilingWei} wei. `
        + "Base L1 data/operator fees can change and are not capped by EIP-1559. "
        + "No CashLoom fee, ever.",
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
    const {
      request,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      estimatedTotalFeeWei,
    } = parseDetail(
      instruction.detail,
      { from, to, amount, asset }
    );
    const [acceptedFeeMinor, acceptedExecutionFeeCeilingMinor] = await Promise.all([
      dependencies.getAcceptedFeeMinor(ctx),
      dependencies.getAcceptedExecutionFeeCeilingMinor(ctx),
    ]);
    if (
      !QUANTITY_PATTERN.test(acceptedFeeMinor) ||
      BigInt(acceptedFeeMinor) !== estimatedTotalFeeWei
    ) {
      throw new Error(
        `The stored EVM total-fee estimate differs from the accepted payment fee.${REQUOTE}`
      );
    }
    if (
      !QUANTITY_PATTERN.test(acceptedExecutionFeeCeilingMinor)
      || BigInt(acceptedExecutionFeeCeilingMinor) !== gas * maxFeePerGas
    ) {
      throw new Error(
        `The stored EVM L2 execution fee ceiling differs from the accepted payment fee.${REQUOTE}`,
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

    const pendingNonce = await dependencies.getPendingNonce(from);
    if (!Number.isSafeInteger(pendingNonce) || pendingNonce < 0) {
      throw new Error("The Base RPC returned an invalid pending nonce.");
    }

    let nonce: number | null = null;
    let hash: Hex | null = null;
    let signedPersisted = false;
    let submitting = false;
    try {
      // The RPC value is a lower bound. SQLite serializes all CashLoom
      // processes sharing this sovereign database and fills the first locally
      // free nonce at or above it. The transaction commits before vault access.
      nonce = await dependencies.reserveNonce(ctx, from, pendingNonce);
      if (!Number.isSafeInteger(nonce) || nonce < pendingNonce) {
        throw new Error("Durable EVM nonce reservation returned an invalid nonce.");
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
      const evidence = await assertExactSignedEip1559Transaction(
        serializedTransaction,
        from,
        {
          chainId: base.id,
          type: "eip1559",
          to: request.to,
          value: request.value,
          data: request.data,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce,
        },
      );

      // EVM transaction hashes are keccak256(signed serialized bytes), stable
      // before any RPC sees them. Both the nonce record and payment row become
      // reconcilable before the durable "submitting" boundary is crossed.
      hash = evidence.txHash;
      await dependencies.markNonceSigned(ctx, from, nonce, evidence);
      signedPersisted = true;
      hooks?.onSigned?.(hash);
      await dependencies.markNonceSubmitting(ctx, from, nonce, hash);
      submitting = true;

      let submittedHash: Hex;
      try {
        // One attempt only. "submitting" was committed before this call, so a
        // crash or any exception from here is sticky and never auto-released.
        submittedHash = await dependencies.sendRawTransaction(serializedTransaction);
      } catch {
        try {
          await dependencies.markNonceSubmissionUnknown(ctx, from, nonce, hash);
        } catch {
          // "submitting" is already a live, non-reusable state.
        }
        throw new AmbiguousBroadcastError(
          `Signed EVM transaction ${hash} was submitted, but the RPC outcome is unknown. Do not retry; reconcile this hash on Base.`,
          hash,
        );
      }
      if (!HASH_PATTERN.test(submittedHash) || !sameHex(submittedHash, hash)) {
        try {
          await dependencies.markNonceSubmissionUnknown(ctx, from, nonce, hash);
        } catch {
          // "submitting" is already a live, non-reusable state.
        }
        throw new AmbiguousBroadcastError(
          `The Base RPC did not acknowledge signed EVM transaction ${hash} consistently. Do not retry; reconcile this hash on Base.`,
          hash,
        );
      }

      try {
        await dependencies.markNonceSubmitted(ctx, from, nonce, hash);
      } catch {
        try {
          await dependencies.markNonceSubmissionUnknown(ctx, from, nonce, hash);
        } catch {
          // A submitted/submitting reservation is already non-reusable.
        }
        throw new AmbiguousBroadcastError(
          `Base acknowledged signed EVM transaction ${hash}, but CashLoom could not persist the submitted nonce state. Do not retry; reconcile this hash on Base.`,
          hash,
        );
      }

      return { externalId: hash, status: "broadcast" };
    } catch (error) {
      if (!submitting && nonce !== null && !signedPersisted) {
        try {
          await dependencies.releaseNoncePreSubmit(ctx, from, nonce);
        } catch (releaseError) {
          const reason =
            releaseError instanceof Error ? releaseError.message : "unknown release error";
          throw new Error(
            `EVM dispatch never began, but nonce ${nonce} could not be released safely: ${reason}`,
            { cause: error },
          );
        }
      }
      if (!submitting && signedPersisted && hash !== null) {
        throw new AmbiguousBroadcastError(
          `Signed EVM transaction ${hash} is durably reserved, but raw submission did not begin. Do not retry automatically; inspect the local signed record before any manual recovery.`,
          hash,
        );
      }
      throw error;
    }
  },
});

export const evmSender: PaymentSender = createEvmSender(defaultDependencies);
