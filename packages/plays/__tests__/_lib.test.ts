import { describe, expect, it } from "vitest";
import { lintEmail, lintOpenerFrequency, openerStem, overusedOpeners } from "../src/_lib.ts";

describe("lintEmail — humanizer canon", () => {
  it("returns no flags for a clean founder-to-founder email", () => {
    const subject = "saw your show hn";
    const body = [
      "Saw your post about durable workflows yesterday.",
      "Did the Postgres backend hold up to the 1k concurrent jobs you described?",
      "Sam",
    ].join("\n\n");
    expect(lintEmail(subject, body)).toEqual([]);
  });

  it("flags em dashes", () => {
    const flags = lintEmail("re: your post", "Saw your post — quick thought. Sam");
    expect(flags).toContain("em-dash");
  });

  it("flags banned openers", () => {
    expect(lintEmail("hi", "I noticed your work and wanted to reach out. Sam")).toContain(
      "banned-opener:I-noticed",
    );
    expect(lintEmail("hi", "I came across your post yesterday. Sam")).toContain(
      "banned-opener:I-came-across",
    );
    expect(lintEmail("hi", "Hope this email finds you well. Sam")).toContain(
      "banned-opener:hope-this-finds",
    );
  });

  it("flags AI vocabulary", () => {
    expect(lintEmail("hi", "We help you leverage your data effectively. Sam")).toContain(
      "ai-vocab",
    );
    expect(lintEmail("hi", "Our pivotal moment is now. Sam")).toContain("ai-vocab");
  });

  it("flags copula avoidance", () => {
    expect(lintEmail("hi", "Our product serves as the bridge to scale. Sam")).toContain(
      "copula-avoidance",
    );
  });

  it("flags rule-of-three lists", () => {
    expect(lintEmail("hi", "We deliver speed, quality, and adoption to your team. Sam")).toContain(
      "rule-of-three",
    );
  });

  it("flags negative parallelism", () => {
    expect(
      lintEmail("hi", "It's not just a tool, it's a movement that changes everything. Sam"),
    ).toContain("negative-parallelism");
  });

  it("flags servile closers", () => {
    expect(lintEmail("hi", "Hope this helps. Let me know if you want more. Sam")).toContain(
      "servile-closer",
    );
  });

  it("flags shouty subjects and excess exclamations", () => {
    expect(lintEmail("RE THE POST", "Body. Sam")).toContain("subject-shouty");
    expect(lintEmail("hi", "First!! Second!! Sam")).toContain("excess-exclamations");
  });

  it("flags calendar links", () => {
    expect(lintEmail("hi", "Here's my calendly link to book. Sam")).toContain("calendar-link");
  });

  it("flags a draft that cites a violation, an inspection score, or a lapsed license", () => {
    expect(lintEmail("hi", "Saw your place failed a health inspection. Sam")).toContain(
      "public-record-leverage",
    );
    expect(lintEmail("hi", "Your inspection score dropped last cycle. Sam")).toContain(
      "public-record-leverage",
    );
    expect(lintEmail("hi", "The report cites a violation for pest evidence. Sam")).toContain(
      "public-record-leverage",
    );
    expect(lintEmail("hi", "Noticed your license lapsed last month. Sam")).toContain(
      "public-record-leverage",
    );
  });

  it("does not flag relevance-only copy about a public record (no leverage)", () => {
    expect(
      lintEmail("hi", "Saw you're new to the neighborhood and work on European imports. Sam"),
    ).not.toContain("public-record-leverage");
  });

  it("flags leverage cited in the SUBJECT even when the body reads neutral", () => {
    // finding PRRT_kwDOSKzrBs6exPHz: the guard only checked body, so a
    // leverage claim moved into the subject line sailed through.
    expect(
      lintEmail("Your failed health inspection", "Hope your week is going well. Sam"),
    ).toContain("public-record-leverage");
  });

  it("does not flag ordinary compliance copy that merely contains the word 'violation'", () => {
    // finding PRRT_kwDOSKzrBs6exPH6: a bare /\bviolation\b/ match rejected
    // valid copy with no public-record claim at all.
    expect(
      lintEmail("hi", "We help teams avoid compliance violations before they happen. Sam"),
    ).not.toContain("public-record-leverage");
  });

  it("still flags a violation when it's cited as a specific finding on record", () => {
    expect(lintEmail("hi", "The report cites a violation for pest evidence. Sam")).toContain(
      "public-record-leverage",
    );
    expect(lintEmail("hi", "A violation was reported at the last inspection. Sam")).toContain(
      "public-record-leverage",
    );
  });

  it("flags adjective-first license/permit/registration phrasing for every state, not just lapsed (finding PRRT_kwDOSKzrBs6fCBd-)", () => {
    expect(lintEmail("hi", "Saw your expired permit come up. Sam")).toContain(
      "public-record-leverage",
    );
    expect(lintEmail("hi", "Noticed your revoked license. Sam")).toContain(
      "public-record-leverage",
    );
    expect(lintEmail("hi", "Saw a suspended registration on file. Sam")).toContain(
      "public-record-leverage",
    );
    expect(lintEmail("hi", "Your lapsed license came up. Sam")).toContain("public-record-leverage");
  });

  it("flags emojis and curly quotes", () => {
    expect(lintEmail("hi", "Awesome work 🚀. Sam")).toContain("emoji");
    expect(lintEmail("hi", "He said “hi” to me. Sam")).toContain("curly-quotes");
  });

  it("flags empty subject and body", () => {
    expect(lintEmail("", "Body. Sam")).toContain("empty-subject");
    expect(lintEmail("hi", "")).toContain("empty-body");
  });

  it("flags subject longer than 60 chars", () => {
    const longSubj = "x".repeat(80);
    expect(lintEmail(longSubj, "Body. Sam")).toContain("subject-too-long");
  });

  it("flags body over the maxBodyWords cap", () => {
    const body = Array.from({ length: 150 }, () => "word").join(" ");
    expect(lintEmail("hi", body, 100)).toContain("body-too-long");
  });
});

