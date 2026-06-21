import { Router, Request, Response } from "express";
import { getWallet, createWallet, setHandle, getBalances, getWalletByHandle } from "../services/wallet.service";
import { Env } from "../config/env.config";

const router = Router();

// All wallet routes require auth (middleware added in app setup)

/**
 * GET /wallet — get the current user's wallet
 * Creates one automatically if it doesn't exist yet (lazy wallet creation)
 */
export async function getWalletController(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  let wallet = await getWallet(userId);

  // Lazy wallet creation — every user gets a wallet on first request
  if (!wallet) {
    const userCurrency = (req.user as any)?.currency || "USD";
    wallet = await createWallet(userId, userCurrency, Env.JWT_SECRET);
  }

  res.status(200).json({
    did: wallet.did,
    address: wallet.address,
    handle: wallet.handle,
    status: wallet.status,
    balances: {
      fiat: {
        amount: wallet.fiatBalance,
        currency: wallet.fiatCurrency,
        updatedAt: wallet.fiatBalanceUpdatedAt,
      },
      onChain: {
        amount: wallet.onChainBalance,
        unit: "ulgm",
        updatedAt: wallet.onChainBalanceUpdatedAt,
      },
    },
  });
}

/**
 * GET /wallet/balances — get both fiat and on-chain balances
 */
export async function getBalancesController(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const balances = await getBalances(userId);
  if (!balances) {
    res.status(404).json({ message: "Wallet not found" });
    return;
  }

  res.status(200).json(balances);
}

/**
 * POST /wallet/handle — set a payment handle
 * Body: { handle: "yu" } — 3-20 chars, lowercase letters, digits, underscores
 */
export async function setHandleController(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const { handle } = req.body;
  if (!handle || typeof handle !== "string") {
    res.status(400).json({ message: "Handle is required" });
    return;
  }

  if (!/^[a-z0-9_]{3,20}$/.test(handle.toLowerCase())) {
    res.status(400).json({
      message: "Handle must be 3-20 characters: lowercase letters, digits, underscores",
    });
    return;
  }

  try {
    const wallet = await setHandle(userId, handle);
    res.status(200).json({
      handle: wallet?.handle,
      did: wallet?.did,
      address: wallet?.address,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
}

/**
 * GET /wallet/resolve/:handle — resolve a handle to a wallet address
 * Used for P2P payments: "send to @yu" -> resolve handle -> get address
 */
export async function resolveHandleController(req: Request, res: Response): Promise<void> {
  const { handle } = req.params;
  const wallet = await getWalletByHandle(handle);

  if (!wallet) {
    res.status(404).json({ message: "Handle not found" });
    return;
  }

  res.status(200).json({
    handle: wallet.handle,
    did: wallet.did,
    address: wallet.address,
  });
}

router.get("/", getWalletController);
router.get("/balances", getBalancesController);
router.post("/handle", setHandleController);
router.get("/resolve/:handle", resolveHandleController);

export default router;