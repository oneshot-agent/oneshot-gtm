# Your first GTM workspace

You can use the dashboard without writing code. Install [Bun](https://bun.sh), then run `bunx oneshot-gtm-server` in a terminal and open the local address it prints. For the CLI or source development, follow the [repository setup](../README.md#setup).

## Describe your business

Open **Setup** and fill in your name, what you sell, and your ideal customer profile (ICP). A product can be a service, a physical product or software. Describe the buyer's role, business type, location and relevant problem. Avoid “everyone” as an ICP; start with one group you can learn from.

For example, a bookkeeping firm might target owners of independent restaurants in its city. An equipment supplier might target operations managers at regional manufacturers. Neither needs to call its buyers technical founders.

Add your product brief and optional voice card. Your card controls how you sound; claims still need evidence. Credentials, partners and admissions are optional. Leave missing facts blank. Add the LLM credentials and sending identity needed for the actions you choose; Setup and `doctor` show what is missing. Research and delivery through OneShot require its configured wallet and may incur charges.

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
