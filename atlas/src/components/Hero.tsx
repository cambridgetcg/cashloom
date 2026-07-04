import { PHILOSOPHY } from "../atlas.manifest";

export default function Hero() {
  return (
    <header id="creed" className="hero">
      <div className="hero__loom" aria-hidden="true">
        <svg
          viewBox="0 0 1200 700"
          preserveAspectRatio="xMidYMid slice"
          className="hero__threads"
        >
          {Array.from({ length: 22 }).map((_, i) => {
            const y = 40 + i * 30;
            const hue = i % 5 === 0 ? "#d4502e" : i % 3 === 0 ? "#57b6a9" : "#d8a24a";
            return (
              <path
                key={i}
                d={`M -50 ${y} C 300 ${y - 60}, 900 ${y + 70}, 1250 ${y - 20}`}
                stroke={hue}
                style={{ ["--i" as string]: i }}
                pathLength={1}
              />
            );
          })}
        </svg>
        <div className="hero__grain" />
      </div>

      <div className="hero__inner">
        <p className="hero__kicker">The Atlas · the human door</p>

        <h1 className="hero__title">{PHILOSOPHY.name}</h1>

        <p className="hero__line">{PHILOSOPHY.line}</p>

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

        <p className="hero__invitation">{PHILOSOPHY.invitation}</p>

        <div className="hero__cta">
          <a className="btn btn--ember" href="#weave">
            Enter the weave
          </a>
          <a className="btn btn--ghost" href="#decisions">
            Read the reasons
          </a>
        </div>
      </div>

      <a className="hero__scroll" href="#weave" aria-label="Scroll to the weave">
        <span />
      </a>
    </header>
  );
}
