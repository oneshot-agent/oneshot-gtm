# Workspaces

One install is one product: one founder voice, one ICP, one product brief, one ledger, one sender pool. Every install starts with a single workspace named `default` at `~/.oneshot-gtm`. Selling two things means two workspaces, each with its own profile, keys, identities and dashboard port:

```bash
bun run cli -- workspace create acme          # ~/.oneshot-gtm-workspaces/acme, next free port
bun run cli -- --workspace acme init          # its own profile, keys, identities
bun run cli -- --workspace acme ui            # runs side by side with the default dashboard
bun run cli -- workspace use acme             # make it the default for runs without the flag
bun run cli -- workspace list                 # every workspace, the current and the default
```

`--workspace` (or `ONESHOT_GTM_WORKSPACE`) is resolved by a bootstrap shim (`apps/cli/src/main.ts`) before anything else loads, so every command and the spawned dashboard see the right home. An explicit `ONESHOT_GTM_HOME` still wins — it's the escape hatch — and `workspace path <name>` prints a home for scripting: `ONESHOT_GTM_HOME=$(oneshot-gtm workspace path acme) …`.

## What stays shared

`~/.oneshot-gtm-shared/shared.sqlite` (relocate with `ONESHOT_GTM_SHARED`) holds the paid lookup caches (enrichment, LinkedIn — the same person is never bought twice) and contact touches. A workspace never first-touches someone another workspace emailed in the last 7 days: the draft holds with a `contacted-elsewhere` flag you can override on a manual send, while drain and cadence steps wait the window out.

Each ledger's own cache tables are imported into the shared DB once on first use and then left unwritten, so rolling back is a code revert, not a data migration.

## What `doctor` warns about

- Two workspaces sharing a **sending domain** — warm-up caps are per-workspace, so the domain's real budget silently doubles.
- Two workspaces sharing a **Gmail account** — both inbox pollers would see both products' replies.

## In the dashboard

A masthead chip names the workspace and its port; each name gets a stable colour. Clicking the chip — or `⌘K → Workspaces` — lists every registered workspace with a live status dot. Running ones open in a new tab; stopped ones start and then open. The server is spawned detached with no supervisor, so the status dots are the truth about what's up, and a launch that doesn't come up within 15s falls back to a copyable `--workspace <name> ui` command.

## Background services

`find watch --install-service` embeds the active home, so `--workspace acme find watch --install-service` pins the generated service to that workspace. See [background monitoring](./background-monitoring.md).
