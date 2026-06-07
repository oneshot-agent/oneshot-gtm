import { describe, expect, it } from "vitest";
import { parallelMap } from "../src/_parallel.ts";

function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("parallelMap", () => {
  it("returns [] for empty input", async () => {
    const out = await parallelMap([] as number[], 4, async (n) => n * 2);
    expect(out).toEqual([]);
  });

  it("preserves input order even when items resolve out of order", async () => {
    const items = [10, 50, 5, 30, 1];
    const out = await parallelMap(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual(items);
  });

  it("never has more than `concurrency` workers in flight", async () => {
    const concurrency = 3;
    let inFlight = 0;
    let peak = 0;
    const out = await parallelMap(
      Array.from({ length: 12 }, (_, i) => i),
      concurrency,
      async (i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return i;
      },
    );
    expect(out).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(concurrency);
    // Sanity: with 12 items and concurrency 3, we should actually reach the cap.
    expect(peak).toBe(concurrency);
  });

  it("concurrency: 1 is equivalent to a serial map (strict ordering of starts)", async () => {
    const starts: number[] = [];
    const ends: number[] = [];
    await parallelMap([0, 1, 2, 3], 1, async (i) => {
      starts.push(i);
      await new Promise((r) => setTimeout(r, 2));
      ends.push(i);
      return i;
    });
    // Serial: each item must finish before the next starts.
    expect(starts).toEqual([0, 1, 2, 3]);
    expect(ends).toEqual([0, 1, 2, 3]);
  });

  it("clamps concurrency to items.length (no idle workers)", async () => {
    let peak = 0;
    let inFlight = 0;
    await parallelMap([1, 2], 100, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
    });
    expect(peak).toBe(2);
  });

  it("clamps concurrency to >=1 (zero or negative still runs)", async () => {
    const out = await parallelMap([1, 2, 3], 0, async (n) => n);
    expect(out).toEqual([1, 2, 3]);
  });

  it("rejects with the first error and does not swallow it", async () => {
    await expect(
      parallelMap([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("fires onItem per completion with (item, result, index) and once per item", async () => {
    const items = ["a", "b", "c", "d"];
    const calls: Array<{ item: string; result: string; index: number }> = [];
    const out = await parallelMap(
      items,
      2,
      async (s, i) => `${s}-done-${i}`,
      (item, result, index) => {
        calls.push({ item, result, index });
      },
    );
    expect(out).toEqual(["a-done-0", "b-done-1", "c-done-2", "d-done-3"]);
    expect(calls).toHaveLength(4);
    // Same set of (index → result) pairs as `out`, but the callback may have
    // fired in completion order rather than index order — sort before assert.
    expect(calls.toSorted((a, b) => a.index - b.index)).toEqual([
      { item: "a", result: "a-done-0", index: 0 },
      { item: "b", result: "b-done-1", index: 1 },
      { item: "c", result: "c-done-2", index: 2 },
      { item: "d", result: "d-done-3", index: 3 },
    ]);
  });

  it("does not block forever when a slow worker completes after a fast one", async () => {
    // Regression guard: a naive chunk-based implementation would stall on the
    // slow item per chunk; the worker-pool variant should keep pulling.
    const slow = defer<number>();
    const items = [slow, "fast"] as const;
    const promise = parallelMap(items, 2, async (item) => {
      if (item === "fast") return "fast-done";
      return await item.promise;
    });
    // Resolve the slow one AFTER the fast one would have finished.
    setTimeout(() => slow.resolve(99), 10);
    const out = await promise;
    expect(out).toEqual([99, "fast-done"]);
  });
});
