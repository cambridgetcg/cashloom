# CashLoom Pay Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the non-custodial outbound payment foundation to CashLoom — a `PaymentSender` seam parallel to the read-only `RailConnector`, local encrypted key custody, a rail-agnostic `Payment` record, a `pay()` primitive, and a `POST /pay` route — proven end-to-end with an in-memory sender (no real money moved yet).

**Architecture:** A new `PaymentSender` interface (outbound) sits alongside the untouched read-only `RailConnector`. A sender registry (mirroring the connector registry) maps `Account.connectorType` → sender. `pay()` resolves the owner-scoped from-Account, records a PENDING `Payment`, calls the sender, and settles to COMPLETED/FAILED with the rail's externalId + fee. Crypto private keys are encrypted locally with scrypt-derived AES-256-GCM; the blob (salt+iv+ciphertext+tag) lives in a local keystore, never the repo. A dedicated `Payment` model carries BigInt-exact `amountMinor` strings (the existing `Transaction.amount` is a fiat-cents `Number` — unusable for 8/18-decimal crypto).

**Tech Stack:** Bun, TypeScript, Express 5, MongoDB/Mongoose 8, Zod, Vitest (+ mongodb-memory-server for integration tests), `node:crypto` (scrypt + AES-256-GCM — built-in, no new dependency).

## Global Constraints

- **Non-custodial.** CashLoom holds no funds and collects no information. Never log secrets, passphrases, private keys, or PII. Credentials are env-var pointers (fiat) or local encrypted blobs (crypto); private keys never leave the machine.
- **Read-only `RailConnector` stays untouched.** Outbound movement lives only behind the new `PaymentSender` seam — do not add `send()` to `RailConnector`.
- **BigInt-exact minor-unit strings** for all money amounts (`amountMinor`, `feeMinor`) — never a JS `Number` for crypto-scale values.
- **Owner-scoped.** Every from-Account lookup is scoped by `{ _id, userId }` (no IDOR — a guessed id can't pay from another user's account).
- **Follow existing patterns:** `asyncHandler` + zod `.parse`, `HTTPSTATUS`, exceptions from `../utils/app-error` (`NotFoundException`/`BadRequestException`/`InternalServerException`), Mongoose models with `timestamps`, the connector-registry shape for the sender registry, MongoMemoryServer integration tests mirroring `account.model.integration.test.ts`.
- **TDD + frequent commits.** Each task: failing test → fail → implement → pass → commit. Commit to `main`.
- **Typecheck clean:** `cd backend && bun run typecheck` must pass after every task.

---

## File Structure

**Create:**
- `backend/src/senders/types.ts` — `PaymentSender` seam interfaces (SendStatus, PaymentInstruction, PaymentReceipt, PaymentSender).
- `backend/src/senders/types.test.ts` — seam shape contract.
- `backend/src/senders/memory.sender.ts` — deterministic in-memory sender (tests/dev only).
- `backend/src/senders/memory.sender.test.ts`
- `backend/src/senders/index.ts` — sender registry (`registerSender`/`getSender`), mirrors `connectors/index.ts`.
- `backend/src/senders/index.test.ts`
- `backend/src/credentials/key-vault.ts` — scrypt + AES-256-GCM encrypt/decrypt.
- `backend/src/credentials/key-vault.test.ts`
- `backend/src/credentials/keystore.ts` — local file store of encrypted blobs (default `~/.cashloom/keystore/`).
- `backend/src/credentials/keystore.test.ts`
- `backend/src/models/payment.model.ts` — BigInt-exact `Payment` record + dedupe index.
- `backend/src/models/payment.model.integration.test.ts`
- `backend/src/services/pay.service.ts` — the `pay()` primitive.
- `backend/src/services/pay.service.integration.test.ts`
- `backend/src/validators/pay.validator.ts`
- `backend/src/controllers/pay.controller.ts`
- `backend/src/routes/pay.route.ts`
- `backend/src/routes/pay.route.test.ts`

**Modify:**
- `backend/src/index.ts` — register the `pay` route behind `passportAuthenticateJwt`.

---

### Task 1: PaymentSender seam (types)

**Files:**
- Create: `backend/src/senders/types.ts`
- Create: `backend/src/senders/types.test.ts`

**Interfaces:**
- Consumes: `ConnectorContext` from `../connectors/types` (reused — `{ credentialRef?, externalAccountId }`).
- Produces: `SendStatus`, `PaymentInstruction`, `PaymentReceipt`, `PaymentSender` (used by every later task).