describe("lintEmail — meeting asks dressed as small ones", () => {
  it("flags compare notes / swap takes / back-and-forth", () => {
    for (const ask of [
      "Still open to compare notes on it? Sam",
      "want to swap takes on this? Sam",
      "worth a quick back-and-forth? Sam",
    ]) {
      expect(lintEmail("ping", ask)).toContain("banned-cta:compare-notes");
    }
  });

  it("leaves a one-line question answerable from their own experience alone", () => {
    expect(lintEmail("ping", "the keys or the billing, which one actually bites? Sam")).toEqual([]);
  });
});

describe("openerStem", () => {
  it("drops a generated greeting so the stem is the actual opener", () => {
    expect(openerStem("Hey Akhilesh,\n\nStill curious if the keys bit you.\n\nJ.")).toBe(
      "still curious",
    );
    expect(openerStem("Hi Dr. Chen -\nthe keys or the billing?")).toBe("the keys");
  });

  it("keeps a first line that only looks like a greeting", () => {
    expect(openerStem("Heya the ramp stalled?")).toBe("heya the");
  });

  it("normalizes case and punctuation, and survives an empty body", () => {
    expect(openerStem("  STILL, curious...  whether\n")).toBe("still curious");
    expect(openerStem("\n\n")).toBe("");
  });
});

/** `n` bodies that all open with `stem`, each otherwise distinct. */
const withStem = (stem: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `Hey Sam,\n\n${stem} thing number ${i}.\n\nJ.`);

describe("lintOpenerFrequency — cap, not ban", () => {
  it("flags an opener that holds more than a quarter of recent sends", () => {
    const recent = [...withStem("still curious", 12), ...withStem("the keys", 8)];
    expect(lintOpenerFrequency("Hey Ada,\n\nstill curious about it.", recent)).toEqual([
      "opener-overused",
    ]);
  });

  it("allows the same opener while it is still a minority", () => {
    const recent = [...withStem("still curious", 4), ...withStem("the keys", 16)];
    expect(lintOpenerFrequency("Hey Ada,\n\nstill curious about it.", recent)).toEqual([]);
  });

  it("stays quiet below the minimum sample rather than guessing", () => {
    expect(
      lintOpenerFrequency("Hey Ada,\n\nstill curious about it.", withStem("still curious", 7)),
    ).toEqual([]);
    expect(lintOpenerFrequency("Hey Ada,\n\nstill curious about it.", [])).toEqual([]);
  });

  it("does not flag a body with no opener at all", () => {
    expect(lintOpenerFrequency("\n\n", withStem("still curious", 20))).toEqual([]);
  });

  it("measures the real shape: a six-word stem would have missed this", () => {
    // "still curious how you handle the" held 18% of 411 real follow-ups while
    // "still curious" held 55% — the cap has to compare the short stem.
    const recent = [
      ...withStem("still curious how you handle the", 8),
      ...withStem("still curious whether the keys are", 8),
      ...withStem("the migration", 4),
    ];
    expect(lintOpenerFrequency("Hey Ada,\n\nstill curious if it bit you.", recent)).toEqual([
      "opener-overused",
    ]);
  });
});

describe("overusedOpeners", () => {
  it("names every stem over the cap, worst first", () => {
    const recent = [
      ...withStem("still curious", 10),
      ...withStem("still open", 6),
      ...withStem("the keys", 4),
    ];
    expect(overusedOpeners(recent)).toEqual(["still curious", "still open"]);
  });

  it("names nothing when the window is short or evenly spread", () => {
    expect(overusedOpeners(withStem("still curious", 7))).toEqual([]);
    const spread = ["a x", "b x", "c x", "d x", "e x", "f x", "g x", "h x"];
    expect(overusedOpeners(spread)).toEqual([]);
  });

  it("agrees with the flag it steers away from", () => {
    // 12 of 20 on one stem; the rest spread thin enough to stay under the cap.
    const spread = ["alpha one", "bravo two", "charlie three", "delta four"].flatMap((s) =>
      withStem(s, 2),
    );
    const recent = [...withStem("still curious", 12), ...spread];
    expect(overusedOpeners(recent)).toEqual(["still curious"]);
    expect(lintOpenerFrequency("Hey Ada,\n\nstill curious about it.", recent)).toEqual([
      "opener-overused",
    ]);
    expect(lintOpenerFrequency("Hey Ada,\n\nalpha one thing.", recent)).toEqual([]);
  });
});
