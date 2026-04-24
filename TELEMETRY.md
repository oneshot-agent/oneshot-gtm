# Telemetry

`oneshot-gtm` ships with anonymous, opt-out telemetry. The intent is narrow: learn which plays land so the next phase ships the right plays. Nothing about your customers, prospects, prompts, or content is collected.

## How to disable

```bash
oneshot-gtm config telemetry off
```

Or set `ONESHOT_GTM_TELEMETRY=0` in your environment. That's a hard kill at the call site — no payload is even constructed.

## What is collected (when telemetry is on)

| Field                  | Example                         | Why                                                     |
| ---------------------- | ------------------------------- | ------------------------------------------------------- |
| `command`              | `motion.show-hn`                | Learn which plays are used.                             |
| `flags`                | `["dry-run"]`                   | Flag names only, never values.                          |
| `outcome`              | `ok` / `error` / `lint-blocked` | Aggregate failure rate.                                 |
| `duration_ms`          | `2840`                          | Find slow plays.                                        |
| `version`              | `0.1.0`                         | Catch regressions on a release.                         |
| `os`                   | `darwin` / `linux` / `win32`    | Reproducibility for bug reports.                        |
| `bun_version`          | `1.3.10`                        | Same.                                                   |
| `anonymous_machine_id` | `9f3...` (sha256, salted)       | Distinguish unique installs without identifying anyone. |
| `llm_provider`         | `openrouter`                    | Learn which providers founders pick.                    |

## What is NEVER collected

- Email content, subject lines, prospect data.
- LLM prompts or responses.
- API keys, wallet credentials, or environment variable values.
- Receipt contents or amounts.
- File paths, project names, repo names.
- Customer names or any PII.
- Stack traces with file paths (only error class names).

## Where it goes

Sent to a single endpoint owned by OneShot. Aggregated and used to prioritize the public roadmap. Never sold, never shared with third parties.

This file is the authoritative spec. If telemetry is ever extended, this file is updated in the same PR. CI rejects PRs that change telemetry without updating this file.

## Local development log (separate from telemetry)

Independent of the opt-out flag above, every install writes a structured local event log to `~/.oneshot-gtm/events.jsonl`. This is **never transmitted off-device**. Its purpose is letting you (the developer) see what's happening inside finder runs, ICP filter decisions, LLM calls, and swallowed errors while iterating.

Tail it with `jq`:

```bash
tail -f ~/.oneshot-gtm/events.jsonl | jq -c '{k:.kind, l:.level, ctx:.ctx}'
```

The same privacy boundary applies to event `ctx` payloads — primitives, counters, durations, category labels, hostnames only. No user-typed values, no prospect data, no LLM completions verbatim. This rule means the local log shape is forward-compatible with future opt-in distribution telemetry: the producer sticks; only the sink (file vs HTTP) changes.

Delete the file any time: `rm ~/.oneshot-gtm/events.jsonl`. Disable the dev mirror to stderr by leaving `DEBUG` unset; the file gets written either way.

## Anonymous `clientId`

A UUID is generated on first run and persisted to `~/.oneshot-gtm/config.json`. It is never exposed to the web layer (filtered out of `/api/setup` responses) and never transmitted today. Reserved for opt-in distribution telemetry once that lands — having it now means pre-launch installs aren't attribution-orphaned later. Disabling telemetry leaves the UUID on disk but blocks any transmission.
