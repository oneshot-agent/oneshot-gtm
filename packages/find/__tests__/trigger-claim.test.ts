import { describe, expect, it } from "vitest";
import { getLedger } from "@oneshot-gtm/core";
import { MAX_RUN_AGE_MS, runTriggerNow } from "../src/registry.ts";

/**
 * Direct `runTriggerNow` calls must respect the running claim — the exported
 * boundary cannot overlap same-trigger runs. Only the BLOCKED path is tested
 * here: it returns before the finder is ever invoked, so no network/SDK is
 * touched (the happy path necessarily runs a real finder and is covered by
 * dogfood runs via fireTriggerNow, which claims before delegating).
 */
describe("runTriggerNow claim guard", () => {
  it("refuses to run while another run holds the claim, leaving the claim intact", async () => {
    const ledger = getLedger();
    ledger.upsertTrigger({ name: "show-hn", configJson: "{}", enabled: true });
    const heldSince = new Date().toISOString();
    const claimed = ledger.markTriggerRunning(
      "show-hn",
      heldSince,
      new Date(Date.now() - MAX_RUN_AGE_MS).toISOString(),
    );
    expect(claimed).toBe(true);

    const outcome = await runTriggerNow("show-hn");
    expect(outcome.fired).toBe(false);
    expect(outcome.error).toMatch(/already running/);
    // The holder's claim was not clobbered by the refused run.
    expect(ledger.getTrigger("show-hn")?.running_started_at).toBe(heldSince);
  });
});
