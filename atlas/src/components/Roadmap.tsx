import { ROADMAP, type RoadmapThread } from "../atlas.manifest";
import { useReveal } from "../lib/hooks";

const STATUS_LABEL: Record<RoadmapThread["status"], string> = {
  next: "next on the loom",
  planned: "planned",
  considering: "considering",
};

export default function Roadmap() {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <section id="roadmap" className="section roadmap-section">
      <div className="section__head">
        <p className="eyebrow">06 · Not yet woven</p>
        <h2 className="display">Threads waiting on the shuttle</h2>
        <p className="lede">
          Forward thinking, not a checklist. Each of these is deliberately{" "}
          <em>not</em> built yet — held back until it can be done without
          quietly losing someone's money.
        </p>
      </div>

      <div ref={ref} className={"roadmap " + (shown ? "is-in" : "")}>
        {ROADMAP.map((t, i) => (
          <article
            className={`rthread rthread--${t.status}`}
            key={i}
            style={{ ["--d" as string]: i }}
          >
            <div className="rthread__ghost" aria-hidden="true" />
            <div className="rthread__head">
              <span className={`rbadge rbadge--${t.status}`}>{STATUS_LABEL[t.status]}</span>
              <h3 className="rthread__title">{t.title}</h3>
            </div>
            <p className="rthread__mindset">{t.mindset}</p>
            <div className="rthread__why">
              <span className="rthread__why-label">Why not yet</span>
              <p>{t.whyNotYet}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
