import { beforeEach, describe, expect, it, vi } from "vitest";

// The humanizer's `Hey` greeting and lowercase subject are the defaults for
// every workspace. `founderGreeting` and `subjectCase` override them: unset
// (or set to the default) adds nothing anywhere, so the prompt and the
// checks are unchanged; any other value reaches the draft as a VOICE line
// and, for subject case, turns the lowercase check and its repair off.

let cfgOverride: Record<string, unknown> = {};
const responses: string[] = [];
const calls: Array<Array<{ role: string; content: string }>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      founderVoice: null,
      productDomain: null,
      founderName: "Sam",
      ...cfgOverride,
    }),
    logEvent: () => undefined,
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      calls.push(input.messages.map((m) => ({ ...m })));
      const next = responses.shift();
      if (next === undefined) throw new Error("no more responses");
      return { content: next, provider: "t", model: "t" };
    },
  };
});

const { founderGreetingOf, subjectCaseOf } = await import("@oneshot-gtm/core");
const {
  lintEmail,
  openerStem,
  opensOnObservation,
  opensWithOffer,
  repairWritingLints,
  voiceBlock,
  voiceKey,
  voiceOverrideLines,
} = await import("../src/_lib.ts");

const CARD = "MOVES\n- a fact, then the mechanism under it";
const messages = () => [
  { role: "system" as const, content: "write" },
  { role: "user" as const, content: "input" },
];

beforeEach(() => {
  cfgOverride = {};
  responses.length = 0;
  calls.length = 0;
});

describe("founderGreetingOf / subjectCaseOf", () => {
  it("read unset, blank and unknown values as today's defaults", () => {
    for (const v of [undefined, null, "", "   ", 3]) {
      expect(founderGreetingOf({ founderGreeting: v })).toBe("Hey");
    }
    for (const v of [undefined, null, "", "Lowercase", "title"]) {
      expect(subjectCaseOf({ subjectCase: v })).toBe("lowercase");
    }
  });

  it("read an override as set, and any-case 'none' as no greeting", () => {
    expect(founderGreetingOf({ founderGreeting: "  Hi, " })).toBe("Hi");
    expect(founderGreetingOf({ founderGreeting: "NONE" })).toBe("none");
    expect(subjectCaseOf({ subjectCase: "sentence" })).toBe("sentence");
    expect(subjectCaseOf({ subjectCase: "as-written" })).toBe("as-written");
  });
});

describe("voiceOverrideLines", () => {
  it("is empty when unset or set to the defaults", () => {
    expect(voiceOverrideLines({})).toEqual([]);
    expect(voiceOverrideLines({ founderGreeting: "Hey", subjectCase: "lowercase" })).toEqual([]);
  });

  it("states a greeting override, and none", () => {
    const [hi] = voiceOverrideLines({ founderGreeting: "Hi" });
    expect(hi).toMatch(/^GREETING: Hi \(/);
    expect(hi).toContain('"Hi," or "Hi <first name>,"');
    expect(hi).toContain('overrides every "Hey" greeting rule');
    const [none] = voiceOverrideLines({ founderGreeting: "none" });
    expect(none).toMatch(/^GREETING: none \(never open with a greeting/);
  });

  it("states a subject-case override", () => {
    expect(voiceOverrideLines({ subjectCase: "sentence" })[0]).toMatch(
      /^SUBJECT CASE: sentence \(.*overrides every lowercase-subject rule/,
    );
    expect(voiceOverrideLines({ subjectCase: "as-written" })[0]).toMatch(
      /^SUBJECT CASE: as written \(no case rule/,
    );
  });
});

describe("voiceBlock with overrides", () => {
  it("stays null with no card and no override", () => {
    cfgOverride = { founderGreeting: "Hey", subjectCase: "lowercase" };
    expect(voiceBlock("intro")).toBeNull();
  });

  it("carries only the overrides when there is no card", () => {
    cfgOverride = { founderGreeting: "Hi", subjectCase: "sentence" };
    const out = voiceBlock("intro")!;
    expect(out.text.startsWith("VOICE (")).toBe(true);
    expect(out.text).toContain("GREETING: Hi");
    expect(out.text).toContain("SUBJECT CASE: sentence");
    expect(out.text).not.toContain("VOICE BUDGET");
    // No card: its drafts count as voice off, not as a card of their own.
    expect(out.key).toBeNull();
  });

  it("puts the overrides after the card and keys on the card alone", () => {
    cfgOverride = { founderVoice: CARD };
    const plain = voiceBlock("intro")!;
    cfgOverride = { founderVoice: CARD, founderGreeting: "none" };
    const out = voiceBlock("intro")!;
    expect(out.key).toBe(voiceKey(CARD));
    expect(out.key).toBe(plain.key);
    const lines = out.text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("GREETING: none"));
    expect(at).toBeGreaterThan(lines.indexOf("- a fact, then the mechanism under it"));
    expect(lines.at(-1)).toMatch(/^VOICE BUDGET/);
  });
});

describe("a configured greeting word is read as a greeting", () => {
  const observation = "Yo Sam,\n\nI noticed your second depot opened. Want me to set up its rota?";
  const offer = "Yo Sam,\n\nI can set up the rota for your second depot. Worth doing?";

  it("is not one under the default greeting, so an observation after it slips past", () => {
    expect(opensOnObservation(observation)).toBe(false);
    expect(openerStem(offer)).toBe("yo sam");
  });

  it("is skipped before the offer-first and opener checks once set", () => {
    cfgOverride = { founderGreeting: "Yo" };
    expect(opensOnObservation(observation)).toBe(true);
    expect(opensWithOffer(observation, "set up the rota")).toBe(false);
    expect(opensWithOffer(offer, "set up the rota")).toBe(true);
    expect(openerStem(offer)).toBe("i can");
  });
});

describe("subject case check", () => {
  it("holds an uppercase run by default and with lowercase set", () => {
    expect(lintEmail("WORKFLOW QUESTION", "Body. Sam")).toContain("subject-shouty");
    cfgOverride = { subjectCase: "lowercase" };
    expect(lintEmail("WORKFLOW QUESTION", "Body. Sam")).toContain("subject-shouty");
  });

  it("is off for sentence and as-written", () => {
    for (const subjectCase of ["sentence", "as-written"]) {
      cfgOverride = { subjectCase };
      expect(lintEmail("API question for Acme", "Body. Sam")).not.toContain("subject-shouty");
      expect(lintEmail("WORKFLOW QUESTION", "Body. Sam")).not.toContain("subject-shouty");
    }
  });

  it("drops lowercase from the sign-off subject repair only when overridden", async () => {
    const clean = { subject: "your intake form", body: "Body that is fine. Sam" };
    responses.push(JSON.stringify(clean));
    await repairWritingLints(messages(), { ...clean, subject: "last note" }, { promptName: "p" });
    expect(calls[0]?.at(-1)?.content).toContain("2-5 lowercase words");

    cfgOverride = { subjectCase: "sentence" };
    responses.push(JSON.stringify(clean));
    await repairWritingLints(messages(), { ...clean, subject: "last note" }, { promptName: "p" });
    const repair = calls[1]?.at(-1)?.content ?? "";
    expect(repair).toContain("signoff-subject");
    expect(repair).not.toContain("lowercase");
    expect(repair).toContain("SUBJECT CASE");
  });
});
