import { CASHLOOM_CAPABILITIES } from "../../../sovereign/src/info/capabilities.ts";
import { useReveal } from "../lib/hooks";

function words(value: string): string {
  return value.replaceAll("_", " ");
}

function isLive(status: string): boolean {
  return status === "implemented" || status.startsWith("implemented_for_");
}

export default function PaymentTruth() {
  const { ref, shown } = useReveal<HTMLOListElement>();

  return (
    <section id="truth" className="section truth-section">
      <div className="section__head">
        <p className="eyebrow">03 · Payment truth</p>
        <h2 className="display">One payment. Six different claims.</h2>
        <p className="lede">
          A signature, a browser return, a broadcast, and settlement are not
          synonyms. CashLoom keeps each claim separate so the next screen
          cannot quietly promote evidence into money.
        </p>
      </div>

      <ol ref={ref} className={`truth-rail ${shown ? "is-in" : ""}`}>
        {CASHLOOM_CAPABILITIES.payment_truth.map((stage, index) => (
          <li className="truth-stage" key={stage.id}>
            <div className="truth-stage__top">
              <span className="truth-stage__number">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                className={`truth-status ${isLive(stage.status) ? "is-live" : "is-later"}`}
              >
                {isLive(stage.status) ? "implemented" : "not released"}
              </span>
            </div>
            <h3>{stage.label}</h3>
            <dl>
              <div>
                <dt>Can prove</dt>
                <dd>{stage.proves}</dd>
              </div>
              <div>
                <dt>Cannot prove</dt>
                <dd>{stage.does_not_prove}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>

      <div className="unknown-rule" role="note">
        <span className="unknown-rule__mark" aria-hidden="true">?</span>
        <div>
          <h3>Unknown stays unknown</h3>
          <p>{CASHLOOM_CAPABILITIES.recovery.instruction}</p>
          <p className="unknown-rule__debt">
            Known recovery debt: {CASHLOOM_CAPABILITIES.recovery.known_debt}.
          </p>
        </div>
      </div>

      <div className="truth-columns">
        <div>
          <p className="minor-head">Capability matrix · exact release state</p>
          <div className="rail-list">
            {CASHLOOM_CAPABILITIES.rails.map((rail) => (
              <article className="rail-card" key={rail.id}>
                <h3>{words(rail.id)}</h3>
                <ul>
                  {Object.entries(rail)
                    .filter(([key]) => key !== "id" && key !== "note")
                    .map(([key, value]) => (
                      <li key={key}>
                        <span>{words(key)}</span>
                        <strong>{words(value)}</strong>
                      </li>
                    ))}
                </ul>
                {"note" in rail && <p>{rail.note}</p>}
              </article>
            ))}
          </div>
        </div>

        <div>
          <p className="minor-head">Files that travel · money that does not</p>
          <div className="artifact-list">
            {CASHLOOM_CAPABILITIES.portable_artifacts.map((artifact) => (
              <article className="artifact-card" key={artifact.extension}>
                <code>{artifact.extension}</code>
                <span>{words(artifact.visibility)}</span>
                <p>{artifact.meaning}.</p>
                <p className="artifact-card__not">
                  Not proof of {artifact.does_not_mean}.
                </p>
              </article>
            ))}
          </div>

          <article className="market-boundary">
            <p className="market-boundary__label">Marketplace boundary</p>
            <h3>Infrastructure, not judge or escrow.</h3>
            <p>
              Shops and third-party providers may publish evidence and terms;
              participants choose what to trust. CashLoom supplies no universal
              legitimacy badge and does not adjudicate disputes.
            </p>
            <p>
              Refunds, reversals, and chargebacks are later adjustment events—
              never edits that erase the earlier payment history.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}
