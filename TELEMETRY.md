# Telemetry

`oneshot-gtm` ships with anonymous, opt-out telemetry. The intent is narrow: learn which plays land so the next phase ships the right plays. Nothing about your customers, prospects, prompts, or content is collected.

## How to disable

```bash
oneshot-gtm config telemetry off
```

Or set `ONESHOT_GTM_TELEMETRY=0` in your environment (`false`, `off`, and `no` work too). That's a hard kill at the call site — no payload is even constructed, and it overrides the persisted flag for that shell session.

To point the CLI at a different ingest endpoint (e.g. a local receiver while developing), set `ONESHOT_GTM_TELEMETRY_URL`.

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
| `anonymous_machine_id` | `9f3a…` (random UUID)           | Distinguish unique installs without identifying anyone. This is the per-install `clientId` (see below) — a random UUID minted on first run, **not** a hash of any machine identifier, so it carries nothing traceable to your hardware or account. |
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

Sent to a single first-party endpoint owned by OneShot: a Cloud Run service on our GCP project (`apps/telemetry-ingest`) that validates the payload against the whitelist above and writes one row to BigQuery. No third-party analytics SDK is bundled in the CLI — it's a plain `fetch` POST, so there's no vendor phoning home from your machine. Aggregated and used to prioritize the public roadmap. Never sold, never shared with third parties.

This file is the authoritative spec. If telemetry is ever extended, this file is updated in the same PR — both the client (`packages/core/src/telemetry.ts`) and the receiver (`apps/telemetry-ingest`) carry the same field whitelist deliberately, and all three must move together. (This is a maintainer convention; it is not yet enforced by CI.)

## Local development log (separate from telemetry)

Independent of the opt-out flag above, every install writes a structured local event log to `~/.oneshot-gtm/events.jsonl`. This is **never transmitted off-device**. Its purpose is letting you (the developer) see what's happening inside finder runs, ICP filter decisions, LLM calls, and swallowed errors while iterating.

Tail it with `jq`:

```bash
tail -f ~/.oneshot-gtm/events.jsonl | jq -c '{k:.kind, l:.level, ctx:.ctx}'
```

The same privacy boundary applies to event `ctx` payloads — primitives, counters, durations, category labels, hostnames only. No user-typed values, no prospect data, no LLM completions verbatim. This rule means the local log shape is forward-compatible with future opt-in distribution telemetry: the producer sticks; only the sink (file vs HTTP) changes.

Delete the file any time: `rm ~/.oneshot-gtm/events.jsonl`. Disable the dev mirror to stderr by leaving `DEBUG` unset; the file gets written either way.

## Anonymous `clientId`

A UUID is generated on first run and persisted to `~/.oneshot-gtm/config.json`. It is never exposed to the web layer (filtered out of `/api/setup` responses). It is the `anonymous_machine_id` sent with each distribution telemetry event (above) — the only thing that distinguishes one install's events from another's, with nothing traceable back to a person or machine. Distribution telemetry is **opt-out** (on by default, disclosed on first run); disabling it leaves the UUID on disk but blocks any transmission.