- [ ] **Step 1: Write the failing test**

`backend/src/senders/types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { PaymentSender, PaymentInstruction, PaymentReceipt } from "./types";
import { SendStatus } from "./types";

describe("PaymentSender seam shape", () => {
  it("a conforming sender has a type and an async send returning a receipt", async () => {
    const sender: PaymentSender = {
      type: "stub",
      async send(_ctx, instruction: PaymentInstruction): Promise<PaymentReceipt> {
        return { externalId: "x", feeMinor: "0", status: SendStatus.COMPLETED };
      },
    };
    const receipt = await sender.send(
      { externalAccountId: "a", credentialRef: null },
      { to: "b", amountMinor: "100", asset: "BTC" }
    );
    expect(receipt.status).toBe(SendStatus.COMPLETED);
    expect(receipt.externalId).toBe("x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bunx vitest run src/senders/types.test.ts`
Expected: FAIL — "Cannot find module './types'".

- [ ] **Step 3: Write minimal implementation**

`backend/src/senders/types.ts`:
```ts
// The outbound seam — parallel to the read-only RailConnector. Nothing here
// reads balances; everything here moves money on explicit user intent. A
// read-only connector must NEVER implement this interface.
import { ConnectorContext } from "../connectors/types";

export enum SendStatus {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

// amountMinor is a SIGNED integer minor-unit string (no floats — crypto needs
// 18-decimal precision). asset is the on-rail symbol ("BTC", "USDC", "USD").
export interface PaymentInstruction {
  to: string;
  amountMinor: string;
  asset: string;
}

// externalId is the rail's own stable id (on-chain txhash, Stripe transfer id) —
// the dedupe key. feeMinor is the rail's pass-through fee in the same minor
// units; CashLoom adds none.
export interface PaymentReceipt {
  externalId: string;
  feeMinor: string;
  status: keyof typeof SendStatus;
}

export interface PaymentSender {
  type: string;
  send(ctx: ConnectorContext, instruction: PaymentInstruction): Promise<PaymentReceipt>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bunx vitest run src/senders/types.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
cd backend && git add src/senders/types.ts src/senders/types.test.ts
git commit -m "feat(pay): PaymentSender outbound seam + contract test"
```

---

### Task 2: In-memory sender (test/dev rail)

**Files:**
- Create: `backend/src/senders/memory.sender.ts`
- Create: `backend/src/senders/memory.sender.test.ts`

**Interfaces:**
- Consumes: `PaymentSender`, `SendStatus`, `PaymentInstruction`, `PaymentReceipt` (Task 1).
- Produces: `createMemorySender()` → `PaymentSender` (registered as `"memory"` in Task 3; used by `pay()` tests in Task 7).

- [ ] **Step 1: Write the failing test**

`backend/src/senders/memory.sender.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createMemorySender } from "./memory.sender";
import { SendStatus } from "./types";

describe("memory sender", () => {
  it("returns a COMPLETED receipt with a unique mem_ id and zero fee", async () => {
    const s = createMemorySender();
    const r = await s.send(
      { externalAccountId: "a", credentialRef: null },
      { to: "b", amountMinor: "100", asset: "BTC" }
    );
    expect(r.status).toBe(SendStatus.COMPLETED);
    expect(r.feeMinor).toBe("0");
    expect(r.externalId).toMatch(/^mem_/);
  });

  it("returns a different externalId per send", async () => {
    const s = createMemorySender();
    const a = await s.send({ externalAccountId: "a", credentialRef: null }, { to: "b", amountMinor: "1", asset: "BTC" });
    const b = await s.send({ externalAccountId: "a", credentialRef: null }, { to: "b", amountMinor: "1", asset: "BTC" });
    expect(a.externalId).not.toBe(b.externalId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bunx vitest run src/senders/memory.sender.test.ts`
Expected: FAIL — "Cannot find module './memory.sender'".

- [ ] **Step 3: Write minimal implementation**

