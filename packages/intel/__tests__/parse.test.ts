import { describe, expect, it } from "vitest";
import { tryParseJsonObject } from "../src/_parse.ts";

describe("tryParseJsonObject", () => {
  it("parses a fenced ```json block", () => {
    const raw = '```json\n{"a":1,"b":"x"}\n```';
    expect(tryParseJsonObject<{ a?: number; b?: string }>(raw, {})).toEqual({ a: 1, b: "x" });
  });

  it("parses a fenced ``` block without the json hint", () => {
    const raw = '```\n{"a":1}\n```';
    expect(tryParseJsonObject<{ a?: number }>(raw, {})).toEqual({ a: 1 });
  });

  it("parses raw JSON (no fences)", () => {
    expect(tryParseJsonObject<{ a?: number }>('{"a":1}', {})).toEqual({ a: 1 });
  });

  it("recovers from leading/trailing prose via brace-slice", () => {
    const raw = 'Sure! Here it is: {"company":"Acme","amount":500} Hope that helps.';
    expect(tryParseJsonObject<{ company?: string; amount?: number }>(raw, {})).toEqual({
      company: "Acme",
      amount: 500,
    });
  });

  it("returns the fallback on garbage input", () => {
    const fallback = { ok: false };
    expect(tryParseJsonObject(":::::", fallback)).toBe(fallback);
    expect(tryParseJsonObject("", fallback)).toBe(fallback);
    expect(tryParseJsonObject("   ", fallback)).toBe(fallback);
  });

  it("prefers fenced content over trailing prose that also has braces", () => {
    const raw = '```json\n{"a":1}\n```\nalso see: {"a":99}';
    expect(tryParseJsonObject<{ a?: number }>(raw, {})).toEqual({ a: 1 });
  });

  it("returns the fallback when the fenced block is invalid JSON and there are no outer braces either", () => {
    const raw = "```json\nnot actually json\n```";
    const fallback = { sentinel: true };
    expect(tryParseJsonObject(raw, fallback)).toBe(fallback);
  });
});
