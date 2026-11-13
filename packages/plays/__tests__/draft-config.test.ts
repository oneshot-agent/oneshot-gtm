import { describe, expect, it } from "vitest";
import type { Ledger } from "@oneshot-gtm/core";
import {
  cadenceDraftIsStale,
  cadenceDraftSurface,
  draftConfigKey,
  draftConfigKeyer,
  draftIsStale,
  queueDraftSurface,
  storedConfigKey,
  type DraftSurface,
} from "../src/_draft-config.ts";

// A stored draft is stamped with the config it was written under, and reads
// stale once that config changes. The key hashes what the config holds and
// never reads it. Fictional config throughout.

type Cfg = Parameters<typeof draftConfigKey>[0];

const base = {
  founderName: "Avery Example",
  productOneLiner: "Example Co plans delivery routes",
  productDomain: "example.test",
  productBrief: "Example Co plans routes and texts arrival times.",
  pilotOffer: "two weeks on one route",
  founderAdmission: "a two-person team",
  founderCredentials: "built two routing tools",
  productPortfolio: "a fictional portfolio",
  partners: "a fictional partner",
  founderCohort: "a fictional cohort",
  founderVoice: "short sentences, dry",
  founderGreeting: "Hi",
  subjectCase: "sentence",
  offerExclusions: ["a fictional kind of goal"],
  noOfferPlays: [],
  mobileSignature: false,
  linkedin: { templates: { note: "Hi {name}" } },
} as unknown as Cfg;

const EMAIL_FOLLOW_UP: DraftSurface = { channel: "email", stage: "follow_up" };
const key = (cfg: Cfg, surface: DraftSurface = EMAIL_FOLLOW_UP, playName = "example-play") =>
  draftConfigKey(cfg, { surface, playName }, null);

