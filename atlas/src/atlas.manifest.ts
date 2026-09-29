/** The Atlas manifest — CashLoom's codebase told as ideas, not as a file tree.
 *
 *  This supplies the explanatory text for the interactive atlas.
 *  The CODE it points at is imported raw at build time (Vite `?raw`) from the
 *  real ../../sovereign/src files, so what a reader sees is always the actual
 *  source at build time. Explanations still need review as behavior changes.
 *
 *  Each `loadBearing` marker is a verbatim substring of the real source; the
 *  atlas finds it in the imported code and attaches the note. Markers survive
 *  line-number churn because they match text, not positions.
 */

export interface LoadBearing {
  /** Verbatim substring of the module's source — the line the atlas spotlights. */
  marker: string;
  /** Why that line carries weight. */
  note: string;
}

export interface Module {
  id: string;
  title: string;
  subtitle: string;
  /** raw-import specifier(s), relative to atlas/src, of the real source. */
  sources: string[];
  /** The idea in one breath. */
  idea: string;
  /** Why the module is shaped the way it is — 2–3 short paragraphs. */
  doctrine: string[];
  loadBearing: LoadBearing[];
  /** ids of modules this one leans on or hands off to. */
  relatesTo: string[];
  /** thread coordinate for the woven map (0–1, 0–1). */
  weave: { x: number; y: number };
}

export interface Decision {
  question: string;
  options: { label: string; verdict: "chosen" | "rejected"; note: string }[];
  because: string;
  /** where the decision is written into the code. */
  livesIn: string;
}

export interface RoadmapThread {
  title: string;
  status: "next" | "planned" | "considering";
  mindset: string;
  whyNotYet: string;
}

export const PHILOSOPHY = {
  name: "CashLoom",
  line: "Money you can read. Code you can read.",
  creed: [
    "Your workspace — one owner runs a local server and keeps account records on their machine.",
    "Your keys — supported payments sign locally; CashLoom does not take custody of funds.",
    "Explicit actions — read connections and payment actions have separate permissions and review steps.",
    "Defined payment routes — local-key Base ETH, Base USDC and Bitcoin are implemented; bank payments and external-wallet execution are not enabled.",
    "Visible boundaries — provider reads and transaction broadcasts use external services; the local database is not encrypted as a whole.",
    "Developer pilot — installation requires access to the private repository. The browser planner and public insights are open to everyone.",
  ],
  invitation:
    "Follow an idea into the selected source modules bundled with this page. They show the implementation at build time; the surrounding explanations describe its purpose and current limits.",
};

