import type { LinkedInAccountView } from "@oneshot-gtm/shared-types";

/** Connection health and import progress are independent provider states. */
export function linkedInConnectionView(account: LinkedInAccountView) {
  // Another member's account: its name and status, nothing to act on or fix here.
  const mine = account.mine !== false;
  const reconnect =
    account.status === "reconnect_required" || account.syncState === "reconnect_required";
  const connected = account.status === "connected" && !reconnect;
  const running = !!account.backfill && !["blocked", "complete"].includes(account.backfill.stage);
  const paused = account.backfill?.stage === "blocked";
  const needsPermissions = connected && !account.canResolve;
  // An older connection that was never asked for connection requests. It works
  // for everything else, so this is an offer, not something needing attention.
  const needsInvite = connected && !needsPermissions && account.canInvite === false;
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
          : needsInvite
            ? "Connection requests are not allowed on this connection yet. Allowing them asks you to sign in to LinkedIn again; the account and its imported conversations stay as they are."
            : null;
  return {
    mine,
    reconnect,
    connected,
    running,
    paused,
    needsPermissions,
    needsInvite,
    title,
    description: mine
      ? description
      : `Connected by ${account.ownerMember ?? "another member"}. Its conversations are visible only to them.`,
    attention:
      mine &&
      (reconnect ||
        needsPermissions ||
        paused ||
        !connected ||
        !!account.error ||
        !!account.permissionUpgradeError),
    showProgress:
      connected &&
      account.backfill?.stage === "resolve" &&
      !account.backfill.nextAttemptAt &&
      !!account.backfill.senders?.total &&
      account.backfill.senders.resolved < account.backfill.senders.total,
  };
}
