import { describe, expect, it, vi } from "vitest";

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, loadPrompt: (name: string) => `PROMPT:${name}` };
});

const { firstTouchArm, readerSeniority, briefFormatBlock } = await import("../src/_first-touch.ts");
const { admissionSlot, bodySentencesForLint, lintEmail } = await import("../src/_lib.ts");

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

  it("flags too-many-sentences only when a sentence cap is passed", () => {
    const body = "One. Two. Three. Four.";
    expect(lintEmail("s", body, 70, 3)).toContain("too-many-sentences");
    expect(lintEmail("s", body, 70)).not.toContain("too-many-sentences");
  });
});
