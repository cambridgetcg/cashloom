import { useState } from "react";
import { Arrow, Icon, ServiceLayout } from "./ServiceLayout";

const JOURNEYS = [
  { id: "personal", label: "Just me", title: "A clearer picture of your everyday money.", description: "Give your income a purpose, make room for the essentials, and see what is left for the things you care about.", steps: ["List what comes in each month", "Make space for bills and savings", "Keep a record of what changes"], action: "Make my money plan", href: "/plan?for=personal", note: "Start in your browser. No account or bank connection needed." },
  { id: "household", label: "My household", title: "Put the household plan on the same page.", description: "Bring contributions, shared bills, and future costs into one monthly plan you can talk through together.", steps: ["List each person's contribution", "Include shared bills and essentials", "Export the plan to discuss together"], action: "Plan household money", href: "/plan?for=household", note: "One editable plan on this device. Share an export by your own choice; live shared access is not available." },
  { id: "work", label: "Independent work", title: "Give irregular income a practical plan.", description: "Use your own monthly estimates to separate work costs, money set aside, and personal spending.", steps: ["Estimate income for the month", "List work costs and your set-asides", "Keep payment activity in your workspace"], action: "Plan work income", href: "/plan?for=work", note: "You choose the amounts. CashLoom does not calculate tax or replace accounting records." },
  { id: "group", label: "A small group", title: "Make the money conversation easier.", description: "Work out contributions and costs for a shared project, then keep an agreed copy of the plan.", steps: ["Name each expected contribution", "List project costs and a buffer", "Export a copy for everyone to review"], action: "Plan a shared project", href: "/plan?for=group", note: "The plan is managed by one person on this device. Member accounts, approvals, and shared balances are future work." },
] as const;

export default function Home() {
  const [audience, setAudience] = useState<string>("personal");
  const journey = JOURNEYS.find((item) => item.id === audience)!;
  return <ServiceLayout current="home">
    <section className="service-hero" aria-labelledby="home-title">
      <div>
        <p className="service-eyebrow">A little clarity goes a long way</p>
        <h1 id="home-title">Your money.<br /><em>Your direction.</em></h1>
        <p className="service-lede">Bring the moving parts together. Make a plan, keep track of your money, and decide what happens next.</p>
        <div className="service-actions"><a className="service-button" href="/plan">Make a money plan <Arrow /></a><a className="service-link" href="/wallet">Explore your workspace <span aria-hidden="true">→</span></a></div>
        <p className="service-small">The planner works here, without an account. Your private workspace runs on your own computer; its developer pilot requires repository access.</p>
      </div>
      <aside className="service-compass" aria-label="Three ways CashLoom helps">
        <div className="service-compass__heading"><span className="service-dot" />A place for each part of your money</div>
        <a href="/plan"><span className="service-icon"><Icon name="plan" /></span><div><span className="service-small">01 / MAKE ROOM</span><h2>Know what is left.</h2><p>Income, essentials, spending, and set-asides.</p></div><Arrow /></a>
        <a href="/wallet"><span className="service-icon"><Icon name="records" /></span><div><span className="service-small">02 / KEEP TRACK</span><h2>Keep the picture together.</h2><p>Accounts, activity, and reviewed payments.</p></div><Arrow /></a>
        <a href="/world"><span className="service-icon"><Icon name="insights" /></span><div><span className="service-small">03 / UNDERSTAND</span><h2>See the wider context.</h2><p>Rates, currencies, and sources you can inspect.</p></div><Arrow /></a>
        <p className="service-compass__foot">You choose the next step. CashLoom helps make it clear.</p>
      </aside>
    </section>

    <section className="service-journey" aria-labelledby="journey-title">
      <div className="service-section-head"><div><p className="service-eyebrow">Built around your situation</p><h2 id="journey-title">Whose money are you sorting?</h2></div><p>Start where you are.<br />Keep only what is useful.</p></div>
      <div className="service-audiences" role="group" aria-label="Choose your situation">{JOURNEYS.map((item) => <button key={item.id} type="button" aria-pressed={audience === item.id} onClick={() => setAudience(item.id)}>{item.label}</button>)}</div>
      <div className="service-journey__body">
        <div><h3>{journey.title}</h3><p>{journey.description}</p><a className="service-button service-button--light" href={journey.href}>{journey.action} <Arrow /></a></div>
        <div><ol>{journey.steps.map((step, i) => <li key={step}><span aria-hidden="true">0{i + 1}</span>{step}</li>)}</ol><p className="service-small">{journey.note}</p></div>
      </div>
    </section>

    <section className="service-tools" aria-labelledby="tools-title">
      <div className="service-section-head"><div><p className="service-eyebrow">From a question to a useful next step</p><h2 id="tools-title">Choose what you need today.</h2></div></div>
      <div className="service-tools__grid">
        <a className="service-tool" href="/plan"><div className="service-tool__top"><Icon name="plan" /><span className="service-status">Use in this browser</span></div><h3>Make a money plan</h3><p>Turn monthly estimates into a clear picture of what is committed and what remains.</p><span className="service-tool__action">Start planning <Arrow /></span></a>
        <a className="service-tool" href="/wallet"><div className="service-tool__top"><Icon name="records" /><span className="service-status service-status--neutral">Developer pilot</span></div><h3>Manage your records</h3><p>Keep accounts, saved balances, and activity together in a local workspace. Repository access and setup are required.</p><span className="service-tool__action">Read the workspace guide <Arrow /></span></a>
        <a className="service-tool" href="/connections"><div className="service-tool__top"><Icon name="connections" /><span className="service-status service-status--neutral">Check availability</span></div><h3>Bring things together</h3><p>Understand which providers can read records and which payment routes are available.</p><span className="service-tool__action">Explore connections <Arrow /></span></a>
      </div>
    </section>

    <section className="service-insights" aria-labelledby="insights-title"><div><p className="service-eyebrow">Make sense of the bigger picture</p><h2 id="insights-title">Money information,<br />with the sources attached.</h2><p>Understand the context around your money. Each research view keeps its dates, sources, and coverage limits visible.</p></div><div className="service-insights__links"><a href="/world"><span><strong>Money insights</strong><small>Rates, currency references, and policy dates</small></span><Arrow /></a><a href="/capital-flows"><span><strong>Capital flows</strong><small>Published financing and investment transactions</small></span><Arrow /></a><a href="/onchain"><span><strong>Network insights</strong><small>Selected blockchain observations and fees</small></span><Arrow /></a></div></section>

    <section className="service-principles" aria-label="What you can expect"><div><span>01</span><h3>Start without connecting a bank.</h3><p>Use the money planner right away. Add records and connections when they serve a purpose.</p></div><div><span>02</span><h3>Understand before you act.</h3><p>See where figures came from. Review supported payments before you confirm them.</p></div><div><span>03</span><h3>Keep control of your next step.</h3><p>Export your plan, choose what to save, and keep private account records on your own computer.</p></div></section>
  </ServiceLayout>;
}
