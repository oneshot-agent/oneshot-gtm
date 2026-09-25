# Data storage

Everything oneshot-gtm knows lives in local SQLite files under your home directory. Nothing is stored in a vendor cloud; paid calls leave a signed receipt on the OneShot platform, and the local ledger keeps a copy of each receipt's envelope.

## The files

| File                    | Where                                                                                | Holds                                                                                                                                             | Written by                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ledger.sqlite`         | each workspace home (`~/.oneshot-gtm` for `default`, `ONESHOT_GTM_HOME` to relocate) | receipts, prospects, target queue, cadences and sequence events, replies, bounces, meetings, deal outcomes, drafts, triggers, runs, mailbox sync  | that workspace's dashboard server and CLI; LinkedIn delivery also records replies into every workspace's ledger |
| `shared.sqlite`         | `~/.oneshot-gtm-shared` (`ONESHOT_GTM_SHARED` to relocate)                           | shared person identities and workspace memberships, paid lookup caches (enrichment, LinkedIn), contact touches for the 7-day cross-workspace hold | every workspace's server and CLI                                                                                |
| `reply-review.sqlite`   | shared directory                                                                     | reply review threads, drafts, leases, sends, reply-learning state                                                                                 | the Replies page, across workspaces                                                                             |
| `linkedin-inbox.sqlite` | shared directory                                                                     | synced LinkedIn accounts, conversations and messages, and which workspace a thread belongs to                                                     | LinkedIn sync and the Replies page                                                                              |

Each workspace's ledger is its own history; [workspaces](./workspaces.md) covers what is shared between them and why.

## Permissions

These files hold prospect emails, reply bodies and research, so they are owner-only. Opening one creates it with mode `0600` (its `-wal` and `-shm` files inherit that mode) and resets an existing file and its `-wal`/`-shm` to `0600`, so an install created before this rule tightens itself on the next start. A directory created for them is `0700`; an existing directory is left as you set it. `doctor` warns about a database file other users can still read, which happens only when the file belongs to another user.

## Copying and backups

The databases run in WAL mode: recent writes sit in the `-wal` file until SQLite checkpoints them into the main file. Copy a database with SQLite's backup command, not `cp`:

```bash
sqlite3 ~/.oneshot-gtm/ledger.sqlite ".backup /path/to/ledger-backup.sqlite"
```

A plain copy of `ledger.sqlite` alone can miss every write since the last checkpoint.

## Schema versions

A ledger records its schema version in SQLite's `user_version`. On open, a ledger that is behind runs the missing migrations and stamps the new version in one transaction, so a crash leaves it on the old version rather than half-migrated. A ledger written by a newer build is never downgraded. Migrations live in `LEDGER_MIGRATIONS` (`packages/core/src/ledger-schema.ts`); a new one is appended, and shipped ones are never edited.

## Conventions

- **Timestamps** are TEXT. Columns stamped by SQL (`datetime('now')`) hold `YYYY-MM-DD HH:MM:SS` UTC; columns written from code hold ISO 8601 with `Z`. Query methods convert their bounds to the column's form, and comparisons across forms go through `julianday()`.
- **Money** in existing columns is REAL USD; totals and caps are compared in integer cents. New money columns are integer micro-dollars.
- **Foreign keys** are enforced on ledger connections: a sequence event, deal outcome, queue row or channel event must point at an existing prospect.
- **Receipts** keep the receipt envelope and short identifiers (receipt and request ids, cost, message and thread ids, URL), not the tool's output. Contact lookups and direct-mail orders are kept whole.

## Size

Ledgers written before receipts were slimmed can hold whole scraped pages. `doctor` says when more than 20 MB could be trimmed; `compact-receipts` shows what it would trim and `compact-receipts --apply` trims it and reclaims the space. Run it once per workspace, with that workspace's dashboard stopped (the final `VACUUM` needs the file to itself).
