# oneshot-gtm-server

Local dashboard for [oneshot-gtm](https://oneshot-gtm.com) — the open-source GTM agent that tells you "not yet".

```bash
bunx oneshot-gtm-server
```

Boots `Bun.serve` and opens the dashboard over your local SQLite ledger. No clone required. Workspace state stays in your home directory; configured providers receive the data needed for research, drafting and sending.

- Website: https://oneshot-gtm.com
- Source & docs: https://github.com/oneshot-agent/oneshot-gtm
- Full CLI: clone the source repository and run `bun run cli -- --help` (same ledger).

MIT.
