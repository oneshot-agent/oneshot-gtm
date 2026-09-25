import { describe, expect, it, vi } from "vitest";

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, loadPrompt: (name: string) => `PROMPT:${name}` };
});

const { firstTouchArm, readerSeniority, briefFormatBlock } = await import("../src/_first-touch.ts");
const { admissionSlot, bodySentencesForLint, bodyWordsForLint, lintEmail } =
  await import("../src/_lib.ts");

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const emails = Array.from({ length: 2000 }, (_, i) => `person${i}@company${i % 37}.example`);

describe("firstTouchArm", () => {
  it("is null when the trigger never set a format, and for unknown values", () => {
    expect(firstTouchArm({ yourEdge: "x" }, "a@b.dev")).toBeNull();
    expect(firstTouchArm({ firstTouchFormat: "short" }, "a@b.dev")).toBeNull();
    expect(firstTouchArm(null, "a@b.dev")).toBeNull();
  });

  it("honours an explicit single format", () => {
    expect(firstTouchArm({ firstTouchFormat: "brief" }, "a@b.dev")).toBe("brief");
    expect(firstTouchArm({ firstTouchFormat: "standard" }, "a@b.dev")).toBe("standard");
  });

  it("splits deterministically, case-insensitively, near the configured share", () => {
    const t = { firstTouchFormat: "split", firstTouchSplit: 0.3 };
    expect(firstTouchArm(t, "Sam@X.dev")).toBe(firstTouchArm(t, "sam@x.dev"));
    const brief = emails.filter((e) => firstTouchArm(t, e) === "brief").length / emails.length;
    expect(brief).toBeGreaterThan(0.25);
    expect(brief).toBeLessThan(0.35);
    expect(
      emails.every(
        (e) => firstTouchArm({ firstTouchFormat: "split", firstTouchSplit: 0 }, e) === "standard",
      ),
    ).toBe(true);
    expect(
      emails.every(
        (e) => firstTouchArm({ firstTouchFormat: "split", firstTouchSplit: 1 }, e) === "brief",
      ),
    ).toBe(true);
  });

  it("defaults to an even split and is independent of the admission slot", () => {
    const t = { firstTouchFormat: "split" };
    const inSlot = emails.filter((e) => admissionSlot(e));
    const outSlot = emails.filter((e) => !admissionSlot(e));
    const share = (xs: string[]) =>
      xs.filter((e) => firstTouchArm(t, e) === "brief").length / xs.length;
    expect(share(emails)).toBeGreaterThan(0.45);
    expect(share(emails)).toBeLessThan(0.55);
    expect(Math.abs(share(inSlot) - share(outSlot))).toBeLessThan(0.08);
  });
});

describe("readerSeniority", () => {
  it.each([
    ["Chief AI Officer", "exec"],
    ["Co-Founder & CEO", "exec"],
    ["VP of Engineering", "exec"],
    ["Head of Growth", "exec"],
    ["Engineering Manager", "lead"],
    ["Director of Platform", "lead"],
    ["Staff Engineer", "lead"],
    ["Software Engineer", "individual"],
    ["Product Designer", "individual"],
    ["Guest", "unknown"],
    ["", "unknown"],
  ])("%s → %s", (title, expected) => {
    expect(readerSeniority(title)).toBe(expected);
  });

  it("puts the seniority line under the format block", () => {
    const block = briefFormatBlock("VP Sales");
    expect(block).toContain("PROMPT:_format-brief");
    expect(block.endsWith("READER SENIORITY: exec")).toBe(true);
  });
});

describe("bodySentencesForLint", () => {
  it("counts sentences, not greetings, sign-offs, URLs or decimals", () => {
    const body =
      "Hey Sam,\n\nThe 2.5x number came from https://example.com/a.b report. It held up.\n\nWorth a reply?\n\nThanks,";
    expect(bodySentencesForLint(body, [])).toBe(3);
  });

  it("counts an unpunctuated line as one sentence", () => {
    expect(bodySentencesForLint("One line without a period\nAnother one.", [])).toBe(2);
  });

  it("does not split on title abbreviations", () => {
    expect(
      bodySentencesForLint("Dr. Patel asked the same thing. Mr. Lee too. Worth a reply?", []),
    ).toBe(3);
  });

  it("still ends a sentence at an abbreviation followed by a capitalised word", () => {
    expect(bodySentencesForLint("We cover Chicago, Denver etc. Want the list?", [])).toBe(2);
    expect(bodySentencesForLint("Tools, e.g. schedulers, break first. Worth a look?", [])).toBe(2);
  });

  it("excludes a standalone greeting from the word budget only when asked", () => {
    const body = "Hey Sam,\none two three";
    expect(bodyWordsForLint(body, [])).toBe(5);
    expect(bodyWordsForLint(body, [], { excludeGreeting: true })).toBe(3);
    // 70 words plus a greeting: within the brief budget, over it for a standard 70-word cap.
    expect(lintEmail("s", `Hey Sam,\n${words(70)}.`, 70, 3)).not.toContain("body-too-long");
    expect(lintEmail("s", `Hey Sam,\n${words(70)}.`, 70)).toContain("body-too-long");
  });

  it("flags too-many-sentences only when a sentence cap is passed", () => {
    const body = "One. Two. Three. Four.";
    expect(lintEmail("s", body, 70, 3)).toContain("too-many-sentences");
    expect(lintEmail("s", body, 70)).not.toContain("too-many-sentences");
  });
});

describe("closingEitherOrQuestion", () => {
  it("flags an ending that offers two options", async () => {
    const { closingEitherOrQuestion } = await import("../src/_lib.ts");
    expect(
      closingEitherOrQuestion(
        "Hey Sid, moving on from this thread. Is founder-led outreach already dialed in for the batch, or just on the back burner for now?",
        [],
      ),
    ).toBe(true);
    expect(closingEitherOrQuestion("Still curious whether it's the keys or the billing?", [])).toBe(
      true,
    );
  });

  it("leaves a yes/no question, an idiom and a non-question alone", async () => {
    const { closingEitherOrQuestion } = await import("../src/_lib.ts");
    expect(closingEitherOrQuestion("Did the keys turn out to be the annoying part?", [])).toBe(
      false,
    );
    expect(closingEitherOrQuestion("Worth a minute or two this week?", [])).toBe(false);
    expect(closingEitherOrQuestion("Keys or billing, either way it bites.", [])).toBe(false);
    expect(
      closingEitherOrQuestion("Keys or billing? I think it's keys. Does that match?", []),
    ).toBe(false);
  });

  it("sees through a partial signature and an abbreviation", async () => {
    const { closingEitherOrQuestion } = await import("../src/_lib.ts");
    expect(closingEitherOrQuestion("Keys or billing?\nJ", ["oneshot.example", "J"])).toBe(true);
    expect(closingEitherOrQuestion("Keys or billing?\n\nThanks,\nJ", [])).toBe(true);
    expect(
      closingEitherOrQuestion("Would keys or billing matter to Acme Inc. this quarter?", []),
    ).toBe(true);
  });

  it("is a lint flag only for follow-ups", async () => {
    const { lintEmail } = await import("../src/_lib.ts");
    const body = "Is it sorted, or still open?";
    expect(lintEmail("s", body, 100, undefined, { followUp: true })).toContain(
      "either-or-question",
    );
    expect(lintEmail("s", body, 100)).not.toContain("either-or-question");
  });
});
