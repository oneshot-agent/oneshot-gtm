import { describe, expect, it } from "vitest";
import {
  batchCompaniesByQueryLength,
  MAX_QUERY_WORDS,
  rotateBatches,
} from "../src/_query-batch.ts";

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function buildQuery(batch: readonly string[]): string {
  const clause = batch.length > 0 ? ` (${batch.map((c) => `"${c}"`).join(" OR ")})` : "";
  return `"Engineer"${clause} last 14 days (site:boards.greenhouse.io OR site:jobs.lever.co)`;
}

describe("batchCompaniesByQueryLength", () => {
  it("returns one empty batch for an empty companies list", () => {
    expect(batchCompaniesByQueryLength([], buildQuery)).toEqual([[]]);
  });

  it("keeps a short list in a single batch", () => {
    const companies = ["Acme", "Globex", "Initech"];
    const batches = batchCompaniesByQueryLength(companies, buildQuery);
    expect(batches).toEqual([companies]);
  });

  it("splits a long list into multiple batches, each under the word bound", () => {
    const companies = Array.from({ length: 40 }, (_, i) => `Company${String(i).padStart(2, "0")}`);
    const batches = batchCompaniesByQueryLength(companies, buildQuery);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(wordCount(buildQuery(batch))).toBeLessThanOrEqual(MAX_QUERY_WORDS);
    }
    // Every company appears exactly once across all batches.
    expect(batches.flat().toSorted()).toEqual([...companies].toSorted());
  });

  it("gives a single company its own batch even if its query alone exceeds the bound", () => {
    const longName = "A Very Long Company Name With Many Words In It Indeed Truly";
    const batches = batchCompaniesByQueryLength([longName], buildQuery);
    expect(batches).toEqual([[longName]]);
  });

  it("respects a caller-supplied maxWords", () => {
    const companies = ["Acme", "Globex", "Initech", "Umbrella"];
    const batches = batchCompaniesByQueryLength(companies, buildQuery, 10);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(wordCount(buildQuery(batch))).toBeLessThanOrEqual(10);
    }
  });
});

describe("rotateBatches", () => {
  it("returns batches unchanged when there is 0 or 1 batch", () => {
    expect(rotateBatches([], 5)).toEqual([]);
    expect(rotateBatches([["a"]], 5)).toEqual([["a"]]);
  });

  it("rotates to start at cursor mod length", () => {
    const batches = [["a"], ["b"], ["c"], ["d"]];
    expect(rotateBatches(batches, 0)).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(rotateBatches(batches, 1)).toEqual([["b"], ["c"], ["d"], ["a"]]);
    expect(rotateBatches(batches, 2)).toEqual([["c"], ["d"], ["a"], ["b"]]);
    expect(rotateBatches(batches, 4)).toEqual([["a"], ["b"], ["c"], ["d"]]); // wraps
    expect(rotateBatches(batches, 5)).toEqual([["b"], ["c"], ["d"], ["a"]]);
  });

  it("normalizes a negative cursor", () => {
    const batches = [["a"], ["b"], ["c"]];
    expect(rotateBatches(batches, -1)).toEqual([["c"], ["a"], ["b"]]);
  });

  it("normalizes a fractional cursor by truncation", () => {
    const batches = [["a"], ["b"], ["c"]];
    expect(rotateBatches(batches, 1.9)).toEqual([["b"], ["c"], ["a"]]);
  });

  it("does not mutate the input array", () => {
    const batches = [["a"], ["b"], ["c"]];
    const original = batches.map((b) => [...b]);
    rotateBatches(batches, 1);
    expect(batches).toEqual(original);
  });
});