describe("draftConfigKey", () => {
  it("is stable: the same config, surface and play give the same short key", () => {
    expect(key(base)).toBe(key({ ...base } as Cfg));
    expect(key(base)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes with each config field a draft is written from", () => {
    const changes: Array<[string, unknown]> = [
      ["founderVoice", "long sentences, warm"],
      ["founderGreeting", "none"],
      ["subjectCase", "as-written"],
      ["founderAdmission", "another concession"],
      ["founderAdmission", null],
      ["founderCredentials", "other credentials"],
      ["productPortfolio", "another portfolio"],
      ["partners", "another partner"],
      ["founderCohort", "another cohort"],
      ["productOneLiner", "Example Co books jobs"],
      ["productBrief", "Example Co books jobs into open slots."],
      ["pilotOffer", "a month on two routes"],
      ["offerExclusions", ["a fictional kind of goal", "another fictional kind"]],
      ["offerExclusions", []],
      ["noOfferPlays", ["example-play"]],
      ["founderName", "Blake Example"],
      ["productDomain", "example.invalid"],
      ["mobileSignature", true],
    ];
    const seen = new Set([key(base)]);
    for (const [field, value] of changes) {
      const k = key({ ...base, [field]: value } as Cfg);
      expect(k, field).not.toBe(key(base));
      seen.add(k);
    }
    expect(seen.size).toBe(changes.length + 1);
  });

  it("reads an unset greeting and subject case as Hi and sentence case", () => {
    const unset = { ...base, founderGreeting: undefined, subjectCase: undefined } as Cfg;
    expect(key(unset)).toBe(key(base));
    const hey = { ...base, founderGreeting: "Hey", subjectCase: "lowercase" } as Cfg;
    expect(key(hey)).not.toBe(key(base));
    expect(key({ ...hey, founderGreeting: " Hey, " } as Cfg)).toBe(key(hey));
  });

  it("ignores what no draft reads, and whitespace and repeats in the exclusions", () => {
    expect(key({ ...base, llmModel: "another-model" } as Cfg)).toBe(key(base));
    expect(
      key({
        ...base,
        offerExclusions: ["  a fictional   kind of goal ", "a fictional kind of goal"],
      } as Cfg),
    ).toBe(key(base));
  });

  it("splits by surface and play, and reads LinkedIn templates on LinkedIn only", () => {
    const linkedin: DraftSurface = { channel: "linkedin", stage: "follow_up" };
    expect(key(base, { channel: "email", stage: "first_touch" })).not.toBe(key(base));
    expect(key(base, linkedin)).not.toBe(key(base));
    expect(key(base, EMAIL_FOLLOW_UP, "another-play")).toBe(key(base));
    const otherTemplates = { ...base, linkedin: { templates: { note: "Hello {name}" } } } as Cfg;
    expect(key(otherTemplates)).toBe(key(base));
    expect(key(otherTemplates, linkedin)).not.toBe(key(base, linkedin));
    const otherWriter = {
      ...base,
      linkedin: { writer: "model", templates: { note: "Hi {name}" } },
    } as Cfg;
    expect(key(otherWriter)).toBe(key(base));
    expect(key(otherWriter, linkedin)).not.toBe(key(base, linkedin));
    // A play that makes no offer: its key differs from one that does.
    expect(key(base, EMAIL_FOLLOW_UP, "community-reply")).not.toBe(key(base));
    // The member offer splits the play that quotes it, and no other.
    const member = { ...base, memberOffer: "a fictional member credit" } as Cfg;
    expect(key(member, EMAIL_FOLLOW_UP, "multiplier")).not.toBe(
      key(base, EMAIL_FOLLOW_UP, "multiplier"),
    );
    expect(key(member)).toBe(key(base));
  });

  it("changes when approved guidance for the surface changes, and not for another surface", () => {
    let instructions = [{ id: "g1", instruction: "lead with the route" }];
    const ledger = {
      learning: {
        guidance: (f: { channel?: string }) => ({
          instructions: f.channel === "email" ? instructions : [],
        }),
      },
      codeAnswers: { approved: () => [] },
    } as unknown as Ledger;
    const at = (surface: DraftSurface) =>
      draftConfigKey(base, { surface, playName: "example-play" }, ledger);
    const before = at(EMAIL_FOLLOW_UP);
    const linkedinBefore = at({ channel: "linkedin", stage: "follow_up" });
    instructions = [...instructions, { id: "g2", instruction: "name the depot" }];
    expect(at(EMAIL_FOLLOW_UP)).not.toBe(before);
    expect(at({ channel: "linkedin", stage: "follow_up" })).toBe(linkedinBefore);
  });

  it("the keyer hashes each surface and play once", () => {
    const keyOf = draftConfigKeyer(base, null);
    expect(keyOf(EMAIL_FOLLOW_UP, "example-play")).toBe(key(base));
    expect(keyOf(EMAIL_FOLLOW_UP, "example-play")).toBe(keyOf(EMAIL_FOLLOW_UP, "example-play"));
  });
});

describe("stale drafts", () => {
  const current = key(base);
  const keyOf = () => current;

  it("a draft with today's key is current; another key, or none, is stale", () => {
    expect(draftIsStale({ configKey: current }, current)).toBe(false);
    expect(draftIsStale({ configKey: "0123456789ab" }, current)).toBe(true);
    expect(draftIsStale({ subject: "written before keys" }, current)).toBe(true);
    expect(draftIsStale({ configKey: "" }, current)).toBe(true);
    expect(storedConfigKey(null)).toBeNull();
  });

  it("a follow-up preview is stale by its payload's surface; a letter or known connection never is", () => {
    const email = { payload: { kind: "email" } };
    expect(cadenceDraftIsStale(email, "example-play", keyOf)).toBe(true);
    expect(cadenceDraftIsStale({ ...email, configKey: current }, "example-play", keyOf)).toBe(
      false,
    );
    for (const kind of ["direct_mail", "linkedin_connected"]) {
      expect(cadenceDraftIsStale({ payload: { kind } }, "example-play", keyOf)).toBe(false);
    }
    expect(cadenceDraftIsStale(null, "example-play", keyOf)).toBe(false);
    expect(cadenceDraftSurface({ kind: "linkedin_invite" })).toEqual({
      channel: "linkedin",
      stage: "follow_up",
    });
  });

  it("a queue draft's surface is its channel's first touch", () => {
    expect(queueDraftSurface("email")).toEqual({ channel: "email", stage: "first_touch" });
    expect(queueDraftSurface("linkedin")).toEqual({ channel: "linkedin", stage: "first_touch" });
    expect(queueDraftSurface("x")).toEqual({ channel: "x", stage: "first_touch" });
    expect(queueDraftSurface(null)).toEqual({ channel: "email", stage: "first_touch" });
  });
});
