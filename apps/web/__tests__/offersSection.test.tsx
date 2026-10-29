import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OffersSection } from "../src/components/setup/OffersSection.tsx";
import type { SetupCfg } from "../src/components/setup/types.ts";
import {
  offerSectionErrors,
  offerSectionRequest,
  offerSectionValues,
} from "../src/lib/offerSettings.ts";

// The /setup section for the offer writer: rewrite rounds, a fallback model
// and its switch, and the decisions check's pass line.

const noop = () => {};
const render = (cfg: Partial<SetupCfg>) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <OffersSection cfg={cfg as SetupCfg} sources={{}} onDirtyChange={noop} />
    </QueryClientProvider>,
  );
const toggle = (html: string) => html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
const judge = {
  engine: "decisions" as const,
  model: "openai/gpt-5-mini",
  minConfidence: 0.5,
};

describe("OffersSection", () => {
  it("renders the defaults: 3 rounds, no fallback model, the switch off and disabled", () => {
    const html = render({});
    expect(html).toContain('value="3"');
    expect(html).toContain('placeholder="anthropic/claude-sonnet-5-5"');
    expect(html).toContain('value=""');
    expect(toggle(html)).toContain('aria-checked="false"');
    expect(toggle(html)).toContain(`disabled=""`);
    expect(html).not.toContain("Pass line");
  });

  it("enables the fallback switch once a model is set", () => {
    const html = render({ offerWriter: { fallbackModel: "anthropic/claude-opus-5-5" } });
    expect(toggle(html)).not.toContain(`disabled=""`);
    expect(offerSectionValues({ offerWriter: { fallbackModel: "m" } }).fallbackModel).toBe("m");
  });

  it("shows the pass line only with the decisions check on", () => {
    expect(render({ offerJudge: judge })).toContain("Pass line");
    expect(render({ offerJudge: { engine: "llm" } })).not.toContain("Pass line");
  });
});

describe("Offers section request", () => {
  const values = offerSectionValues({});

  it("sends offerWriter whole, without a model and with the switch forced off when blank", () => {
    expect(offerSectionRequest({ ...values, rounds: "2" }, { rounds: "2" }, {})).toEqual({
      offerWriter: { rounds: 2, fallbackOnWeak: false },
    });
    const typed = { ...values, fallbackModel: " anthropic/claude-opus-5-5 ", fallbackOnWeak: true };
    expect(offerSectionRequest(typed, { fallbackModel: typed.fallbackModel }, {})).toEqual({
      offerWriter: { rounds: 3, fallbackModel: "anthropic/claude-opus-5-5", fallbackOnWeak: true },
    });
    const cleared = { ...values, fallbackModel: "", fallbackOnWeak: true };
    expect(offerSectionRequest(cleared, { fallbackModel: "" }, {})).toEqual({
      offerWriter: { rounds: 3, fallbackOnWeak: false },
    });
  });

  it("sends offerJudge whole with its model, only when the pass line changed", () => {
    const cfg = { offerJudge: judge };
    const v = { ...offerSectionValues(cfg), minConfidence: "0.7" };
    expect(offerSectionRequest(v, { minConfidence: "0.7" }, cfg)).toEqual({
      offerJudge: { engine: "decisions", model: "openai/gpt-5-mini", minConfidence: 0.7 },
    });
    expect(offerSectionRequest(v, { rounds: "3" }, cfg)).not.toHaveProperty("offerJudge");
  });

  it("rejects 6 rounds, a pass line of 1.5 and a model over 200 characters", () => {
    const errors = offerSectionErrors({
      ...values,
      rounds: "6",
      minConfidence: "1.5",
      fallbackModel: "m".repeat(201),
    });
    expect(errors.rounds).toBe("A whole number from 0 to 5.");
    expect(errors.minConfidence).toBe("A number from 0 to 1.");
    expect(errors.fallbackModel).toBe("At most 200 characters.");
    expect(offerSectionErrors(values)).toEqual({
      rounds: null,
      fallbackModel: null,
      minConfidence: null,
    });
  });
});
