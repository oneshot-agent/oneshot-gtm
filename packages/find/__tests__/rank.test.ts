import { describe, expect, it } from "vitest";
import { rankPendingRows, roundRobin } from "../src/_rank.ts";

function artifact(total: number): string {
  return JSON.stringify({
    version: "heuristic-v2",
    total,
    components: {
      personFit: total,
      accountFit: total,
      intentStrength: total,
      timingFreshness: total,
      signalConfidence: total,
      contactability: total,
    },
    reasons: [],
    finder: "t",
    scoredAt: "2026-09-01T12:00:00.000Z",
  });
}

let nextId = 1;
function row(play: string, total: number | null, extra: Record<string, unknown> = {}) {
  const id = nextId++;
  return {
    id,
    play_name: play,
    dedupe_key: `k${id}`,
    found_at: `2026-09-01 10:00:${String(id % 60).padStart(2, "0")}`,
    priority_json: total === null ? null : artifact(total),
    payload_json: JSON.stringify({ name: "x", ...extra }),
  };
}

describe("roundRobin (moved from luma.ts)", () => {
  it("interleaves fairly and sparse buckets surrender capacity", () => {
    const out = roundRobin(
      new Map([
        ["a", [1, 2, 3]],
        ["b", [10]],
      ]),
      4,
    );
    expect(out).toEqual([1, 10, 2, 3]);
  });
});

describe("rankPendingRows", () => {
  it("returns a permutation — nothing dropped, nothing duplicated", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row("show-hn", 40 + i)),
      ...Array.from({ length: 10 }, (_, i) => row("post-funding", 50 + i)),
      row("show-hn", null),
    ];
    const ranked = rankPendingRows(rows);
    expect(ranked.map((r) => r.id).toSorted((a, b) => a - b)).toEqual(
      rows.map((r) => r.id).toSorted((a, b) => a - b),
    );
  });

  it("is deterministic", () => {
    const rows = [row("a", 70), row("b", 30), row("a", null), row("b", 90), row("a", 55)];
    expect(rankPendingRows(rows)).toEqual(rankPendingRows(rows));
  });

  it("interleaves finders instead of sorting one flat list", () => {
    const rows = [row("aaa", 90), row("aaa", 89), row("aaa", 88), row("zzz", 10), row("zzz", 9)];
    const plays = rankPendingRows(rows, { explorationInterval: 100 }).map((r) => r.play_name);
    // zzz's low totals must not banish it to the tail — the second slot is zzz.
    expect(plays[1]).toBe("zzz");
  });

  it("orders by score within a finder; pool rows (bottom decile + unscored) trail", () => {
    const low = row("solo", 40);
    const high = row("solo", 90);
    const unscored = row("solo", null);
    const mid = row("solo", 60);
    const ranked = rankPendingRows([low, high, unscored, mid], { explorationInterval: 100 });
    // Main stream is score-desc; the bottom-decile row (40) and the unscored
    // row live in the exploration pool (hash-ordered) at the tail here.
    expect(ranked.slice(0, 2).map((r) => r.id)).toEqual([high.id, mid.id]);
    expect(new Set(ranked.slice(2).map((r) => r.id))).toEqual(new Set([low.id, unscored.id]));
  });

  it("sub-buckets luma rows by eventCity so city diversity survives ranking", () => {
    const sf1 = row("luma-events", 80, { eventCity: "San Francisco" });
    const sf2 = row("luma-events", 79, { eventCity: "San Francisco" });
    const ny = row("luma-events", 78, { eventCity: "New York" });
    const junk = row("luma-events", 10, { eventCity: "San Francisco" }); // → exploration pool
    const ranked = rankPendingRows([sf1, sf2, ny, junk], { explorationInterval: 100 });
    // NY interleaves at slot 1 (key order) despite the lower score.
    expect(ranked.map((r) => r.id)).toEqual([ny.id, sf1.id, sf2.id, junk.id]);
  });

  it("hands every Kth slot to the exploration pool (unscored rows get eyes)", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row("solo", 60 + i)),
      row("solo", null),
      row("solo", null),
    ];
    const ranked = rankPendingRows(rows, { explorationInterval: 3 });
    // Pool = the two unscored rows plus the bottom-decile scored row (60).
    // Slots 3 and 6 (1-indexed multiples of 3) must come from that pool.
    const poolTotals = new Set([null, 60]);
    const totalAt = (i: number) => {
      const raw = ranked[i]!.priority_json;
      return raw === null ? null : (JSON.parse(raw) as { total: number }).total;
    };
    expect(poolTotals.has(totalAt(2))).toBe(true);
    expect(poolTotals.has(totalAt(5))).toBe(true);
    expect(ranked).toHaveLength(10);
  });

  it("survives empty input, all-unscored input, and malformed payloads", () => {
    expect(rankPendingRows([])).toEqual([]);
    const unscored = [row("a", null), row("b", null), row("a", null)];
    expect(rankPendingRows(unscored)).toHaveLength(3);
    const malformed = { ...row("luma-events", 70), payload_json: "{broken" };
    expect(rankPendingRows([malformed])).toHaveLength(1);
  });
});
