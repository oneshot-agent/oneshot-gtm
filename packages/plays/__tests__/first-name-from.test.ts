import { describe, expect, it } from "vitest";
import { firstNameFrom } from "../src/_lib.ts";

describe("firstNameFrom", () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    ["Sarah Chen", "Sarah"],
    ["Sarah", "Sarah"],
    ["Dr. Sarah Chen", "Sarah"],
    ["Prof. Anya Rao", "Anya"],
    ["Md. Naimur Rahman", "Naimur"],
    // An initial is not a greeting.
    ["Mrs. J Doe", null],
    ["J. Eduardo", null],
    ["K.O", null],
    // Roles and mailboxes — "Hey CEO," shipped once.
    ["CEO", null],
    ["Founder", null],
    ["Admin", null],
    ["Info", null],
    // Companies, not people.
    ["Bytedance Inc.", null],
    ["Megabyte Labs", null],
    ["MyriaLabs", null],
    ["Arcade.dev", null],
    ["Trigger.dev", null],
    ["BlockRun.ai", null],
    ["taracodlabs", null],
    // Names that share a word with the org list stay names.
    ["Dev Patel", "Dev"],
    ["Prince Sonnenberg", "Prince"],
    // Handles with digits.
    ["Kiyotaka29", null],
    ["n3on p0rtal", null],
    ["wong2kim", null],
    // Shouting: a whole shouted name is a name; a lone shouted token is not.
    ["JAGADISH SUNIL PEDNEKAR", "Jagadish"],
    ["SARANKUMAR S", "Sarankumar"],
    ["KEVINWONG", null],
    ["KERNEL", null],
    ["MAXOUT", null],
    ["KC", "KC"],
    // Dotted pair and "LAST, First".
    ["Wei.Jiang", "Wei"],
    ["Chen, Sarah", "Sarah"],
    ["Leila Rishniw, Workato", "Leila"],
    ["Blake B.", "Blake"],
    ["Rafael K. Streit", "Rafael"],
    // Non-Latin scripts get no greeting rather than a wrong one.
    ["이동욱", null],
    ["麦奇", null],
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
