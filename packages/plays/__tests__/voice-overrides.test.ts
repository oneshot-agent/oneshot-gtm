import { beforeEach, describe, expect, it, vi } from "vitest";

// Every draft states its greeting word and subject case on a GREETING and a
// SUBJECT CASE line, from `founderGreeting` and `subjectCase`. Unset reads
// as `Hi` and sentence case; a workspace that sets `Hey` and `lowercase`
// gets the lowercase check and its repair back.

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
  draftEmailFromPrompt,
  lintEmail,
  openerStem,
  opensOnObservation,
  opensWithOffer,
  repairWritingLints,
  voiceBlock,
  voiceKey,
  voiceOverrideLines,
  withVoiceLines,
} = await import("../src/_lib.ts");

const CARD = "MOVES\n- a fact, then the mechanism under it";
const messages = () => [
  { role: "system" as const, content: "write" },
  { role: "user" as const, content: "input" },
];
const HEY_LOWERCASE = { founderGreeting: "Hey", subjectCase: "lowercase" };

beforeEach(() => {
  cfgOverride = {};
  responses.length = 0;
  calls.length = 0;
});

describe("founderGreetingOf / subjectCaseOf", () => {
  it("read unset, blank and unknown values as Hi and sentence case", () => {
    for (const v of [undefined, null, "", "   ", 3]) {
      expect(founderGreetingOf({ founderGreeting: v })).toBe("Hi");
    }
    for (const v of [undefined, null, "", "Lowercase", "title"]) {
      expect(subjectCaseOf({ subjectCase: v })).toBe("sentence");
    }
  });

  it("read a setting as set, and any-case 'none' as no greeting", () => {
    expect(founderGreetingOf({ founderGreeting: "  Hey, " })).toBe("Hey");
    expect(founderGreetingOf({ founderGreeting: "NONE" })).toBe("none");
    expect(subjectCaseOf({ subjectCase: "lowercase" })).toBe("lowercase");
    expect(subjectCaseOf({ subjectCase: "sentence" })).toBe("sentence");
    expect(subjectCaseOf({ subjectCase: "as-written" })).toBe("as-written");
  });
});

describe("voiceOverrideLines", () => {
  it("states Hi and sentence case when unset", () => {
    expect(voiceOverrideLines({})).toEqual([
      'GREETING: Hi (when you open with a greeting, it is exactly "Hi," or "Hi <first name>,", never another word)',
      "SUBJECT CASE: sentence (capitalize the first word and proper nouns only, and keep acronyms and identifiers as written)",
    ]);
  });

  it("states Hey and lowercase when a workspace sets them", () => {
    expect(voiceOverrideLines(HEY_LOWERCASE)).toEqual([
      'GREETING: Hey (when you open with a greeting, it is exactly "Hey," or "Hey <first name>,", never another word)',
      "SUBJECT CASE: lowercase (lowercase the whole subject, brand names and acronyms included)",
    ]);
  });

  it("states no greeting, and as-written", () => {
    const [none, asWritten] = voiceOverrideLines({
      founderGreeting: "none",
      subjectCase: "as-written",
    });
    expect(none).toBe("GREETING: none (never open with a greeting)");
    expect(asWritten).toMatch(/^SUBJECT CASE: as written \(no case rule/);
  });
});

describe("withVoiceLines", () => {
  it("appends the two lines to an input without them", () => {
    cfgOverride = HEY_LOWERCASE;
    expect(withVoiceLines("PROSPECT: Dana").split("\n")).toEqual([
      "PROSPECT: Dana",
      "",
      ...voiceOverrideLines(HEY_LOWERCASE),
    ]);
  });

  it("leaves an input that already carries a VOICE block alone", () => {
    const input = `PROSPECT: Dana\n\n${voiceBlock("intro").text}`;
    expect(withVoiceLines(input)).toBe(input);
  });

  it("adds the line a block lacks, and is not fooled by free text that looks like one", () => {
    cfgOverride = HEY_LOWERCASE;
    const [greeting, subject] = voiceOverrideLines(HEY_LOWERCASE);
    expect(withVoiceLines(`PROSPECT: Dana\n${greeting}`).split("\n")).toEqual([
      "PROSPECT: Dana",
      greeting,
      "",
      subject,
    ]);
    const signup = "SIGNUP CONTEXT:\nGREETING: Hi team, thanks for the call";
    expect(withVoiceLines(signup).split("\n").slice(-2)).toEqual([greeting, subject]);
  });

  it("reaches a draft whose play adds no VOICE block", async () => {
    cfgOverride = HEY_LOWERCASE;
    responses.push(JSON.stringify({ subject: "a short call", body: "Body that is fine. Sam" }));
    await draftEmailFromPrompt({ promptName: "demo-no-show-email", inputBlock: "PROSPECT: Dana" });
    expect(calls[0]?.[1]?.content).toContain("SUBJECT CASE: lowercase (");
    expect(calls[0]?.[1]?.content).toContain("GREETING: Hey (");
  });
});

describe("voiceBlock with the lines", () => {
  it("carries only the lines when there is no card", () => {
    cfgOverride = HEY_LOWERCASE;
    const out = voiceBlock("intro");
    expect(out.text.startsWith("VOICE (")).toBe(true);
    expect(out.text).toContain("GREETING: Hey (");
    expect(out.text).toContain("SUBJECT CASE: lowercase (");
    expect(out.text).not.toContain("VOICE BUDGET");
    // No card: its drafts count as voice off, not as a card of their own.
    expect(out.key).toBeNull();
  });

  it("puts the lines after the card and keys on the card alone", () => {
    cfgOverride = { founderVoice: CARD };
    const plain = voiceBlock("intro");
    cfgOverride = { founderVoice: CARD, founderGreeting: "none" };
    const out = voiceBlock("intro");
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
  it("holds an uppercase run only with lowercase set", () => {
    expect(lintEmail("WORKFLOW QUESTION", "Body. Sam")).not.toContain("subject-shouty");
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

  it("asks for lowercase in the sign-off subject repair only under lowercase", async () => {
    const clean = { subject: "your intake form", body: "Body that is fine. Sam" };
    cfgOverride = { subjectCase: "lowercase" };
    responses.push(JSON.stringify(clean));
    await repairWritingLints(messages(), { ...clean, subject: "last note" }, { promptName: "p" });
    expect(calls[0]?.at(-1)?.content).toContain("2-5 lowercase words");

    cfgOverride = {};
    responses.push(JSON.stringify(clean));
    await repairWritingLints(messages(), { ...clean, subject: "last note" }, { promptName: "p" });
    const repair = calls[1]?.at(-1)?.content ?? "";
    expect(repair).toContain("signoff-subject");
    expect(repair).not.toContain("lowercase");
    expect(repair).toContain("SUBJECT CASE");
  });
});
