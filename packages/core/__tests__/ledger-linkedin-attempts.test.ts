import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";
import {
  isFailedLinkedInSend,
  linkedInSendBaseKey,
  linkedInSendKeyAt,
} from "../src/ledger-linkedin-attempts.ts";

// OneShot never sends twice under one idempotency key, so a LinkedIn send
// whose job failed goes again under a new one. Only a proven failure moves
// the key: a send that may have gone out keeps it.

let ledger: Ledger;
beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => ledger.close());

const BASE = "gtm:acme:cadence:7:luma-events:1";
const failed = (code: string) =>
  Object.assign(new Error(`Job failed: ${code}`), { name: "JobError", code, jobError: code });

describe("keys", () => {
  it("are the base key until a failure, then <base>:r<n>", () => {
    expect(linkedInSendKeyAt(BASE, 0)).toBe(BASE);
    expect(linkedInSendKeyAt(BASE, 2)).toBe(`${BASE}:r2`);
    expect(linkedInSendBaseKey(`${BASE}:r2`)).toBe(BASE);
    expect(linkedInSendBaseKey(BASE)).toBe(BASE);
    expect(linkedInSendBaseKey("gtm:acme:queue:7:invite")).toBe("gtm:acme:queue:7:invite");
  });
});

describe("what counts as a failed send", () => {
  it("a failed job, never send_unverified, a 429, a pending job or a transport error", () => {
    expect(isFailedLinkedInSend(failed("internal_error"))).toBe(true);
    expect(isFailedLinkedInSend(failed("rate_limited"))).toBe(true);
    expect(isFailedLinkedInSend(failed("send_unverified"))).toBe(false);
    expect(
      isFailedLinkedInSend(Object.assign(failed("x"), { jobError: "linkedin: send_unverified" })),
    ).toBe(false);
    expect(isFailedLinkedInSend({ name: "ToolError", statusCode: 429 })).toBe(false);
    expect(isFailedLinkedInSend({ name: "JobTimeoutError" })).toBe(false);
    expect(isFailedLinkedInSend({ name: "LinkedInSendPendingError" })).toBe(false);
    expect(isFailedLinkedInSend(new Error("LinkedIn workspace worker stopped"))).toBe(false);
    expect(isFailedLinkedInSend(null)).toBe(false);
  });
});

describe("LinkedInSendAttemptStore", () => {
  it("moves the key on once per failed job, recording its code", () => {
    const attempts = ledger.linkedInSendAttempts;
    expect(attempts.key(BASE)).toBe(BASE);
    expect(attempts.noteFailed(BASE, failed("rate_limited"))).toBe(true);
    expect(attempts.key(BASE)).toBe(`${BASE}:r1`);
    expect(attempts.noteFailed(`${BASE}:r1`, failed("not_connected"))).toBe(true);
    expect(attempts.key(BASE)).toBe(`${BASE}:r2`);
    expect(attempts.attempt(BASE)).toBe(2);
  });

  it("never moves on an outcome that may have gone out", () => {
    const attempts = ledger.linkedInSendAttempts;
    expect(attempts.noteFailed(BASE, failed("send_unverified"))).toBe(false);
    expect(attempts.noteFailed(BASE, { name: "ToolError", statusCode: 429 })).toBe(false);
    expect(attempts.noteFailed(BASE, new Error("network"))).toBe(false);
    expect(attempts.key(BASE)).toBe(BASE);
  });

  it("a failure read twice under the same key (the click, then the sweep) counts once", () => {
    const attempts = ledger.linkedInSendAttempts;
    attempts.noteFailed(BASE, failed("internal_error"));
    expect(attempts.noteFailed(BASE, failed("internal_error"))).toBe(false);
    expect(attempts.markFailed(BASE, "not_sent")).toBe(false);
    expect(attempts.key(BASE)).toBe(`${BASE}:r1`);
  });

  it("keeps each send's attempts apart", () => {
    const attempts = ledger.linkedInSendAttempts;
    attempts.noteFailed(BASE, failed("internal_error"));
    expect(attempts.key("gtm:acme:cadence:7:luma-events:2")).toBe(
      "gtm:acme:cadence:7:luma-events:2",
    );
  });
});
