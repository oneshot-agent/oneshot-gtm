# Members

Several people can use one install from their own machines. The dashboards still bind `127.0.0.1`; everyone else comes in through [`tailscale serve`](https://tailscale.com/kb/1312/serve), on a hostname you allow, signed in as a member you added. Nothing is hosted: the ledgers, the shared database and the keys stay on the host machine.

Until you allow a host, only the host machine can open the dashboards.

## What members can see

Every member sees every workspace and can do everything in its dashboard: review, send, run finders, change Setup and spend from the wallet. There is no per-workspace access. The one exception is [LinkedIn conversations](#what-stays-private), which only the member who connected the account sees. Apart from that, `owner` and `member` differ only in the role the dashboard shows. Add the people you would hand the laptop to.

The header names who is signed in; `GET /api/me` returns their email, name and role. The CLI stays on the host machine.

## What stays private

Workspaces and mailboxes are shared. A LinkedIn account is one person's identity, so its conversations belong to the member who connected it.

- **Private to that member:** the account's conversations in Replies, matched to a prospect or not, with their messages and reply drafts. Replying, archiving, snoozing, assigning a conversation to a prospect, and the account's own actions (reconnect, import history, remove) are theirs alone. Anyone else who tries gets `403`.
- **Shown to every member:** the account's name, who connected it and whether it is connected, under **Replies → Connections & reply preferences → LinkedIn** and in the Setup account picker. A workspace can send from any connected account, whoever connected it.
- **Shared on purpose:** LinkedIn counts in Measure and the funnel, and the writing rules learned from replies. Every member reads a rule, its one-line summary and its counts, and every member's drafts follow it once approved. No member reads another member's LinkedIn messages through it: the replies a rule was learned from, the suggestions they started as and the names of the people they went to are shown only to the member who connected that account. The same holds for a prospect's LinkedIn reply quoted behind a suggested angle. A LinkedIn message whose account cannot be told, such as an outreach draft, is shown to no member. The row says how many examples were left out. Email examples are shown to everyone.
- **Not affected:** syncing, history import, matching replies to prospects and stopping a sequence on a reply run for every account. A reply matched to a prospect still marks that prospect as replied in its workspace.

The account belongs to the member who started **Connect LinkedIn**, and stays theirs through reconnects. An account connected before you added members, or one a sync found on the wallet, belongs to the owner: the first owner on the list, which is also who the host machine acts as. It stays the owner's when another member later signs in to the same LinkedIn account. A conversation never changes owner: a force reconnect merges the new connection's conversations into the account only when both belong to the same member. Otherwise nothing moves, the login stays open and the server logs the mismatch. With no members at all, the one person using the install sees every account and every example, as before.

## Action attribution

Queue approvals, rejections, moves and manual sends record the requesting member's email. The open queue case shows “Approved by …”, “Rejected by …” or “Sent by …”. The decision kind (`human`, `human_bulk`, `machine`) remains separate. Approval and rejection members stay in `decided_by_member`; the sender is recorded separately in `sent_by_member`. An unattended send retains its existing approval and shows no sending member. Machine decisions and rows from before member attribution have no member. A local owner without a listed email also remains unattributed.

Regenerated drafts record their requester as `editedBy`, separately from the row's approval. Offer edits, code-answer decisions and saved inbox drafts also record the member. Member-written offers keep the same protection from automatic rewriting as older founder edits.

Server setup saves and play cadence/mail settings append a `config_changes` row in the workspace ledger: `member`, `section` and `changed_at`. Sections are `setup`, `plays.<name>.cadence` and `plays.<name>.directMail`; configuration values and secrets are not copied into this audit table.

## Add members

Run these on the host. A member's email is their Tailscale login name, matched without regard to case.

```bash
bun run cli -- members add you@example.com --owner --name "Your Name"
bun run cli -- members add teammate@example.com
bun run cli -- members list
bun run cli -- members remove teammate@example.com
```

Members and allowed hosts are in the shared database, so they hold for every workspace. A change applies to the next request; no dashboard needs a restart. Adding a removed member brings them back.

On the host machine itself you are the owner, whoever is listed: the first owner you added, or a local owner with no email when the list has none.

## Allow a host

The dashboards answer on loopback and on the hostnames you allow. Allow the name members browse to, which is the host machine's tailnet name (`tailscale status` shows it).

```bash
bun run cli -- members allow-host <machine>.<tailnet>.ts.net
bun run cli -- members disallow-host <machine>.<tailnet>.ts.net
```

The entry is a hostname without a port, so one entry covers every workspace's dashboard.

## Serve each workspace port

Each workspace's dashboard is its own port (`workspace list` shows them). Serve each one on the same port number, over HTTPS:

```bash
tailscale serve --bg --https=3030 http://127.0.0.1:3030        # the default workspace
tailscale serve --bg --https=<port> http://127.0.0.1:<port>    # once per other workspace
tailscale serve status
```

Members open `https://<machine>.<tailnet>.ts.net:3030/`. On the host machine keep opening `http://127.0.0.1:3030`: Tailscale may attach no sign-in to the host's own requests to its tailnet name, and without one they are refused. Links between workspaces keep the hostname the page was opened on and change the port, which is why the two port numbers must match. A workspace started from the switcher still needs its port served before its tab loads. A workspace a member creates there does not open on its own: the switcher shows its port and the `tailscale serve` command above for the host operator, then a link.

`tailscale serve --https=<port> off` stops serving a port. To close the install again, do that for each port and `members disallow-host` the name. Do not use `tailscale funnel`: a Funnel visitor carries no sign-in and is refused.

## Connecting Gmail from another machine

Open Setup on the allowed HTTPS host and look under Email. It shows the exact callback URI for that workspace: `<origin>/api/gmail/auth/callback`, including the port when present.

In Google Cloud, enable the Gmail API and create an OAuth client with application type **Web application**. Add the displayed URI under **Authorized redirect URIs**. Save the client ID and client secret from that same Web client as `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in Setup → Credentials, then choose **Connect Gmail account**. Add each workspace's displayed callback URI if you use the client across multiple ports.

If Google rejects the redirect (`redirect_uri_mismatch` or a loopback-only redirect error), check that the URI matches exactly and that both saved credentials belong to the Web client. Google may leave you on its error page without returning to Setup; return manually after correcting the client and retry. A Desktop client cannot redirect to the member-facing hostname.

The workspace stores one Gmail client ID and secret pair, so saving the Web client's credentials also changes the client used by loopback Setup and the defaults for `gmail auth`. Register each host connection's exact loopback redirect URI on that same Web client too; otherwise Google rejects it. See [Gmail setup](./sending.md#connecting-gmail-from-another-machine) for the Setup callback path and the CLI's per-run callback port.

## How a request is judged

| Request                                                                 | Acts as     |
| ----------------------------------------------------------------------- | ----------- |
| Made on the host machine, to a loopback address                         | the owner   |
| On an allowed host, with `Tailscale-User-Login` naming an active member | that member |
| On an allowed host, with an unknown or removed email, or no sign-in     | refused     |
| On any other host                                                       | refused     |

A refused request gets `403`. A request that changes something must also come from a page on loopback or on an allowed host: one whose `Origin` is anywhere else, or that the browser marks `Sec-Fetch-Site: cross-site`, gets `403`.

## What `tailscale serve` sends

Read from Tailscale's source (`ipn/ipnlocal/serve.go`), since the gate depends on it:

- **Host.** The browser's `Host` header is passed through unchanged: the tailnet name, with the port when it is not 443. It is not rewritten to the backend's address. That is why the name has to be allowed.
- **Sign-in.** Any `Tailscale-User-Login` the client sent is removed, and Tailscale sets its own for a device signed in as a tailnet user. A tagged device and a Funnel visitor get none, so they are refused. A login with non-ASCII characters arrives RFC 2047 encoded and is decoded before the match.
- **A loopback Host can be forged.** Over HTTPS the backend is chosen by the TLS server name, not the `Host` header, so a tailnet device can send `Host: 127.0.0.1` through it. Every proxied request carries `X-Forwarded-Host`, set to the `Host` the client sent, and `X-Forwarded-For`; the client cannot remove either. So a request with a loopback `Host` and a loopback `X-Forwarded-Host` is refused rather than treated as the owner, whether or not a host is allowed: `tailscale serve` can be running before you allow a host and after you disallow the last one. Once a host is allowed, a loopback `Host` with any forwarding header is refused.

## Limits

- **Other proxies.** With no host allowed, a proxy that rewrites `Host` to loopback reaches the server as before, unless it also sends a loopback `X-Forwarded-Host`. Once a host is allowed, it is refused if it adds `X-Forwarded-For`, `X-Forwarded-Host` or `Forwarded`. This includes a proxy in front of the [webhooks](./webhooks.md).
- **One sign-in method.** Identity comes from Tailscale only.
