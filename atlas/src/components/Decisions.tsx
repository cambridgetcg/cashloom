import { DECISIONS, MODULES } from "../atlas.manifest";
import { useReveal } from "../lib/hooks";

interface Props {
  onOpen: (id: string) => void;
}

/** Turn a livesIn string ("a · b") into clickable module pointers. */
function LivesIn({ value, onOpen }: { value: string; onOpen: (id: string) => void }) {
  const parts = value
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <div className="lives-in">
      <span className="lives-in__label">Lives in</span>
      {parts.map((p) => {
        const mod = MODULES.find((m) => m.id === p);
        if (mod) {
          return (
            <button key={p} className="lives-in__link" onClick={() => onOpen(mod.id)}>
              {mod.title}
            </button>
          );
        }
        return (
          <span key={p} className="lives-in__plain">
            {p}
          </span>
        );
      })}
    </div>
  );
}

export default function Decisions({ onOpen }: Props) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <section id="decisions" className="section decisions-section">
      <div className="section__head">
        <p className="eyebrow">05 · The decisions</p>
        <h2 className="display">Every fork, and the road taken</h2>
        <p className="lede">
          A codebase is a pile of answers. Here are the questions — and the
          roads not taken, kept in view on purpose. This is where the{" "}
          <em>why</em> lives.
        </p>
      </div>

      <div ref={ref} className={"decisions " + (shown ? "is-in" : "")}>
        {DECISIONS.map((d, i) => (
          <article className="decision" key={i} style={{ ["--d" as string]: i }}>
            <div className="decision__q">
              <span className="decision__n">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="decision__question">{d.question}</h3>
            </div>

            <ul className="options">
              {d.options.map((o, j) => (
                <li key={j} className={`option option--${o.verdict}`}>
                  <span className="option__mark" aria-hidden="true">
                    {o.verdict === "chosen" ? "●" : "╱"}
                  </span>
                  <div className="option__text">
                    <span className="option__label">{o.label}</span>
                    <span className="option__note">{o.note}</span>
                  </div>
                  <span className="option__verdict" aria-label={o.verdict}>
                    {o.verdict === "chosen" ? "woven" : "cut"}
                  </span>
                </li>
              ))}
            </ul>

            <div className="decision__because">
              <span className="decision__because-label">Because</span>
              <p>{d.because}</p>
            </div>

            <LivesIn value={d.livesIn} onOpen={onOpen} />
          </article>
        ))}
      </div>
    </section>
  );
}
