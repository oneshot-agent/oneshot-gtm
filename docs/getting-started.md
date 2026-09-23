# Your first GTM workspace

You can use the dashboard without writing code. Install [Bun](https://bun.sh), then run `bunx oneshot-gtm-server` in a terminal and open the local address it prints. For the CLI or source development, follow the [repository setup](../README.md#setup).

## Describe your business

A new workspace opens **Onboarding** from Today. Complete three short steps:

1. **Your business:** founder name, website, and one sentence describing what you sell and its benefit. Enter a bare domain or HTTP(S) URL; only the hostname is saved. Onboarding does not scrape the site.
2. **Your customer:** buyer role, business type, and problem, plus geography when relevant. This saves your ideal customer profile (ICP). For example, a bookkeeping firm might target owners of independent restaurants in its city.
3. **Connect AI:** choose a provider and add its API key. Existing credentials, including environment keys, are recognized. Keep the default model or enter a custom model under Advanced. **Save and test connection** makes one small provider request, which may incur a charge.

Each completed step is saved. **Finish later** returns to Today and stops automatic reopening; the reminder and **Setup** page let you resume at the first incomplete step. Unsaved edits prompt before leaving. Existing configured workspaces receive a reminder instead of a redirect; the read-only demo stays browsable.

When you see **Ready to plan**, choose **Plan my first motion** to open the strategist. No wallet or sending account is required to plan. Changing the provider, model, or effective key requires a new connection test. Readiness is based on your current saved business context and verified connection.

Personal email, product brief, voice, social proof, calendar, and other integrations remain optional in **Setup**. Research, some drafting paths, and sending need additional setup; OneShot research and delivery may require a wallet and incur charges. Completing onboarding does not enable finders, run research, or send messages. The CLI setup flow is unchanged.

## Choose a source and a motion

New workspaces start with all finders off. In **Queue**, choose an industry pack or configure a relevant source. Packs configure and enable their sources, but do not overwrite your ICP or invent your useful observation (`yourEdge`). Review the proposed ICP, fill required fields, and check geography and spending limits before running. Existing workspaces keep their saved source settings.

| Who you want to reach             | A starting path                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Local business owners             | A relevant industry pack, `local-business`, or supported `local-registry` sources        |
| Business decision-makers          | Add Prospect, your own imported list, or relevant hiring/job-change signals              |
| Developers or startup founders    | Show HN, GitHub or funding signals, when those sources match your ICP                    |
| Public-sector buyers              | Government solicitations or civic agendas, where the supported sources cover your market |
| Buyers outside the supplied packs | Add Prospect or bring your own list; configure sources around your ICP                   |

Pick the motion for what you need to learn or offer. `discovery-interview` asks a business owner about how they work; `free-pilot` offers a real setup or trial; `profile-intro` starts from a person you selected; institutional plays fit longer evaluation processes. Review each play's requirements before choosing it. The [play overview](../README.md#the-plays) and [sample target files](../examples/) show the available shapes.

Packs describe the customers you sell to, not necessarily your own industry. Many registry sources are U.S.-specific. A pack is a starting configuration, not a promise of complete coverage. The current product focuses on business outreach and customer discovery; it is not a consumer ads manager or retail storefront.

## Review your first draft

Start with a few prospects. Check the person, why they fit and the evidence behind the opener. Draft and read it before sending. Correct assumptions and adjust your voice or useful observation, then regenerate. Check the sender and follow-up cadence; approving a queue row makes it eligible for a later drain, while Drain sends approved rows.

Watch replies and record outcomes before expanding volume. [Sending](./sending.md) explains identity limits and reply handling. [Finders](./finders.md) explains qualification, research and costs.

## Keep each business separate

One workspace holds one business's profile, voice, ICP, ledger and sender pool. Use the workspace switcher or the [workspace commands](./workspaces.md) for another business. Create a fresh workspace instead of copying someone else's configuration or ledger.

Your working data belongs in the workspace home, outside this checkout. The public repository contains application code and fictional examples. See [repository boundaries](./repository-boundaries.md) before sharing files or contributing.
