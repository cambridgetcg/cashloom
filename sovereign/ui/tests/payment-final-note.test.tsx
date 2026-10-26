import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentFinalNote } from "../src/components/PaymentFinalNote";

test("the review card says a sent payment is final, calmly, before signing", () => {
  const html = renderToStaticMarkup(<PaymentFinalNote />);
  expect(html).toContain("can&#x27;t be recalled");
  expect(html).toContain("a channel you find yourself");
  expect(html).not.toMatch(/warning|danger|urgent|act now/i);
});