`backend/src/senders/memory.sender.ts`:
```ts
// A deterministic in-rail sender for tests + local dev. It moves NO money; it
// returns a unique receipt. Never used for a real rail — only reached when an
// Account's connectorType is "memory".
import { ConnectorContext } from "../connectors/types";
import { PaymentSender, PaymentInstruction, PaymentReceipt, SendStatus } from "./types";

let nonce = 0;
const nextId = (): string => {
  nonce += 1;
  return `mem_${Date.now().toString(36)}_${nonce}`;
};

export const createMemorySender = (): PaymentSender => ({
  type: "memory",
  async send(_ctx: ConnectorContext, _instruction: PaymentInstruction): Promise<PaymentReceipt> {
    return { externalId: nextId(), feeMinor: "0", status: SendStatus.COMPLETED };
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bunx vitest run src/senders/memory.sender.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd backend && git add src/senders/memory.sender.ts src/senders/memory.sender.test.ts
git commit -m "feat(pay): in-memory test sender"
```

---

### Task 3: Sender registry

**Files:**
- Create: `backend/src/senders/index.ts`
- Create: `backend/src/senders/index.test.ts`

**Interfaces:**
- Consumes: `PaymentSender` (Task 1), `createMemorySender` (Task 2).
- Produces: `registerSender(type, impl)`, `getSender(type)` → `PaymentSender` (used by `pay()` in Task 7).

- [ ] **Step 1: Write the failing test**

`backend/src/senders/index.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { getSender, registerSender } from "./index";
import { PaymentSender, SendStatus } from "./types";

describe("sender registry", () => {
  it("returns the registered memory sender", () => {
    expect(getSender("memory").type).toBe("memory");
  });

  it("throws BadRequest for an unknown type", () => {
    expect(() => getSender("nope-not-registered")).toThrow(/Unknown payment sender/);
  });

  it("lets a test override/register a type", () => {
    const fake: PaymentSender = {
      type: "fake",
      async send() {
        return { externalId: "f", feeMinor: "0", status: SendStatus.COMPLETED };
      },
    };
    registerSender("override-me", fake);
    expect(getSender("override-me")).toBe(fake);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bunx vitest run src/senders/index.test.ts`
Expected: FAIL — "Cannot find module './index'".

- [ ] **Step 3: Write minimal implementation**

`backend/src/senders/index.ts`:
```ts
// The sender registry: Account.connectorType -> PaymentSender. Mirrors the
// read-only connector registry. Additive so a test can override a type without
// touching built-ins.
import { BadRequestException } from "../utils/app-error";
import { PaymentSender } from "./types";
import { createMemorySender } from "./memory.sender";

const registry = new Map<string, () => PaymentSender>();

export const registerSender = (
  type: string,
  impl: PaymentSender | (() => PaymentSender)
): void => {
  registry.set(type, typeof impl === "function" ? (impl as () => PaymentSender) : () => impl);
};

export const getSender = (type: string): PaymentSender => {
  const factory = registry.get(type);
  if (!factory) {
    throw new BadRequestException(
      `Unknown payment sender "${type}": no sender is registered for it`
    );
  }
  return factory();
};

registerSender("memory", createMemorySender);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bunx vitest run src/senders/index.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd backend && git add src/senders/index.ts src/senders/index.test.ts
git commit -m "feat(pay): sender registry (mirrors connector registry)"
```

---

### Task 4: Local encrypted key vault (scrypt + AES-256-GCM)

**Files:**
- Create: `backend/src/credentials/key-vault.ts`
- Create: `backend/src/credentials/key-vault.test.ts`

**Interfaces:**
- Consumes: `node:crypto` (built-in).
- Produces: `EncryptedBlob`, `encryptKey(passphrase, plaintext)`, `decryptKey(passphrase, blob)` (used by the keystore in Task 5 and the real crypto senders in later plans).

- [ ] **Step 1: Write the failing test**

`backend/src/credentials/key-vault.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { encryptKey, decryptKey } from "./key-vault";

describe("key vault", () => {
  it("round-trips a private key through encrypt then decrypt", () => {
    const secret = Buffer.from(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "hex"
    );
    const blob = encryptKey("correct horse battery staple", secret);
    const back = decryptKey("correct horse battery staple", blob);
    expect(back.equals(secret)).toBe(true);
  });

  it("refuses the wrong passphrase", () => {
    const blob = encryptKey("right", Buffer.from("deadbeef", "hex"));
    expect(() => decryptKey("wrong", blob)).toThrow(/Could not decrypt key/);
  });

  it("stores no plaintext in the serialized blob", () => {
    const secret = Buffer.from("supersecret-private-key-material", "utf8");
    const blob = encryptKey("pw", secret);
    expect(JSON.stringify(blob)).not.toContain("supersecret-private-key-material");
  });

  it("uses a fresh salt + iv per encryption (same passphrase, different blobs)", () => {
    const a = encryptKey("pw", Buffer.from([1, 2, 3]));
    const b = encryptKey("pw", Buffer.from([1, 2, 3]));
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bunx vitest run src/credentials/key-vault.test.ts`
Expected: FAIL — "Cannot find module './key-vault'".

