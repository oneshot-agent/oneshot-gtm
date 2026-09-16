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

`~/.oneshot-gtm-shared/shared.sqlite` (relocate with `ONESHOT_GTM_SHARED`) holds shared person identities and workspace membership links, alongside the paid lookup caches (enrichment and LinkedIn, reused when lookup identifiers match; unlinked aliases can still cause duplicate lookups) and contact touches. A workspace never first-touches someone another workspace emailed in the last 7 days: the draft holds with a `contacted-elsewhere` flag you can override on a manual send, while drain and cadence steps wait the window out.

Rejects are per workspace and permanent within it: the queue's unique key on play + dedupe key ignores status, so a finder can never re-enqueue someone you rejected there (only "Approve anyway" on /prospects reopens the row). Nothing carries a reject across workspaces. To hand a prospect to the other product, use **move →** on the /queue row (pending, approved or rejected). The destination is started if it is not running, the row lands in its queue as pending under the same play with the person's research intact and the sender's edge and verdicts stripped (the destination's own `yourEdge` applies at draft time), and the row here is rejected with a `moved to <workspace>` note. A rejected or expired row the destination already holds for that person is re-opened instead of refused — that is also how a prospect comes back.

Each ledger's own cache tables are imported into the shared DB once on first use and then left unwritten, so rolling back is a code revert, not a data migration.

## What `doctor` warns about

- Two workspaces sharing a **sending domain** — warm-up caps are per-workspace, so the domain's real budget silently doubles.
- Two workspaces sharing a **Gmail account** — both inbox pollers would see both products' replies.

## In the dashboard

A masthead chip names the workspace and its port; each name gets a stable colour. Clicking the chip — or `⌘K → Workspaces` — lists every registered workspace with a live status dot. Running ones open in a new tab; stopped ones start and then open. The server is spawned detached with no supervisor, so the status dots are the truth about what's up, and a launch that doesn't come up within 15s falls back to a copyable `--workspace <name> ui` command.

## Background services

### Smartlead inboxes

Every workspace automatically receives mail for its registered Smartlead identities
while its dashboard server runs. Smartlead continues handling outreach and warmup;
the dashboard reads IMAP and sends threaded replies over SMTP from the receiving
mailbox. Newly registered identities join the next sync automatically.

Open **Replies** to see mailbox connection status, the last successful sync, and
history import progress. The first import covers 30 days and older recorded
outreach; opening a conversation loads its available full history. Partial imports
and disconnected mailboxes are shown explicitly. A typical clean sync runs about
once a minute; a stopped dashboard does not receive mail in the background.

Use **Connection settings** when Smartlead does not expose working IMAP/SMTP
credentials. Both connections are verified before saving. Explicit credentials
live in the workspace's private `mailbox-connections.json` (mode `0600`), never in
the ledger or browser responses. OAuth-only accounts may require an app password
or another supported mailbox connection from the provider.

Threads match existing prospects by outreach references or email address; unmatched
mail stays under **No match**, where it can be associated with an existing prospect.
Read/unread, drafts, and archive state belong to this workspace. Reading or archiving
here does not change Smartlead or provider mailbox flags. A new inbound message
reopens an archived thread. Replies preserve email threading headers and remain
manually sent. If a send times out after submission, GTM checks Sent mail before
allowing another attempt to avoid duplicate responses.

Removing an identity stops its sync and sending but retains saved conversations.
Connecting one mailbox in two workspaces gives both access to that mailbox; their
prospect matches, read states, drafts, and archives remain independent.

`find watch --install-service` embeds the active home, so `--workspace acme find watch --install-service` pins the generated service to that workspace. See [background monitoring](./background-monitoring.md).

### Shared people and workspace memberships

A person has one shared identity and can belong to several workspaces. Normalized email and LinkedIn profile identifiers resolve to that identity. Matching names alone never merges people; contradictory identifiers require review. Adding the same person in another workspace links a membership rather than creating a second shared person.

Existing numeric prospect IDs remain workspace-local history keys. On startup, each workspace links those records to `shared_person_id` without renumbering or deleting sends, replies, queues or cadences. Legacy IDs that resolve to the same person remain valid. The workspace identity columns are compatibility projections; the shared person is authoritative. Dossiers, product-specific angles, qualification and outreach history stay with the workspace.

The shared contact check follows known email aliases of a person, so changing email addresses does not bypass another workspace's recent-contact hold. Unknown aliases still need an email or LinkedIn identity link before they can be recognised.

Code opening a custom ledger path outside the configured workspace home can opt into the same store with `new Ledger(path, { sharedPeoplePath })`; isolated fixture ledgers keep their previous local-only behavior.
