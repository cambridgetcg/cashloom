import { formatMinorCompact } from "../format";
import type {
  QuoteFeeComponent,
  QuoteFeeComponentKind,
  QuoteFeeTerms as QuoteFeeTermsValue,
} from "../types";

const componentFor = (
  terms: QuoteFeeTermsValue,
  kind: QuoteFeeComponentKind,
): QuoteFeeComponent | undefined => terms.components.find((component) => component.kind === kind);

function AtomicQuoteFee({
  amount,
  feeAsset,
  decimals,
}: {
  amount: string;
  feeAsset: string;
  decimals: number;
}) {
  const label = feeAsset === "ETH(wei)" ? "wei" : feeAsset;
  return (
    <span className="quote-term-value">
      <span className="amt">{formatMinorCompact(amount, decimals)} {label}</span>
      {decimals > 0 && <code>{amount} atomic</code>}
    </span>
  );
}

function Source({ component }: { component: QuoteFeeComponent | undefined }) {
  if (!component) return null;
  return (
    <small>
      {component.source_block ? <>Pinned at Base block <code>{component.source_block}</code> · </> : null}
      {component.method}
    </small>
  );
}

/** Base's total protocol fee cannot truthfully be presented as one transaction
 * hard cap. This renders the execution cap separately from the two estimates. */
export function QuoteFeeTerms({
  terms,
  feeAsset,
  feeDecimals,
}: {
  terms: QuoteFeeTermsValue;
  feeAsset: string;
  feeDecimals: number;
}) {
  const execution = componentFor(terms, "l2_execution");
  const l1 = componentFor(terms, "l1_data_security");
  const operator = componentFor(terms, "operator");
  return (
    <section className="quote-terms" aria-labelledby="base-fee-terms-title">
      <div className="quote-terms-head">
        <h3 id="base-fee-terms-title">Base protocol fee terms</h3>
        <span className="badge" data-tone="gold">Estimate, not a maximum</span>
      </div>
      <dl>
        <div>
          <dt>L2 execution hard cap</dt>
          <dd>
            <AtomicQuoteFee amount={terms.hard_execution_cap_atomic} feeAsset={feeAsset} decimals={feeDecimals} />
            <Source component={execution} />
          </dd>
        </div>
        <div>
          <dt>L1 data/security upper-bound estimate</dt>
          <dd>
            <AtomicQuoteFee amount={terms.estimated_l1_upper_bound_atomic} feeAsset={feeAsset} decimals={feeDecimals} />
            <Source component={l1} />
          </dd>
        </div>
        <div>
          <dt>Operator upper-bound estimate</dt>
          <dd>
            <AtomicQuoteFee amount={terms.estimated_operator_upper_bound_atomic} feeAsset={feeAsset} decimals={feeDecimals} />
            <Source component={operator} />
          </dd>
        </div>
        <div className="quote-terms-total">
          <dt>Estimated total</dt>
          <dd><AtomicQuoteFee amount={terms.estimated_total_atomic} feeAsset={feeAsset} decimals={feeDecimals} /></dd>
        </div>
      </dl>
      <p>
        <strong>The estimated total is not a hard maximum.</strong> Base's L1
        data/security and operator inputs are sampled at the displayed block
        and can change before inclusion. The transaction itself hard-caps only
        the L2 execution term.
      </p>
    </section>
  );
}
