import { expect, it } from "vitest";
import type { ReplySendState } from "@oneshot-gtm/shared-types";
import { replySendFailure } from "../src/lib/replySendFailure.ts";
const send = {
  status: "failed",
  error: "Job failed: The LinkedIn account is no longer authorized; reconnect it and retry.",
} as ReplySendState;
it.each(["connected", "restoring"] as const)(
  "does not show stale reconnect instructions when the account is %s",
  (linkedinConnectionState) => {
    const result = replySendFailure({
      channel: "linkedin",
      send,
      canSend: false,
      linkedinConnectionState,
    });
    expect(result?.recovered).toBe(true);
    expect(result?.message).not.toMatch(/no longer authorized|reconnect/);
    expect(send.error).toContain("no longer authorized"); // retain the historical record
  },
);
it("invites a deliberate retry only when sending is available", () => {
  expect(replySendFailure({ channel: "linkedin", send, canSend: true })?.message).toContain(
    "review your draft and send",
  );
});
it("keeps real connection failures and unrelated send errors visible", () => {
  expect(
    replySendFailure({
      channel: "linkedin",
      send,
      canSend: false,
      linkedinConnectionState: "unavailable",
    }),
  ).toMatchObject({ recovered: false, message: send.error });
  expect(
    replySendFailure({
      channel: "linkedin",
      send: { ...send, error: "Rate limit" },
      canSend: true,
    }),
  ).toMatchObject({ recovered: false, message: "Rate limit" });
});
it.each(["pending", "uncertain", "sent"] as const)(
  "does not change %s delivery handling",
  (status) => {
    expect(
      replySendFailure({ channel: "linkedin", send: { ...send, status }, canSend: true }),
    ).toBeNull();
  },
);

it("says a refused payment sent nothing and points at the wallet", () => {
  // OneShot bills before dispatch; its rejection text never says "empty wallet".
  expect(
    replySendFailure({
      channel: "linkedin",
      canSend: true,
      linkedinConnectionState: "connected",
      send: {
        id: "s1",
        status: "failed",
        body: "x",
        variant: "direct",
        generationId: "g1",
        error:
          "payment rejected: invalid_payload — expected $0.02, signed $0.02 [payment attempt a]",
      },
    }),
  ).toEqual({
    recovered: false,
    message:
      "Your reply was not sent: OneShot refused the payment for it, which usually means the sending wallet is empty. Fund the wallet, then send again.",
  });
});
