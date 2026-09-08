# Demo mode

A fresh install is nine empty states, which makes it hard to show anyone what this looks like in use. `demo` builds a fictional, fully-populated install in its own home and opens the dashboard against it.

```bash
bun run cli -- demo seed      # → ~/.oneshot-gtm-demo
bun run cli -- demo ui        # dashboard, pointed at the demo install
bun run cli -- demo reset     # delete it
```

The cast is invented (it extends the one in `examples/`) and the numbers are internally consistent: ~24 prospects across eight plays and 30 days, 147 signed receipts totalling $2.94, cadences in all five states, replies matched to their prospects, two closed deals. Everything is anchored to a timestamp, so `--now` reproduces a ledger exactly and a re-shoot matches the first take.

What demo mode changes, and nothing else:

- Four **read-only** calls that fetch at request time rather than reading the ledger — the reply list, the platform RoCS rollup, the domain pool, the wallet balance — are served from JSON fixtures in the demo home. Without that, Replies is blank no matter what's in SQLite.
- The in-process **scheduler idles**, so enabled triggers don't fire against the demo install and overwrite its state mid-screenshot.

Nothing that sends, drafts or spends is faked. Under the flag, the demo home's `.env` is the **sole** source of secrets — real credentials inherited from your shell, your install, or a repo-root `.env` are overwritten or deleted — so a stray click on Run or Send fails at auth rather than doing something real. `demo seed` refuses to touch `~/.oneshot-gtm`, and `demo reset` only removes a directory it marked as its own.

## Privacy toggle

Independent of demo mode, the dashboard has a privacy toggle next to the strategist dock. Flip it on and names, emails, companies and phone numbers render partially masked everywhere — enough to screenshot a receipt or a cadence without exposing a real contact. Costs, receipt IDs and every other figure stay untouched. Off by default, remembered per browser. It's readable obfuscation for screenshots, not secure redaction.
