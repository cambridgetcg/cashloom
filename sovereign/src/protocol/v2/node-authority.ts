/**
 * The one local CashLoom v2 protocol authority.
 *
 * This seam owns no HTTP route and accepts no caller-supplied message to sign.
 * It resolves one vault-held Ed25519 key, exposes its self-certifying public
 * authority, and supplies the narrow RecordSigner contract consumed by the
 * closed v2 record constructors.
 */

import type { Database } from "bun:sqlite";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  signatureToBase64Url,
  type RecordSigner,
} from "@agenttool/wallet";
import {
  createSelfCertifyingAuthority,
  type SelfCertifyingAuthority,
} from "./records.ts";

export const CASHLOOM_V2_NODE_AUTHORITY_LABEL =
  "cashloom-v2-node-authority" as const;

interface GeneratedEd25519Key {
  readonly id: string;
  readonly address: string | null;
}

export interface V2NodeAuthorityVault {
  generateEd25519Key(label: string): Promise<GeneratedEd25519Key>;
  revealForSigning(keyId: string): Promise<string>;
}

export interface V2NodeAuthority {
  /** Local vault row id. It is not a protocol identity. */
  readonly vaultKeyId: string;
  /** Self-certifying protocol identity derived from the public key. */
  readonly authority: SelfCertifyingAuthority;
}

export interface V2NodeSigningContext extends V2NodeAuthority {
  /**
   * Internal adapter for signV2Record(). Each call reveals the sealed seed for
   * exactly one 32-byte digest, checks it still matches the public authority,
   * signs, and drops the mutable seed bytes.
   */
  readonly signer: RecordSigner;
}

export interface V2NodeAuthorityProvider {
  ensure(): Promise<V2NodeAuthority>;
  signingContext(): Promise<V2NodeSigningContext>;
}

export interface V2NodeAuthorityDependencies {
  readonly db: Database;
  readonly vault: V2NodeAuthorityVault;
}

interface AuthorityRow {
  id: string;
  address: string | null;
}

const SEED_HEX = /^[0-9a-fA-F]{64}$/u;
const ED25519_DIGEST_BYTES = 32;

function authorityRow(db: Database): AuthorityRow | null {
  const rows = db
    .query(
      `SELECT id, address
       FROM vault_keys
       WHERE label = ? AND kind = 'secret'
       LIMIT 2`,
    )
    .all(CASHLOOM_V2_NODE_AUTHORITY_LABEL) as AuthorityRow[];
  if (rows.length > 1) {
    throw new Error(
      "CashLoom v2 node authority is ambiguous; more than one dedicated vault key exists.",
    );
  }
  return rows[0] ?? null;
}

function resolvedAuthority(row: AuthorityRow): V2NodeAuthority {
  if (
    typeof row.id !== "string"
    || row.id.length === 0
    || typeof row.address !== "string"
    || row.address.length === 0
  ) {
    throw new Error(
      "CashLoom v2 node authority exists but has no usable public key.",
    );
  }
  return Object.freeze({
    vaultKeyId: row.id,
    authority: createSelfCertifyingAuthority(row.address),
  });
}

function seedFromHex(value: string): Uint8Array {
  if (!SEED_HEX.test(value)) {
    throw new Error(
      "CashLoom v2 node authority key material is not a valid Ed25519 seed.",
    );
  }
  const seed = new Uint8Array(32);
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return seed;
}

function vaultSigner(
  node: V2NodeAuthority,
  vault: V2NodeAuthorityVault,
): RecordSigner {
  return Object.freeze({
    public_key: node.authority.public_key,
    async sign_digest(digest: Uint8Array): Promise<string> {
      if (
        !(digest instanceof Uint8Array)
        || digest.byteLength !== ED25519_DIGEST_BYTES
      ) {
        throw new Error(
          `CashLoom v2 record digests must be exactly ${ED25519_DIGEST_BYTES} bytes.`,
        );
      }

      // Clone before awaiting the vault so a caller cannot mutate the bytes
      // between validation and signing.
      const stableDigest = Uint8Array.from(digest);
      const revealed = await vault.revealForSigning(node.vaultKeyId);
      const seed = seedFromHex(revealed);
      try {
        const publicKey = base64UrlEncode(
          await ed25519.getPublicKeyAsync(seed),
        );
        if (publicKey !== node.authority.public_key) {
          throw new Error(
            "CashLoom v2 node authority key material does not match its public key.",
          );
        }
        return signatureToBase64Url(
          await ed25519.signAsync(stableDigest, seed),
        );
      } finally {
        seed.fill(0);
        stableDigest.fill(0);
      }
    },
  });
}

/**
 * Create one authority provider for one sovereign-node process.
 *
 * The database's dedicated partial UNIQUE index is the cross-process arbiter.
 * The in-flight promise is the cheaper in-process arbiter. If another process
 * wins between our read and vault insert, generation throws; re-reading the
 * committed winner is recovery, while an error with no winner is propagated.
 */
export function createV2NodeAuthorityProvider(
  dependencies: V2NodeAuthorityDependencies,
): V2NodeAuthorityProvider {
  const { db, vault } = dependencies;
  let cached: V2NodeAuthority | undefined;
  let inFlight: Promise<V2NodeAuthority> | undefined;

  const resolve = async (): Promise<V2NodeAuthority> => {
    const existing = authorityRow(db);
    if (existing) return resolvedAuthority(existing);

    try {
      await vault.generateEd25519Key(CASHLOOM_V2_NODE_AUTHORITY_LABEL);
    } catch (error) {
      // A concurrent process may have committed the unique labelled row while
      // this process was generating. Only a valid committed winner converts
      // the generation error into success.
      const winner = authorityRow(db);
      if (winner) return resolvedAuthority(winner);
      throw error;
    }

    const generated = authorityRow(db);
    if (!generated) {
      throw new Error(
        "Vault generation returned without persisting the CashLoom v2 node authority.",
      );
    }
    return resolvedAuthority(generated);
  };

  const ensure = (): Promise<V2NodeAuthority> => {
    if (cached) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    inFlight = resolve()
      .then((node) => {
        cached = node;
        return node;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return Object.freeze({
    ensure,
    async signingContext(): Promise<V2NodeSigningContext> {
      const node = await ensure();
      return Object.freeze({
        ...node,
        signer: vaultSigner(node, vault),
      });
    },
  });
}