export const MODULES: Module[] = [
  {
    id: "the-node",
    title: "The Node",
    subtitle: "A local workspace server.",
    sources: ["../../sovereign/src/index.ts?raw"],
    idea: "A single Bun process serves the private workspace API and UI from one origin, bound to loopback by default.",
    doctrine: [
      "The private workspace is a program you run. Its node binds to 127.0.0.1 by default, limiting ordinary network access to the local machine. An unlocked owner session controls access; this is separate from the public planner and information website.",
      "One process serves the workspace API and interface from the same origin. Provider reads and transaction broadcasts can still contact external services, depending on the actions and connections you choose.",
      "Private account and payment routes require an unlocked session, with additional owner and permission checks for supported actions. The node also exposes public information and vault setup/status routes; those do not authorize spending.",
    ],
    loadBearing: [
      { marker: "const HOSTNAME = process.env.CASHLOOM_BIND ?? \"127.0.0.1\"", note: "The default binding is loopback. Changing this setting changes the network exposure and needs a separate deployment review." },
      { marker: "requires an unlocked vault session", note: "Session middleware rejects unauthenticated private requests. Action-specific permissions and vault checks are additional boundaries." },
      { marker: "Errors carry instructions, never secrets", note: "Errors should explain a useful next step without exposing key material. Provider responses and new error paths still need review." },
    ],
    relatesTo: ["the-vault", "pay", "the-read-seam"],
    weave: { x: 0.5, y: 0.12 },
  },
  {
    id: "the-vault",
    title: "The Vault",
    subtitle: "Protect local key material.",
    sources: ["../../sovereign/src/vault.ts?raw"],
    idea: "The vault seals signing keys and supported provider tokens for storage, then makes them available to authorized operations in the unlocked local process.",
    doctrine: [
      "The vault uses Argon2id to derive a master key from your passphrase and AES-256-GCM to seal key material before database storage. Plaid sandbox access tokens are also encrypted with a binding to their connection. Account and activity records are separate: the whole workspace database is not encrypted.",
      "Signing uses decrypted key material inside the local process and broadcasts the signed transaction. This limits the intended exposure of key material; it does not make a compromised device or runtime safe.",
      "There is no passphrase reset or recovery service. A database backup preserves stored state but does not replace the passphrase needed to unlock it. Keep the passphrase and any independent key backups securely.",
    ],
    loadBearing: [
      { marker: "The passphrase IS custody", note: "There is no passphrase recovery service. Keep a separate secure backup of the keys you control." },
      { marker: "One error for every wrong-passphrase shape — no oracle", note: "The unlock path uses the same error message for wrong-passphrase cases to reduce information disclosed by failures." },
      { marker: "lives for the duration of one signature", note: "Signing paths limit decrypted key use and clear working buffers afterward. Runtime memory can have other copies; this is not a universal erasure guarantee." },
    ],
    relatesTo: ["pay", "the-node"],
    weave: { x: 0.22, y: 0.4 },
  },
  {
    id: "the-connection-boundary",
    title: "The Connection Boundary",
    subtitle: "Separate integration code from readiness.",
    sources: [
      "../../sovereign/src/wallet/integration-catalog.ts?raw",
      "../../sovereign/src/wallet/integrations/requests.ts?raw",
      "../../sovereign/src/wallet/adapters/webauthn-verifier.ts?raw",
    ],
    idea: "The integration foundation binds supported request formats to an owner's intent. Having a parser or verifier does not mean an external-wallet or bank-payment flow is enabled.",
    doctrine: [
      "Prepared requests record the intended action, authorization and expiry. The design calls for independent validation of wallet or provider output before it is accepted; an SDK callback alone is not evidence that an approved payment settled.",
      "Signed transaction bytes and provider-managed operations need different execution and recovery paths. Durable records, replay controls and independent observations are requirements of this foundation, not evidence that every adapter is ready to execute.",
      "Passkey, hardware EVM, WalletConnect, ERC-4337 and pay-by-bank execution remain policy-blocked. Their required verification and persistence work is separate from the enabled Plaid sandbox read flow and the implemented local-key payment routes.",
    ],
    loadBearing: [
      { marker: "atomic_verified_persistence_enabled: false", note: "This readiness flag records a missing execution requirement. A configured adapter still cannot be presented as an enabled payment route." },
      { marker: "authorization must bind the exact unsigned ERC-4337 operation", note: "The request validation requires the unsigned operation to match its authorization. This is one check within a still-disabled smart-account flow." },
      { marker: "Enterprise attestation is a separate policy product and is intentionally refused here.", note: "Accepting the supported attestation-none ceremony does not establish a device brand or hardware security assurance." },
    ],
    relatesTo: ["the-node", "the-vault", "the-outbound-seam", "the-read-seam"],
    weave: { x: 0.5, y: 0.34 },
  },
  {
    id: "pay",
    title: "pay()",
    subtitle: "Prepare, review, then confirm.",
    sources: ["../../sovereign/src/pay.ts?raw"],
    idea: "Supported payments separate an unsigned quote from explicit confirmation. Recorded state and replay checks reduce duplicate-execution risk; a submission still needs settlement evidence.",
    doctrine: [
      "The payment flow separates preparation from execution. Quote first: the estimated network fee is shown with nothing yet signed. An explicit confirmation then requests execution of that quoted intent.",
      "The supported flow records failures and does not automatically submit a new payment after a send failure. An uncertain network result needs investigation before someone decides whether another payment is appropriate.",
      "State is recorded around signing and submission so an interrupted attempt can be distinguished from an unused quote. These records support recovery; they do not prove whether a network accepted or confirmed a transaction.",
    ],
    loadBearing: [
      { marker: "NEVER auto-retried", note: "A send failure is surfaced for review rather than starting an automatic new payment attempt." },
      { marker: "Point of no return is INSIDE send()", note: "Persisting the transition before submission helps identify interrupted attempts that need investigation." },
      { marker: "only a fresh quote can be confirmed", note: "Confirmation checks quote state and expiry. A fresh quote remains an estimate, not a settlement promise." },
    ],
    relatesTo: ["the-outbound-seam", "the-vault", "the-ledger"],
    weave: { x: 0.5, y: 0.52 },
  },
  {
    id: "the-outbound-seam",
    title: "The Outbound Seam",
    subtitle: "Movement lives behind a stricter door.",
    sources: ["../../sovereign/src/senders/types.ts?raw", "../../sovereign/src/senders/evm.sender.ts?raw"],
    idea: "PaymentSender defines the legacy local-key sending interface, separate from balance and activity reads. Supported execution paths validate requests, disclose fees and record submission evidence.",
    doctrine: [
      "Reading records and authorizing a payment have different consequences. Separate interfaces make that distinction visible in code. Runtime validation, permission checks, credential scope and implementation review are still needed.",
      "Implemented local-key routes cover Base L2 (ETH + USDC) and Bitcoin on-chain. Bitcoin has its own module because UTXO selection and change need separate validation. The quote uses the public address; local key material is used during signing.",
      "The implemented payment routes disclose network fees and currently add no CashLoom service fee. Provider charges and future routes need their own disclosure.",
    ],
    loadBearing: [
      { marker: "a connector that could initiate movement does not belong behind the read interface", note: "The interfaces separate intended read and send operations. TypeScript does not prevent an implementation from making additional network calls." },
      { marker: "Disclose the UPPER BOUND", note: "The supported quote exposes its fee estimate or cap for review. Network conditions and execution checks can still prevent submission." },
      { marker: "the private key never touches the network", note: "The intended local-key path sends the signed transaction rather than the signing key. This depends on the implementation and security of the local runtime." },
    ],
    relatesTo: ["pay", "the-vault", "btc-sending"],
    weave: { x: 0.78, y: 0.4 },
  },
  {
    id: "btc-sending",
    title: "BTC Sending",
    subtitle: "Sign exactly what was disclosed.",
    sources: ["../../sovereign/src/senders/btc.sender.ts?raw"],
    idea: "The supported Bitcoin path persists selected inputs, outputs and fee at quote time, then validates the signed transaction against that selection before broadcast.",
    doctrine: [
      "Bitcoin transaction fees are the difference between input and output amounts. The quote records a concrete selection so confirmation can check the same destinations, change and fee instead of silently choosing a different transaction.",
      "Signing revalidates the stored amounts and selection, and checks that the signed transaction matches the authorized request and expected fee. This is scoped to the implemented native SegWit account path; it is not a guarantee against every corrupted state or compromised dependency.",
      "Public indexer data can be wrong or unavailable. SegWit signatures bind input amounts, which helps reject some inconsistent data, but does not establish all indexer claims. The signed transaction ID is recorded before broadcast, and an unanswered submission retains an uncertain outcome for later investigation.",
    ],
    loadBearing: [
      { marker: "Re-selection at confirm is never a fallback", note: "The supported confirmation path refuses to replace the quoted input selection silently." },
      { marker: "BEFORE the network hears the tx", note: "Saving the signed transaction ID before broadcast provides an identifier for later checks. Those checks still depend on available network evidence." },
      { marker: "the double-pay lever", note: "An unanswered broadcast is an uncertain outcome. Recording it as unknown discourages a second payment before the first is understood." },
    ],
    relatesTo: ["the-outbound-seam", "pay", "the-vault", "the-read-seam"],
    weave: { x: 0.88, y: 0.56 },
  },
  {
    id: "the-read-seam",
    title: "The Read Seam",
    subtitle: "A dedicated interface for account reads.",
    sources: ["../../sovereign/src/connectors/types.ts?raw", "../../sovereign/src/connectors/agenttool.connector.ts?raw"],
    idea: "RailConnector defines balance and transaction reads for supported Stripe, bank-data, Bitcoin, Ethereum and AgentTool sources. Its interface has no payment method.",
    doctrine: [
      "The legacy RailConnector contract exposes balance and transaction reads, without a send method. This describes the intended operations; it does not sandbox connector code or restrict what a provider credential could authorize outside that contract.",
      "Legacy connectors store a credential reference and resolve supported environment-variable names locally. The separate Plaid sandbox flow instead stores encrypted access tokens in the vault. Both approaches require appropriate provider permissions and care with the local runtime.",
      "The connector contract carries amounts as integer minor-unit strings with an explicit currency and scale. That preserves a value's representation; the value can still be stale, incomplete or wrong at its source. Each provider supports a particular scope of accounts and activity.",
    ],
    loadBearing: [
      { marker: "nothing behind this interface can move money", note: "This comment states the design intent. The interface omits sending, while runtime behavior and credential permissions need separate enforcement and review." },
      { marker: "credentialRef is the NAME of an environment variable", note: "This legacy connector field stores an environment-variable reference. It does not describe the encrypted provider-token storage used by Plaid sandbox." },
      { marker: "SIGNED integer minor-unit string", note: "An explicit scale and integer-string amount avoid floating-point storage loss in this contract. They do not verify the provider's underlying observation." },
    ],
    relatesTo: ["sync", "the-node"],
    weave: { x: 0.5, y: 0.78 },
  },
  {
    id: "sync",
    title: "Sync",
    subtitle: "Import records with identity and currency checks.",
    sources: ["../../sovereign/src/sync.ts?raw"],
    idea: "Sync brings supported connector balances and transactions into the local ledger, checking currency and using provider identifiers to avoid repeated imports of the same record.",
    doctrine: [
      "Provider identifiers let the importer recognize records it has seen before. Legacy connector sync ignores repeated identifiers, while the normalized read model can update revised records and record provider removals. Different identifiers can still refer to the same real-world activity.",
      "Currency and decimal-scale checks reject values that do not fit the destination account. Provider status, observation dates and unknown balance fields remain important even when an amount passes those checks.",
      "Legacy sync requests an overlap before the newest recorded transaction to catch some late records. Plaid sandbox uses its separate cursor-based sync. Neither approach proves that a provider returned a complete history, and manual CSV matching has its own review rules.",
    ],
    loadBearing: [
      { marker: "refusing to mix currencies", note: "The legacy import checks that a transaction's currency matches the account instead of converting it implicitly." },
      { marker: "refusing to mis-scale", note: "The importer requires the expected decimal scale so the same integer is not interpreted as a different amount." },
      { marker: "INSERT OR IGNORE", note: "This legacy insert avoids duplicate rows for an existing account/provider identifier. Other sync paths can revise records, and unstable provider identifiers still need attention." },
    ],
    relatesTo: ["the-read-seam", "the-ledger"],
    weave: { x: 0.32, y: 0.66 },
  },
  {
    id: "the-ledger",
    title: "The Ledger",
    subtitle: "Local records with explicit units.",
    sources: ["../../sovereign/src/db.ts?raw"],
    idea: "Bun's embedded SQLite stores the workspace's main records without a separate database server. Monetary record fields use integer strings with an explicit currency and decimal scale.",
    doctrine: [
      "The main database defaults to ~/.cashloom/sovereign.db and can use a configured data directory. SQLite uses write-ahead-log sidecars while running; the trade simulation has a separate database. Use the local-data backup command for consistent snapshots of the supported databases.",
      "An account record describes money held elsewhere; it does not hold funds itself. Integer-string storage avoids rounding the recorded minor units, but cannot establish whether a manual entry or provider balance is accurate, current or spendable.",
      "Payment and activity records retain the available state and evidence. A quoted amount, submitted transaction and confirmed settlement are different facts. Recorded activity is also separate from an observed account balance.",
    ],
    loadBearing: [
      { marker: "integer minor units as TEXT", note: "These monetary fields store integer strings, preserving their represented units without relying on floating-point storage." },
      { marker: "UNIQUE INDEX IF NOT EXISTS idx_tx_dedupe", note: "The unique index prevents repeated account/provider identifiers. It does not detect every duplicate real-world transaction or validate provider accuracy." },
      { marker: "plaintext key material NEVER touches this table", note: "The intended vault write path stores encrypted key blobs here. Other database records remain unencrypted, and backups need private storage." },
    ],
    relatesTo: ["sync", "pay", "the-vault"],
    weave: { x: 0.68, y: 0.66 },
  },
];

