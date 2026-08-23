import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuoteFeeTerms } from "../src/components/QuoteFeeTerms";

test("Base quote separates the execution hard cap from block-pinned estimates", () => {
  const html = renderToStaticMarkup(
    <QuoteFeeTerms
      feeAsset="ETH(wei)"
      feeDecimals={0}
      terms={{
        schema_version: "cashloom.payment-fee-terms/1",
        hard_execution_cap_atomic: "42000000000000",
        estimated_l1_upper_bound_atomic: "2500000000",
        estimated_operator_upper_bound_atomic: "0",
        estimated_total_atomic: "42002500000000",
        total_is_hard_cap: false,
        components: [
          {
            kind: "l2_execution",
            amount_atomic: "42000000000000",
            classification: "hard_cap",
            method: "gas_limit_x_max_fee_per_gas",
          },
          {
            kind: "l1_data_security",
            amount_atomic: "2500000000",
            classification: "estimated_upper_bound",
            method: "GasPriceOracle.getL1FeeUpperBound",
            source_block: "34567890",
          },
          {
            kind: "operator",
            amount_atomic: "0",
            classification: "estimated_upper_bound",
            method: "GasPriceOracle.getOperatorFee",
            source_block: "34567890",
          },
        ],
      }}
    />,
  );

  expect(html).toContain("L2 execution hard cap");
  expect(html).toContain("L1 data/security upper-bound estimate");
  expect(html).toContain("Operator upper-bound estimate");
  expect(html).toContain("Pinned at Base block");
  expect(html).toContain("34567890");
  expect(html).toContain("not a hard maximum");
  expect(html).toContain("42,002,500,000,000 wei");
});
