import { expect, it } from "vitest";
import { summarizeRun } from "./summarizeRun.ts";

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
