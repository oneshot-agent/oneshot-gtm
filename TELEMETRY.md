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
