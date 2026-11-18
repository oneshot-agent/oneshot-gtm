/** Google can reject the redirect on its own page without calling us back. */
export function GmailConnectHelp({ origin }: { origin: string }) {
  const url = new URL(origin);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  return (
    <div className="text-[12px] text-ink-muted flex flex-col gap-2">
      <p>
        Connecting Gmail from another machine needs a Google Cloud OAuth client of type Web
        application. Add this exact Authorized redirect URI:
      </p>
      <code className="break-all select-all">{url.origin}/api/gmail/auth/callback</code>
      <p>
        Save the client ID and client secret from that same Web client as GMAIL_CLIENT_ID and
        GMAIL_CLIENT_SECRET in Credentials, then connect.
      </p>
      <p>
        If Google rejects the redirect (redirect_uri_mismatch or a loopback-only redirect error),
        return to Setup, add the URI above to the Web client and save its credentials, then retry. A
        Desktop client cannot use this address.
      </p>
    </div>
  );
}
