import type { ReplyThread } from "@oneshot-gtm/shared-types";

/** A failed attempt is historical evidence, not the account's current connection status. */
export function replySendFailure(
  thread: Pick<ReplyThread, "channel" | "send" | "canSend" | "linkedinConnectionState">,
) {
  if (thread.send?.status !== "failed") return null;
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
