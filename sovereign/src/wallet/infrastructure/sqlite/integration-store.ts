import type { Database } from "bun:sqlite";
import { z } from "zod";
import { caip10AccountIdSchema } from "../../domain/identities.ts";
import {
  parseErc4337UserOperationRequest,
  parseFiatRedirectBinding,
  parseFiatWebhookEvidence,
  parseHardwareSigningHandoff,
  parseRegulatedFiatPaymentAuthorization,
  parseWalletConnectRequestBinding,
  parseWalletConnectSessionBinding,
  parseWebAuthnCeremony,
  type WebAuthnVerifiedEvidence,
  canonicalBase64UrlSchema,
  canonicalHexDataSchema,
  hashCanonicalContract,
  hashHexData,
  hashUtf8,
  unsignedIntegerSchema,
  webAuthnRpIdSchema,
  webAuthnVerifiedEvidenceSchema,
} from "../../integrations/index.ts";
import {
  canonicalTimestampSchema,
  sha256DigestSchema,
  walletOpaqueIdSchema,
  type Sha256Digest,
} from "../../domain/intent.ts";
import { canonicalJson, type JsonValue } from "./store.ts";
import { installWalletIntegrationSchema } from "./integration-schema.ts";

type IntegrationKind = "WEBAUTHN" | "HARDWARE" | "WALLETCONNECT" | "ERC4337" | "FIAT";
type IntegrationStatus = "ACTIVE" | "REVOKED" | "EXPIRED" | "UNAVAILABLE";
type SignerStatus = "ACTIVE" | "REVOKED" | "UNAVAILABLE";
type InteractionKind = "hardware" | "walletconnect" | "erc4337";
type Erc4337Status = "PREPARED" | "SIGNED" | "SUBMITTED" | "AMBIGUOUS" | "SETTLED" | "FAILED" | "REVERTED";

export interface WebAuthnStorePolicy {
  readonly rpId: string;
  readonly originHash: Sha256Digest;
}

export interface StoredWebAuthnCredential {
  readonly credential_id: string;
  readonly signer_id: string;
  readonly account_id: string;
  readonly rp_id: string;
  readonly origin_hash: Sha256Digest;
  readonly public_key: `0x${string}`;
  readonly public_key_hash: Sha256Digest;
  readonly sign_count: string;
  readonly status: "ACTIVE";
}

const passkeyPublicKey = (value: string): `0x${string}` => {
  if (!/^0x04[0-9a-f]{128}$/.test(value)) {
    throw new WalletIntegrationStoreError("WEBAUTHN_PUBLIC_KEY_REFUSED");
  }
  return value as `0x${string}`;
};

const verifiedRegistrationSchema = z.object({
  credential: z.object({
    credential_id: canonicalBase64UrlSchema.max(2048),
    public_key: z.string(),
    sign_count: unsignedIntegerSchema,
    counter_supported: z.boolean(),
    user_verified: z.literal(true),
    backup_eligible: z.boolean(),
    backed_up: z.boolean(),
    device_type: z.enum(["single_device", "multi_device"]),
    attestation_assurance: z.literal("none"),
    transports: z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])).max(8),
  }).strict(),
  evidence: z.object({
    schema_version: z.literal("cashloom.webauthn-registration-evidence/1"),
    ceremony_id: walletOpaqueIdSchema,
    credential_id: canonicalBase64UrlSchema.max(2048),
    rp_id: webAuthnRpIdSchema,
    origin_hash: sha256DigestSchema,
    attestation_object_hash: sha256DigestSchema,
    client_data_hash: sha256DigestSchema,
    user_present: z.literal(true),
    user_verified: z.literal(true),
    verified_at: canonicalTimestampSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.credential.credential_id !== value.evidence.credential_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["credential", "credential_id"], message: "credential evidence mismatch" });
  }
  if (value.credential.counter_supported !== (value.credential.sign_count !== "0")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["credential", "counter_supported"], message: "counter policy mismatch" });
  }
  if (value.credential.backed_up && !value.credential.backup_eligible) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["credential", "backed_up"], message: "backup state mismatch" });
  }
  if (value.credential.device_type === "multi_device" !== value.credential.backup_eligible) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["credential", "device_type"], message: "device type mismatch" });
  }
  try {
    passkeyPublicKey(value.credential.public_key);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["credential", "public_key"], message: "invalid P-256 public key" });
  }
}).readonly();

export type VerifiedWebAuthnRegistration = z.infer<typeof verifiedRegistrationSchema>;

const erc4337InteractionBindingSchema = z.object({
  binding_hash: sha256DigestSchema,
}).strict().readonly();

const walletConnectPersistenceGuardSchema = z.object({
  policy: z.literal("ACTIVE_SESSION_PENDING_REQUEST_ARTIFACT_CAS"),
  session_id: walletOpaqueIdSchema,
  session_binding_hash: sha256DigestSchema,
  expected_session_status: z.literal("ACTIVE"),
  request_id: walletOpaqueIdSchema,
  expected_request_status: z.literal("PENDING"),
  expected_request_version: z.number().int().nonnegative(),
  request_hash: sha256DigestSchema,
  params_hash: sha256DigestSchema,
  authorization_id: walletOpaqueIdSchema,
  external_tx_id: canonicalHexDataSchema.refine((value) => value.length === 66, "expected a 32-byte transaction id"),
}).strict().readonly();

const EVENT_TYPES: Readonly<Record<InteractionKind, readonly string[]>> = Object.freeze({
  hardware: Object.freeze(["HARDWARE_VERIFIED", "HARDWARE_REFUSED"]),
  walletconnect: Object.freeze(["WALLETCONNECT_VERIFIED", "WALLETCONNECT_REFUSED"]),
  erc4337: Object.freeze(["ERC4337_SIGNED", "ERC4337_SUBMITTED", "ERC4337_AMBIGUOUS"]),
});

export class WalletIntegrationStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WalletIntegrationStoreError";
  }
}

const iso = (date: Date): string => canonicalTimestampSchema.parse(date.toISOString());
const digest = (value: string): Sha256Digest => sha256DigestSchema.parse(value);
const opaqueId = (value: string): string => walletOpaqueIdSchema.parse(value);
const json = (value: JsonValue): string => canonicalJson(value);
const timestamp = (value: string): string => canonicalTimestampSchema.parse(value);

interface ActiveConnectionRow {
  readonly connection_id: string;
  readonly kind: IntegrationKind;
  readonly status: string;
  readonly core_status: string;
}

interface ActiveSignerRow {
  readonly signer_id: string;
  readonly connection_id: string;
  readonly signer_status: string;
  readonly connection_status: string;
  readonly kind: IntegrationKind;
  readonly core_signer_status: string;
  readonly core_connection_status: string;
}

export class WalletIntegrationStore {
  readonly #now: () => Date;
  readonly #webAuthnPolicy: WebAuthnStorePolicy | null;

  constructor(
    readonly db: Database,
    options: {
      readonly now?: () => Date;
      readonly install?: boolean;
      readonly webAuthnPolicy?: { readonly rpId: string; readonly originHash: string };
    } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#webAuthnPolicy = options.webAuthnPolicy
      ? Object.freeze({
          rpId: webAuthnRpIdSchema.parse(options.webAuthnPolicy.rpId),
          originHash: digest(options.webAuthnPolicy.originHash),
        })
      : null;
    if (options.install !== false) installWalletIntegrationSchema(db);
  }

  #nowIso(): string {
    return iso(this.#now());
  }

  #assertFuture(value: string, code: string): string {
    const parsed = timestamp(value);
    if (parsed <= this.#nowIso()) throw new WalletIntegrationStoreError(code);
    return parsed;
  }

