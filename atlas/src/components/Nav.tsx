import { useActiveSection } from "../lib/hooks";

const LINKS: { id: string; label: string }[] = [
  { id: "creed", label: "Creed" },
  { id: "weave", label: "Weave" },
  { id: "decisions", label: "Reasons" },
  { id: "roadmap", label: "Not yet" },
  { id: "craft", label: "Craft" },
];

export default function Nav() {
  const active = useActiveSection(LINKS.map((l) => l.id));
  return (
    <nav className="selvage" aria-label="Sections of the atlas">
      <a className="selvage__brand" href="#creed">
        <span className="selvage__mark" aria-hidden="true" />
        <span className="selvage__word">CashLoom</span>
        <span className="selvage__sub">The Atlas</span>
      </a>
      <ul className="selvage__links">
        <li>
          <a href="/world" className="selvage__link">
            World ↗
          </a>
        </li>
        <li>
          <a href="/onchain" className="selvage__link">
            Onchain ↗
          </a>
        </li>
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