- [ ] **Step 3: Write minimal implementation**

`backend/src/credentials/key-vault.ts`:
```ts
// Local non-custodial key custody. A crypto private key is encrypted with a key
// derived from the user's passphrase (scrypt, memory-hard) via AES-256-GCM
// (authenticated: a wrong passphrase fails the GCM tag, never silently). The
// blob carries salt + iv + ciphertext + tag — never the passphrase, never the
// plaintext. Keys never leave the machine; this module never logs.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "crypto";
import { BadRequestException } from "../utils/app-error";

const KEY_LEN = 32; // 256-bit AES key
const SCRYPT_N = 16384; // ~0.2s on a laptop; memory-hard
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_LEN = 16;
const IV_LEN = 12; // GCM nonce

export interface EncryptedBlob {
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
  tag: string; // base64 (GCM auth tag)
  v: 1; // format version
}

const b64 = (b: Buffer): string => b.toString("base64");
const fromB64 = (s: string): Buffer => Buffer.from(s, "base64");

const deriveKey = (passphrase: string, salt: Buffer): Buffer =>
  scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });

export const encryptKey = (passphrase: string, plaintext: Buffer): EncryptedBlob => {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext), tag: b64(tag), v: 1 };
};

export const decryptKey = (passphrase: string, blob: EncryptedBlob): Buffer => {
  if (blob.v !== 1) throw new BadRequestException("Unknown key blob version");
  const salt = fromB64(blob.salt);
  const key = deriveKey(passphrase, salt);
  const iv = fromB64(blob.iv);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(fromB64(blob.tag));
  try {
    return Buffer.concat([
      decipher.update(fromB64(blob.ciphertext)),
      decipher.final(),
    ]);
  } catch {
    // GCM auth-tag mismatch = wrong passphrase or a tampered blob. Never say
    // which; never log the passphrase or blob.
    throw new BadRequestException(
      "Could not decrypt key — wrong passphrase or corrupted blob"
    );
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bunx vitest run src/credentials/key-vault.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd backend && git add src/credentials/key-vault.ts src/credentials/key-vault.test.ts
git commit -m "feat(pay): local encrypted key vault (scrypt + AES-256-GCM)"
```

---

### Task 5: Local keystore (file-backed, never in the repo)

**Files:**
- Create: `backend/src/credentials/keystore.ts`
- Create: `backend/src/credentials/keystore.test.ts`

**Interfaces:**
- Consumes: `EncryptedBlob` (Task 4), `node:fs`, `node:path`, `node:os`.
- Produces: `KeyStore` interface, `createKeystore(dir)`, `defaultKeystore()` (used by the real crypto senders in later plans; here, tested in isolation).

- [ ] **Step 1: Write the failing test**

`backend/src/credentials/keystore.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { createKeystore } from "./keystore";
import { encryptKey } from "./key-vault";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cashloom-keystore-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("keystore", () => {
  it("saves and loads an encrypted blob by account id", async () => {
    const ks = createKeystore(dir);
    const blob = encryptKey("pw", Buffer.from("key", "utf8"));
    await ks.save("acct_123", blob);
    const back = await ks.load("acct_123");
    expect(back).not.toBeNull();
    expect(back!.ciphertext).toBe(blob.ciphertext);
  });

  it("returns null for a missing account", async () => {
    const ks = createKeystore(dir);
    expect(await ks.load("nope")).toBeNull();
  });

  it("lists saved account ids", async () => {
    const ks = createKeystore(dir);
    await ks.save("acct_a", encryptKey("pw", Buffer.from([1])));
    await ks.save("acct_b", encryptKey("pw", Buffer.from([2])));
    expect((await ks.list()).sort()).toEqual(["acct_a", "acct_b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bunx vitest run src/credentials/keystore.test.ts`
Expected: FAIL — "Cannot find module './keystore'".

- [ ] **Step 3: Write minimal implementation**

