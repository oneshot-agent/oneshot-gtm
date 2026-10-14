# Workspaces

One workspace is one product: one voice, one ICP, one ledger, one sender pool. A second product gets a second workspace, not a second section of the first.

Every install starts with one workspace named `default` at `~/.oneshot-gtm`.

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
| The LinkedIn account      | one connection, with a daily invite share per workspace                          |
| LinkedIn suppression list | a profile one workspace invited is never invited by another                      |

The 7-day hold follows a person's known email aliases. The draft is flagged `contacted-elsewhere`; you can override it on a single manual send.

Everything else stays in the workspace: research conclusions, angles, verdicts, outreach history.

## Rejects and moves

A reject is permanent inside its workspace. A finder cannot queue that person again; only **Approve anyway** on Prospects reopens the row. Nothing carries a reject to another workspace.

To hand a person to another product, use **move →** on the queue row. The destination starts if it is not running. The row arrives pending under the same play with its research, and [derives its own edge and verdict](./finders.md#rows-moved-between-workspaces). The row here is rejected with a `moved to <workspace>` note. If the destination had already rejected that person, its row is reopened.

## What `doctor` warns about

- Two workspaces on one **sending domain**. Caps are counted per workspace, so the domain's real daily volume doubles.
- Two workspaces on one **Gmail account**. Both would read both products' replies.
- **Old receipt payloads** over 20 MB. `compact-receipts` shows what it would trim and `--apply` trims it. Stop that workspace's dashboard first.

## In the dashboard

A chip in the masthead names the workspace and its port. Click it, or `⌘K → Workspaces`, to see every workspace with a live status dot. A running one opens in a new tab; a stopped one starts first. If it is not up within 15 seconds you get the command to start it by hand.

To bring each dashboard back after a restart, install it as a [service](./background-monitoring.md).
