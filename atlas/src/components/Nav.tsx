import { useActiveSection } from "../lib/hooks";

const LINKS: { id: string; label: string }[] = [
  { id: "start", label: "Run locally" },
  { id: "truth", label: "Payment truth" },
  { id: "weave", label: "Code map" },
  { id: "decisions", label: "Decisions" },
  { id: "roadmap", label: "Roadmap" },
];

export default function Nav() {
  const active = useActiveSection(LINKS.map((l) => l.id));
  return (
    <nav className="selvage" aria-label="Sections of the atlas">
      <a className="selvage__brand" href="#creed">
        <span className="selvage__mark" aria-hidden="true" />
        <span className="selvage__word">CashLoom</span>
        <span className="selvage__sub">Sovereign payments</span>
      </a>
      <ul className="selvage__links">
        {LINKS.map((l) => (
          <li key={l.id}>
            <a
              href={`#${l.id}`}
              className={"selvage__link" + (active === l.id ? " is-active" : "")}
              aria-current={active === l.id ? "true" : undefined}
            >
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
