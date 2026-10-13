import type { ReplyThread } from "@oneshot-gtm/shared-types";

/** A failed attempt is historical evidence, not the account's current connection status. */
export function replySendFailure(
  thread: Pick<ReplyThread, "channel" | "send" | "canSend" | "linkedinConnectionState">,
) {
  if (thread.send?.status !== "failed") return null;
  // OneShot bills before it dispatches, so a refused payment means nothing
  // went out. Its own text ("payment rejected: invalid_payload — expected
  // $0.02, signed $0.02") does not say that the wallet is empty, which is what
  // it meant on 2026-10-12.
  // A budget is a limit the account set on itself: money in the wallet does
  // not lift it, so it gets its own instruction.
  if (/budget/i.test(thread.send.error ?? ""))
    return {
      recovered: false,
      message:
        "Your reply was not sent: it would go over a spending budget set on the OneShot account. Review the budget, then send again.",
    };
  if (/payment rejected|insufficient credits/i.test(thread.send.error ?? ""))
    return {
      recovered: false,
      message:
        "Your reply was not sent: OneShot refused the payment for it, which usually means the sending wallet is empty. Fund the wallet, then send again.",
    };
  const authFailure =
    /no longer authorized|reconnect.*retry|grant.revoked|account.revoked|reply permission/i.test(
      thread.send.error ?? "",
    );
  const recovered =
    thread.channel === "linkedin" &&
    authFailure &&
    (thread.canSend ||
      thread.linkedinConnectionState === "connected" ||
      thread.linkedinConnectionState === "restoring");
  return {
    recovered,
    message: recovered
      ? thread.canSend
        ? "Your previous reply was not sent. LinkedIn is connected again; review your draft and send when ready."
        : "Your previous reply was not sent. Your draft is saved; see the conversation status above."
      : (thread.send.error ?? "Your reply was not sent. Try again."),
  };
}
