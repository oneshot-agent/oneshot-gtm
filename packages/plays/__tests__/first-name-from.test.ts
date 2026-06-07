import { describe, expect, it } from "vitest";
import { firstNameFrom } from "../src/_lib.ts";

describe("firstNameFrom", () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    ["Sarah Chen", "Sarah"],
    ["Sarah", "Sarah"],
    ["Dr. Sarah Chen", "Sarah"],
    ["Mrs. J Doe", "J"],
    ["Prof. Anya Rao", "Anya"],
    ["sarah", null],
    ["schen", null],
    ["samaralihussain", null],
    ["(unknown)", null],
    [null, null],
    [undefined, null],
    ["", null],
    ["  ", null],
    ["  Pat  Doe  ", "Pat"],
    ["Sarah,", "Sarah"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(firstNameFrom(input)).toBe(expected);
    });
  }
});
