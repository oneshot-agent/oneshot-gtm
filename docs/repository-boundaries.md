# Public code and private operating data

This repository contains the GTM application, its workspace-management code, prompts, tests, fictional examples and user documentation. Workspace-management code lets every founder create their own install; it does not include the maintainer's actual workspace.

## Keep outside Git

- Actual workspace homes: `~/.oneshot-gtm`, `~/.oneshot-gtm-workspaces` and `~/.oneshot-gtm-shared`.
- Config with your founder profile or voice, credentials, OAuth tokens, mailbox connections and browser session material.
- Ledgers, prospect lists, research dossiers, draft/reply exports, transcripts and event logs from real activity.
- Local launch copy, research output, maintainer notes and infrastructure under `launch/`, `output/` and `ops/`.
- Private SDK source checkouts and SDK archives. GTM installs `@oneshot-agent/sdk` as an external package dependency; integration wrappers and dependency metadata remain public.

Use the normal workspace homes even when developing locally. If you override `ONESHOT_GTM_HOME`, `ONESHOT_GTM_WORKSPACES` or `ONESHOT_GTM_SHARED`, point them outside the checkout. Ignore rules cover the known local paths and runtime files, but cannot identify arbitrary renamed exports. Put temporary exports in the ignored `output/` directory; never use production data as a test fixture.

Use `*.local.json`, `*.private.json` or the ignored `output/` directory for real target files. The committed files in `examples/` are sample inputs, not a place to maintain customer lists. Use the [fictional demo](./demo-mode.md) for captures and screenshots.

## Review before publishing

Inspect `git status --short` and `git diff --cached` before committing. The repository boundary tests reject tracked runtime files and private SDK directories; they also check that representative private paths stay ignored. These checks complement review and are not a complete secret scanner.

Removing a tracked file and adding an ignore rule prevents future inclusion. It does not remove copies from prior Git commits. History cleanup is a separate operation.

Local storage does not mean every operation stays offline: configured LLM, research and delivery providers receive the data needed to perform the requested action. [Telemetry](../TELEMETRY.md) documents the separate product-telemetry fields and opt-out.
