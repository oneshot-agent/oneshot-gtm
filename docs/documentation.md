# Maintaining the GTM docs

The public guides live in `tormine/oneshot`, under `apps/docs/oneshot-gtm/`.
The GTM README remains a standalone guide; preserve its anchors, especially
`#watching-whats-happening`, which TELEMETRY.md links to.

## Generate the CLI reference

From the GTM checkout, with the docs repo checked out alongside it:

```bash
bun run scripts/generate-cli-reference.ts --output ../one-shot/apps/docs/oneshot-gtm/cli-reference.mdx
bun run scripts/generate-cli-reference.ts --output ../one-shot/apps/docs/oneshot-gtm/cli-reference.mdx --check
```

Adjust the output path to your actual checkout. The generator imports Commander
with parsing disabled, isolates its config in a temporary home, and never runs
command actions. It emits command groups and leaves, positional arguments,
options and inherited options. Check mode reads without rewriting and exits
nonzero if content differs. The provenance comment records the source HEAD;
check mode ignores that SHA so unrelated commits do not cause false drift.
Generate release artifacts from a clean, committed GTM checkout.

The MDX artifact is committed to the docs repo. A normal docs build needs no
GTM checkout. Do not hand-edit the generated reference.

## Cross-repo changes

When changing CLI commands, flags, finders, plays, scoring or other documented
behavior, update the README where relevant and open a linked docs change.
Use the existing `docs-follow-up` issue label in either repo when the external
surface cannot be updated in the same release. Name the source PR and affected
pages so the follow-up has an explicit owner and target.

Avoid hardcoded command/play/finder totals in public prose. Existing README count
tests remain authoritative for README totals; generated CLI content comes from
the same command tree. Descriptive guides still need review when behavior changes.

Before a docs release, run generation check against the chosen GTM revision,
build the docs site, and verify navigation and internal links. Deploy new pages
before shipping README links to their URLs. Telemetry's authoritative spec stays
in TELEMETRY.md; link to it instead of duplicating its field whitelist.
