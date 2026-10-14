# Demo mode

A screenshot of a real prospect is a leak. Demo mode builds a fictional install with every page full, in its own home, and opens the dashboard on it.

```bash
bun run cli -- demo seed      # builds ~/.oneshot-gtm-demo
bun run cli -- demo ui        # the dashboard, on the demo install
bun run cli -- demo reset     # deletes it
```

The people and companies are invented. The data is consistent with itself: prospects across plays, receipts, cadences in every state, replies matched to their prospects, closed deals. `--now <iso>` anchors every timestamp, so the same seed gives the same ledger. `--home <dir>` puts it elsewhere; `--force` overwrites a non-empty directory.

## What it changes

- Pages that fetch live data (replies, the spend rollup, sending domains, wallet balance, meetings) read fixtures from the demo home.
- The scheduler idles, so no trigger fires and overwrites the demo.
- Learning proposals are shown and decisions are refused.

Nothing that sends, drafts or spends is faked. The demo home's `.env` is the only source of secrets under the flag, so a stray click on Run or Send fails at sign-in. It cannot reach your real keys. `demo seed` refuses to touch `~/.oneshot-gtm`, and `demo reset` removes only a directory it marked as its own.

## Privacy toggle

Separate from demo mode, the dashboard has a privacy toggle beside the strategist dock. On, it partly masks names, emails, companies and phone numbers everywhere. Costs and ids stay. It is off by default and remembered per browser. It is for screenshots, not for redaction you can rely on.
