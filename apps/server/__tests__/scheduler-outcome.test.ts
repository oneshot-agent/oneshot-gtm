import { describe, expect, it } from "vitest";
import type { TriggerRunOutcome } from "@oneshot-gtm/find";
import { triggerOutcome } from "../src/scheduler.ts";

// triggerOutcome only reads `.error` and `.result?.halted`, so partial casts
// are enough — no need to build a full FinderResult.
function outcome(partial: Partial<TriggerRunOutcome>): TriggerRunOutcome {
  return { name: "show-hn", fired: true, nextDueInMs: 0, ...partial } as TriggerRunOutcome;
}

describe("triggerOutcome", () => {
  it("maps a clean run to ok", () => {
    expect(triggerOutcome(outcome({ result: { candidates: 3, enqueued: 1 } as never }))).toBe("ok");
  });

  it("maps a thrown error to error", () => {
    expect(triggerOutcome(outcome({ error: "boom" }))).toBe("error");
  });

  it("maps a halted finder (returned, but stopped early) to error", () => {
    expect(triggerOutcome(outcome({ result: { halted: "max-cost cap" } as never }))).toBe("error");
  });

  it("maps a fired run with neither error nor result to ok", () => {
    expect(triggerOutcome(outcome({}))).toBe("ok");
  });
});