  #requireWebAuthnPolicy(rpId: string, originHash: string): WebAuthnStorePolicy {
    const policy = this.#webAuthnPolicy;
    if (!policy || webAuthnRpIdSchema.parse(rpId) !== policy.rpId || digest(originHash) !== policy.originHash) {
      throw new WalletIntegrationStoreError("WEBAUTHN_POLICY_REFUSED");
    }
    return policy;
  }

  #activeConnectionRow(connectionId: string, expectedKind?: IntegrationKind): ActiveConnectionRow | null {
    const row = this.db.query(`
      SELECT i.connection_id,i.kind,i.status,c.status core_status
      FROM wk_integration_connections i
      JOIN wk_connections c ON c.id=i.connection_id
      WHERE i.connection_id=?
    `).get(opaqueId(connectionId)) as ActiveConnectionRow | null;
    if (!row || row.status !== "ACTIVE" || row.core_status !== "ACTIVE" || (expectedKind && row.kind !== expectedKind)) {
      return null;
    }
    return row;
  }

  #activeSignerRow(
    signerId: string,
    expectedConnectionId?: string,
    expectedKind?: IntegrationKind,
  ): ActiveSignerRow | null {
    const row = this.db.query(`
      SELECT s.signer_id,s.connection_id,s.status signer_status,c.status connection_status,c.kind,
             ks.status core_signer_status,kc.status core_connection_status
      FROM wk_integration_signers s
      JOIN wk_integration_connections c ON c.connection_id=s.connection_id
      JOIN wk_signers ks ON ks.id=s.signer_id
      JOIN wk_connections kc ON kc.id=c.connection_id
      WHERE s.signer_id=?
    `).get(opaqueId(signerId)) as ActiveSignerRow | null;
    if (
      !row ||
      row.signer_status !== "ACTIVE" ||
      row.connection_status !== "ACTIVE" ||
      row.core_signer_status !== "ACTIVE" ||
      row.core_connection_status !== "ACTIVE" ||
      (expectedConnectionId && row.connection_id !== opaqueId(expectedConnectionId)) ||
      (expectedKind && row.kind !== expectedKind)
    ) {
      return null;
    }
    return row;
  }

  putConnection(input: {
    readonly connectionId: string;
    readonly kind: IntegrationKind;
    readonly bindingHash: string;
  }): void {
    const core = this.db.query("SELECT status FROM wk_connections WHERE id=?").get(opaqueId(input.connectionId)) as { status: string } | null;
    if (!core || core.status !== "ACTIVE") throw new WalletIntegrationStoreError("CONNECTION_PROJECTION_REFUSED");
    const at = this.#nowIso();
    this.db.query(`
      INSERT INTO wk_integration_connections(connection_id,kind,binding_hash,status,created_at,updated_at)
      VALUES(?,?,?,'ACTIVE',?,?)
    `).run(opaqueId(input.connectionId), input.kind, digest(input.bindingHash), at, at);
  }

  transitionConnection(input: {
    readonly connectionId: string;
    readonly expectedVersion: number;
    readonly status: IntegrationStatus;
  }): void {
    if (input.status === "ACTIVE") throw new WalletIntegrationStoreError("CONNECTION_COMPARE_AND_SET_FAILED");
    const at = this.#nowIso();
    this.db.transaction(() => {
      const signerIds = this.db.query(`
        SELECT signer_id FROM wk_integration_signers WHERE connection_id=? AND status='ACTIVE'
      `).all(opaqueId(input.connectionId)) as Array<{ signer_id: string }>;
      const changed = this.db.query(`
        UPDATE wk_integration_connections
        SET status=?,version=version+1,updated_at=?,revoked_at=?
        WHERE connection_id=? AND version=? AND status='ACTIVE'
      `).run(
        input.status,
        at,
        input.status === "REVOKED" ? at : null,
        opaqueId(input.connectionId),
        input.expectedVersion,
      );
      if (changed.changes !== 1) throw new WalletIntegrationStoreError("CONNECTION_COMPARE_AND_SET_FAILED");

      const dependentStatus = input.status === "EXPIRED" ? "EXPIRED" : "REVOKED";
      const signerStatus = input.status === "REVOKED" ? "REVOKED" : "UNAVAILABLE";
      this.db.query("UPDATE wk_connections SET status=?,updated_at=? WHERE id=? AND status='ACTIVE'")
        .run(input.status, at, opaqueId(input.connectionId));
      this.db.query(`
        UPDATE wk_integration_signers
        SET status=?,version=version+1,updated_at=?,revoked_at=?
        WHERE connection_id=? AND status='ACTIVE'
      `).run(signerStatus, at, signerStatus === "REVOKED" ? at : null, opaqueId(input.connectionId));
      for (const { signer_id } of signerIds) {
        this.db.query("UPDATE wk_signers SET status=?,updated_at=? WHERE id=? AND status='ACTIVE'")
          .run(signerStatus, at, signer_id);
        this.db.query("UPDATE wk_webauthn_credentials SET status='REVOKED',revoked_at=? WHERE signer_id=? AND status='ACTIVE'")
          .run(at, signer_id);
        this.db.query("UPDATE wk_webauthn_ceremonies SET status=?,consumed_at=NULL WHERE signer_id=? AND status='PENDING'")
          .run(dependentStatus, signer_id);
      }
      this.db.query("UPDATE wk_integration_interactions SET status=?,version=version+1,completed_at=NULL WHERE connection_id=? AND status='PENDING'")
        .run(dependentStatus, opaqueId(input.connectionId));
      this.db.query("UPDATE wk_walletconnect_sessions SET status=?,version=version+1,revoked_at=? WHERE connection_id=? AND status='ACTIVE'")
        .run(dependentStatus, dependentStatus === "REVOKED" ? at : null, opaqueId(input.connectionId));

      const consentIds = this.db.query("SELECT id FROM wk_fiat_consents WHERE connection_id=? AND status='ACTIVE'")
        .all(opaqueId(input.connectionId)) as Array<{ id: string }>;
      for (const consent of consentIds) {
        this.db.query("UPDATE wk_fiat_payees SET status='REVOKED',revoked_at=? WHERE consent_id=? AND status='ACTIVE'")
          .run(at, consent.id);
        this.db.query("UPDATE wk_fiat_authorization_sessions SET status=?,consumed_at=NULL WHERE consent_id=? AND status='PENDING'")
          .run(dependentStatus, consent.id);
      }
      this.db.query("UPDATE wk_fiat_consents SET status=?,revoked_at=? WHERE connection_id=? AND status='ACTIVE'")
        .run(dependentStatus, dependentStatus === "REVOKED" ? at : null, opaqueId(input.connectionId));
    })();
  }

  getConnection(connectionId: string): unknown {
    return this.db.query("SELECT * FROM wk_integration_connections WHERE connection_id=?").get(opaqueId(connectionId));
  }

  putSigner(input: {
    readonly signerId: string;
    readonly connectionId: string;
    readonly bindingHash: string;
  }): void {
    const connection = this.#activeConnectionRow(input.connectionId);
    const core = this.db.query(`
      SELECT s.status,s.wallet_id,c.wallet_id connection_wallet_id
      FROM wk_signers s JOIN wk_connections c ON c.id=? WHERE s.id=?
    `).get(opaqueId(input.connectionId), opaqueId(input.signerId)) as {
      status: string;
      wallet_id: string;
      connection_wallet_id: string;
    } | null;
    if (!connection || !core || core.status !== "ACTIVE" || core.wallet_id !== core.connection_wallet_id) {
      throw new WalletIntegrationStoreError("SIGNER_PROJECTION_REFUSED");
    }
    const at = this.#nowIso();
    this.db.query(`
      INSERT INTO wk_integration_signers(signer_id,connection_id,binding_hash,status,created_at,updated_at)
      VALUES(?,?,?,'ACTIVE',?,?)
    `).run(opaqueId(input.signerId), opaqueId(input.connectionId), digest(input.bindingHash), at, at);
  }

  transitionSigner(input: {
    readonly signerId: string;
    readonly expectedVersion: number;
    readonly status: SignerStatus;
  }): void {
    if (input.status === "ACTIVE") throw new WalletIntegrationStoreError("SIGNER_COMPARE_AND_SET_FAILED");
    const at = this.#nowIso();
    this.db.transaction(() => {
      const changed = this.db.query(`
        UPDATE wk_integration_signers
        SET status=?,version=version+1,updated_at=?,revoked_at=?
        WHERE signer_id=? AND version=? AND status='ACTIVE'
      `).run(
        input.status,
        at,
        input.status === "REVOKED" ? at : null,
        opaqueId(input.signerId),
        input.expectedVersion,
      );
      if (changed.changes !== 1) throw new WalletIntegrationStoreError("SIGNER_COMPARE_AND_SET_FAILED");
      this.db.query("UPDATE wk_signers SET status=?,updated_at=? WHERE id=? AND status='ACTIVE'")
        .run(input.status, at, opaqueId(input.signerId));
      this.db.query("UPDATE wk_webauthn_credentials SET status='REVOKED',revoked_at=? WHERE signer_id=? AND status='ACTIVE'")
        .run(at, opaqueId(input.signerId));
      this.db.query("UPDATE wk_webauthn_ceremonies SET status='REVOKED',consumed_at=NULL WHERE signer_id=? AND status='PENDING'")
        .run(opaqueId(input.signerId));
      this.db.query("UPDATE wk_integration_interactions SET status='REVOKED',version=version+1,completed_at=NULL WHERE signer_id=? AND status='PENDING'")
        .run(opaqueId(input.signerId));
    })();
  }

  #projectInteractionBinding(input: {
    readonly connectionId: string;
    readonly signerId?: string;
    readonly kind: InteractionKind;
    readonly intentHash: string;
    readonly requestHash: string;
    readonly binding: unknown;
    readonly expiresAt: string;
  }): JsonValue {
    if (input.kind === "hardware") {
      const handoff = parseHardwareSigningHandoff(input.binding);
      if (
        !input.signerId ||
        handoff.signer_id !== input.signerId ||
        handoff.authorization.intent_hash !== input.intentHash ||
        handoff.request_hash !== input.requestHash ||
        handoff.expires_at !== input.expiresAt
      ) throw new WalletIntegrationStoreError("INTERACTION_BINDING_REFUSED");
      return {
        schema_version: handoff.schema_version,
        handoff_id: handoff.handoff_id,
        signer_id: handoff.signer_id,
        device_binding_hash: handoff.device_binding_hash,
        transport: handoff.transport,
        authorization: {
          authorization_id: handoff.authorization.authorization_id,
          intent_hash: handoff.authorization.intent_hash,
          request_hash: handoff.authorization.request_hash,
          expires_at: handoff.authorization.expires_at,
        },
        request_hash: handoff.request_hash,
        expires_at: handoff.expires_at,
      };
    }
    if (input.kind === "walletconnect") {
      const request = parseWalletConnectRequestBinding(input.binding);
      const session = this.db.query(`
        SELECT namespaces_json,expires_at,status,binding_hash,version FROM wk_walletconnect_sessions
        WHERE session_id=? AND connection_id=?
      `).get(request.session_id, opaqueId(input.connectionId)) as {
        namespaces_json: string | null;
        expires_at: string;
        status: string;
        binding_hash: string;
        version: number;
      } | null;
      let namespaces: Array<{ chain_id: string; accounts: string[]; methods: string[] }> = [];
      try {
        namespaces = session?.namespaces_json ? JSON.parse(session.namespaces_json) as typeof namespaces : [];
      } catch {
        throw new WalletIntegrationStoreError("INTERACTION_BINDING_REFUSED");
      }
      const namespace = namespaces.find((entry) => entry.chain_id === request.chain_id);
      if (
        request.authorization.intent_hash !== input.intentHash ||
        request.request_hash !== input.requestHash ||
        request.expires_at !== input.expiresAt ||
        !session || session.status !== "ACTIVE" || session.expires_at < request.expires_at ||
        !namespace || !namespace.accounts.includes(request.account_id) || !namespace.methods.includes(request.method)
      ) throw new WalletIntegrationStoreError("INTERACTION_BINDING_REFUSED");
      return {
        schema_version: request.schema_version,
        session_id: request.session_id,
        session_binding_hash: session.binding_hash,
        session_version: session.version,
        request_id: request.request_id,
        chain_id: request.chain_id,
        account_id: request.account_id,
        method: request.method,
        params_hash: request.params_hash,
        authorization: {
          authorization_id: request.authorization.authorization_id,
          intent_hash: request.authorization.intent_hash,
          request_hash: request.authorization.request_hash,
          expires_at: request.authorization.expires_at,
        },
        request_hash: request.request_hash,
        expires_at: request.expires_at,
      };
    }
    const binding = erc4337InteractionBindingSchema.parse(input.binding);
    return { binding_hash: binding.binding_hash };
  }

  createInteraction(input: {
    readonly id: string;
    readonly connectionId: string;
    readonly signerId?: string;
    readonly kind: InteractionKind;
    readonly intentHash: string;
    readonly requestHash: string;
    readonly binding: unknown;
    readonly expiresAt: string;
  }): void {
    const expectedKind: IntegrationKind = input.kind === "hardware"
      ? "HARDWARE"
      : input.kind === "walletconnect" ? "WALLETCONNECT" : "ERC4337";
    if (!this.#activeConnectionRow(input.connectionId, expectedKind)) {
      throw new WalletIntegrationStoreError("INTERACTION_AUTHORITY_REFUSED");
    }
    if (input.signerId && !this.#activeSignerRow(input.signerId, input.connectionId, expectedKind)) {
      throw new WalletIntegrationStoreError("INTERACTION_AUTHORITY_REFUSED");
    }
    if (input.kind === "hardware" && !input.signerId) {
      throw new WalletIntegrationStoreError("INTERACTION_AUTHORITY_REFUSED");
    }
    const expiresAt = this.#assertFuture(input.expiresAt, "INTERACTION_EXPIRED");
    const projection = this.#projectInteractionBinding({ ...input, expiresAt });
    this.db.query(`
      INSERT INTO wk_integration_interactions(
        id,connection_id,signer_id,kind,intent_hash,request_hash,binding_json,status,expires_at,created_at
      ) VALUES(?,?,?,?,?,?,?,'PENDING',?,?)
    `).run(
      opaqueId(input.id),
      opaqueId(input.connectionId),
      input.signerId ? opaqueId(input.signerId) : null,
      input.kind,
      digest(input.intentHash),
      digest(input.requestHash),
      json(projection),
      expiresAt,
      this.#nowIso(),
    );
  }

  /** Operational persistence boundary: completion, verifier digest, and the
   * external artifact claim commit atomically while authority is still live.
   * The caller must pass output from the matching protocol verifier. */
  persistVerifiedExternalArtifact(input: {
    readonly interactionId: string;
    readonly expectedVersion: number;
    readonly eventId: string;
    readonly artifactId: string;
    readonly kind: InteractionKind;
    readonly intentHash: string;
    readonly requestHash: string;
    readonly artifactHash: string;
    readonly externalIdHash?: string;
    readonly walletConnectGuard?: unknown;
  }): void {
    let walletConnectGuard: z.infer<typeof walletConnectPersistenceGuardSchema> | null = null;
    if (input.kind === "walletconnect") {
      const parsed = walletConnectPersistenceGuardSchema.safeParse(input.walletConnectGuard);
      if (
        !parsed.success || parsed.data.expected_request_version !== input.expectedVersion ||
        parsed.data.request_hash !== digest(input.requestHash) || !input.externalIdHash ||
        hashHexData(parsed.data.external_tx_id) !== digest(input.externalIdHash)
      ) throw new WalletIntegrationStoreError("WALLETCONNECT_PERSISTENCE_GUARD_REFUSED");
      walletConnectGuard = parsed.data;
    } else if (input.walletConnectGuard !== undefined) {
      throw new WalletIntegrationStoreError("INTERACTION_BINDING_REFUSED");
    }
    const at = this.#nowIso();
    this.db.transaction(() => {
      const changed = this.db.query(`
        UPDATE wk_integration_interactions AS i
        SET status='COMPLETED',version=version+1,completed_at=?
        WHERE id=? AND version=? AND status='PENDING' AND expires_at>?
          AND kind=? AND intent_hash=? AND request_hash=?
          AND EXISTS (
            SELECT 1 FROM wk_integration_connections c JOIN wk_connections kc ON kc.id=c.connection_id
            WHERE c.connection_id=i.connection_id AND c.status='ACTIVE' AND kc.status='ACTIVE'
          )
          AND (signer_id IS NULL OR EXISTS (
            SELECT 1 FROM wk_integration_signers s
            JOIN wk_signers ks ON ks.id=s.signer_id
            WHERE s.signer_id=i.signer_id AND s.connection_id=i.connection_id
              AND s.status='ACTIVE' AND ks.status='ACTIVE'
          ))
          AND (kind<>'walletconnect' OR (
            json_extract(i.binding_json,'$.session_id')=?
            AND json_extract(i.binding_json,'$.session_binding_hash')=?
            AND json_extract(i.binding_json,'$.request_id')=?
            AND json_extract(i.binding_json,'$.request_hash')=?
            AND json_extract(i.binding_json,'$.params_hash')=?
            AND json_extract(i.binding_json,'$.authorization.authorization_id')=?
            AND json_extract(i.binding_json,'$.method')='eth_signTransaction'
            AND EXISTS (
              SELECT 1 FROM wk_walletconnect_sessions ws
              WHERE ws.session_id=json_extract(i.binding_json,'$.session_id')
                AND ws.connection_id=i.connection_id AND ws.status='ACTIVE' AND ws.expires_at>?
                AND ws.binding_hash=json_extract(i.binding_json,'$.session_binding_hash')
                AND ws.version=CAST(json_extract(i.binding_json,'$.session_version') AS INTEGER)
            )
          ))
      `).run(
        at,
        opaqueId(input.interactionId),
        input.expectedVersion,
        at,
        input.kind,
        digest(input.intentHash),
        digest(input.requestHash),
        walletConnectGuard?.session_id ?? null,
        walletConnectGuard?.session_binding_hash ?? null,
        walletConnectGuard?.request_id ?? null,
        walletConnectGuard?.request_hash ?? null,
        walletConnectGuard?.params_hash ?? null,
        walletConnectGuard?.authorization_id ?? null,
        at,
      );
      if (changed.changes !== 1) throw new WalletIntegrationStoreError("INTERACTION_COMPARE_AND_SET_FAILED");
      this.db.query(`
        INSERT INTO wk_integration_interaction_events(
          id,interaction_id,sequence,event_type,result_hash,occurred_at,data_json
        ) VALUES(?,?,0,'COMPLETED',?,?,'{}')
      `).run(
        opaqueId(input.eventId),
        opaqueId(input.interactionId),
        digest(input.artifactHash),
        at,
      );
      this.db.query(`
        INSERT INTO wk_external_artifacts(
          id,interaction_id,kind,intent_hash,request_hash,artifact_hash,external_id_hash,created_at
        ) VALUES(?,?,?,?,?,?,?,?)
      `).run(
        opaqueId(input.artifactId),
        opaqueId(input.interactionId),
        input.kind,
        digest(input.intentHash),
        digest(input.requestHash),
        digest(input.artifactHash),
        input.externalIdHash ? digest(input.externalIdHash) : null,
        at,
      );
    })();
  }

  /** Digest-only trusted verifier evidence. Event names are discriminated by
   * interaction kind and arbitrary payload fields are never persisted. */
  appendVerifiedInteractionEventEvidence(input: {
    readonly id: string;
    readonly interactionId: string;
    readonly sequence: number;
    readonly eventType: string;
    readonly resultHash: string;
    readonly occurredAt: string;
  }): void {
    const row = this.db.query(`
      SELECT kind,connection_id,signer_id,status FROM wk_integration_interactions WHERE id=?
    `).get(opaqueId(input.interactionId)) as {
      kind: InteractionKind;
      connection_id: string;
      signer_id: string | null;
      status: string;
    } | null;
    if (
      !row ||
      row.status === "REVOKED" || row.status === "EXPIRED" ||
      !EVENT_TYPES[row.kind]?.includes(input.eventType) ||
      !this.#activeConnectionRow(row.connection_id) ||
      (row.signer_id !== null && !this.#activeSignerRow(row.signer_id, row.connection_id))
    ) throw new WalletIntegrationStoreError("INTERACTION_EVENT_REFUSED");
    const occurredAt = timestamp(input.occurredAt);
    if (occurredAt > this.#nowIso()) throw new WalletIntegrationStoreError("INTERACTION_EVENT_REFUSED");
    this.db.query(`
      INSERT INTO wk_integration_interaction_events(
        id,interaction_id,sequence,event_type,result_hash,occurred_at,data_json
      ) VALUES(?,?,?,?,?,?,'{}')
    `).run(
      opaqueId(input.id),
      opaqueId(input.interactionId),
      input.sequence,
      input.eventType,
      digest(input.resultHash),
      occurredAt,
    );
  }

  #insertWebAuthnCredential(input: {
    readonly credentialId: string;
    readonly signerId: string;
    readonly accountId: string;
    readonly rpId: string;
    readonly originHash: string;
    readonly publicKey: string;
    readonly counterPolicy: "MONOTONIC" | "ZERO_ALLOWED";
    readonly signCount: string;
  }): StoredWebAuthnCredential {
    this.#requireWebAuthnPolicy(input.rpId, input.originHash);
    if (!this.#activeSignerRow(input.signerId, undefined, "WEBAUTHN")) {
      throw new WalletIntegrationStoreError("WEBAUTHN_AUTHORITY_REFUSED");
    }
    const credentialId = canonicalBase64UrlSchema.max(2048).parse(input.credentialId);
    const publicKey = passkeyPublicKey(input.publicKey);
    const publicKeyHash = hashHexData(publicKey);
    const accountId = caip10AccountIdSchema.parse(input.accountId);
    const signCount = unsignedIntegerSchema.parse(input.signCount);
    const at = this.#nowIso();
    this.db.query(`
      INSERT INTO wk_webauthn_credentials(
        credential_id,signer_id,account_id,rp_id,origin_hash,public_key,public_key_hash,
        counter_policy,sign_count,status,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',?)
    `).run(
      credentialId,
      opaqueId(input.signerId),
      accountId,
      webAuthnRpIdSchema.parse(input.rpId),
      digest(input.originHash),
      publicKey,
      publicKeyHash,
      input.counterPolicy,
      signCount,
      at,
    );
    return Object.freeze({
      credential_id: credentialId,
      signer_id: opaqueId(input.signerId),
      account_id: accountId,
      rp_id: webAuthnRpIdSchema.parse(input.rpId),
      origin_hash: digest(input.originHash),
      public_key: publicKey,
      public_key_hash: publicKeyHash,
      sign_count: signCount,
      status: "ACTIVE",
    });
  }

  getWebAuthnCredential(credentialIdInput: string): StoredWebAuthnCredential {
    const credentialId = canonicalBase64UrlSchema.max(2048).parse(credentialIdInput);
    const row = this.db.query(`
      SELECT k.credential_id,k.signer_id,k.account_id,k.rp_id,k.origin_hash,k.public_key,
             k.public_key_hash,k.sign_count,k.status,s.connection_id
      FROM wk_webauthn_credentials k
      JOIN wk_integration_signers s ON s.signer_id=k.signer_id
      WHERE k.credential_id=?
    `).get(credentialId) as {
      credential_id: string;
      signer_id: string;
      account_id: string;
      rp_id: string;
      origin_hash: Sha256Digest;
      public_key: string | null;
      public_key_hash: Sha256Digest;
      sign_count: string;
      status: string;
      connection_id: string;
    } | null;
    if (
      !row || row.status !== "ACTIVE" || !row.public_key ||
      !this.#activeSignerRow(row.signer_id, row.connection_id, "WEBAUTHN")
    ) throw new WalletIntegrationStoreError("WEBAUTHN_CREDENTIAL_REFUSED");
    this.#requireWebAuthnPolicy(row.rp_id, row.origin_hash);
    const publicKey = passkeyPublicKey(row.public_key);
    if (hashHexData(publicKey) !== row.public_key_hash) {
      throw new WalletIntegrationStoreError("WEBAUTHN_CREDENTIAL_REFUSED");
    }
    return Object.freeze({
      credential_id: row.credential_id,
      signer_id: row.signer_id,
      account_id: row.account_id,
      rp_id: row.rp_id,
      origin_hash: row.origin_hash,
      public_key: publicKey,
      public_key_hash: row.public_key_hash,
      sign_count: row.sign_count,
      status: "ACTIVE",
    });
  }

  createWebAuthnCeremony(input: unknown): void {
    const ceremony = parseWebAuthnCeremony(input);
    this.#requireWebAuthnPolicy(ceremony.rp_id, ceremony.origin_hash);
    const signer = this.#activeSignerRow(ceremony.signer_id, undefined, "WEBAUTHN");
    if (!signer) throw new WalletIntegrationStoreError("WEBAUTHN_AUTHORITY_REFUSED");
    const expiresAt = this.#assertFuture(ceremony.expires_at, "WEBAUTHN_CEREMONY_REFUSED");
    if (ceremony.kind === "assertion") {
      const credential = this.getWebAuthnCredential(ceremony.credential_id);
      if (
        credential.signer_id !== ceremony.signer_id ||
        credential.account_id !== ceremony.account_id ||
        credential.rp_id !== ceremony.rp_id ||
        credential.origin_hash !== ceremony.origin_hash ||
        credential.sign_count !== ceremony.prior_sign_count
      ) throw new WalletIntegrationStoreError("WEBAUTHN_CEREMONY_REFUSED");
    }
    this.db.query(`
      INSERT INTO wk_webauthn_ceremonies(
        id,kind,signer_id,credential_id,account_id,authorization_id,prior_sign_count,
        rp_id,origin_hash,challenge_hash,intent_hash,request_hash,status,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?)
    `).run(
      ceremony.ceremony_id,
      ceremony.kind === "registration" ? "REGISTRATION" : "ASSERTION",
      ceremony.signer_id,
      ceremony.kind === "assertion" ? ceremony.credential_id : null,
      ceremony.account_id,
      ceremony.kind === "assertion" ? ceremony.authorization.authorization_id : null,
      ceremony.kind === "assertion" ? ceremony.prior_sign_count : null,
      ceremony.rp_id,
      ceremony.origin_hash,
      ceremony.challenge_hash,
      ceremony.kind === "assertion" ? ceremony.authorization.intent_hash : null,
      ceremony.kind === "assertion" ? ceremony.authorization.request_hash : null,
      expiresAt,
    );
  }

  #verifiedAtIsBound(verifiedAt: string, now: string, expiresAt: string): boolean {
    const parsed = timestamp(verifiedAt);
    return parsed <= now && parsed < expiresAt;
  }

  /** Trusted verifier-consume boundary. `registration` must be the output of
   * the WebAuthn verifier; this layer rebinds it to durable policy/ceremony
   * state and commits credential plus digest-only evidence atomically. */
  consumeVerifiedWebAuthnRegistration(input: {
    readonly ceremony: unknown;
    readonly registration: unknown;
  }): StoredWebAuthnCredential {
    const ceremony = parseWebAuthnCeremony(input.ceremony);
    if (ceremony.kind !== "registration") throw new WalletIntegrationStoreError("WEBAUTHN_CEREMONY_REFUSED");
    const registration = verifiedRegistrationSchema.parse(input.registration);
    this.#requireWebAuthnPolicy(ceremony.rp_id, ceremony.origin_hash);
    const at = this.#nowIso();
    return this.db.transaction(() => {
      const row = this.db.query(`
        SELECT c.*,s.connection_id,s.status signer_status,ic.status connection_status,ic.kind connection_kind,
               ks.status core_signer_status,kc.status core_connection_status
        FROM wk_webauthn_ceremonies c
        JOIN wk_integration_signers s ON s.signer_id=c.signer_id
        JOIN wk_integration_connections ic ON ic.connection_id=s.connection_id
        JOIN wk_signers ks ON ks.id=s.signer_id
        JOIN wk_connections kc ON kc.id=ic.connection_id
        WHERE c.id=?
      `).get(ceremony.ceremony_id) as Record<string, string | null> | null;
      if (
        !row || row.kind !== "REGISTRATION" || row.status !== "PENDING" || row.expires_at! <= at ||
        row.signer_status !== "ACTIVE" || row.connection_status !== "ACTIVE" || row.connection_kind !== "WEBAUTHN" ||
        row.core_signer_status !== "ACTIVE" || row.core_connection_status !== "ACTIVE" ||
        row.id !== ceremony.ceremony_id || row.signer_id !== ceremony.signer_id ||
        row.account_id !== ceremony.account_id || row.rp_id !== ceremony.rp_id ||
        row.origin_hash !== ceremony.origin_hash || row.challenge_hash !== ceremony.challenge_hash ||
        row.expires_at !== ceremony.expires_at ||
        registration.evidence.ceremony_id !== ceremony.ceremony_id ||
        registration.evidence.rp_id !== ceremony.rp_id ||
        registration.evidence.origin_hash !== ceremony.origin_hash ||
        !this.#verifiedAtIsBound(registration.evidence.verified_at, at, ceremony.expires_at)
      ) throw new WalletIntegrationStoreError("WEBAUTHN_CEREMONY_REFUSED");

      const credential = this.#insertWebAuthnCredential({
        credentialId: registration.credential.credential_id,
        signerId: ceremony.signer_id,
        accountId: ceremony.account_id,
        rpId: ceremony.rp_id,
        originHash: ceremony.origin_hash,
        publicKey: registration.credential.public_key,
        counterPolicy: registration.credential.counter_supported ? "MONOTONIC" : "ZERO_ALLOWED",
        signCount: registration.credential.sign_count,
      });
      this.db.query(`
        INSERT INTO wk_webauthn_evidence(
          ceremony_id,kind,credential_id,rp_id,origin_hash,primary_evidence_hash,
          secondary_evidence_hash,sign_count,verified_at
        ) VALUES(?,'REGISTRATION',?,?,?,?,?,?,?)
      `).run(
        ceremony.ceremony_id,
        credential.credential_id,
        ceremony.rp_id,
        ceremony.origin_hash,
        registration.evidence.attestation_object_hash,
        registration.evidence.client_data_hash,
        null,
        registration.evidence.verified_at,
      );
      const changed = this.db.query(`
        UPDATE wk_webauthn_ceremonies SET status='CONSUMED',consumed_at=?
        WHERE id=? AND status='PENDING'
      `).run(at, ceremony.ceremony_id);
      if (changed.changes !== 1) throw new WalletIntegrationStoreError("WEBAUTHN_CEREMONY_REFUSED");
      return credential;
    })();
  }

  /** Trusted verifier-consume boundary. Structural verifier evidence is never
   * sufficient alone: every ceremony, authorization, key, account, policy,
   * and prior-counter field is rechecked against durable state. */
  consumeVerifiedWebAuthnAssertion(input: {
    readonly ceremony: unknown;
    readonly evidence: WebAuthnVerifiedEvidence;
  }): void {
    const ceremony = parseWebAuthnCeremony(input.ceremony);
    if (ceremony.kind !== "assertion") throw new WalletIntegrationStoreError("WEBAUTHN_CEREMONY_REFUSED");
    const evidence = webAuthnVerifiedEvidenceSchema.parse(input.evidence);
    this.#requireWebAuthnPolicy(ceremony.rp_id, ceremony.origin_hash);
    const at = this.#nowIso();
    this.db.transaction(() => {
      const row = this.db.query(`
        SELECT c.*,k.sign_count,k.counter_policy,k.status credential_status,k.public_key,k.public_key_hash,
               k.signer_id credential_signer_id,k.account_id credential_account_id,
               k.rp_id credential_rp_id,k.origin_hash credential_origin_hash,
               s.connection_id,s.status signer_status,ic.status connection_status,ic.kind connection_kind,
               ks.status core_signer_status,kc.status core_connection_status
        FROM wk_webauthn_ceremonies c
        JOIN wk_webauthn_credentials k ON k.credential_id=c.credential_id
        JOIN wk_integration_signers s ON s.signer_id=c.signer_id
        JOIN wk_integration_connections ic ON ic.connection_id=s.connection_id
        JOIN wk_signers ks ON ks.id=s.signer_id
        JOIN wk_connections kc ON kc.id=ic.connection_id
        WHERE c.id=?
      `).get(ceremony.ceremony_id) as Record<string, string | null> | null;
      const publicKey = row?.public_key ? passkeyPublicKey(row.public_key) : null;
      if (
        !row || !publicKey || hashHexData(publicKey) !== row.public_key_hash ||
        row.kind !== "ASSERTION" || row.status !== "PENDING" || row.expires_at! <= at ||
        row.credential_status !== "ACTIVE" || row.signer_status !== "ACTIVE" || row.connection_status !== "ACTIVE" ||
        row.connection_kind !== "WEBAUTHN" || row.core_signer_status !== "ACTIVE" || row.core_connection_status !== "ACTIVE" ||
        row.id !== ceremony.ceremony_id || row.signer_id !== ceremony.signer_id ||
        row.credential_id !== ceremony.credential_id || row.account_id !== ceremony.account_id ||
        row.authorization_id !== ceremony.authorization.authorization_id ||
        row.intent_hash !== ceremony.authorization.intent_hash || row.request_hash !== ceremony.authorization.request_hash ||
        row.prior_sign_count !== ceremony.prior_sign_count || row.rp_id !== ceremony.rp_id ||
        row.origin_hash !== ceremony.origin_hash || row.challenge_hash !== ceremony.challenge_hash ||
        row.expires_at !== ceremony.expires_at || row.credential_signer_id !== ceremony.signer_id ||
        row.credential_account_id !== ceremony.account_id || row.credential_rp_id !== ceremony.rp_id ||
        row.credential_origin_hash !== ceremony.origin_hash || row.sign_count !== ceremony.prior_sign_count ||
        evidence.ceremony_id !== ceremony.ceremony_id || evidence.credential_id !== ceremony.credential_id ||
        evidence.rp_id !== ceremony.rp_id || evidence.origin_hash !== ceremony.origin_hash ||
        !this.#verifiedAtIsBound(evidence.verified_at, at, ceremony.expires_at)
      ) throw new WalletIntegrationStoreError("WEBAUTHN_CEREMONY_REFUSED");

      const oldCount = BigInt(row.sign_count!);
      const nextCount = BigInt(evidence.sign_count);
      const refused = row.counter_policy === "MONOTONIC"
        ? nextCount <= oldCount
        : oldCount > 0n ? nextCount <= oldCount : nextCount < 0n;
      if (refused) throw new WalletIntegrationStoreError("WEBAUTHN_COUNTER_REFUSED");

      this.db.query(`
        INSERT INTO wk_webauthn_evidence(
          ceremony_id,kind,credential_id,rp_id,origin_hash,primary_evidence_hash,
          secondary_evidence_hash,sign_count,verified_at
        ) VALUES(?,'ASSERTION',?,?,?,?,?,?,?)
      `).run(
        ceremony.ceremony_id,
        ceremony.credential_id,
        ceremony.rp_id,
        ceremony.origin_hash,
        evidence.authenticator_data_hash,
        evidence.signature_hash,
        evidence.sign_count,
        evidence.verified_at,
      );
      if (nextCount > oldCount) {
        const counterChanged = this.db.query(`
          UPDATE wk_webauthn_credentials SET sign_count=?
          WHERE credential_id=? AND status='ACTIVE' AND sign_count=?
        `).run(nextCount.toString(), ceremony.credential_id, oldCount.toString());
        if (counterChanged.changes !== 1) throw new WalletIntegrationStoreError("WEBAUTHN_COUNTER_REFUSED");
      }
      const consumed = this.db.query(`
        UPDATE wk_webauthn_ceremonies SET status='CONSUMED',consumed_at=?
        WHERE id=? AND status='PENDING'
      `).run(at, ceremony.ceremony_id);
      if (consumed.changes !== 1) throw new WalletIntegrationStoreError("WEBAUTHN_CEREMONY_REFUSED");
    })();
  }

  putWalletConnectSession(input: unknown, connectionId: string): void {
    const session = parseWalletConnectSessionBinding(input);
    if (!this.#activeConnectionRow(connectionId, "WALLETCONNECT")) {
      throw new WalletIntegrationStoreError("WALLETCONNECT_SESSION_REFUSED");
    }
    const expiresAt = this.#assertFuture(session.expires_at, "WALLETCONNECT_SESSION_REFUSED");
    this.db.query(`
      INSERT INTO wk_walletconnect_sessions(
        session_id,connection_id,peer_public_key_hash,binding_hash,namespaces_json,status,expires_at,created_at
      ) VALUES(?,?,?,?,?,'ACTIVE',?,?)
    `).run(
      session.session_id,
      opaqueId(connectionId),
      session.peer_public_key_hash,
      hashCanonicalContract(session as unknown as JsonValue),
      json(session.namespaces as unknown as JsonValue),
      expiresAt,
      this.#nowIso(),
    );
  }

  revokeWalletConnectSession(sessionId: string): void {
    const at = this.#nowIso();
    this.db.transaction(() => {
      const session = this.db.query(`
        SELECT connection_id,binding_hash,version,status,expires_at
        FROM wk_walletconnect_sessions WHERE session_id=?
      `).get(opaqueId(sessionId)) as {
        connection_id: string;
        binding_hash: string;
        version: number;
        status: string;
        expires_at: string;
      } | null;
      if (
        !session || session.status !== "ACTIVE" || session.expires_at <= at ||
        !this.#activeConnectionRow(session.connection_id, "WALLETCONNECT")
      ) throw new WalletIntegrationStoreError("WALLETCONNECT_SESSION_REFUSED");
      const changed = this.db.query(`
        UPDATE wk_walletconnect_sessions
        SET status='REVOKED',version=version+1,revoked_at=?
        WHERE session_id=? AND status='ACTIVE' AND version=?
      `).run(at, opaqueId(sessionId), session.version);
      if (changed.changes !== 1) throw new WalletIntegrationStoreError("WALLETCONNECT_SESSION_REFUSED");
      this.db.query(`
        UPDATE wk_integration_interactions
        SET status='REVOKED',version=version+1,completed_at=NULL
        WHERE connection_id=? AND kind='walletconnect' AND status='PENDING'
          AND json_extract(binding_json,'$.session_id')=?
          AND json_extract(binding_json,'$.session_binding_hash')=?
          AND CAST(json_extract(binding_json,'$.session_version') AS INTEGER)=?
      `).run(
        session.connection_id,
        opaqueId(sessionId),
        session.binding_hash,
        session.version,
      );
    })();
  }

  /** Evidence-retention boundary for an output that returned after a durable
   * interaction was revoked/expired. It does not authorize work or reactivate
   * the interaction; callers must supply already-verified protocol output. */
  importVerifiedExternalArtifactEvidence(input: {
    readonly id: string;
    readonly interactionId: string;
    readonly kind: InteractionKind;
    readonly intentHash: string;
    readonly requestHash: string;
    readonly artifactHash: string;
    readonly externalIdHash?: string;
  }): void {
    const interaction = this.db.query(`
      SELECT i.intent_hash,i.request_hash,i.status,i.kind,i.connection_id,i.signer_id
      FROM wk_integration_interactions i WHERE i.id=?
    `).get(opaqueId(input.interactionId)) as {
      intent_hash: string;
      request_hash: string;
      status: string;
      kind: InteractionKind;
      connection_id: string;
      signer_id: string | null;
    } | null;
    if (
      !interaction || !["COMPLETED", "REVOKED", "EXPIRED"].includes(interaction.status) ||
      interaction.kind !== input.kind || interaction.intent_hash !== digest(input.intentHash) ||
      interaction.request_hash !== digest(input.requestHash)
    ) throw new WalletIntegrationStoreError("EXTERNAL_ARTIFACT_BINDING_REFUSED");
    this.db.query(`
      INSERT INTO wk_late_external_artifact_evidence(
        id,interaction_id,kind,intent_hash,request_hash,artifact_hash,external_id_hash,observed_at
      ) VALUES(?,?,?,?,?,?,?,?)
    `).run(
      opaqueId(input.id),
      opaqueId(input.interactionId),
      input.kind,
      digest(input.intentHash),
      digest(input.requestHash),
      digest(input.artifactHash),
      input.externalIdHash ? digest(input.externalIdHash) : null,
      this.#nowIso(),
    );
  }

  createErc4337Operation(input: unknown, interactionId: string): void {
    const operation = parseErc4337UserOperationRequest(input);
    const at = this.#nowIso();
    if (operation.expires_at <= at) throw new WalletIntegrationStoreError("ERC4337_INTERACTION_BINDING_REFUSED");
    const interaction = this.db.query(`
      SELECT i.intent_hash,i.request_hash,i.status,i.kind,i.connection_id,i.signer_id,i.expires_at,i.binding_json
      FROM wk_integration_interactions i WHERE i.id=?
    `).get(opaqueId(interactionId)) as {
      intent_hash: string;
      request_hash: string;
      status: string;
      kind: string;
      connection_id: string;
      signer_id: string | null;
      expires_at: string;
      binding_json: string;
    } | null;
    let interactionBinding: z.infer<typeof erc4337InteractionBindingSchema> | null = null;
    try {
      interactionBinding = erc4337InteractionBindingSchema.parse(interaction ? JSON.parse(interaction.binding_json) : null);
    } catch {
      interactionBinding = null;
    }
    if (
      !interaction || !interactionBinding || interaction.kind !== "erc4337" ||
      !["PENDING", "COMPLETED"].includes(interaction.status) ||
      interaction.intent_hash !== operation.intent_hash ||
      interaction.request_hash !== operation.authorization.request_hash ||
      interaction.expires_at !== operation.expires_at ||
      interactionBinding.binding_hash !== operation.user_operation_binding_hash ||
      !this.#activeConnectionRow(interaction.connection_id, "ERC4337") ||
      (interaction.signer_id !== null && !this.#activeSignerRow(interaction.signer_id, interaction.connection_id, "ERC4337"))
    ) throw new WalletIntegrationStoreError("ERC4337_INTERACTION_BINDING_REFUSED");
    this.db.query(`
      INSERT INTO wk_erc4337_operations(
        id,interaction_id,chain_id,entry_point,sender,nonce_key,nonce_sequence,binding_hash,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?, 'PREPARED',?,?)
    `).run(
      operation.request_id,
      opaqueId(interactionId),
      operation.chain_id,
      operation.entry_point,
      operation.user_operation.sender,
      operation.nonce_key,
      operation.nonce_sequence,
      operation.user_operation_binding_hash,
      at,
      at,
    );
  }

  transitionErc4337Operation(input: {
    readonly id: string;
    readonly from: Erc4337Status;
    readonly to: Erc4337Status;
  }): void {
    const allowed: Readonly<Record<Erc4337Status, readonly Erc4337Status[]>> = {
      PREPARED: ["SIGNED", "FAILED"],
      SIGNED: ["SUBMITTED", "FAILED"],
      // A bundler response is not chain inclusion. Terminal transitions remain
      // unreachable until a receipt/consensus evidence ledger is installed.
      SUBMITTED: ["AMBIGUOUS"],
      AMBIGUOUS: [],
      SETTLED: [], FAILED: [], REVERTED: [],
    };
    if (!allowed[input.from].includes(input.to)) throw new WalletIntegrationStoreError("ERC4337_TRANSITION_REFUSED");
    const changed = this.db.query(`
      UPDATE wk_erc4337_operations AS o SET status=?,updated_at=?
      WHERE id=? AND status=? AND EXISTS (
        SELECT 1 FROM wk_integration_interactions i
        JOIN wk_integration_connections c ON c.connection_id=i.connection_id
        JOIN wk_connections kc ON kc.id=c.connection_id
        WHERE i.id=o.interaction_id AND c.kind='ERC4337' AND c.status='ACTIVE' AND kc.status='ACTIVE'
          AND (i.signer_id IS NULL OR EXISTS (
            SELECT 1 FROM wk_integration_signers s JOIN wk_signers ks ON ks.id=s.signer_id
            WHERE s.signer_id=i.signer_id AND s.connection_id=i.connection_id AND s.status='ACTIVE' AND ks.status='ACTIVE'
          ))
      )
    `).run(input.to, this.#nowIso(), opaqueId(input.id), input.from);
    if (changed.changes !== 1) throw new WalletIntegrationStoreError("ERC4337_TRANSITION_REFUSED");
  }

  #activeFiatConsent(consentId: string): {
    readonly id: string;
    readonly connection_id: string;
    readonly provider_id: string;
    readonly account_ref_hash: Sha256Digest;
    readonly expires_at: string | null;
  } | null {
    const at = this.#nowIso();
    return this.db.query(`
      SELECT f.id,f.connection_id,f.provider_id,f.account_ref_hash,f.expires_at
      FROM wk_fiat_consents f
      JOIN wk_integration_connections c ON c.connection_id=f.connection_id
      JOIN wk_connections kc ON kc.id=c.connection_id
      WHERE f.id=? AND f.status='ACTIVE' AND (f.expires_at IS NULL OR f.expires_at>?)
        AND c.kind='FIAT' AND c.status='ACTIVE' AND kc.status='ACTIVE'
    `).get(opaqueId(consentId), at) as {
      id: string;
      connection_id: string;
      provider_id: string;
      account_ref_hash: Sha256Digest;
      expires_at: string | null;
    } | null;
  }

  createFiatConsent(input: {
    readonly id: string;
    readonly connectionId: string;
    readonly providerId: string;
    readonly consentRefHash: string;
    readonly accountRefHash: string;
    readonly expiresAt?: string;
  }): void {
    if (!this.#activeConnectionRow(input.connectionId, "FIAT")) {
      throw new WalletIntegrationStoreError("FIAT_CONSENT_REFUSED");
    }
    const expiresAt = input.expiresAt
      ? this.#assertFuture(input.expiresAt, "FIAT_CONSENT_REFUSED")
      : null;
    this.db.query(`
      INSERT INTO wk_fiat_consents(
        id,connection_id,provider_id,consent_ref_hash,account_ref_hash,status,expires_at,created_at
      ) VALUES(?,?,?,?,?,'ACTIVE',?,?)
    `).run(
      opaqueId(input.id),
      opaqueId(input.connectionId),
      opaqueId(input.providerId),
      digest(input.consentRefHash),
      digest(input.accountRefHash),
      expiresAt,
      this.#nowIso(),
    );
  }

  createFiatAuthorizationSession(input: unknown, consentId: string): void {
    const binding = parseFiatRedirectBinding(input);
    const consent = this.#activeFiatConsent(consentId);
    const expiresAt = this.#assertFuture(binding.expires_at, "FIAT_AUTHORIZATION_SESSION_REFUSED");
    if (
      !consent || binding.provider_id !== consent.provider_id ||
      (consent.expires_at !== null && expiresAt > consent.expires_at)
    ) throw new WalletIntegrationStoreError("FIAT_AUTHORIZATION_SESSION_REFUSED");
    this.db.query(`
      INSERT INTO wk_fiat_authorization_sessions(
        id,consent_id,provider_id,redirect_uri_hash,issuer_hash,state_hash,pkce_verifier_hash,status,expires_at
      ) VALUES(?,?,?,?,?,?,?,'PENDING',?)
    `).run(
      binding.flow_id,
      opaqueId(consentId),
      binding.provider_id,
      binding.redirect_uri_hash,
      binding.issuer_hash,
      binding.state_hash,
      binding.pkce_verifier_hash,
      expiresAt,
    );
  }

  consumeFiatAuthorizationSession(input: unknown, consentId: string): void {
    const binding = parseFiatRedirectBinding(input);
    const consent = this.#activeFiatConsent(consentId);
    const at = this.#nowIso();
    if (!consent || consent.provider_id !== binding.provider_id) {
      throw new WalletIntegrationStoreError("FIAT_AUTHORIZATION_SESSION_REFUSED");
    }
    const changed = this.db.query(`
      UPDATE wk_fiat_authorization_sessions
      SET status='CONSUMED',consumed_at=?
      WHERE id=? AND consent_id=? AND provider_id=? AND redirect_uri_hash=? AND issuer_hash=?
        AND state_hash=? AND pkce_verifier_hash=? AND expires_at=? AND status='PENDING' AND expires_at>?
    `).run(
      at,
      binding.flow_id,
      opaqueId(consentId),
      binding.provider_id,
      binding.redirect_uri_hash,
      binding.issuer_hash,
      binding.state_hash,
      binding.pkce_verifier_hash,
      binding.expires_at,
      at,
    );
    if (changed.changes !== 1) throw new WalletIntegrationStoreError("FIAT_AUTHORIZATION_SESSION_REFUSED");
  }

  putFiatPayee(input: {
    readonly id: string;
    readonly consentId: string;
    readonly beneficiaryRefHash: string;
  }): void {
    if (!this.#activeFiatConsent(input.consentId)) throw new WalletIntegrationStoreError("FIAT_PAYEE_REFUSED");
    this.db.query(`
      INSERT INTO wk_fiat_payees(id,consent_id,beneficiary_ref_hash,status,created_at)
      VALUES(?,?,?,'ACTIVE',?)
    `).run(
      opaqueId(input.id),
      opaqueId(input.consentId),
      digest(input.beneficiaryRefHash),
      this.#nowIso(),
    );
  }

  prepareFiatRequestAttempt(input: {
    readonly id: string;
    readonly consentId: string;
    readonly payeeId: string;
    readonly authorization: unknown;
  }): Readonly<{ attemptId: string; created: boolean }> {
    const authorization = parseRegulatedFiatPaymentAuthorization(input.authorization);
    const consent = this.#activeFiatConsent(input.consentId);
    const expiresAt = this.#assertFuture(authorization.expires_at, "FIAT_ATTEMPT_BINDING_REFUSED");
    const payee = this.db.query(`
      SELECT consent_id,beneficiary_ref_hash,status FROM wk_fiat_payees WHERE id=?
    `).get(opaqueId(input.payeeId)) as {
      consent_id: string;
      beneficiary_ref_hash: string;
      status: string;
    } | null;
    if (
      !consent || !payee || payee.status !== "ACTIVE" || payee.consent_id !== input.consentId ||
      consent.provider_id !== authorization.provider_id ||
      consent.connection_id !== authorization.connection_id ||
      consent.account_ref_hash !== authorization.provider_account_ref_hash ||
      payee.beneficiary_ref_hash !== authorization.beneficiary_ref_hash ||
      (consent.expires_at !== null && expiresAt > consent.expires_at)
    ) throw new WalletIntegrationStoreError("FIAT_ATTEMPT_BINDING_REFUSED");

    if (authorization.redirect_flow_id) {
      const redirect = this.db.query(`
        SELECT consent_id,provider_id,status,expires_at FROM wk_fiat_authorization_sessions WHERE id=?
      `).get(authorization.redirect_flow_id) as {
        consent_id: string;
        provider_id: string;
        status: string;
        expires_at: string;
      } | null;
      if (
        !redirect || redirect.consent_id !== input.consentId || redirect.provider_id !== authorization.provider_id ||
        redirect.status !== "CONSUMED" || redirect.expires_at <= this.#nowIso()
      ) throw new WalletIntegrationStoreError("FIAT_ATTEMPT_BINDING_REFUSED");
    }

    const authorizationProjection: JsonValue = {
      schema_version: authorization.schema_version,
      authorization_id: authorization.authorization_id,
      intent_hash: authorization.intent_hash,
      provider_id: authorization.provider_id,
      connection_id: authorization.connection_id,
      provider_account_ref_hash: authorization.provider_account_ref_hash,
      beneficiary_ref_hash: authorization.beneficiary_ref_hash,
      amount: authorization.amount as unknown as JsonValue,
      provider_idempotency_key_hash: authorization.provider_idempotency_key_hash,
      expires_at: authorization.expires_at,
      ...(authorization.fee_ceiling_atomic === undefined
        ? {} : { fee_ceiling_atomic: authorization.fee_ceiling_atomic }),
      ...(authorization.redirect_flow_id === undefined
        ? {} : { redirect_flow_id: authorization.redirect_flow_id }),
    };
    const authorizationHash = hashCanonicalContract(authorizationProjection);
    const existing = this.db.query(`
      SELECT id,consent_id,payee_id,authorization_id,connection_id,provider_id,redirect_flow_id,
             intent_hash,authorization_hash,provider_idempotency_key_hash,expires_at
      FROM wk_fiat_request_attempts
      WHERE consent_id=? AND provider_idempotency_key_hash=?
    `).get(input.consentId, authorization.provider_idempotency_key_hash) as Record<string, string | null> | null;
    if (existing) {
      if (
        existing.payee_id !== input.payeeId || existing.authorization_id !== authorization.authorization_id ||
        existing.connection_id !== authorization.connection_id || existing.provider_id !== authorization.provider_id ||
        existing.redirect_flow_id !== (authorization.redirect_flow_id ?? null) ||
        existing.intent_hash !== authorization.intent_hash || existing.authorization_hash !== authorizationHash ||
        existing.expires_at !== authorization.expires_at
      ) throw new WalletIntegrationStoreError("FIAT_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ attemptId: existing.id!, created: false });
    }

    const attemptId = opaqueId(input.id);
    this.db.query(`
      INSERT INTO wk_fiat_request_attempts(
        id,consent_id,payee_id,authorization_id,connection_id,provider_id,redirect_flow_id,
        intent_hash,authorization_hash,provider_idempotency_key_hash,outcome,expires_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'PREPARED',?,?)
    `).run(
      attemptId,
      opaqueId(input.consentId),
      opaqueId(input.payeeId),
      authorization.authorization_id,
      authorization.connection_id,
      authorization.provider_id,
      authorization.redirect_flow_id ?? null,
      authorization.intent_hash,
      authorizationHash,
      authorization.provider_idempotency_key_hash,
      expiresAt,
      this.#nowIso(),
    );
    return Object.freeze({ attemptId, created: true });
  }

  /** Compatibility alias. Direct terminal outcomes are intentionally not part
   * of this API; the only durable pre-I/O state is PREPARED. */
  appendFiatRequestAttempt(input: {
    readonly id: string;
    readonly consentId: string;
    readonly payeeId: string;
    readonly authorization: unknown;
    readonly outcome: "PREPARED";
  }): Readonly<{ attemptId: string; created: boolean }> {
    if (input.outcome !== "PREPARED") throw new WalletIntegrationStoreError("FIAT_DIRECT_OUTCOME_REFUSED");
    return this.prepareFiatRequestAttempt(input);
  }

  /** Append-only transport evidence for I/O that began only after the matching
   * immutable PREPARED row committed. Revocation after I/O cannot erase the
   * response; this method authorizes no new provider action. */
  appendFiatTransportOutcomeEvidence(input: {
    readonly id: string;
    readonly attemptId: string;
    readonly sequence: number;
    readonly outcome: "SUBMITTED" | "AMBIGUOUS";
    readonly responseHash: string;
    readonly providerPaymentRefHash?: string;
    readonly occurredAt: string;
  }): void {
    if (input.outcome !== "SUBMITTED" && input.outcome !== "AMBIGUOUS") {
      throw new WalletIntegrationStoreError("FIAT_DIRECT_OUTCOME_REFUSED");
    }
    if (input.outcome === "SUBMITTED" && !input.providerPaymentRefHash) {
      throw new WalletIntegrationStoreError("FIAT_TRANSPORT_OUTCOME_REFUSED");
    }
    const occurredAt = timestamp(input.occurredAt);
    const at = this.#nowIso();
    if (occurredAt > at || input.sequence !== 0) {
      throw new WalletIntegrationStoreError("FIAT_TRANSPORT_OUTCOME_REFUSED");
    }
    const attempt = this.db.query(`
      SELECT id,connection_id,provider_id,authorization_hash,outcome
      FROM wk_fiat_request_attempts WHERE id=?
    `).get(opaqueId(input.attemptId)) as Record<string, string | null> | null;
    const next = this.db.query(`
      SELECT COALESCE(MAX(sequence)+1,0) next_sequence FROM wk_fiat_request_outcomes WHERE attempt_id=?
    `).get(opaqueId(input.attemptId)) as { next_sequence: number };
    if (
      !attempt || attempt.outcome !== "PREPARED" || !attempt.connection_id ||
      !attempt.provider_id || !attempt.authorization_hash || input.sequence !== next.next_sequence
    ) throw new WalletIntegrationStoreError("FIAT_TRANSPORT_OUTCOME_REFUSED");
    this.db.query(`
      INSERT INTO wk_fiat_request_outcomes(
        id,attempt_id,sequence,outcome,provider_payment_ref_hash,response_hash,occurred_at
      ) VALUES(?,?,?,?,?,?,?)
    `).run(
      opaqueId(input.id),
      opaqueId(input.attemptId),
      input.sequence,
      input.outcome,
      input.providerPaymentRefHash ? digest(input.providerPaymentRefHash) : null,
      digest(input.responseHash),
      occurredAt,
    );
  }

  /** Trusted verifier import. The caller must first authenticate the webhook
   * signature (or obtain equivalent read-only provider observation evidence).
   * This method only binds and retains the sanitized verifier output. */
  importVerifiedFiatWebhookEvidence(input: unknown, evidenceId: string, attemptId: string): void {
    const evidence = parseFiatWebhookEvidence(input);
    const paymentRefHash = hashUtf8(evidence.provider_payment_ref);
    const binding = this.db.query(`
      SELECT a.provider_id,o.provider_payment_ref_hash
      FROM wk_fiat_request_attempts a
      JOIN wk_fiat_request_outcomes o ON o.attempt_id=a.id
      WHERE a.id=? AND o.provider_payment_ref_hash=?
      ORDER BY o.sequence DESC LIMIT 1
    `).get(opaqueId(attemptId), paymentRefHash) as {
      provider_id: string;
      provider_payment_ref_hash: string;
    } | null;
    if (!binding || binding.provider_id !== evidence.provider_id) {
      throw new WalletIntegrationStoreError("FIAT_WEBHOOK_BINDING_REFUSED");
    }
    this.db.query(`
      INSERT INTO wk_fiat_webhook_evidence(
        id,attempt_id,provider_id,delivery_id,event_type,provider_payment_ref,
        provider_payment_ref_hash,payload_hash,signature_key_id,signature_hash,
        occurred_at,received_at,state
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      opaqueId(evidenceId),
      opaqueId(attemptId),
      evidence.provider_id,
      evidence.delivery_id,
      evidence.event_type,
      paymentRefHash,
      paymentRefHash,
      evidence.payload_hash,
      evidence.signature_key_id,
      evidence.signature_hash,
      evidence.occurred_at,
      evidence.received_at,
      evidence.state,
    );
  }
}
