# Workspaces

One workspace is one product: one voice, one ICP, one ledger, one sender pool. A second product gets a second workspace, not a second section of the first.

Every install starts with one workspace named `default` at `~/.oneshot-gtm`.

To add another from the dashboard, open the workspace switcher and choose **New workspace**. Enter 1–32 lowercase letters, digits or hyphens, starting with a letter or digit. Names must be unique. The dashboard creates its home and default profile, assigns a port, and opens a new tab once its server answers `/api/health` as that workspace. A server that answers on the port under a different name is never opened. Complete the new workspace's profile and keys in Setup; it does not copy the current workspace's settings or credentials.

From a non-loopback address (anything but a loopback one on the host machine, such as `http://127.0.0.1:3030` or `localhost`) no tab opens. As soon as the workspace is created, the switcher shows the assigned port and the command the host operator runs to serve it, then a link to the new workspace. It says the workspace is running only once the new server has answered, and says so when it has not; see [serve each workspace port](./members.md#serve-each-workspace-port).

The switcher and a queue move apply the same check: a workspace whose port answers as a different workspace shows as stopped, and starting it or moving a row to it is refused until that server is stopped. A dashboard from an older build does not name itself; it still counts as running. A move also names its destination in the hand-over, and a server that is not that workspace refuses the row.

On macOS it writes and loads a launchd agent; on Linux it writes and enables a systemd user unit. When no user service manager is available, it starts an unsupervised server and warns that it won't survive a reboot. Services start at user login; see [background monitoring](./background-monitoring.md) for headless Linux startup.

From the CLI:

```bash
bun run cli -- workspace create acme          # ~/.oneshot-gtm-workspaces/acme, next free port
bun run cli -- --workspace acme init          # its own profile, keys, identities
bun run cli -- --workspace acme ui            # runs beside the default dashboard
bun run cli -- workspace use acme             # the default for commands without the flag
bun run cli -- workspace list
```

`--workspace` or `ONESHOT_GTM_WORKSPACE` picks the workspace for any command. An explicit `ONESHOT_GTM_HOME` wins over both. `workspace path <name>` prints a home for scripts.

## What workspaces share

One database, `~/.oneshot-gtm-shared/shared.sqlite` (`ONESHOT_GTM_SHARED` moves it). It exists so two products do not trip over the same person.

| Shared                    | Why                                                                              |
| ------------------------- | -------------------------------------------------------------------------------- |
| People                    | one identity per person, by email or LinkedIn profile; a name alone never merges |
| Paid lookups              | a person researched for one product is not bought again for another              |
| Contact touches           | no first touch to someone another workspace emailed in the last 7 days           |
| LinkedIn accounts         | shared connections; each workspace selects its sender with `linkedin.accountKey` |
| LinkedIn suppression list | a profile one workspace invited is never invited by another                      |
| Members and allowed hosts | every dashboard lets the same people in; see [members](./members.md)             |

The invite share is optional: unset, a workspace is held only by the account's daily cap; `0` pauses that workspace's invites. See [LinkedIn](./linkedin.md#connection-requests-as-a-first-touch).

The 7-day hold follows a person's known email aliases. The draft is flagged `contacted-elsewhere`; you can override it on a single manual send.

Someone in a live sequence (active or paused) in another workspace gets no email or LinkedIn first touch here (drafts you post by hand, like X, are not checked), matched by email, a known alias or LinkedIn profile. The draft or invite is flagged `live-elsewhere` and goes back to pending; no override on a manual send lifts it (`breakup-revive`, which deliberately re-contacts people, is not held), but every Send checks again, so it goes once that sequence ends. Follow-ups are not held by it; they keep the 7-day spacing. `workspace overlaps` lists the people in a live sequence here and in another workspace, by play pair (`--json` for scripts). It changes nothing.

Everything else stays in the workspace: research conclusions, angles, verdicts, outreach history.

## Paid lookups

A lookup bought once is not bought again. Every paid lookup goes through one cache in the shared database, so a result bought in any workspace answers all of them until it expires.

| Lookup                                     | Kept     |
| ------------------------------------------ | -------- |
| Person research                            | 90 days  |
| Person profile, by email, LinkedIn or name | 30 days  |
| Email find                                 | 30 days  |
| Company profile, company search            | 30 days  |
| Local business resolve                     | 30 days  |
| Topic research                             | 30 days  |
| LinkedIn profile read and profile view     | 30 days  |
| Email verify, recent posts                 | 14 days  |
| People search, local business search       | 7 days   |
| Page read, web search, federal notices     | 12 hours |

A cached answer costs nothing and writes no receipt. A genuine failure is remembered for 3 days (12 hours for the 12-hour lookups); an outage, a rate limit or an empty wallet never is. Sends, replies, invites, messages, letters, builds and browser tasks are actions, never cached.

`--rebuy` on `research-queue` and `research-prospects`, and **Find business address** on a mail step, buy again. `--refresh` alone re-derives researched rows from the cache. `doctor` shows how much the cache answered over the last 7 days; `find cache-stats` breaks it down per lookup.

## Rejects and moves

A reject is permanent inside its workspace. A finder cannot queue that person again; only **Approve anyway** on Prospects reopens the row. Nothing carries a reject to another workspace.

To hand a person to another product, use **move →** on the queue row. The destination starts if it is not running. The row arrives pending under the same play with its research, and [derives its own edge and verdict](./finders.md#rows-moved-between-workspaces). The row here is rejected with a `moved to <workspace> #<move id>` note; the id names the move that holds the row, so a move that failed after a later one succeeded leaves the row with the later move. If the destination had already rejected that person, its row is reopened.

## What `doctor` warns about

- Two workspaces on one **sending domain**. Caps are counted per workspace, so the domain's real daily volume doubles.
- Two workspaces on one **Gmail account**. Both would read both products' replies.
- **Old receipt payloads** over 20 MB. `compact-receipts` shows what it would trim and `--apply` trims it. Stop that workspace's dashboard first.

## In the dashboard

A chip in the masthead names the workspace and its port. Click it, or `⌘K → Workspaces`, to see every workspace with a live status dot. A running one opens in a new tab, on the hostname this page was opened with; a stopped one starts first, with only its own keys and wallet, not the ones of the dashboard that started it. If it is not up within 15 seconds you get the command to start it by hand.

Workspaces created with **New workspace** install their service automatically when a user service manager is available. For CLI-created workspaces, install a [service](./background-monitoring.md) to bring the dashboard back after a restart.
