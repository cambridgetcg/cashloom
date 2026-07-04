/** EVM sender — Base mainnet. USDC (the spec's chosen cheap stablecoin rail)
 *  and native ETH. Signs locally with a vault key; broadcasts the SIGNED
 *  transaction through a public RPC — the private key never touches the
 *  network (PROTOCOL.md §5.2). Pass-through fees only: the network's gas,
 *  nothing else.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { revealForSigning } from "../vault.ts";
import type {
  PaymentInstruction,
  PaymentQuote,
  PaymentReceipt,
  PaymentSender,
  SenderContext,
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
  // The throw above proves the narrowing, but TS cannot narrow a plain string
  // by !== literal checks — assert what was just verified.
  return { to: instruction.to as `0x${string}`, amount, asset: asset as "ETH" | "USDC" };
};

/** The transaction request shared by quote (estimate) and send (submit) —
 *  built ONCE so what was disclosed is exactly what is signed. */
const buildRequest = (to: `0x${string}`, amount: bigint, asset: "ETH" | "USDC") =>
  asset === "ETH"
    ? { to, value: amount, data: undefined as `0x${string}` | undefined }
    : {
        to: USDC_ADDRESS as `0x${string}`,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [to, amount],
        }),
      };

export const evmSender: PaymentSender = {
  type: "evm-base",
  assets: ["ETH", "USDC"],

  async quote(ctx: SenderContext, instruction: PaymentInstruction): Promise<PaymentQuote> {
    const { to, amount, asset } = parseInstruction(instruction);
    const client = publicClient();

    // The vault key's public address is all quoting needs — reveal nothing.
    const from = await senderAddress(ctx);
    const request = buildRequest(to, amount, asset);

    const [gas, fees] = await Promise.all([
      client.estimateGas({ account: from, ...request }),
      client.estimateFeesPerGas(),
    ]);
    // Disclose the UPPER BOUND (gas × maxFeePerGas); the chain will charge
    // less. Never understate a fee to a confirm screen.
    const feeWei = gas * fees.maxFeePerGas;
    const amountHuman =
      asset === "USDC"
        ? `${Number(amount) / 10 ** USDC_DECIMALS} USDC`
        : `${amount} wei`;
    return {
      feeMinor: feeWei.toString(),
      feeAsset: "ETH(wei)",
      summary: `Send ${amountHuman} on Base to ${to} — network fee at most ${feeWei} wei (~${Number(feeWei) / 1e18} ETH). No CashLoom fee, ever.`,
    };
  },

  async send(ctx: SenderContext, instruction: PaymentInstruction): Promise<PaymentReceipt> {
    const { to, amount, asset } = parseInstruction(instruction);
    // Reveal lives for exactly this scope: derive the signer, sign, done.
    // (The vault reveals evm-kind keys as 0x-hex — asserted, not re-checked.)
    const account = privateKeyToAccount((await revealForSigning(ctx.vaultKeyId)) as `0x${string}`);
    const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl()) });
    const request = buildRequest(to, amount, asset);
    const hash = await wallet.sendTransaction({
      to: request.to,
      value: request.value,
      data: request.data,
    });
    return { externalId: hash, status: "broadcast" };
  },
};

const senderAddress = async (ctx: SenderContext): Promise<`0x${string}`> => {
  // Address is derivable public data; stored on the vault row at creation.
  const { db } = await import("../db.ts");
  const row = db
    .query("SELECT address FROM vault_keys WHERE id = ? AND kind = 'evm'")
    .get(ctx.vaultKeyId) as { address: string | null } | null;
  if (!row?.address) throw new Error(`No EVM vault key ${ctx.vaultKeyId}`);
  return row.address as `0x${string}`;
};
