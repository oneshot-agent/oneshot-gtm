<img src="apps/web/public/icon-192.png" alt="" width="72" height="72" align="left" />

# oneshot-gtm

Outbound for founders who have not earned scale yet. It finds people, you approve them, it writes, you send.

**[oneshot-gtm.com](https://oneshot-gtm.com)** · [docs](https://docs.oneshotagent.com/oneshot-gtm/introduction) · [what a signed receipt is](https://oneshot-gtm.com/receipt)

```bash
bunx oneshot-gtm-server     # the dashboard, no clone
```

[![Built with oneshot-sdk](https://img.shields.io/badge/built%20with-oneshot--sdk-0a0a0a?style=flat&labelColor=18181b&color=22c55e)](https://www.npmjs.com/package/@oneshot-agent/sdk) [![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![Bun](https://img.shields.io/badge/runtime-Bun%201.3+-fbf0df?logo=bun&logoColor=black)](https://bun.sh) [![TypeScript](https://img.shields.io/badge/typed-TypeScript%206-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

https://github.com/user-attachments/assets/d4c3a6b1-2850-481c-bb78-9d3cec940ea5

## How it works

- Finders watch public signals: a launch, a funding round, a new licence, a starred repo.
- A gate judges each person against your ICP and rejects who does not fit. You can overrule it.
- You approve rows in a queue. Approval sends nothing.
- Each message opens with an offer specific to their firm, written from research and your product brief, in your voice. You send one, or run a batch. See [the prospect offer](./docs/prompt-inputs.md#the-prospect-offer).
- Cadences follow up. A reply on any channel stops them.

Every paid call leaves a signed receipt, so spend per reply is a record and not an estimate.

It runs on your machine: a CLI and a local dashboard over one SQLite ledger. [OneShot](https://docs.oneshotagent.com) supplies the actions (research, enrichment, email, LinkedIn, SMS, voice, letters) and bills per call. You bring the LLM key. The licence is MIT. Read the prompts, fork the plays.

## What it will not let you do

Most outbound tools assume product-market fit and optimise sends. Most founders using them do not have it yet. So the limits are in the code.

- A first touch never asks a stranger for a meeting. It says one useful thing and asks one line back, or nothing.
- Every draft passes a lint for machine writing. A flagged draft is held.
- A new mailbox sends 10 a day and earns 10 more each week, up to 50. Once the day's quota is used, nothing more sends until midnight.
- The `handoff` commands check your replies and deals before a scale move, and say so when it is too early.

## Setup

```bash
curl -fsSL https://bun.sh/install | bash        # Bun is the runtime

git clone https://github.com/oneshot-agent/oneshot-gtm
cd oneshot-gtm && bun install

bun run cli -- init                             # profile and keys
bun run cli -- doctor                           # health check
bun run --cwd apps/web build                    # build the dashboard once
bun run cli -- ui                               # http://127.0.0.1:3030
```

`init` asks who you are and what you sell. Every field is optional: a blank one skips its beat in the draft, it is never invented. [Your first workspace](./docs/getting-started.md) walks the dashboard path from an empty install to a reviewed draft. [Prompt inputs](./docs/prompt-inputs.md) maps each field to the drafts it reaches, and a [voice card](./docs/voice.md) makes them sound like you.

`bunx oneshot-gtm-server` runs the dashboard without a clone. Both paths need Bun; the code uses `bun:sqlite` and fails under plain Node. `bun run cli -- --help` lists every command, and the [CLI reference](https://docs.oneshotagent.com/oneshot-gtm/cli-reference) documents each flag.

## Where targets come from

A finder is a source with a schedule and a spend cap: Show HN, funding news, accelerator cohorts, job changes, open roles, GitHub stars, event guest lists, business registries, public tenders, any page that lists companies. All of them start off. Turn on the ones your buyers show up in, apply an industry pack, or bring your own list. [Finders](./docs/finders.md) has the table, the gates and the research each row gets.

### The plays

A play is one motion: who it is for, what happened to them, what the first message says and how it follows up. Pick by the buyer's situation. Email and LinkedIn go out when you send. X, Reddit and Hacker News drafts are posted by you, then marked sent. [Choosing a play](./docs/plays.md) lists each one with what it needs and what it produces.

### Sending

Mail goes out through a pool of your own mailboxes and OneShot domains. A prospect always hears from the address that wrote first. [Sending](./docs/sending.md) has the caps, the duplicate guard and reply handling.

### LinkedIn

Connect your account once on Setup. Invites, messages and replies go through OneShot's API from that account, never a browser bot. [LinkedIn](./docs/linkedin.md) has the limits and the guard that runs before each invite.

### Direct mail

A physical letter as an optional cadence step. Each one is proofed and approved by hand; no bulk action sends mail. See [direct mail](./docs/direct-mail.md).

### Background monitoring as a service

Finders poll while the dashboard runs. `ui --install-service` keeps it running across restarts, and `config spend-ceiling` caps what a day of finder runs and drains may spend. See [background monitoring](./docs/background-monitoring.md).

## Workspaces

One workspace is one product: one voice, one ICP, one ledger, one sender pool. A second product gets a second workspace.

```bash
bun run cli -- workspace create acme
bun run cli -- --workspace acme init
bun run cli -- --workspace acme ui
```

Workspaces share one database of people, paid lookups and contact history, so two products do not cold-email the same person in the same week. See [workspaces](./docs/workspaces.md).

## Architecture

```
   apps/cli        apps/server       apps/web        surfaces
   commander       Bun.serve + SSE   Vite + React
        \               |               /
   packages/*      core · intel · plays · find · prompts · doctor · shared-types
                        |
   @oneshot-agent/sdk   email · LinkedIn · SMS · voice · research · enrichment · receipts
```

- **State.** `~/.oneshot-gtm/ledger.sqlite` is the source of truth for the CLI and the dashboard. `ONESHOT_GTM_HOME` moves it. [Data storage](./docs/data-storage.md) lists every file and how to back it up.
- **Secrets.** `~/.oneshot-gtm/.env`, mode 600.
- **Server.** Single user, bound to `127.0.0.1`. The only routes meant for other systems are two [webhooks](./docs/webhooks.md).
- **Data.** Lookups resolve through OneShot's [data vendors](https://docs.oneshotagent.com/vendors).
- **Stack.** Bun, TypeScript, Vitest, oxlint and oxfmt, Vite, React, TanStack, Tailwind. Plain `async`/`await` throughout.

What stays out of Git is in [repository boundaries](./docs/repository-boundaries.md).

## Development

```bash
bun install
bun run typecheck                  # tsc across apps and packages
bun run lint                       # oxlint
bun run fmt                        # oxfmt, also formats Markdown
bun --bun run test                 # vitest under Bun
bun run --cwd apps/web build       # apps/web/dist
bun run --cwd apps/server build    # the published server bundle
```

The `--bun` flag matters: `bun:sqlite` does not exist under Node. Tests set `ONESHOT_GTM_HOME` to a temp directory and never touch your ledger. [STATUS.md](./STATUS.md) carries the current test totals. Docs upkeep is in [maintaining the docs](./docs/documentation.md).

### Watching what's happening

Each install writes `~/.oneshot-gtm/events.jsonl`: one line per LLM call, gate decision, finder event and swallowed error. It never leaves the machine.

```bash
tail -F ~/.oneshot-gtm/events.jsonl | jq -c '{t:.ts, k:.kind, ctx:.ctx}'            # everything, condensed
tail -F ~/.oneshot-gtm/events.jsonl | jq -c 'select(.kind|startswith("llm."))'      # LLM calls
tail -F ~/.oneshot-gtm/events.jsonl | jq -c 'select(.kind=="icp.decision")'         # topic gate
tail -F ~/.oneshot-gtm/events.jsonl | jq -c 'select(.kind=="icp.person_decision")'  # person gate
tail -F ~/.oneshot-gtm/events.jsonl | jq -c 'select(.level=="error" or .level=="warn")'
DEBUG=oneshot:* oneshot-gtm find watch --once                                       # mirror to stderr
```

The file rotates at about 10 MB into three older generations. Use `tail -F`; `tail -f` loses the file at rotation.

## Telemetry

Anonymous and on by default. One command turns it off:

```bash
oneshot-gtm config telemetry off        # or ONESHOT_GTM_TELEMETRY=0
```

It sends one event per command: the command name, flag names, outcome, duration, versions, OS, LLM provider and a random install id. Nothing about prospects, prompts, replies, receipts or your wallet. [TELEMETRY.md](./TELEMETRY.md) is the field list.

## Status and scope

[STATUS.md](./STATUS.md) says what is verified against the live API and what is thin. [ROADMAP.md](./ROADMAP.md) says what is not built and what never will be: it will not run an SDR for you, manage your DNS, hold your customer data, lock you to one LLM or go multi-user.

## License

MIT. See [LICENSE](./LICENSE). Shipped something with it? There is a [badge](./docs/badge.md).

Built by [free.butter](https://freebutter.com). The lead pipeline behind it runs there.
