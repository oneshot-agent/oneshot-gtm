import { expect, it } from "vitest";
import { runSummaryDetail, summarizeRun } from "./summarizeRun.ts";

it("distinguishes community source errors, empty results and skipped sources", () => {
  expect(
    summarizeRun({
      candidates: 0,
      enqueued: 0,
      perSource: [
        { source: "reddit", label: "Reddit", records: 0, error: "read unavailable" },
        { source: "hacker-news", label: "Hacker News", records: 0 },
      ],
    }),
  ).toContain("Reddit: 0 records, error: read unavailable · Hacker News: no matches");
  expect(
    summarizeRun({ perSource: [{ label: "Reddit", records: 0, status: "skipped" }] }),
  ).toContain("Reddit: not searched");
});

const SETTLEMENT =
  "payment rejected: settlement_pending: transaction did not confirm in time: context deadline exceeded — expected $0.05 to 0xabc [payment attempt 3/3] (ref: 9f2c)";
const EVM = "payment rejected: invalid_exact_evm_failed_to_execute_transfer — expected $0.05";

/** 17 sources read (10 records each), 23 settlement failures, 1 EVM failure: 41 sources. */
function outageSources() {
  return [
    ...Array.from({ length: 17 }, (_, i) => ({
      source: `ok-${i}`,
      label: `runs member messaging on Firm ${i}'s inbound queue and support desk`,
      records: 10 + i * 50,
    })),
    ...Array.from({ length: 23 }, (_, i) => ({
      source: `settle-${i}`,
      label: `runs member service calls on Firm ${i}'s phone line`,
      records: 0,
      error: SETTLEMENT,
    })),
    { source: "evm", label: "runs claims intake on Firm X", records: 0, error: EVM },
  ];
}

it("groups many failed sources into a short line", () => {
  const line = summarizeRun({ halted: "limit (1000)", perSource: outageSources() });
  // 17 × 10 + 50 × (0 + … + 16) = 170 + 6800
  expect(line).toBe(
    "halted · limit (1000) · 17 of 41 sources read (6,970 companies) · 23 failed: payment did not settle · 1 failed: payment rejected: invalid_exact_evm_failed_to_execute_transf",
  );
  expect(line.length).toBeLessThan(200);
});

it("normalizes wallet and tool-outage errors and counts skipped sources", () => {
  const line = summarizeRun({
    perSource: [
      { label: "A", records: 5 },
      { label: "B", records: 0, error: "payment rejected: invalid_payload" },
      { label: "C", records: 0, error: "insufficient credits [payment attempt 1/2]" },
      { label: "D", records: 0, error: "the tool is temporarily unavailable (ref: abc)" },
      { label: "E", records: 0, status: "skipped" },
    ],
  });
  expect(line).toBe(
    "1 of 5 sources read (5 companies) · 2 failed: wallet refused payment · 1 failed: tool temporarily unavailable · 1 not searched",
  );
});

it("leads with paused and the local retry time, dropping a halt that repeats it", () => {
  const retryAt = new Date(2026, 10, 3, 14, 5).toISOString();
  expect(
    summarizeRun({
      paused: "OneShot payments not settling",
      retryAt,
      halted: "limit (1000)",
      perSource: outageSources(),
    }),
  ).toBe(
    "paused · OneShot payments not settling · retry 14:05 · 17 of 41 sources read (6,970 companies) · 23 failed: payment did not settle · 1 failed: payment rejected: invalid_exact_evm_failed_to_execute_transf · limit (1000)",
  );
  expect(
    summarizeRun({
      paused: "OneShot payments not settling",
      halted: "OneShot payments not settling",
      retryAt: "not a date",
      perSource: [{ label: "Reddit", records: 3 }],
    }),
  ).toBe("paused · OneShot payments not settling · Reddit: 3 records");
});

it("shows paused instead of error on a thrown run", () => {
  const retryAt = new Date(2026, 10, 3, 9, 30).toISOString();
  expect(
    summarizeRun({
      error: "payment rejected: settlement_pending",
      at: retryAt,
      paused: "OneShot payments not settling",
      retryAt,
    }),
  ).toBe("paused · OneShot payments not settling · retry 09:30");
  expect(summarizeRun({ error: "boom", at: retryAt })).toBe("error: boom");
});

it("keeps per-source labels for three or fewer sources, truncating errors to 90 chars", () => {
  const long = "x".repeat(120);
  expect(
    summarizeRun({
      halted: "limit (10)",
      perSource: [
        { label: "Reddit", records: 0, error: long },
        { label: "Hacker News", records: 4 },
        { label: "X", records: 0 },
      ],
    }),
  ).toBe(
    `halted · limit (10) · Reddit: 0 records, error: ${"x".repeat(90)} · Hacker News: 4 records · X: no matches`,
  );
});

it("runSummaryDetail lists every source on its own line", () => {
  const detail = runSummaryDetail({ perSource: outageSources() });
  const lines = detail?.split("\n") ?? [];
  expect(lines).toHaveLength(41);
  expect(lines[0]).toBe(
    "runs member messaging on Firm 0's inbound queue and support desk: 10 records",
  );
  expect(lines[17]).toBe(
    `runs member service calls on Firm 0's phone line: error: ${SETTLEMENT.slice(0, 200)}`,
  );
  expect(
    runSummaryDetail({ perSource: [{ label: "Reddit", records: 0, status: "skipped" }] }),
  ).toBe("Reddit: not searched");
  expect(runSummaryDetail({ error: "boom" })).toBeNull();
  expect(runSummaryDetail(null)).toBeNull();
  expect(runSummaryDetail({ perSource: [] })).toBeNull();
});