`backend/src/credentials/keystore.ts`:
```ts
// Where encrypted key blobs live: on the user's machine, never in the repo.
// Default ~/.cashloom/keystore (home — local, never committed); override with
// CASHLOOM_KEYSTORE_DIR for tests/custom locations.
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { EncryptedBlob } from "./key-vault";

const defaultDir = (): string =>
  process.env.CASHLOOM_KEYSTORE_DIR ??
  path.join(os.homedir(), ".cashloom", "keystore");

export interface KeyStore {
  save(accountId: string, blob: EncryptedBlob): Promise<void>;
  load(accountId: string): Promise<EncryptedBlob | null>;
  list(): Promise<string[]>;
}

export const createKeystore = (dir: string): KeyStore => {
  const fileFor = (accountId: string): string => path.join(dir, `${accountId}.json`);
  return {
    async save(accountId, blob) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fileFor(accountId), JSON.stringify(blob), { mode: 0o600 });
    },
    async load(accountId) {
      try {
        return JSON.parse(await fs.readFile(fileFor(accountId), "utf8")) as EncryptedBlob;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async list() {
      try {
        const entries = await fs.readdir(dir);
        return entries.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },
  };
};

export const defaultKeystore = (): KeyStore => createKeystore(defaultDir());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bunx vitest run src/credentials/keystore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd backend && git add src/credentials/keystore.ts src/credentials/keystore.test.ts
git commit -m "feat(pay): local file keystore for encrypted key blobs"
```

---

### Task 6: Payment model (rail-agnostic, BigInt-exact)

**Files:**
- Create: `backend/src/models/payment.model.ts`
- Create: `backend/src/models/payment.model.integration.test.ts`

**Interfaces:**
- Consumes: Mongoose.
- Produces: `PaymentModel`, `PaymentStatusEnum`, `PaymentDocument` (used by `pay()` in Task 7).

- [ ] **Step 1: Write the failing test**

`backend/src/models/payment.model.integration.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import PaymentModel, { PaymentStatusEnum } from "./payment.model";

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await PaymentModel.init();
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
beforeEach(async () => {
  await PaymentModel.deleteMany({});
});

describe("Payment model", () => {
  it("stores an 18-decimal amountMinor as an exact string", async () => {
    const wei = "1234567890123456789";
    const p = await PaymentModel.create({
      userId: new mongoose.Types.ObjectId(),
      fromAccountId: new mongoose.Types.ObjectId(),
      rail: "eth",
      asset: "ETH",
      amountMinor: wei,
      decimals: 18,
      to: "0xabc",
      feeMinor: "0",
      status: PaymentStatusEnum.PENDING,
    });
    expect(p.amountMinor).toBe(wei);
    const raw = await PaymentModel.collection.findOne({ _id: p._id });
    expect(raw?.amountMinor).toBe(wei);
  });

  it("defaults status to PENDING and feeMinor to '0'", async () => {
    const p = await PaymentModel.create({
      userId: new mongoose.Types.ObjectId(),
      fromAccountId: new mongoose.Types.ObjectId(),
      rail: "btc",
      asset: "BTC",
      amountMinor: "1000",
      decimals: 8,
      to: "addr",
    });
    expect(p.status).toBe(PaymentStatusEnum.PENDING);
    expect(p.feeMinor).toBe("0");
  });

  it("rejects a duplicate (user, fromAccount, externalId)", async () => {
    const userId = new mongoose.Types.ObjectId();
    const from = new mongoose.Types.ObjectId();
    const base = { userId, fromAccountId: from, rail: "btc", asset: "BTC", amountMinor: "1000", decimals: 8, to: "addr" };
    await PaymentModel.create({ ...base, externalId: "tx_1", status: PaymentStatusEnum.COMPLETED });
    await expect(
      PaymentModel.create({ ...base, externalId: "tx_1", status: PaymentStatusEnum.COMPLETED })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bunx vitest run src/models/payment.model.integration.test.ts`
Expected: FAIL — "Cannot find module './payment.model'".

- [ ] **Step 3: Write minimal implementation**

