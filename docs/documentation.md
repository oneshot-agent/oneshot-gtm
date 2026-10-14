# Maintaining the docs

Change behaviour, change the page that states it, in the same pull request. Three things are generated; edit their source, never the output.

| Output                        | Source                                                    | Regenerate                                                  |
| ----------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| `docs/plays.md`               | `packages/plays/src/descriptions.ts`, intro in the script | `bun run scripts/generate-play-guide.ts`                    |
| hosted `cli-reference.mdx`    | the CLI's own command tree                                | `bun run scripts/generate-cli-reference.ts --output <path>` |
| the stamp line in `STATUS.md` | a real test run                                           | CI, on every merge to `main`                                |

Both scripts take `--check`, which writes nothing and exits nonzero on drift. Generate the CLI reference from a clean, committed checkout; it records the commit it came from.

## Rules for prose

- Answer first. One sentence that settles the reader's question, then the detail.
- One fact, one home. Other pages link to it.
- No totals. Do not count commands, plays, finders or tests in prose; `repo/__tests__/readme-counts.test.ts` fails the README if one appears.
- No per-tool prices. Link the [pricing page](https://docs.oneshotagent.com/pricing).
- No history. Say what the tool does, not what it used to do.
- `acme` and `default` are the only workspace names in examples.

Keep these README anchors; other files link to them: `#setup`, `#the-plays`, `#where-targets-come-from`, `#direct-mail`, `#background-monitoring-as-a-service`, `#watching-whats-happening`.

## The hosted site

The site at docs.oneshotagent.com is maintained in a separate repository. When a change here makes a hosted page wrong and you cannot fix it in the same release, open an issue labelled `docs-follow-up` naming the source pull request and the pages. Deploy a new hosted page before a README link points at it. Telemetry's field list lives only in [TELEMETRY.md](../TELEMETRY.md).

## The mark

The icon is a ledger receipt: cream slip, torn bottom edge, a green total line. Everything is in `apps/web/public/`. `icon.svg` is the master and every raster derives from it.

```bash
brew install librsvg
bun run --cwd apps/web brand
```

- Keep `icon.svg` in hex. librsvg renders `oklch()` fills as black without warning; the script fails the build when a fill stops parsing.
- `og.png` is rendered through headless Chrome so the real typeface loads. The script checks that it did.
- The PNGs are committed. Settle the SVG first, then render once.
- GitHub's social card is an upload, not a file it reads: **Settings → General → Social preview**.
