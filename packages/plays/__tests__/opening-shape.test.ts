import { figuresIn, OPENING_SHAPES, openingShapeOf } from "@oneshot-gtm/core";
import { describe, expect, it } from "vitest";
import { briefHasFigure, OPENING_ROTATION, openingLine, openingShapeFor } from "../src/_opening.ts";

// Openings are assigned in code before drafting, so variety does not depend
// on the model remembering what it wrote last. Fictional copy.

const brief = "Only 47% of treatment plans are finished by year end.";
const mixed = { messageOpening: "mixed", productBrief: brief };
const emails = Array.from({ length: 1000 }, (_, i) => `person${i}@example.test`);

describe("openingShapeFor", () => {
  it("unset and offer open on the offer; problem opens on a bet", () => {
    expect(openingShapeFor({}, "a@example.test", 0)).toBe("offer");
    expect(openingShapeFor({ messageOpening: "offer" }, "a@example.test", 2)).toBe("offer");
    expect(openingShapeFor({ messageOpening: "problem" }, "a@example.test", 0)).toBe("bet");
    expect(openingShapeFor({ messageOpening: "Mixed" }, "a@example.test", 0)).toBe("offer");
  });

  it("mixed: stable per person, case and spacing ignored", () => {
    for (const email of emails.slice(0, 50)) {
      expect(openingShapeFor(mixed, ` ${email.toUpperCase()} `, 0)).toBe(
        openingShapeFor(mixed, email, 0),
      );
    }
  });

  it("mixed: splits evenly across the shapes", () => {
    const counts = new Map<string, number>();
    for (const email of emails) {
      const shape = openingShapeFor(mixed, email, 0);
      counts.set(shape, (counts.get(shape) ?? 0) + 1);
    }
    expect([...counts.keys()].toSorted()).toEqual([...OPENING_SHAPES].toSorted());
    for (const n of counts.values()) expect(n).toBeGreaterThan(200);
  });

  it("mixed: each follow-up moves to the next shape", () => {
    const n = OPENING_ROTATION.length;
    for (const email of emails.slice(0, 50)) {
      const first = OPENING_ROTATION.indexOf(openingShapeFor(mixed, email, 0));
      for (const step of [1, 2, 3]) {
        expect(openingShapeFor(mixed, email, step)).toBe(OPENING_ROTATION[(first + step) % n]);
        expect(openingShapeFor(mixed, email, step)).not.toBe(
          openingShapeFor(mixed, email, step - 1),
        );
      }
    }
  });

  it("mixed: no figure without a number in the brief, the offer stands in", () => {
    expect(briefHasFigure("We follow up with patients.")).toBe(false);
    expect(briefHasFigure(brief)).toBe(true);
    const plain = { messageOpening: "mixed", productBrief: "We follow up with patients." };
    for (const email of emails.slice(0, 200)) {
      const withNumber = openingShapeFor(mixed, email, 0);
      expect(openingShapeFor(plain, email, 0)).toBe(withNumber === "figure" ? "offer" : withNumber);
    }
  });

  it("mixed: a brief edit between two emails never repeats an opening", () => {
    const plain = { messageOpening: "mixed", productBrief: "We follow up with patients." };
    for (const email of emails.slice(0, 300)) {
      for (const [a, b] of [
        [mixed, plain],
        [plain, mixed],
      ]) {
        for (const step of [1, 2, 3]) {
          expect(openingShapeFor(b!, email, step)).not.toBe(openingShapeFor(a!, email, step - 1));
        }
      }
    }
  });

  it("the input line per shape", () => {
    expect(openingLine("offer")).toBeNull();
    expect(openingLine("bet")).toBe("OPENING: problem");
    expect(openingLine("figure")).toBe("OPENING: figure");
    expect(openingLine("question")).toBe("OPENING: question");
  });
});

describe("openingShapeOf", () => {
  it("reads the first sentence after the greeting", () => {
    expect(openingShapeOf("Hey Sam,\n\nI can book every open plan. Worth it?")).toBe("offer");
    expect(openingShapeOf("Hey Sam,\n\nI'd bet plans go quiet. I can book them.")).toBe("bet");
    expect(openingShapeOf("Hey Sam,\n\nI’d bet plans go quiet.")).toBe("bet");
    expect(openingShapeOf("Hey Sam,\n\nOnly 47% of plans get finished. I can help.")).toBe(
      "figure",
    );
    expect(openingShapeOf("Do patients ever come back? I can book them.")).toBe("question");
    expect(openingShapeOf("Hey,\n\nAbout one in five visits is missed. I can rebook them.")).toBe(
      "figure",
    );
    // An offer that names a number, or is phrased as a question, is offer-led.
    expect(openingShapeOf("Hey Sam,\n\nI can cut missed visits by 47%. Worth it?")).toBe("offer");
    expect(openingShapeOf("Hey Sam,\n\nWant me to book every open plan?")).toBe("offer");
    // A custom greeting line is still a greeting.
    expect(openingShapeOf("Yo Sam,\n\nI'd bet plans go quiet. I can book them.")).toBe("bet");
    // A figure later in the email is not the opening.
    expect(openingShapeOf("Hey Sam,\n\nI can book plans. Only 47% get finished.")).toBe("offer");
    expect(openingShapeOf("")).toBe("offer");
  });

  it("normalises figures", () => {
    expect(figuresIn("Only 47% and 58 percent; about one in five, or 1 in 4")).toEqual([
      "47%",
      "58%",
      "1 in 5",
      "1 in 4",
    ]);
    expect(figuresIn("We have 35 offices and 2 regions.")).toEqual([]);
  });
});