`backend/src/models/payment.model.ts`:
```ts
// A Payment is one outbound move: from one Account, over one rail, to one
// destination. amountMinor + feeMinor are integer MINOR-unit STRINGS (BigInt-
// exact, like Account.balanceMinor) so an 18-decimal wei send never touches a
// float. externalId is the rail's own tx id — the dedupe key.
import mongoose, { Schema, Document } from "mongoose";

export enum PaymentStatusEnum {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

export interface PaymentDocument extends Document {
  userId: mongoose.Types.ObjectId;
  fromAccountId: mongoose.Types.ObjectId;
  rail: string;
  asset: string;
  amountMinor: string;
  decimals: number;
  to: string;
  externalId?: string;
  feeMinor: string;
  status: keyof typeof PaymentStatusEnum;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<PaymentDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },
    fromAccountId: { type: Schema.Types.ObjectId, required: true, ref: "Account" },
    rail: { type: String, required: true },
    asset: { type: String, required: true, uppercase: true, trim: true },
    amountMinor: { type: String, required: true },
    decimals: { type: Number, required: true, min: 0, max: 30 },
    to: { type: String, required: true },
    externalId: { type: String, default: null },
    feeMinor: { type: String, required: true, default: "0" },
    status: {
      type: String,
      enum: Object.values(PaymentStatusEnum),
      required: true,
      default: PaymentStatusEnum.PENDING,
    },
  },
  { timestamps: true }
);

// Re-broadcasting the same rail tx (same externalId) must not double-record.
paymentSchema.index(
  { userId: 1, fromAccountId: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: "string" } } }
);

const PaymentModel = mongoose.model<PaymentDocument>("Payment", paymentSchema);
export default PaymentModel;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bunx vitest run src/models/payment.model.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd backend && git add src/models/payment.model.ts src/models/payment.model.integration.test.ts
git commit -m "feat(pay): rail-agnostic Payment model (BigInt-exact + dedupe index)"
```

---

### Task 7: The `pay()` primitive

**Files:**
- Create: `backend/src/services/pay.service.ts`
- Create: `backend/src/services/pay.service.integration.test.ts`

**Interfaces:**
- Consumes: `getAccountByIdService(userId, accountId)` from `./account.service` (owner-scoped, throws `NotFoundException`); `getSender(type)` from `../senders` (Task 3); `PaymentModel`/`PaymentStatusEnum` (Task 6); `ConnectorContext` from `../connectors/types`.
- Produces: `payService(userId, PayInput): Promise<PayResult>` (used by the controller in Task 8).

- [ ] **Step 1: Write the failing test**

`backend/src/services/pay.service.integration.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import AccountModel, { RailEnum } from "../models/account.model";
import PaymentModel, { PaymentStatusEnum } from "../models/payment.model";
import { payService } from "./pay.service";
import { registerSender } from "../senders";
import { PaymentSender, SendStatus } from "../senders/types";

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await AccountModel.init();
  await PaymentModel.init();
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
beforeEach(async () => {
  await AccountModel.deleteMany({});
  await PaymentModel.deleteMany({});
});

const makeAccount = async (connectorType = "memory") => {
  const userId = new mongoose.Types.ObjectId();
  const acc = await AccountModel.create({
    userId,
    rail: RailEnum.CRYPTO,
    connectorType,
    displayName: "Hot",
    currency: "BTC",
    decimals: 8,
  });
  return { userId, acc };
};

describe("payService", () => {
  it("records PENDING then settles COMPLETED with the rail externalId", async () => {
    const { userId, acc } = await makeAccount();
    const result = await payService(String(userId), {
      fromAccountId: String(acc._id),
      to: "bc1q...",
      amountMinor: "5000",
      asset: "BTC",
    });
    expect(result.status).toBe(PaymentStatusEnum.COMPLETED);
    expect(result.externalId).toMatch(/^mem_/);
    const p = await PaymentModel.findById(result.paymentId);
    expect(p?.status).toBe(PaymentStatusEnum.COMPLETED);
    expect(p?.externalId).toBe(result.externalId);
  });

  it("settles FAILED and rethrows when the sender throws", async () => {
    const boom: PaymentSender = {
      type: "boom",
      async send() {
        throw new Error("rail down");
      },
    };
    registerSender("boom", boom);
    const { userId, acc } = await makeAccount("boom");
    await expect(
      payService(String(userId), {
        fromAccountId: String(acc._id),
        to: "x",
        amountMinor: "1",
        asset: "BTC",
      })
    ).rejects.toThrow(/rail down/);
    const p = await PaymentModel.findOne({ fromAccountId: acc._id });
    expect(p?.status).toBe(PaymentStatusEnum.FAILED);
  });

  it("refuses to pay from another user's account (no IDOR)", async () => {
    const { acc } = await makeAccount();
    const other = new mongoose.Types.ObjectId();
    await expect(
      payService(String(other), {
        fromAccountId: String(acc._id),
        to: "x",
        amountMinor: "1",
        asset: "BTC",
      })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bunx vitest run src/services/pay.service.integration.test.ts`
