import type { LinkedInAccountView } from "@oneshot-gtm/shared-types";

/** Connection health and import progress are independent provider states. */
export function linkedInConnectionView(account: LinkedInAccountView) {
  const reconnect =
    account.status === "reconnect_required" || account.syncState === "reconnect_required";
  const connected = account.status === "connected" && !reconnect;
  const running = !!account.backfill && !["blocked", "complete"].includes(account.backfill.stage);
  const paused = account.backfill?.stage === "blocked";
  const needsPermissions = connected && !account.canResolve;
  const title = reconnect
    ? "Reconnect LinkedIn"
    : needsPermissions
      ? "Allow profile access"
      : paused
        ? "History import paused"
        : connected
          ? "Connected"
          : "Connection unavailable";
  const description = reconnect
    ? "LinkedIn requires you to sign in again. Imported conversations are saved."
    : needsPermissions
      ? "Allow profile access to match imported messages to people."
      : paused
        ? "The import stopped before finishing. Your progress is saved; resume when you’re ready."
        : !connected
          ? "Check the connection details below before connecting again."
          : null;
  return {
    reconnect,
    connected,
    running,
    paused,
    needsPermissions,
    title,
    description,
    attention:
      reconnect ||
      needsPermissions ||
      paused ||
      !connected ||
      !!account.error ||
      !!account.permissionUpgradeError,
    showProgress:
      connected &&
      account.backfill?.stage === "resolve" &&
      !account.backfill.nextAttemptAt &&
      !!account.backfill.senders?.total &&
      account.backfill.senders.resolved < account.backfill.senders.total,
  };
}
