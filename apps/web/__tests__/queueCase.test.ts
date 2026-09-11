import { describe, expect, it } from "vitest";
import {
  caseMeta,
  caseRows,
  personResearchBadge,
  personResearchRows,
} from "../src/lib/queueCase.ts";

// Issue #594: the case column lays the priority engine's reasons out as
// key–value rows where they have a key and as plain lines where they don't.

describe("caseRows", () => {
  it("splits a keyed reason and keeps a plain one whole", () => {
    expect(
      caseRows([
        "title: Co-Founder & CEO at Upgraded",
        "Guest at The Korea Playbook for Austin Physical AI Founders",
        "upcoming event",
        "1 evidence link",
      ]),
    ).toEqual([
      { key: "title", value: "Co-Founder & CEO at Upgraded" },
      { key: null, value: "Guest at The Korea Playbook for Austin Physical AI Founders" },
      { key: null, value: "upcoming event" },
      { key: null, value: "1 evidence link" },
    ]);
  });

  it("does not mistake a sentence with a colon for a key", () => {
    expect(caseRows(["bio: ai, founder, saas"])).toEqual([
      { key: "bio", value: "ai, founder, saas" },
    ]);
    expect(caseRows(["Public launch on Product Hunt today: 300 upvotes"])).toEqual([
      { key: null, value: "Public launch on Product Hunt today: 300 upvotes" },
    ]);
    expect(caseRows(["https://x.com/foo: seen"])).toEqual([
      { key: null, value: "https://x.com/foo: seen" },
    ]);
  });

  it("drops blanks and repeats", () => {
    expect(caseRows(["", "  ", "2.1k followers", "2.1k followers "])).toEqual([
      { key: null, value: "2.1k followers" },
    ]);
  });
});

describe("caseMeta", () => {
  it("joins what exists with middle dots and is null when nothing does", () => {
    expect(caseMeta(["YC S26", null, "yc-s26", undefined, " found 6 days ago "])).toBe(
      "YC S26 · yc-s26 · found 6 days ago",
    );
    expect(caseMeta([null, "", undefined])).toBeNull();
  });
});

// Person research (2026-09-11): the researched facts lead the case, and the
// draft state line says whether the draft was written from them.
const research = {
  version: 1,
  status: "complete",
  researchedAt: "2026-09-11T20:00:00.000Z",
  currentRole: { title: "Founder & Product Owner", company: "WildMuse.App", since: "Mar 2026" },
  organizations: [{ name: "WildMuse.App", current: true }],
};

describe("personResearchRows", () => {
  it("shows now / company / listed as / formerly from the stamped strings", () => {
    expect(
      personResearchRows({
        personResearch: research,
        currentRole: "Founder & Product Owner at WildMuse.App since Mar 2026",
        companyFacts: "WildMuse.App · Software · 1-10 employees · founded 2026",
        titleAtFinder: "| Curious Explorer",
        companyAtFinder: "L'eto Group",
        formerRoles: "Head of Product at L'ETO Group (Nov 2024–Oct 2025)",
      }),
    ).toEqual([
      { key: "now", value: "Founder & Product Owner at WildMuse.App since Mar 2026" },
      { key: "company", value: "WildMuse.App · Software · 1-10 employees · founded 2026" },
      { key: "listed as", value: "| Curious Explorer · L'eto Group" },
      { key: "formerly", value: "Head of Product at L'ETO Group (Nov 2024–Oct 2025)" },
    ]);
  });

  it("renders the now row from the research when no string was stamped, and omits listed-as when nothing changed", () => {
    expect(personResearchRows({ personResearch: research })).toEqual([
      { key: "now", value: "Founder & Product Owner at WildMuse.App since Mar 2026" },
    ]);
  });

  it("is empty without research or when research found nothing", () => {
    expect(personResearchRows({ title: "CEO" })).toEqual([]);
    expect(
      personResearchRows({
        personResearch: { ...research, status: "unavailable", organizations: [] },
      }),
    ).toEqual([]);
    expect(personResearchRows(null)).toEqual([]);
  });
});

describe("personResearchBadge", () => {
  const payload = { personResearch: research };
  it("is null without usable research", () => {
    expect(personResearchBadge({}, null)).toBeNull();
    expect(
      personResearchBadge({ personResearch: { ...research, status: "unavailable" } }, null),
    ).toBeNull();
  });
  it("says researched when the draft postdates the research, and asks for a regenerate otherwise", () => {
    expect(personResearchBadge(payload, null)).toBe("researched");
    expect(personResearchBadge(payload, { draftedAt: "2026-09-11T21:00:00.000Z" })).toBe(
      "researched",
    );
    expect(personResearchBadge(payload, { draftedAt: "2026-09-11T19:00:00.000Z" })).toBe(
      "researched · regenerate to use it",
    );
    expect(
      personResearchBadge(payload, {
        draftedAt: "2026-09-11T21:00:00.000Z",
        enrichmentFailed: true,
      }),
    ).toBe("researched · regenerate to use it");
  });
});
