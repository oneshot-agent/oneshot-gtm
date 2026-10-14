# Public code and private data

The code is public. Your prospects, keys and ledger are not, and a test fails when one of them gets tracked.

The repository holds the application, prompts, tests, fictional examples and docs. It holds nobody's actual workspace.

## Keep outside Git

- Workspace homes: `~/.oneshot-gtm`, `~/.oneshot-gtm-workspaces`, `~/.oneshot-gtm-shared`.
- Config with your profile or voice, keys, OAuth tokens, `mailbox-connections.json`, LinkedIn session material.
- Ledgers, prospect lists, research, draft and reply exports, transcripts, event logs.
- Launch copy, research output and maintainer scripts under `launch/`, `output/` and `ops/`.
- SDK source or archives. The SDK is installed from the package registry.

If you override `ONESHOT_GTM_HOME`, `ONESHOT_GTM_WORKSPACES` or `ONESHOT_GTM_SHARED`, point them outside the checkout. Keep real target files as `examples/*.local.json` or `examples/*.private.json`, or in `output/`; all three are ignored. Never use real data as a test fixture. For screenshots, use the [demo](./demo-mode.md).

## Before you commit

Read `git status --short` and `git diff --cached`. The boundary tests reject tracked runtime files and check that the private paths stay ignored. They are not a secret scanner.

Removing a tracked file does not remove it from history.

Local storage is not offline operation. The LLM, research and delivery providers you configure receive what they need to do the job. [Telemetry](../TELEMETRY.md) is separate and lists its own fields.
