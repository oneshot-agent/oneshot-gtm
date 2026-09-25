import { expect, it } from "vitest";
import { tryParseJsonObject } from "../src/_parse.ts";

it("reads a fenced json block, a bare fence, and raw json", () => {
  expect(tryParseJsonObject('here:\n```json\n{"a":1}\n```\nbye', {})).toEqual({ a: 1 });
  expect(tryParseJsonObject('```\n{"b":2}\n```', {})).toEqual({ b: 2 });
  expect(tryParseJsonObject('{"c":3}', {})).toEqual({ c: 3 });
  expect(tryParseJsonObject("no json", { d: 4 })).toEqual({ d: 4 });
});

it("stays linear on an unclosed fence followed by many spaces", () => {
  const hostile = "```" + " ".repeat(200_000) + "x";
  const t0 = performance.now();
  expect(tryParseJsonObject(hostile, { ok: true })).toEqual({ ok: true });
  expect(performance.now() - t0).toBeLessThan(200);
});