Expected: FAIL — "Cannot find module './pay.service'".

- [ ] **Step 3: Write minimal implementation**

`backend/src/services/pay.service.ts`:
```ts
// The universal primitive. Resolves the owner-scoped from-Account, picks the
// PaymentSender for its connectorType, records a PENDING Payment, calls send,
// and settles to COMPLETED/FAILED with the rail's externalId + fee. CashLoom
// holds no funds and collects no info; the credential is resolved inside the
// sender (env pointer for fiat, local encrypted key for crypto), never here.
import { ConnectorContext } from "../connectors/types";
import { getAccountByIdService } from "./account.service";
import PaymentModel, { PaymentStatusEnum } from "../models/payment.model";
import { getSender } from "../senders";
import { PaymentReceipt } from "../senders/types";

export interface PayInput {
  fromAccountId: string;
  to: string;
  amountMinor: string;
  asset: string;
}

export interface PayResult {
  paymentId: string;
  status: keyof typeof PaymentStatusEnum;
  externalId?: string;
  feeMinor: string;
}

export const payService = async (userId: string, input: PayInput): Promise<PayResult> => {
  const account = await getAccountByIdService(userId, input.fromAccountId); // NotFoundException if not owned
  const senderType = account.connectorType ?? account.rail;
  const sender = getSender(senderType);
  const ctx: ConnectorContext = {
    externalAccountId: account.externalAccountId ?? "",
    credentialRef: account.credentialRef ?? null,
  };

  const payment = await PaymentModel.create({
    userId: account.userId,
    fromAccountId: account._id,
    rail: senderType,
    asset: input.asset,
    amountMinor: input.amountMinor,
    decimals: account.decimals,
    to: input.to,
    feeMinor: "0",
    status: PaymentStatusEnum.PENDING,
  });

  try {
    const receipt: PaymentReceipt = await sender.send(ctx, {
      to: input.to,
      amountMinor: input.amountMinor,
      asset: input.asset,
    });
    payment.set({
      externalId: receipt.externalId,
      feeMinor: receipt.feeMinor,
      status: receipt.status,
    });
    await payment.save();
    return {
      paymentId: String(payment._id),
      status: receipt.status,
      externalId: receipt.externalId,
      feeMinor: receipt.feeMinor,
    };
  } catch (err) {
    payment.set({ status: PaymentStatusEnum.FAILED });
    await payment.save();
    throw err;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bunx vitest run src/services/pay.service.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd backend && git add src/services/pay.service.ts src/services/pay.service.integration.test.ts
git commit -m "feat(pay): pay() primitive — PENDING -> send -> settle, owner-scoped"
```

---

### Task 8: POST /pay validator + controller + route

**Files:**
- Create: `backend/src/validators/pay.validator.ts`
- Create: `backend/src/controllers/pay.controller.ts`
- Create: `backend/src/routes/pay.route.ts`
- Create: `backend/src/routes/pay.route.test.ts`

**Interfaces:**
- Consumes: `payService` (Task 7); `asyncHandler`, `HTTPSTATUS`, zod, `express-rate-limit` (existing patterns).
- Produces: `payRoutes` router mounted in Task 9 at `${BASE_PATH}/pay` behind JWT.

- [ ] **Step 1: Write the failing test**

`backend/src/routes/pay.route.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import payRoutes from "./pay.route";

interface RouteHandlerLayer {
  name: string;
  handle: { resetKey?: unknown; getKey?: unknown };
}
interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: RouteHandlerLayer[] };
}
const findRoute = (path: string, method: string) =>
  (payRoutes as unknown as { stack: RouterLayer[] }).stack.find(
    (l) => l.route?.path === path && l.route.methods[method]
  )?.route;
const isRateLimiter = (l: RouteHandlerLayer): boolean =>
  typeof l.handle.resetKey === "function" && typeof l.handle.getKey === "function";

describe("pay route", () => {
  it("POST / runs a per-endpoint rate limiter ahead of the controller", () => {
    const route = findRoute("/", "post");
    expect(route).toBeTruthy();
    expect(route!.stack.length).toBeGreaterThanOrEqual(2);
    expect(isRateLimiter(route!.stack[0])).toBe(true);
    expect(isRateLimiter(route!.stack[route!.stack.length - 1])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bunx vitest run src/routes/pay.route.test.ts`
