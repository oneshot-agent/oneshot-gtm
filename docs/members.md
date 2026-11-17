# Members

Several people can use one install from their own machines. The dashboards still bind `127.0.0.1`; everyone else comes in through [`tailscale serve`](https://tailscale.com/kb/1312/serve), on a hostname you allow, signed in as a member you added. Nothing is hosted: the ledgers, the shared database and the keys stay on the host machine.

Until you allow a host, only the host machine can open the dashboards.

## What members can see

Every member sees every workspace and can do everything in its dashboard: review, send, run finders, change Setup and spend from the wallet. There is no per-workspace access, and `owner` and `member` differ only in the role the dashboard shows. Add the people you would hand the laptop to.

The header names who is signed in; `GET /api/me` returns their email, name and role. The CLI stays on the host machine.

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

Members open `https://<machine>.<tailnet>.ts.net:3030/`. On the host machine keep opening `http://127.0.0.1:3030`: Tailscale may attach no sign-in to the host's own requests to its tailnet name, and without one they are refused. Links between workspaces keep the hostname the page was opened on and change the port, which is why the two port numbers must match. A workspace started from the switcher still needs its port served before its tab loads.

`tailscale serve --https=<port> off` stops serving a port. To close the install again, do that for each port and `members disallow-host` the name. Do not use `tailscale funnel`: a Funnel visitor carries no sign-in and is refused.

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
- **A loopback Host can be forged.** Over HTTPS the backend is chosen by the TLS server name, not the `Host` header, so a tailnet device can send `Host: 127.0.0.1` through it. Every proxied request carries `X-Forwarded-Host` and `X-Forwarded-For`, which the client cannot remove. So once a host is allowed, a request with a loopback `Host` and those headers is refused rather than treated as the owner.

## Limits

- **Other proxies.** With no host allowed, a proxy that rewrites `Host` to loopback reaches the server as before. Once a host is allowed, it is refused if it adds `X-Forwarded-For`, `X-Forwarded-Host` or `Forwarded`. This includes a proxy in front of the [webhooks](./webhooks.md).
- **Connecting Gmail.** Google's sign-in returns to a loopback address, so do it in a browser on the host machine.
- **One sign-in method.** Identity comes from Tailscale only.
