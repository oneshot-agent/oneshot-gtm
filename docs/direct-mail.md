# Direct mail

Physical letters as an optional, individually approved step in a cadence. Bulk actions never send mailpieces; every letter needs its own proof review and approval.

## Which prospects get a mail step

**Plays → Direct mail** chooses suitable prospects automatically for selected motions. Choose **Automatic**, **Always include**, or **Off** per play, and edit the mail step's position and delay.

| Motion                                         | Automatic selection                                                     | Default placement                            |
| ---------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| New business, free pilot                       | Named prospect, company, and complete U.S. business address             | Step 2, three days after the first email     |
| Design-partner LOI                             | Same address requirements; enterprise or hardware buyer                 | Step 2, three days after the first email     |
| Post-funding, hiring-signal, competitor-switch | Same address requirements; confirmed ICP match and decision-maker title | Step 3, three days after the first follow-up |
| Other motions                                  | Off by default; founder can choose Always include                       | Founder-selected                             |

These are explainable starting rules, not predictions of conversion or account value. Sources labeled as registered-agent, registered-office or residential addresses are excluded from automatic selection. An address still needs review: complete postal fields do not establish that a person works there. Research can add mail to an eligible active cadence when its insertion point is still ahead; completed touches and existing mailpieces retain their plans. Explicit Off overrides survive future default changes.

## Addresses

Save your return address once under **Setup → Founder → Direct mail return address**. Business addresses are collected from prospect inputs, CSV/registry data, and company research for mail-enabled motions. Missing addresses hold the mail step until you correct them or explicitly skip mail.

## Reviewing and sending

On **Cadences**, click a prospect's **Review mail** button. Both saved addresses are filled automatically. Generate or edit a personalized letter, or upload a PDF/JPEG for that prospect, review the print proof and price, then **Approve and send**. Replacing content or changing an address requires a fresh proof. The dashboard sends U.S. letters; existing postcard orders and the artwork CLI remain supported. Mail history provides postal status, recovery, and cancellation.

An accepted order advances the cadence once. Its next follow-up allows at least eight business days for printing and transit, plus two calendar days to read; longer configured delays remain in force. This is an estimate, not a delivery guarantee. Skipping mail keeps the normal next-touch delay. Postal delivery does not prove readership.

## CLI

```
direct-mail list · upload · preview · refresh · approve · send · cancel
```
