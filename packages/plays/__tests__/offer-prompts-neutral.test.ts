import { describe, expect, it } from "vitest";
import { loadPrompt } from "@oneshot-gtm/intel";
import { OFFER_ROLE_RESCUE, offerRelevanceCriteria } from "../src/_prospect-offer.ts";

// The offer writer and judge every workspace shares carry a bar any product
// can meet. One product's shape of offer (how long the work runs, who does
// it, whether a check, a report or paperwork can be the offer) is that
// workspace's `offerRules` and `offerChecks`, never the shipped text.
const ONE_PRODUCT = [
  /over weeks/i,
  /weeks of work/i,
  /by machine/i,
  /outside parties/i,
  /into production/i,
  /the system that/i,
  /paperwork/i,
  /agent execution/i,
  /\bmonitor/i,
];

describe("the shared offer prompts stay product-neutral", () => {
  const texts: Record<string, string> = {
    "prospect-offer": loadPrompt("prospect-offer"),
    "prospect-offer-judge": loadPrompt("prospect-offer-judge"),
    "prospect-offer-rescue": loadPrompt("prospect-offer-rescue"),
    "the role rescue": OFFER_ROLE_RESCUE,
    ...Object.fromEntries(
      Object.entries(offerRelevanceCriteria()).map(([label, text]) => [`criteria ${label}`, text]),
    ),
  };
  for (const [name, body] of Object.entries(texts)) {
    it(`${name} states no one product's shape of offer`, () => {
      for (const rx of ONE_PRODUCT) expect(body, String(rx)).not.toMatch(rx);
    });
  }
});