Expected: FAIL — "Cannot find module './pay.route'".

- [ ] **Step 3: Write minimal implementation**

`backend/src/validators/pay.validator.ts`:
```ts
import { z } from "zod";

export const paySchema = z.object({
  fromAccountId: z.string().trim().min(1, "fromAccountId is required"),
  to: z.string().trim().min(1, "destination is required"),
  amountMinor: z
    .string()
    .trim()
    .regex(/^-?\d+$/, "amountMinor must be an integer minor-unit string"),
  asset: z.string().trim().min(1, "asset is required").max(20),
});

export type PayType = z.infer<typeof paySchema>;
```

`backend/src/controllers/pay.controller.ts`:
```ts
import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { HTTPSTATUS } from "../config/http.config";
import { paySchema } from "../validators/pay.validator";
import { payService } from "../services/pay.service";

export const payController = asyncHandler(async (req: Request, res: Response) => {
  const body = paySchema.parse(req.body);
  const userId = req.user?._id;
  const result = await payService(String(userId), body);
  return res.status(HTTPSTATUS.OK).json({ message: "Payment sent", payment: result });
});
```

`backend/src/routes/pay.route.ts`:
```ts
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { payController } from "../controllers/pay.controller";

const payRoutes = Router();

// Pay moves money / burns rail fees — tighter than the 300/15min global cap so
// a runaway client can't torch fees; generous for honest use.
const payLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many payment attempts — please slow down." },
});

payRoutes.post("/", payLimiter, payController);

export default payRoutes;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bunx vitest run src/routes/pay.route.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
cd backend && git add src/validators/pay.validator.ts src/controllers/pay.controller.ts src/routes/pay.route.ts src/routes/pay.route.test.ts
git commit -m "feat(pay): POST /pay validator + controller + rate-limited route"
```

---

### Task 9: Wire the pay route into the app + full green

**Files:**
- Modify: `backend/src/index.ts` (add import + mount behind `passportAuthenticateJwt`)

**Interfaces:**
- Consumes: `payRoutes` (Task 8), `passportAuthenticateJwt`, `BASE_PATH` (existing).
- Produces: `POST ${BASE_PATH}/pay` reachable behind JWT.

- [ ] **Step 1: Add the import**

In `backend/src/index.ts`, after the `valuationRoutes` import (line 23), add:
```ts
import payRoutes from "./routes/pay.route";
```

- [ ] **Step 2: Mount the route behind JWT**

In `backend/src/index.ts`, after the `valuation` mount (line 85), add:
```ts
// Pay moves money over the outbound PaymentSender seam — JWT-gated, and
// rate-limited at the route (see pay.route) since it burns rail fees.
app.use(`${BASE_PATH}/pay`, passportAuthenticateJwt, payRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `cd backend && bun run typecheck`
Expected: no output (clean) — exit 0.

- [ ] **Step 4: Run the full suite**

Run: `cd backend && bun run test`
Expected: all tests pass, including the new `senders/*`, `credentials/*`, `models/payment.model.integration`, `services/pay.service.integration`, `routes/pay.route` tests. No regressions in the existing suite.

- [ ] **Step 5: Commit**

```bash
cd backend && git add src/index.ts
git commit -m "feat(pay): mount POST /pay behind JWT (Plan 1 foundation wired)"
```

---

## Notes for the implementer

- **Idempotency is deliberately out of scope here.** A double-submit creates two PENDING `Payment`s (no `externalId` yet) and the sender fires twice. The `{userId, fromAccount, externalId}` index dedupes *re-broadcasts of the same rail tx*, not double-submits. A client idempotency key is the fast-follow (ROADMAP #2).
- **The keystore + key vault are introduced + unit-tested here but not yet wired into a sender** — the real BTC/USDC senders (Plans 2–3) load the encrypted blob from the keystore and decrypt with the user's passphrase to sign. No code in Plan 1 reads keys at send time.
- **The in-memory sender is registered as `"memory"`** — a test/dev account sets `connectorType: "memory"`. It is never a real rail.
- **`node:crypto` only** for the vault — no new dependency. `mongodb-memory-server` is already a devDep.