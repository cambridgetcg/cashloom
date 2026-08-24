/** The Atlas manifest — CashLoom's codebase told as ideas, not as a file tree.
 *
 *  This is the single source of narrative truth for the interactive atlas.
 *  The CODE it points at is imported raw at build time (Vite `?raw`) from the
 *  real ../../sovereign/src files, so what a reader sees is always the actual
 *  source — the atlas cannot drift from the code it explains.
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
    "Non-custodial — it holds no funds, ever.",
    "Local-first — one process, your machine, no server, no telemetry.",
    "Everyone pays everyone — over every open rail, fiat or crypto.",
    "Pass-through fees only — no CashLoom fee, ever, because there is no intermediary to take one.",
    "Your keys, your data, your machine.",
    "Open — this is the reference implementation; anyone may run, read, fork, or rebuild it.",
  ],
  invitation:
    "Most open source hands you a folder and wishes you luck. This is the opposite: follow an idea, and the real code that enacts it comes with you. Nothing here is a diagram of the code — it IS the code, wired to the reasons it exists.",
};

export const MODULES: Module[] = [
  {
    id: "the-node",
    title: "The Node",
    subtitle: "One process, bound to your machine.",
    sources: ["../../sovereign/src/index.ts?raw"],
    idea: "A single Bun process serves the API and the UI from one origin, listening only to you.",
    doctrine: [
      "CashLoom is not a service you sign into — it is a program you run. The node binds to 127.0.0.1 by default: the only thing that can reach it is the machine it runs on. There is no account, no tenant, no operator on the other end.",
      "One process serves both the API and the interface from the same origin, so there is no CORS, no second server, no cloud hop. The whole thing is small enough to read in an afternoon.",
      "Everything that can touch money sits behind an unlocked-vault session. The public surface is deliberately tiny: read the node's own state, initialize a vault, unlock one.",
    ],
    loadBearing: [
      { marker: "const HOSTNAME = process.env.CASHLOOM_BIND ?? \"127.0.0.1\"", note: "Local-first is the default, not a setting you have to find. Exposing the node is a deliberate act, never an accident." },
      { marker: "requires an unlocked vault session", note: "The gate is one middleware. Below it, nothing runs without a live session — money-shaped routes cannot be reached with a locked vault." },
      { marker: "Errors carry instructions, never secrets", note: "Every error is written to be read by the person who hit it — and never carries key material." },
    ],
    relatesTo: ["the-vault", "pay", "the-read-seam"],
    weave: { x: 0.5, y: 0.12 },
  },
  {
    id: "the-vault",
    title: "The Vault",
    subtitle: "Your passphrase is custody.",
    sources: ["../../sovereign/src/vault.ts?raw"],
    idea: "Private keys are sealed with a key derived from your passphrase, decrypted only in memory, only to sign.",
    doctrine: [
      "Non-custodial is not a promise, it is an architecture. Your passphrase runs through Argon2id — memory-hard, slow on purpose — to derive a master key that seals every private key with AES-256-GCM. The sealed blob is all that ever touches disk.",
      "A key is decrypted for exactly the span of one signature and never returned to any caller, written to any log, or sent over any network. CashLoom signs locally and broadcasts the *signed* transaction — the private half never leaves the machine.",
      "The passphrase IS custody: there is no recovery, no reset link, no support line that can let you back in. That is the cost of holding nothing on your behalf, stated plainly rather than hidden.",
    ],
    loadBearing: [
      { marker: "The passphrase IS custody", note: "No recovery by design. A recoverable vault is a custodial vault wearing a costume." },
      { marker: "One error for every wrong-passphrase shape — no oracle", note: "Unlock failures are indistinguishable, so the error can never become a guessing aid." },
      { marker: "lives for the duration of one signature", note: "The decrypted key's lifetime is a single call. Exposure is measured in microseconds, never persisted." },
    ],
    relatesTo: ["pay", "the-node"],
    weave: { x: 0.22, y: 0.4 },
  },
  {
    id: "the-connection-boundary",
    title: "The Connection Boundary",
    subtitle: "Many wallets. One durable decision.",
    sources: [
      "../../sovereign/src/wallet/integration-catalog.ts?raw",
      "../../sovereign/src/wallet/integrations/requests.ts?raw",
      "../../sovereign/src/wallet/adapters/webauthn-verifier.ts?raw",
    ],
    idea: "Passkeys, hardware wallets, WalletConnect, smart accounts, and banks may interact differently, but none may change the intent that the owner approved.",
    doctrine: [
      "An SDK is not an authority. Every external journey begins from the same canonical intent, exact prepared request, one-use authorization, and expiry. The browser, device, relay, bundler, or bank is treated as a hostile transport until CashLoom independently verifies its bounded output.",
      "Some integrations return signed wire bytes; others only accept a provider operation. Those are separate execution lanes. Exact bytes must be durably committed before broadcast, while provider operations are prepared and idempotency-claimed before I/O, then settled only by an independent observer.",
      "The catalogue is deliberately honest about readiness. A parser, verifier, or configured credential does not make an integration executable. Passkey, hardware EVM, WalletConnect, ERC-4337, and pay-by-bank remain policy-blocked until verification and core artifact consumption share one atomic coordinator transaction.",
    ],
    loadBearing: [
      { marker: "atomic_verified_persistence_enabled: false", note: "The readiness API refuses to call adapter code ‘live’ before verified output, one-use authority, and resource claims can commit atomically." },
      { marker: "authorization must bind the exact unsigned ERC-4337 operation", note: "A smart-account signature may be added later; every economic and gas field was already frozen by the owner’s request hash." },
      { marker: "Enterprise attestation is a separate policy product and is intentionally refused here.", note: "Attestation-none proves a valid passkey ceremony, not a device brand or hardware assurance the evidence cannot support." },
    ],
    relatesTo: ["the-node", "the-vault", "the-outbound-seam", "the-read-seam"],
    weave: { x: 0.5, y: 0.34 },
  },
  {
    id: "pay",
    title: "pay()",
    subtitle: "Quote, then confirm. Never twice.",
    sources: ["../../sovereign/src/pay.ts?raw"],
    idea: "Every payment is a two-step rite: a quote that discloses the fee and signs nothing, then a confirm that signs and broadcasts exactly once.",
    doctrine: [
      "The universal primitive is deliberately slow at the one moment speed would be dangerous. Quote first: the network fee is estimated as an upper bound and shown to you with nothing yet signed. Only an explicit confirm turns that quoted intent — and only that intent — into a broadcast.",
      "A failed send is recorded and surfaced, never auto-retried. A payment that failed is a decision for a human, not a loop; retrying money automatically is how money gets sent twice.",
      "The status is marked *before* the point of no return inside send(), so a crash between broadcast and bookkeeping is visible as 'needs investigation', never silently re-sendable.",
    ],
    loadBearing: [
      { marker: "NEVER auto-retried", note: "The single most important rule about moving money: one attempt, then a human decides." },
      { marker: "Point of no return is INSIDE send()", note: "Ordering chosen so a mid-flight crash can never look like a payment that never happened." },
      { marker: "only a fresh quote can be confirmed", note: "A stale or already-spent quote is inert. Fees move; a disclosure you didn't just see is not a disclosure." },
    ],
    relatesTo: ["the-outbound-seam", "the-vault", "the-ledger"],
    weave: { x: 0.5, y: 0.52 },
  },
  {
    id: "the-outbound-seam",
    title: "The Outbound Seam",
    subtitle: "Movement lives behind a stricter door.",
    sources: ["../../sovereign/src/senders/types.ts?raw", "../../sovereign/src/senders/evm.sender.ts?raw"],
    idea: "All money movement goes through PaymentSender — a separate interface from reading, held to stricter rules: validate, disclose the fee, sign locally, broadcast the signed result.",
    doctrine: [
      "Reading a balance and moving money are different acts with different blast radii, so they live behind different interfaces. A sender validates the destination and amount before anything is signed, discloses the fee before anything moves, and signs locally — the key never rides the wire.",
      "Two rails move money so far: Base L2 (ETH + USDC), a cheap fast stablecoin path chosen so 'everyone pays everyone' is affordable enough to actually mean everyone — and Bitcoin on-chain, which earned its own module because UTXOs carry their own ways to lose money quietly. The quote uses only the public address; the private key surfaces solely inside the send.",
      "Fees are pass-through only — the network's gas, nothing added. The fee summary says so out loud: 'No CashLoom fee, ever.'",
    ],
    loadBearing: [
      { marker: "a connector that could initiate movement does not belong behind the read interface", note: "The seam boundary as a sentence. Read and write are kept apart at the type level, not just by convention." },
      { marker: "Disclose the UPPER BOUND", note: "A confirm screen is never shown a fee lower than what could be charged. Honesty rounds against the house." },
      { marker: "the private key never touches the network", note: "Sign here, broadcast the signature. The secret and the internet never meet." },
    ],
    relatesTo: ["pay", "the-vault", "btc-sending"],
    weave: { x: 0.78, y: 0.4 },
  },
  {
    id: "btc-sending",
    title: "BTC Sending",
    subtitle: "Sign exactly what was disclosed.",
    sources: ["../../sovereign/src/senders/btc.sender.ts?raw"],
    idea: "Coin selection and the exact fee happen at quote time and are persisted; confirm rebuilds that selection bit-for-bit, signs, and broadcasts — the fee paid is the fee disclosed, to the satoshi.",
    doctrine: [
      "On Bitcoin the fee is never written down — it is the implicit difference between inputs and outputs, which makes it the easiest number in all of money to get quietly wrong. So the quote does the whole selection, persists it, and the confirm signs exactly that selection: no re-selection, no re-estimation, nothing the human didn't see.",
      "The persisted selection is treated as hostile at signing time: every amount re-proven, the inputs-minus-outputs equation checked to the satoshi, and a final assert that the signed transaction's fee equals the disclosed one — or nothing broadcasts. A doctored row overpays no one.",
      "The indexer it reads is public and keyless, and the design assumes it lies. BIP-143 makes a lying indexer harmless to funds — a wrong claimed value yields a consensus-invalid signature, rejected loudly. And when a broadcast goes unanswered, the payment refuses to call itself failed: the signed txid was recorded before the network ever heard it, so the one wrong move — signing the same money twice — stays impossible.",
    ],
    loadBearing: [
      { marker: "Re-selection at confirm is never a fallback", note: "The built-ONCE doctrine, ported to UTXO land. What confirm signs is what quote disclosed — structurally, not aspirationally." },
      { marker: "BEFORE the network hears the tx", note: "The txid is deterministic once signed, so it is written down before broadcast. A crash mid-flight leaves a payment you can check on-chain, never a mystery." },
      { marker: "the double-pay lever", note: "An unanswered broadcast is not a failure — it is unknown. Calling it 'failed' would invite the second send a hostile indexer is fishing for." },
    ],
    relatesTo: ["the-outbound-seam", "pay", "the-vault", "the-read-seam"],
    weave: { x: 0.88, y: 0.56 },
  },
  {
    id: "the-read-seam",
    title: "The Read Seam",
    subtitle: "Observe every rail. Move nothing.",
    sources: ["../../sovereign/src/connectors/types.ts?raw", "../../sovereign/src/connectors/agenttool.connector.ts?raw"],
    idea: "RailConnector reads balances and transactions from any rail — Stripe, banks, Bitcoin, Ethereum, the agent economy — and can never, by construction, move money.",
    doctrine: [
      "A connector has exactly two methods, both read: fetch a balance, fetch transactions. Nothing behind this interface can initiate a movement — a rail you can watch is not a rail that can drain you.",
      "Credentials are pointers, never values: an account stores the NAME of an environment variable, and the secret is resolved at call time from a closed namespace. A stored reference can never name your database URL or your session secret and exfiltrate it.",
      "Balances are BigInt-exact minor-unit strings — an 18-decimal wei amount never touches a float. The agent economy (agenttool) rides in as just another rail, so agent earnings appear beside your bank and your chain.",
    ],
    loadBearing: [
      { marker: "nothing behind this interface can move money", note: "The read seam's whole reason for being. Safety by shape, not by care." },
      { marker: "credentialRef is the NAME of an environment variable", note: "Secrets are referenced, never stored. The database holds a pointer; the value lives only in the process environment." },
      { marker: "SIGNED integer minor-unit string", note: "Money is integers-as-text end to end. Floats are never allowed near an amount." },
    ],
    relatesTo: ["sync", "the-node"],
    weave: { x: 0.5, y: 0.78 },
  },
  {
    id: "sync",
    title: "Sync",
    subtitle: "Record; never double, never mix.",
    sources: ["../../sovereign/src/sync.ts?raw"],
    idea: "Sync pulls a connector's balance and transactions into the local ledger, deduped and currency-checked, so the same row can never land twice or in the wrong denomination.",
    doctrine: [
      "Connectors observe; sync records. Every imported row is deduped on the rail's own stable id via a database uniqueness constraint — a re-sync is a skip, never a double.",
      "A row whose currency or decimal scale disagrees with the account is refused loudly, not imported wrong. Silent mis-scaling is the least-debuggable kind of money bug, so the code would rather stop than guess.",
      "Sync re-fetches a little behind the newest known row, because real ledgers settle out of order — and the dedupe makes that overlap free.",
    ],
    loadBearing: [
      { marker: "refusing to mix currencies", note: "A foreign-currency row would corrupt every sum. The import refuses rather than pollute the ledger." },
      { marker: "refusing to mis-scale", note: "Decimals must agree exactly. A 100x error hiding behind a correct balance is worse than a loud failure." },
      { marker: "INSERT OR IGNORE", note: "The dedupe is enforced by the database, not hoped for in code. Re-running sync is always safe." },
    ],
    relatesTo: ["the-read-seam", "the-ledger"],
    weave: { x: 0.32, y: 0.66 },
  },
  {
    id: "the-ledger",
    title: "The Ledger",
    subtitle: "One file. Exact money.",
    sources: ["../../sovereign/src/db.ts?raw"],
    idea: "All state is one SQLite file that ships inside Bun — no database server to install, start, or host. Money is stored as exact integer strings.",
    doctrine: [
      "The entire data plane is one file at ~/.cashloom/sovereign.db, opened by bun:sqlite which is built into the runtime. There is nothing to provision — the zero-infra promise is literal.",
      "Every amount is a TEXT minor-unit string, BigInt-exact: an account holds no funds itself, it is the labelled container a balance syncs into, and the numbers in it can be trusted to the last unit.",
      "Outbound payments are their own table with an audit trail: quoted, confirmed, broadcast, or failed — each state recorded, none ever silently retried.",
    ],
    loadBearing: [
      { marker: "integer minor units as TEXT", note: "SQLite stores money as exact text. No column anywhere is a float that could round your balance." },
      { marker: "UNIQUE INDEX IF NOT EXISTS idx_tx_dedupe", note: "The dedupe guarantee is a database index. Correctness that does not depend on remembering to check." },
      { marker: "plaintext key material NEVER touches this table", note: "The vault table holds only sealed blobs. The database never sees a key." },
    ],
    relatesTo: ["sync", "pay", "the-vault"],
    weave: { x: 0.68, y: 0.66 },
  },
];

export const DECISIONS: Decision[] = [
  {
    question: "Should reading a balance and sending money share one interface?",
    options: [
      { label: "One interface with a send() method", verdict: "rejected", note: "Pollutes the read-only guarantee — now every connector *could* move money." },
      { label: "Two parallel seams: RailConnector (read) + PaymentSender (write)", verdict: "chosen", note: "Read stays provably safe; all movement lives behind a stricter, separate door." },
      { label: "A separate sending microservice", verdict: "rejected", note: "Overkill for a program meant to run on one laptop." },
    ],
    because: "A connector that could initiate movement does not belong behind the read interface. Keeping them apart at the type level means 'this can only observe' is enforced by the compiler, not by reviewer vigilance.",
    livesIn: "the-read-seam · the-outbound-seam",
  },
  {
    question: "Where do private keys live?",
    options: [
      { label: "A custodial server holds them", verdict: "rejected", note: "Then it is not your money — and the server is a target." },
      { label: "Local, encrypted: Argon2id(passphrase) → AES-256-GCM, decrypt only to sign", verdict: "chosen", note: "Non-custodial by architecture; the key never leaves the machine or touches the network." },
      { label: "Plaintext local file", verdict: "rejected", note: "One stray backup or log line and the key is gone." },
    ],
    because: "Non-custodial has to be structural, not a policy you trust. The passphrase is custody, with no recovery — the honest price of holding nothing on your behalf.",
    livesIn: "the-vault",
  },
  {
    question: "How does a payment actually happen?",
    options: [
      { label: "One call that sends immediately", verdict: "rejected", note: "No moment to disclose the fee; a fat-finger is irreversible." },
      { label: "Quote (fee disclosed, nothing signed) → explicit Confirm (signed, once)", verdict: "chosen", note: "You see the true cost before anything is signed; confirm is a deliberate act." },
      { label: "Send with automatic retry on failure", verdict: "rejected", note: "Auto-retrying money is how money gets sent twice." },
    ],
    because: "The primitive is slow at exactly the instant speed is dangerous. Failed sends are recorded and surfaced for a human, never retried by a loop.",
    livesIn: "pay",
  },
  {
    question: "How is money represented in the code?",
    options: [
      { label: "Floating-point major units (12.34)", verdict: "rejected", note: "A float cannot hold 18-decimal wei; rounding corrupts real balances." },
      { label: "Integer minor-unit strings with an explicit decimals field", verdict: "chosen", note: "Exact to the last unit across fiat and crypto alike." },
    ],
    because: "Every amount is integers-as-text end to end. The one place a float touches money is the one place a balance silently goes wrong.",
    livesIn: "the-ledger · the-read-seam",
  },
  {
    question: "What database?",
    options: [
      { label: "MongoDB / Postgres server", verdict: "rejected", note: "Infra to install, run, and host — friction against 'everyone runs their own'." },
      { label: "bun:sqlite — one file, built into the runtime", verdict: "chosen", note: "Nothing to provision. The whole data plane is a single file you can back up by copying it." },
    ],
    because: "The zero-infra promise had to be literal. If running your own node needs a database server, most people never will.",
    livesIn: "the-ledger",
  },
  {
    question: "A Bitcoin fee can drift between quote and send. How do you keep the disclosure honest?",
    options: [
      { label: "Re-select coins at send, capped at the quoted fee", verdict: "rejected", note: "Caps one number but signs inputs and change the human never saw — the disclosure covered the whole intent, not just the fee." },
      { label: "Persist the selection at quote; confirm signs exactly that, or nothing", verdict: "chosen", note: "The fee paid equals the fee disclosed, to the satoshi. A spent-from-under-us coin fails loudly into a fresh quote." },
      { label: "Build and sign at quote time", verdict: "rejected", note: "Nothing may carry a signature before the human confirms — that is the whole rite." },
    ],
    because: "The quote→confirm promise is about the entire intent. On a UTXO chain the only way to keep it is to make the quoted selection the thing that is signed — and to treat that persisted selection as untrusted input when signing time comes.",
    livesIn: "btc-sending",
  },
  {
    question: "SaaS, or sovereign?",
    options: [
      { label: "Hosted SaaS: plans, quotas, pricing, a central operator", verdict: "rejected", note: "That is the old age. It makes the operator the owner of your money's story." },
      { label: "Sovereign: one owner, one machine, everything unlimited, no operator", verdict: "chosen", note: "Plans, quotas, and pricing were deleted, not toggled off." },
    ],
    because: "'For everyone' means no one needs anyone else's server. The SaaS layer was removed entirely so the default posture is yours.",
    livesIn: "the-node",
  },
];

export const ROADMAP: RoadmapThread[] = [
  // Bitcoin sending (PSBT + coin selection) graduated from this list on
  // 2026-07-05 — it lives in the weave now, as the btc-sending module.
  {
    title: "Lightning",
    status: "next",
    mindset: "The path to near-free instant payments — but it needs a node. The honest question is embedded (LDK) versus connect-your-own, and that trade-off deserves its own spec before a line is written.",
    whyNotYet: "A whole sub-design about where the Lightning node lives; scoped as its own slice.",
  },
  {
    title: "BTC fee-bump & broadcast reconciliation",
    status: "planned",
    mindset: "Every send already signals RBF and records its txid before broadcast — the door is open. What remains is walking back through it: bump a stuck fee, and re-check payments whose broadcast went unanswered against the chain.",
    whyNotYet: "The safe-by-default posture shipped first; the recovery tooling is its own small, careful slice.",
  },
  {
    title: "Payment pointers — you@cashloom",
    status: "planned",
    mindset: "The simplicity that hides all rail complexity behind a name: pay a person, not an address. 'Everyone reaches everyone' becomes true the moment a handle resolves to someone's preferred rail.",
    whyNotYet: "Direct addressing (paste an address or link) proves the primitive first; naming is the layer on top.",
  },
  {
    title: "Local import — CSV & statements, no cloud AI",
    status: "considering",
    mindset: "Getting messy real-world money data in cleanly is the highest-value everyday feature — but it must happen entirely on your machine. No statement is ever shipped to someone else's model.",
    whyNotYet: "The old build leaned on a cloud AI for this; the sovereign version needs a local parser, which is its own piece of work.",
  },
  {
    title: "Tauri desktop packaging",
    status: "considering",
    mindset: "Double-click to run, zero terminal. The node already is the whole app; packaging just removes the last friction between a person and their own sovereign wallet.",
    whyNotYet: "The core had to be right first. Packaging is the last mile, not the foundation.",
  },
  {
    title: "More rails — SEPA, UPI, Solana, and beyond",
    status: "considering",
    mindset: "Every rail added is one more way 'everyone pays everyone' becomes literally true. Each slots into the same two seams — read to observe, sender to move — so the shape never changes, only the reach.",
    whyNotYet: "Breadth follows a proven spine. The seams are built to make each new rail additive, never a rewrite.",
  },
];

export const HOW_WE_BUILD = {
  title: "The mindset behind the upgrades",
  principles: [
    { name: "Reversible steps, bounded changes", body: "Nothing that works gets removed; new capability arrives as a layer that can be peeled back. A change you can undo is a change you can dare to make." },
    { name: "Refuse loudly over guess quietly", body: "When the code isn't sure — a mismatched currency, an unknown scale, a stale quote — it stops and says why, instead of proceeding into a silent error that surfaces as wrong money weeks later." },
    { name: "Errors are written to be read", body: "Every failure carries instructions for the person who hit it, and never carries a secret. The message is part of the product." },
    { name: "The code is the spec's reference implementation", body: "The protocol is the promise; this repo is one honest way to keep it. Anyone may read it, run it, fork it, or write their own — and interoperate over the same open rails." },
    { name: "Everyone runs their own", body: "The whole design bends toward the day a person double-clicks and holds their own money, needing no one else's server. Every decision is measured against that." },
  ],
};
