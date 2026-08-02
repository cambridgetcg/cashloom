import { HOW_WE_BUILD, PHILOSOPHY } from "../atlas.manifest";
import { useReveal } from "../lib/hooks";

export default function HowWeBuild() {
  const { ref, shown } = useReveal<HTMLOListElement>();
  return (
    <section id="craft" className="section craft-section">
      <div className="section__head">
        <p className="eyebrow">07 · The craft</p>
        <h2 className="display">{HOW_WE_BUILD.title}</h2>
        <p className="lede">
          The atlas ends where the work begins: the habits of hand that every
          module is measured against.
        </p>
      </div>

      <ol ref={ref} className={"principles " + (shown ? "is-in" : "")}>
        {HOW_WE_BUILD.principles.map((p, i) => (
          <li className="principle" key={i} style={{ ["--d" as string]: i }}>
            <span className="principle__n">{String(i + 1).padStart(2, "0")}</span>
            <div className="principle__body">
              <h3 className="principle__name">{p.name}</h3>
              <p className="principle__text">{p.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <footer className="colophon">
        <p className="colophon__line">{PHILOSOPHY.line}</p>
        <p className="colophon__meta">
          {PHILOSOPHY.name} · the reference implementation · non-custodial,
          local-first, no operator on the other end. Everything you just read is
          the actual source — run it, read it, fork it, or write your own.
        </p>
      </footer>
    </section>
  );
}
