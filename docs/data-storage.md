# Data storage

Your data is on your disk. Nowhere else. Paid calls leave a signed receipt on the OneShot platform; the local ledger keeps each receipt's envelope.

## The files

| File                       | Where                   | Holds                                                                                                             |
| -------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ledger.sqlite`            | each workspace home     | receipts, prospects, the queue, cadences, replies, bounces, meetings, deals, drafts, triggers, learning proposals |
| `config.json`              | each workspace home     | your profile, ICP, voice card and settings                                                                        |
| `.env`                     | each workspace home     | keys, mode 600                                                                                                    |
| `events.jsonl`             | each workspace home     | the local event log                                                                                               |
| `gmail-tokens.json`        | each workspace home     | Gmail OAuth tokens                                                                                                |
| `mailbox-connections.json` | each workspace home     | mailbox credentials you entered by hand, mode 600                                                                 |
| `shared.sqlite`            | `~/.oneshot-gtm-shared` | shared people, paid lookup caches, contact touches, the LinkedIn invite counter and suppression list              |
| `reply-review.sqlite`      | `~/.oneshot-gtm-shared` | reply threads, drafts and sends from the Replies page                                                             |
| `linkedin-inbox.sqlite`    | `~/.oneshot-gtm-shared` | synced LinkedIn conversations and which workspace each belongs to                                                 |

The `default` workspace home is `~/.oneshot-gtm`; named ones live under `~/.oneshot-gtm-workspaces`. `ONESHOT_GTM_HOME` and `ONESHOT_GTM_SHARED` move them. [Workspaces](./workspaces.md) explains what is shared and why.

## Permissions

These files hold prospect emails, reply bodies and research. On macOS and Linux each database is created owner-only (`0600`) and reset to that when opened. A directory created for them is `0700`. `doctor` warns about any database another user can read. On Windows the files inherit your user profile's ACLs and `doctor` does not check them.

## Backups

The databases run in WAL mode: recent writes sit in a `-wal` file beside the main one. A plain `cp` of `ledger.sqlite` can miss them. Use SQLite's backup command.

```bash
sqlite3 ~/.oneshot-gtm/ledger.sqlite ".backup /path/to/ledger-backup.sqlite"
```

## Upgrades

A ledger records its schema version. Opening an older one runs the missing migrations in a single transaction, so a crash leaves it on the old version, not half-migrated. A ledger written by a newer build is never downgraded.

## Conventions, for anyone querying the files

- **Timestamps** are text, in UTC. Compare across columns with `julianday()`.
- **Money** is USD. Caps and totals are compared in whole cents.
- **Receipts** keep the envelope and identifiers (ids, cost, message and thread ids), not the tool's output. Contact lookups and mail orders are kept whole.

## Size

`doctor` says when more than 20 MB of old receipt payloads could be trimmed. `compact-receipts` shows what it would remove; `compact-receipts --apply` removes it and shrinks the file. Stop that workspace's dashboard first.
