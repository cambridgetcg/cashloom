import { useActiveSection } from "../lib/hooks";
import { PublicHeader } from "./PublicHeader";

const LINKS: { id: string; label: string }[] = [
  { id: "creed", label: "Purpose" },
  { id: "weave", label: "Modules" },
  { id: "decisions", label: "Reasons" },
  { id: "roadmap", label: "In development" },
  { id: "craft", label: "How we build" },
];

export default function Nav() {
  const active = useActiveSection(LINKS.map((l) => l.id));
  return (
    <PublicHeader current="atlas">
      <div className="module-toolbar"><nav aria-label="How it works sections"><ul>
        {LINKS.map((l) => (
          <li key={l.id}>
            <a
              href={`#${l.id}`}
              aria-current={active === l.id ? "true" : undefined}
            >
              {l.label}
            </a>
          </li>
        ))}
      </ul></nav></div>
    </PublicHeader>
  );
}
