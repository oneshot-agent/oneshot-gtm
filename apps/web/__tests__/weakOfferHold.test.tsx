import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SendHoldNote } from "../src/components/queue/WeakOfferHold.tsx";

const reason =
  "The offer was rated a weak fit for this firm. Rewrite it, pick another, or approve it.";
const render = (code: "weak-offer" | "off-icp") =>
  renderToStaticMarkup(<SendHoldNote hold={{ code, reason }} />);

it("explains a weak-offer hold with the held line's advice", () => {
  const html = render("weak-offer");
  expect(html).toContain("Held · weak offer · approve the offer, pick another or rewrite it");
  expect(html).toContain(reason);
  expect(html).toContain("Regenerating the draft will not clear this hold");
});

it("leaves Approve offer to the offer block", () => {
  expect(render("weak-offer")).not.toContain("Approve offer");
  expect(render("weak-offer")).not.toContain("<button");
});

it("keeps the fit hold for an off-ICP row", () => {
  const html = render("off-icp");
  expect(html).toContain("Held · fit review");
  expect(html).not.toContain("Approve offer");
});
