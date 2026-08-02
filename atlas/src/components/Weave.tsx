import { useMemo, useState } from "react";
import { MODULES } from "../atlas.manifest";
import { buildEdges, neighbours, roleOf, SEAM, type Seam } from "../lib/weave";
import { usePrefersReducedMotion, useReveal } from "../lib/hooks";

const W = 1000;
const H = 640;
const PAD_X = 132;
const PAD_Y = 104;

function pos(x: number, y: number) {
  return {
    cx: PAD_X + x * (W - PAD_X * 2),
    cy: PAD_Y + y * (H - PAD_Y * 2),
  };
}

// A gentle woven bow between two knots. Direction alternates by a stable hash
// so threads cross like weft over warp instead of lying flat.
function thread(ax: number, ay: number, bx: number, by: number, sway: number) {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bow = Math.min(len * 0.16, 74) * sway;
  const cx = mx + nx * bow;
  const cy = my + ny * bow;
  return `M ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
}

interface Props {
  onOpen: (id: string) => void;
}

export default function Weave({ onOpen }: Props) {
  const edges = useMemo(() => buildEdges(), []);
  const [active, setActive] = useState<string | null>(null);
  const reduced = usePrefersReducedMotion();
  const { ref, shown } = useReveal<HTMLDivElement>();

  const nodes = useMemo(
    () =>
      MODULES.map((m) => ({
        m,
        seam: roleOf(m.id) as Seam,
        ...pos(m.weave.x, m.weave.y),
      })),
    [],
  );
  const nodePos = useMemo(() => {
    const map = new Map<string, { cx: number; cy: number }>();
    nodes.forEach((n) => map.set(n.m.id, { cx: n.cx, cy: n.cy }));
    return map;
  }, [nodes]);

  const near = active ? neighbours(active, edges) : null;

  return (
    <section id="weave" className="section weave-section">
      <div className="section__head">
        <p className="eyebrow">04 · The code map</p>
        <h2 className="display">{MODULES.length} ideas, held on one loom</h2>
        <p className="lede">
          Each knot is a module, placed where it sits in the machine. The
          threads are what leans on what. Follow one with your eye — or your
          keyboard — and open it to read the real code underneath.
        </p>
      </div>

      <div
        ref={ref}
        className={"weave " + (shown ? "is-in" : "") + (reduced ? " reduced" : "")}
        onMouseLeave={() => setActive(null)}
      >
        <svg
          className="weave__svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`A woven map of CashLoom's ${MODULES.length} modules and the threads between them.`}
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <filter id="thread-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="3.2" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <radialGradient id="knot-core" cx="50%" cy="42%" r="65%">
              <stop offset="0%" stopColor="#241f27" />
              <stop offset="100%" stopColor="#0e0c11" />
            </radialGradient>
          </defs>

          {/* the warp — faint vertical guides, the frame of the loom */}
          <g className="weave__warp" aria-hidden="true">
            {Array.from({ length: 9 }).map((_, i) => {
              const x = PAD_X + (i / 8) * (W - PAD_X * 2);
              return <line key={i} x1={x} y1={PAD_Y - 40} x2={x} y2={H - PAD_Y + 40} />;
            })}
          </g>

          {/* threads */}
          <g className="weave__threads">
            {edges.map((e, i) => {
              const pa = nodePos.get(e.a)!;
              const pb = nodePos.get(e.b)!;
              const sway = i % 2 === 0 ? 1 : -1;
              const d = thread(pa.cx, pa.cy, pb.cx, pb.cy, sway);
              const isActive = active && (e.a === active || e.b === active);
              const isDim = active && !isActive;
              const c = SEAM[e.seam];
              return (
                <g key={`${e.a}-${e.b}`} className="thread-group">
                  <path
                    className={
                      "thread" +
                      (isActive ? " thread--active" : "") +
                      (isDim ? " thread--dim" : "")
                    }
                    d={d}
                    stroke={c.stroke}
                    style={{
                      // draw-in stagger
                      // @ts-expect-error custom property
                      "--i": i,
                      filter: isActive ? "url(#thread-glow)" : undefined,
                    }}
                    pathLength={1}
                  />
                  {isActive && !reduced && (
                    <path className="thread-spark" d={d} stroke={c.glow} pathLength={1} />
                  )}
                </g>
              );
            })}
          </g>

          {/* knots */}
          <g className="weave__knots">
            {nodes.map((n) => {
              const isActive = active === n.m.id;
              const isNear = near?.has(n.m.id);
              const isDim = active && !isActive && !isNear;
              const c = SEAM[n.seam];
              return (
                <g
                  key={n.m.id}
                  className={
                    "knot knot--" +
                    n.seam +
                    (isActive ? " knot--active" : "") +
                    (isDim ? " knot--dim" : "")
                  }
                  transform={`translate(${n.cx} ${n.cy})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open module: ${n.m.title}. ${n.m.subtitle}`}
                  onMouseEnter={() => setActive(n.m.id)}
                  onFocus={() => setActive(n.m.id)}
                  onBlur={() => setActive((cur) => (cur === n.m.id ? null : cur))}
                  onClick={() => onOpen(n.m.id)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      onOpen(n.m.id);
                    }
                  }}
                >
                  <circle className="knot__halo" r={30} fill={c.soft} />
                  <circle className="knot__ring" r={15} stroke={c.stroke} />
                  <circle className="knot__bead" r={7.5} fill={c.stroke} />
                  <circle className="knot__pip" r={2.6} fill="#0c0a0e" />
                  <text className="knot__label" y={44} textAnchor="middle">
                    {n.m.title}
                  </text>
                  <text className="knot__sub" y={60} textAnchor="middle">
                    {n.m.subtitle}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        <ul className="weave__legend" aria-hidden="true">
          {(["read", "write", "core"] as Seam[]).map((s) => (
            <li key={s} className={`lg lg--${s}`}>
              <span className="lg__swatch" style={{ background: SEAM[s].stroke }} />
              <span className="lg__name">{SEAM[s].name}</span>
              <span className="lg__gloss">{SEAM[s].gloss}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="weave__truth">
        Look closely: the <em>read</em> threads and the <em>write</em> threads
        never touch each other directly. They meet only at{" "}
        <button className="inline-link" onClick={() => onOpen("the-node")}>
          the Node
        </button>{" "}
        and{" "}
        <button className="inline-link" onClick={() => onOpen("the-ledger")}>
          the Ledger
        </button>
        . That gap is the whole architecture — safety by shape, not by care.
      </p>

      {/* Keyboard- and touch-friendly index; the same doors, in a list. */}
      <div className="module-index" aria-label={`The ${MODULES.length} modules`}>
        <h3 className="module-index__title">Or browse all {MODULES.length}</h3>
        <ul>
          {MODULES.map((m) => {
            const c = SEAM[roleOf(m.id)];
            return (
              <li key={m.id}>
                <button
                  className="mi"
                  onMouseEnter={() => setActive(m.id)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(m.id)}
                  onBlur={() => setActive(null)}
                  onClick={() => onOpen(m.id)}
                >
                  <span className="mi__dot" style={{ background: c.stroke }} />
                  <span className="mi__text">
                    <span className="mi__title">{m.title}</span>
                    <span className="mi__sub">{m.subtitle}</span>
                  </span>
                  <span className="mi__idea">{m.idea}</span>
                  <span className="mi__go" aria-hidden="true">
                    read →
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
