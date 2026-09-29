import { useEffect } from "react";
import { PublicHeader } from "../components/PublicHeader";
import { WORKSPACE_SOURCE } from "../workspace-source";
import "./wallet-guide.css";

const USES = [
  { title: "For yourself", text: "Know what you hold, keep a record of spending, and give your next decision a clear starting point." },
  { title: "For your household", text: "Label accounts around shared costs and keep an understandable record for your next money conversation." },
  { title: "For self-employed work", text: "Keep work accounts distinct from personal accounts and record incoming money and expenses." },
  { title: "For a small team", text: "Let one local operator organise accounts and supporting records to review together." },
];
const GUIDE_ANCHORS = new Set(["workspace-main", "first-steps", "statements", "connections", "payments", "agents", "crypto", "setup"]);

export default function WalletGuide() {
  useEffect(() => {
    // The route arrives after the browser's initial fragment navigation.
    // Only known guide destinations can request this one-time scroll.
    const id = window.location.hash.slice(1);
    if (!GUIDE_ANCHORS.has(id)) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return <div className="wallet-guide">
    <a className="skip-link" href="#workspace-main">Skip to your workspace guide</a>
    <PublicHeader current="wallet">
      <span className="wallet-guide-local">Developer pilot · local setup</span>
    </PublicHeader>
    <main id="workspace-main">
      <header className="wallet-guide-hero">
        <div>
          <p className="wallet-guide-eyebrow">Your workspace</p>
          <h1>Know where you stand.<br /><em>Choose what comes next.</em></h1>
          <p className="wallet-guide-lead">Bring your accounts, balances and money records into one local workspace. Start with what you know, keep it up to date, and stay in charge of each action.</p>
          <div className="wallet-guide-links">
            <a className="wallet-guide-button" href="#setup">Check setup requirements <span aria-hidden="true">↓</span></a>
            <a className="wallet-guide-button wallet-guide-button--secondary" href="/plan">Start with a money plan</a>
          </div>
          <p className="wallet-guide-hint">The workspace is a separate developer pilot with private repository access required. Everyone can use the money plan in this browser.</p>
        </div>
        <aside className="wallet-guide-principles" aria-label="How your workspace works">
          <span className="wallet-guide-eyebrow">A useful starting point</span>
          <h2>Your records.<br /> Your decisions.</h2>
          <ul>
            <li><strong>Start manually</strong><span>No bank connection needed to record an account and balance.</span></li>
            <li><strong>See the date</strong><span>A saved balance shows when it was observed.</span></li>
            <li><strong>Choose each action</strong><span>Refresh connected accounts and review supported payments yourself.</span></li>
          </ul>
        </aside>
      </header>

      <nav className="wallet-guide-sections" aria-label="Workspace guide sections">
        <a href="#setup">Setup requirements</a><a href="#first-steps">First account</a><a href="#statements">Import &amp; export</a><a href="#crypto">Watch a wallet</a><a href="#agents">Agent access</a><a href="#connections">Connections &amp; payments</a>
      </nav>

      <section className="wallet-guide-section" aria-labelledby="workspace-fit-title">
        <p className="wallet-guide-eyebrow">Make it useful to you</p>
        <h2 id="workspace-fit-title">Different needs. One clear record.</h2>
        <div className="wallet-guide-audiences">{USES.map((use) => <article key={use.title}><h3>{use.title}</h3><p>{use.text}</p></article>)}</div>
        <p className="wallet-guide-hint">One local owner controls this workspace. Shared sign-in, separate member permissions and live collaboration are not available.</p>
      </section>

      <section id="first-steps" className="wallet-guide-section" aria-labelledby="workspace-routine-title">
        <p className="wallet-guide-eyebrow">A simple first routine</p>
        <h2 id="workspace-routine-title">Start with one account.</h2>
        <ol className="wallet-guide-steps">
          <li><span aria-hidden="true">01</span><div><h3>Add an account</h3><p>In your local workspace, open Accounts and add a manual account in its own currency. Use a name that tells you what the money is for.</p></div></li>
          <li><span aria-hidden="true">02</span><div><h3>Record the balance</h3><p>Enter the amount you observed. Overview shows the saved amount and its date, so an old balance stays recognisable.</p></div></li>
          <li><span aria-hidden="true">03</span><div><h3>Keep the activity</h3><p>Open Activity to record money in or out. Activity records and observed balances are separate; recording an expense does not change the balance or move money.</p></div></li>
          <li><span aria-hidden="true">04</span><div><h3>Review and decide</h3><p>Return when you need to make a decision. Check the dates, update what you know, and use your money plan to work through what comes next.</p></div></li>
        </ol>
      </section>

      <section id="statements" className="wallet-guide-section" aria-labelledby="workspace-statements-title">
        <p className="wallet-guide-eyebrow">Keep useful records</p>
        <h2 id="workspace-statements-title">Bring in activity. Keep a copy.</h2>
        <div className="wallet-guide-grid">
          <article><span className="wallet-guide-tag">Activity → Import CSV</span><h3>Review a statement</h3><p>Choose an active manual account, then select or paste a CSV with date, title, amount and currency columns. Category is optional. Preview the rows and skipped matches before confirming.</p><p>Use the account’s currency and negative amounts for money out. Importing a provider statement into an already connected account can duplicate its activity, so imports are limited to manual accounts.</p></article>
          <article><span className="wallet-guide-tag">Activity → Export all activity (JSON)</span><h3>Take a copy with you</h3><p>Export saved activity as a JSON file. Choose an account filter first to use “Export this account (JSON).” Keep downloaded files somewhere private.</p><p>This export contains activity records. It is not a complete workspace backup and does not include signing keys.</p></article>
          <article><span className="wallet-guide-tag">Activity → Review internal transfers</span><h3>Recognise your own transfers</h3><p>Review a suggested outgoing and incoming pair, then confirm that both accounts belong to you before linking them. Only equal amounts without fee or currency differences are suggested.</p><p>Linking records marks your own movement between accounts. It does not send money. You can review and unlink a match.</p></article>
        </div>
        <p className="wallet-guide-hint">Activity and observed balances stay separate. Importing records does not update a saved balance. Identical activity on the same day can be a separate transaction; review skipped matches before confirming.</p>
      </section>

      <section id="crypto" className="wallet-guide-section" aria-labelledby="workspace-crypto-title">
        <p className="wallet-guide-eyebrow">Crypto, in the same account view</p>
        <h2 id="workspace-crypto-title">Watch a wallet. See what it holds.</h2>
        <p className="wallet-guide-connection-intro">Start in your <a href="#setup">local workspace</a>. A public Base address is enough to watch ETH and native USDC; no seed phrase, private key or signature is needed.</p>
        <ol className="wallet-guide-steps">
          <li><span aria-hidden="true">01</span><div><h3>Add a watched address</h3><p>Open Connections → Add crypto wallet. Check that the network is Base, paste the public address and choose a label. Adding an already tracked address opens its existing account.</p></div></li>
          <li><span aria-hidden="true">02</span><div><h3>Choose when to check</h3><p>In Accounts, choose Check balances. This sends the address to the node’s configured RPC providers. Matching finalized evidence establishes ETH and native USDC balances; missing evidence stays unknown.</p></div></li>
          <li><span aria-hidden="true">03</span><div><h3>Read the saved evidence</h3><p>Accounts and Overview show the holdings and observation time. Opening these views does not refresh the network. A failed check keeps the previous dated snapshot; conflicting evidence needs review.</p></div></li>
        </ol>
        <p className="wallet-guide-hint">Watching an address does not establish ownership or authorize spending. This flow reads balances only; Base transaction-history import, other token discovery and WalletConnect are not included. Agent access can share selected saved Base holdings, with their dates and evidence status, without giving the client refresh or payment authority.</p>
        <a className="wallet-guide-button wallet-guide-button--secondary" href={`${WORKSPACE_SOURCE}/sovereign#watch-a-base-wallet`} target="_blank" rel="noopener noreferrer">Read crypto setup · repository access required ↗</a>
      </section>

      <section id="connections" className="wallet-guide-section" aria-labelledby="workspace-tools-title">
        <p className="wallet-guide-eyebrow">Build on that foundation</p>
        <h2 id="workspace-tools-title">Use the tools you need.</h2>
        <p className="wallet-guide-connection-intro">First time here? <a href="#setup">Set up your local workspace</a>. Once it is running, unlock it and open Connections to see your saved sources. Opening that page does not refresh providers.</p>
        <div className="wallet-guide-grid">
          <article><span className="wallet-guide-tag">Local workspace → Connections</span><h3>Read balances &amp; activity</h3><p>For Plaid, configure sandbox credentials in your private node, then choose “Connect a test bank.” Only supported USD test accounts are available; live bank access and bank payments are not enabled.</p><p>Use Accounts to configure other supported readers with your own provider access. GoCardless requires an account and consent already linked with the provider; the workspace does not start that consent journey.</p><a href={`${WORKSPACE_SOURCE}/sovereign#unified-money-view-local-pilot`} target="_blank" rel="noopener noreferrer">Read connection setup · repository access required ↗</a></article>
          <article id="payments"><span className="wallet-guide-tag">Local keys required</span><h3>Send &amp; receive</h3><p>Supported local-key payments are Base ETH, Base USDC and Bitcoin. Choose an account and recipient, review a quote, then confirm signing and broadcast.</p><p>Receiving uses a public address. Payment records retain the available evidence and any uncertain outcome.</p></article>
          <article><span className="wallet-guide-tag">Records &amp; rehearsal</span><h3>Trade agreements</h3><p>This development checkout includes card-trade terms and supporting records. Its separate escrow simulation holds no money and provides no real payment protection.</p></article>
        </div>
        <p className="wallet-guide-hint wallet-guide-connection-limits">Hardware-wallet, WalletConnect and pay-by-bank execution are not enabled. <a href={`${WORKSPACE_SOURCE}/sovereign#connectivity-foundation-honest-release-state`} target="_blank" rel="noopener noreferrer">Read provider and wallet limits · repository access required ↗</a></p>
      </section>

      <section id="agents" className="wallet-guide-section" aria-labelledby="workspace-agents-title">
        <p className="wallet-guide-eyebrow">Help within boundaries you choose</p>
        <h2 id="workspace-agents-title">Let an agent help sort your records.</h2>
        <p>In your local workspace, open Agent access. Select accounts, choose an expiry, and decide whether the agent may suggest activity categories. A separate local MCP adapter gives a compatible agent client access to those saved records.</p>
        <ol className="wallet-guide-steps">
          <li><span aria-hidden="true">01</span><div><h3>Choose what to share</h3><p>Only your selected accounts are exposed, including names, saved balances and recent activity descriptions. The snapshot includes dates and test-data labels. It is a bounded view, not a complete financial report.</p></div></li>
          <li><span aria-hidden="true">02</span><div><h3>Review each suggestion</h3><p>Compare the original activity category with the agent’s proposed category and reason. You apply or reject it. A changed record needs a new suggestion; accepting changes a category only.</p></div></li>
          <li><span aria-hidden="true">03</span><div><h3>End access when you choose</h3><p>Revoke access individually, let it expire, or lock the workspace. Existing suggestions remain yours to review. Ending access cannot retrieve information an agent client has already read.</p></div></li>
        </ol>
        <p className="wallet-guide-hint">CashLoom does not include a hosted model or chat service. Your chosen agent client may send records to its model provider and retain them under its own settings. This access cannot refresh providers, change balances, approve suggestions or send money.</p>
        <a className="wallet-guide-button wallet-guide-button--secondary" href={`${WORKSPACE_SOURCE}/docs/agent-layer-2026-09-29.md`} target="_blank" rel="noopener noreferrer">Read agent setup · repository access required ↗</a>
      </section>

      <section id="setup" className="wallet-guide-start" aria-labelledby="workspace-start-title">
        <div>
          <p className="wallet-guide-eyebrow">Local setup</p>
          <h2 id="workspace-start-title">Run your workspace locally.</h2>
          <p>The workspace is currently a developer pilot. You need access to the private CashLoom repository, its source code, and Bun on your machine. This website does not open your private node or ask for your keys. There is no hosted workspace sign-in.</p>
          <div className="wallet-guide-links">
            <a className="wallet-guide-button" href={`${WORKSPACE_SOURCE}/sovereign#run-it`} target="_blank" rel="noopener noreferrer">Open setup guide · repository access required ↗</a>
            <a className="wallet-guide-button wallet-guide-button--secondary" href="/atlas">How it works</a>
          </div>
          <p className="wallet-guide-hint">Sign in to GitHub with an account that has repository access. Without access, GitHub may show “Page not found.” You can still use the public money planner and insights without installing anything.</p>
        </div>
        <details>
          <summary>Already have the CashLoom source?</summary>
          <p>From your CashLoom checkout, with Bun installed:</p>
          <pre><code>{"cd sovereign\nbun install --frozen-lockfile\n(cd ui && bun install --frozen-lockfile)\nbun run build:ui\nbun start"}</code></pre>
          <p>Open the local address printed by your node. On first use, create a passphrase, then add an account. Keep your passphrase separately; CashLoom has no passphrase recovery service.</p>
          <p>To watch Base ETH and USDC, open Connections → Add crypto wallet and use a public address. For supported local-key payments, create or import a key in Signing keys and choose “Use in an account.” Keep a secure backup of that key. Bank payments and external-wallet execution are still in development.</p>
          <p>The vault encrypts key material. Account and activity records are local data, and the whole database is not encrypted.</p>
        </details>
      </section>
      <footer className="wallet-guide-return"><p>Need context for a decision? <a href="/world">Read money insights</a>, <a href="/capital-flows">follow reported capital flows</a>, or <a href="/onchain">explore network insights</a>.</p><a href="/">Back to overview ↑</a></footer>
    </main>
  </div>;
}
