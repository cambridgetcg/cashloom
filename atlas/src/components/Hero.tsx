import { PHILOSOPHY } from "../atlas.manifest";

export default function Hero() {
  return (
    <header id="creed" className="hero">
      <div className="hero__inner">
        <p className="hero__kicker">How it works · design &amp; source code</p>

        <h1 className="hero__title">Understand your workspace.</h1>

        <p className="hero__line">Every module has a job. Every action has a reason.</p>

        <p className="hero__invitation">Explore how the local workspace keeps your accounts, keys and payment records connected, and where work is still in progress. To start using it, <a className="inline-link" href="/wallet">open your workspace guide</a>.</p>

        <ul className="creed">
          {PHILOSOPHY.creed.map((c, i) => {
            const [head, ...rest] = c.split("—");
            const tail = rest.join("—").trim();
            return (
              <li key={i} className="creed__item" style={{ ["--d" as string]: i }}>
                <span className="creed__knot" aria-hidden="true" />
                <span className="creed__head">{head.trim()}</span>
                {tail && <span className="creed__body">{tail}</span>}
              </li>
            );
          })}
        </ul>

        <div className="hero__cta">
          <a className="btn btn--ember" href="#weave">
            Explore the modules
          </a>
          <a className="btn btn--ghost" href="#decisions">
            Read the reasons
          </a>
        </div>
      </div>

    </header>
  );
}