export const DECISIONS: Decision[] = [
  {
    question: "Should reading a balance and sending money share one interface?",
    options: [
      { label: "One interface with a send() method", verdict: "rejected", note: "Makes payment operations part of a contract used for observing accounts." },
      { label: "Two parallel seams: RailConnector (read) + PaymentSender (write)", verdict: "chosen", note: "Makes intended read and payment operations distinct, alongside runtime authorization and validation." },
      { label: "A separate sending microservice", verdict: "rejected", note: "Overkill for a program meant to run on one laptop." },
    ],
    because: "Separate types help callers choose the intended operation. They are not a security sandbox: implementation review, provider credential permissions and runtime action checks are still necessary.",
    livesIn: "the-read-seam · the-outbound-seam",
  },
  {
    question: "Where do private keys live?",
    options: [
      { label: "A custodial server holds them", verdict: "rejected", note: "Would give a hosted operator responsibility for signing keys and recovery." },
      { label: "Local vault: Argon2id(passphrase) → AES-256-GCM", verdict: "chosen", note: "Seals key material for storage and supports local signing. The unlocked process and device remain part of the security boundary." },
      { label: "Plaintext local file", verdict: "rejected", note: "Would expose usable key material to anyone who can read that file or its copies." },
    ],
    because: "The workspace keeps signing under its local owner's control. Encryption protects stored key material, while the owner must keep the passphrase and backups secure; there is no hosted recovery service.",
    livesIn: "the-vault",
  },
  {
    question: "How does a payment actually happen?",
    options: [
      { label: "One call that sends immediately", verdict: "rejected", note: "Leaves no separate opportunity to review the destination, amount and estimated fee." },
      { label: "Unsigned quote → explicit confirmation", verdict: "chosen", note: "The owner reviews a prepared request before authorizing the supported execution path." },
      { label: "Send with automatic retry on failure", verdict: "rejected", note: "An unanswered submission may already have reached the network; starting another payment can duplicate it." },
    ],
    because: "Review separates intention from execution. Failures and uncertain outcomes are recorded for investigation instead of automatically starting a new payment.",
    livesIn: "pay",
  },
  {
    question: "How is money represented in the code?",
    options: [
      { label: "Floating-point major units (12.34)", verdict: "rejected", note: "Binary floating point cannot represent every required decimal amount or large integer exactly." },
      { label: "Integer minor-unit strings with an explicit decimals field", verdict: "chosen", note: "Preserves represented monetary units for supported currencies and tokens, within each route's validated limits." },
    ],
    because: "Workspace monetary contracts and storage use integer strings and explicit scales to avoid representation loss. Provider parsing, display formatting and the separate browser planner have their own numeric limits and checks. Precision does not establish source accuracy.",
    livesIn: "the-ledger · the-read-seam",
  },
  {
    question: "What database?",
    options: [
      { label: "MongoDB / Postgres server", verdict: "rejected", note: "Would add a separately managed database service to local setup." },
      { label: "bun:sqlite — embedded in the runtime", verdict: "chosen", note: "No separate database server. Use the local-data backup command for a consistent snapshot; copying a live database file alone can miss committed records in its write-ahead log." },
    ],
    because: "An embedded database reduces setup and operational work for a local workspace. It still needs private storage, sufficient disk space and a tested backup process.",
    livesIn: "the-ledger",
  },
  {
    question: "A Bitcoin fee can drift between quote and send. How do you keep the disclosure honest?",
    options: [
      { label: "Re-select coins at send, capped at the quoted fee", verdict: "rejected", note: "Caps one number but signs inputs and change the human never saw — the disclosure covered the whole intent, not just the fee." },
      { label: "Persist the selection and validate it again before broadcast", verdict: "chosen", note: "The supported path checks destinations, change and fee against the authorized selection. Inputs can still be spent elsewhere or rejected by the network." },
      { label: "Build and sign at quote time", verdict: "rejected", note: "Would create a signed payment before the owner had confirmed the review." },
    ],
    because: "The chosen implementation carries the reviewed selection into confirmation and revalidates it before submission. This checks the prepared transaction; it cannot guarantee network acceptance or confirmation.",
    livesIn: "btc-sending",
  },
  {
    question: "SaaS, or sovereign?",
    options: [
      { label: "Hosted shared workspace", verdict: "rejected", note: "Would require hosted account storage, member access and operating responsibilities that are outside the current pilot." },
      { label: "Local workspace controlled by one owner", verdict: "chosen", note: "Records stay on the owner's machine. Local resource limits, provider limits and explicit request bounds still apply." },
    ],
    because: "The workspace runs locally under one owner. There is no hosted shared-workspace service; configured provider connections still depend on external services.",
    livesIn: "the-node",
  },
];

