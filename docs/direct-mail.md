# Direct mail

A letter cannot be unsent, so each one is approved by hand. It is an optional step in a cadence, and no bulk action sends mail.

## Who gets a letter

**Plays → Direct mail** sets it per play: **Automatic**, **Always include** or **Off**, plus the step's position and delay.

| Play                                           | Automatic picks                                                 | Default position                       |
| ---------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| New business, free pilot                       | a named person, a company, a complete U.S. business address     | step 2, three days after the email     |
| Design-partner LOI                             | the same, for an enterprise or hardware buyer                   | step 2, three days after the email     |
| Post-funding, hiring-signal, competitor-switch | the same, with a confirmed ICP match and a decision-maker title | step 3, three days after the follow-up |
| Every other play                               | off; you can choose Always include                              | where you put it                       |

These are starting rules, not predictions. Registered-agent, registered-office and residential addresses are never picked. A complete address still needs your eye: it does not prove the person works there.

## Addresses

Save your return address once under **Setup → Founder → Direct mail return address**. Business addresses come from prospect inputs, registry data and company research. A missing address holds the mail step until you fix it or skip the letter.

## Reviewing and sending

On **Cadences**, press **Review mail** on the prospect. Write or generate the letter, or upload a PDF or JPEG. Check the print proof and the price, then **Approve and send**. Changing the content or an address needs a fresh proof. Letters go to U.S. addresses.

An accepted order advances the cadence once. The next follow-up waits at least eight business days for print and transit, plus two days to read. That is an estimate. Delivery does not prove anyone read it.

**Skip mail** on the row, in its sheet or in the review drops the letter. It is recorded as skipped and never counts as a send.

## CLI

```
direct-mail list · upload · preview · refresh · approve · send · cancel · skip
```
