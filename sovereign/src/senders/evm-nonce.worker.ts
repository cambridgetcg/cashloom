/**
 * Test-only process boundary for exercising SQLite nonce coordination.
 * No RPC, vault, or signing code is loaded.
 */

export {};

const [paymentId, pendingRaw, fromAddress, chainRaw] = process.argv.slice(2);
if (!paymentId || !pendingRaw || !fromAddress || !chainRaw) {
  throw new Error("Expected payment id, pending nonce, sender address, and chain id.");
}

const { reserveEvmNonce } = await import("./evm-nonce.ts");
const nonce = reserveEvmNonce({
  paymentId,
  pendingNonce: Number(pendingRaw),
  fromAddress,
  chainId: Number(chainRaw),
});

process.stdout.write(JSON.stringify({ paymentId, nonce }));