export const ROADMAP: RoadmapThread[] = [
  // Bitcoin sending (PSBT + coin selection) graduated from this list on
  // 2026-07-05 — it lives in the weave now, as the btc-sending module.
  {
    title: "Lightning",
    status: "next",
    mindset: "A possible additional Bitcoin payment route. Node ownership, channel liquidity, fees and recovery would need an explicit design before implementation.",
    whyNotYet: "No Lightning payment route is implemented. The node connection and its operating responsibilities still need to be defined.",
  },
  {
    title: "BTC fee-bump & broadcast reconciliation",
    status: "planned",
    mindset: "The implemented Bitcoin flow records signed transaction identifiers and uses replaceable sequences. A fee-bump interface and broader recovery tooling need additional ownership, fee and state checks.",
    whyNotYet: "There is no owner-facing Bitcoin fee-bump action. Recovery must distinguish another submission of the same transaction from authorizing a replacement or a new payment.",
  },
  {
    title: "Payment pointers — you@cashloom",
    status: "planned",
    mindset: "A future name-resolution layer could make supported payment destinations easier to find. It would still need destination verification, eligibility checks and a clear review step.",
    whyNotYet: "No CashLoom payment-handle service is available. Supported payments currently use the implemented account and address paths.",
  },
  {
    title: "More statement formats",
    status: "considering",
    mindset: "The workspace now previews and imports the supported CSV format into manual accounts locally. Additional bank-specific formats would reduce preparation work while retaining explicit review.",
    whyNotYet: "Each new format needs tested date, amount, currency and duplicate handling. PDF extraction and automatic provider-statement matching are not implemented.",
  },
  {
    title: "Tauri desktop packaging",
    status: "considering",
    mindset: "A packaged desktop application could reduce source-code and terminal setup. Secure updates, local storage, runtime permissions and recovery would remain part of that work.",
    whyNotYet: "A desktop installer is not available. The current developer pilot requires repository access, Bun and local setup.",
  },
  {
    title: "More rails — SEPA, UPI, Solana, and beyond",
    status: "considering",
    mindset: "Additional payment routes could make the workspace useful in more places. Each needs a separate reader, sender, eligibility check and review of its failure modes.",
    whyNotYet: "Each route needs implementation, provider eligibility where applicable, failure recovery and evidence that its execution checks work. An existing interface alone does not make a new route available.",
  },
];

export const HOW_WE_BUILD = {
  title: "The mindset behind the upgrades",
  principles: [
    { name: "Reversible steps, bounded changes", body: "Prefer changes with a clear scope, appropriate checks and a recovery path. Migrations and external actions need their own review because not every effect can be undone." },
    { name: "Make uncertainty visible", body: "Validate supported currencies, scales and request states. Explain unavailable observations and unresolved payment outcomes instead of substituting a zero or claiming success without evidence." },
    { name: "Write useful errors", body: "Aim to explain what failed and what the owner can do next, while keeping credential and key material out of messages. New error paths need review and testing." },
    { name: "Connect explanations to implementation", body: "The selected source modules on this page are bundled at build time. Read them alongside their purpose and limits. Installing the current developer pilot requires private repository access." },
    { name: "Make local ownership practical", body: "The workspace runs on the owner's computer. Easier installation is planned; provider connections still depend on their services, access requirements and availability." },
  ],
};
