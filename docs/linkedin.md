# LinkedIn

OneShot operates LinkedIn account connections, message synchronization, and authorized actions. GTM owns prospect matching, research, reply drafts, and cadence decisions. Users connect their human LinkedIn account through OneShot; OneShot handles the upstream connection.

## Account connection and messages

The OneShot SDK provides `linkedinConnect`, `getLinkedInConnection`, account listing/status, reconnect, and revoke. The human opens the returned hosted login link and completes verification. OneShot verifies the connection and binds it to the calling agent. Request only the actions needed, such as `read` and `reply`.

`linkedinSync` ingests history in bounded, resumable runs. `linkedinConversations` and `linkedinMessages` read the synchronized data. Check `coverage` and `sync_state`: exhausting a cursor does not establish that the provider has finished importing history. OneShot handles provider notifications and reconciliation internally.

`linkedinReply` sends into an existing conversation with the account's grant and an idempotency key. The platform also exposes profile views and post reactions. Invitations and new conversations are not supported by the current LinkedIn API; do not assume full cadence-action parity with older outreach tools.

See the [OneShot LinkedIn API documentation](https://docs.oneshotagent.com/api-reference/linkedin/overview) for the current contract and supported actions.

## Using LinkedIn in GTM

Connect the messaging account from Replies. GTM reads conversations and messages through OneShot, supports reconnect and history sync, and sends reviewed replies through the connected account. The server refreshes messages in the background and when the Replies view loads.

Conversations are matched to prospects and assigned to a workspace. Human replies are recorded through GTM's reply handling and stop active or paused cadences for the prospect. Automatic responses remain separate from human replies.

**No LinkedIn webhook setup is required in GTM.** The local app reads from OneShot without exposing a public callback.

The LinkedIn browser connection on `/setup` is for [live profile research](./finders.md), separate from the messaging account. You can also record a reply manually from the queue or cadences view, optionally including its text.

## Reply preferences

Replies learns writing preferences across LinkedIn conversations in the same workspace. New suggestions and Improve use the active preferences alongside your configured founder voice, conversation instructions, prospect angle, and product brief. Current instructions and founder voice take priority; learned preferences never establish product facts or promises. Existing drafts stay intact when learning changes.

Learning uses confirmed sends, not keystrokes or unused suggestions. Explicit general feedback on an accepted improvement can establish a preference after sending. Inferred editing patterns need three distinct conversations; historical or unchanged style examples need five. Feedback that applies only to one conversation stays local. The first background pass imports up to 100 recent app-confirmed sends with reliable workspace attribution. Synchronized outbound messages alone are not treated as reviewed examples, and missing originals are not reconstructed.

Open **Reply preferences · LinkedIn** on Replies to inspect the guidance and its supporting replies, disable a preference, or pause learning. Pausing stops synthesis and use of learned guidance; evidence and settings remain saved. Disabled guidance remains excluded from future synthesis until re-enabled. Email and other workspaces are separate.

The background scheduler refreshes pending evidence at most once every five minutes, subject to the daily spend limit. Failed refreshes retry and retain the last good preferences. Prospect responses and business outcomes continue feeding prospect angles; this feature learns your writing preferences, not which wording caused an outcome.

## Historical backfill and identity matching

**Import history** captures all saved conversation and message pages, resolves distinct inbound sender IDs through silent (`notify: false`) OneShot profile lookups, then replays confirmed human replies across all local workspaces. Names only prioritize possible active-cadence matches; names never establish identity. Verified provider-ID/public-profile mappings are stored in the private shared LinkedIn database and reused across workspaces.

Any historical human reply stops that person's active or paused cadences, even when it predates enrollment or conversation ownership is ambiguous. Replay also discards pending drafts and expires re-engagement queue entries. Repeating the backfill does not duplicate reply events. Manual ownership and previously recorded reply history remain intact. Sender resolution does not fill missing attendees or unlock automatic group-conversation reply generation.

First-time connections request `read`, `reply`, and `view_profile` together. Older connections can attempt **Allow profile access** using a new hosted intent because reconnect cannot widen permissions. The current OneShot service rejects that intent for an already connected member (`duplicate_member`); the dashboard records this failure and prevents repeated login attempts. OneShot currently requires revoking and connecting again to widen the grant. Replacement disconnects the upstream connection and cancels pending sends, so GTM does not revoke automatically. Local history and assignments stay intact. A backfill remains paused until a supported grant upgrade or an explicitly authorized replacement is completed.

The shared job saves pagination progress, accepted request IDs, idempotency keys, failures, and per-workspace counts. Both servers share a renewable lease. It uses the wallet's existing spending limits without an additional backfill cap. Permission, payment, and budget failures stop the job for review; Resume uses the existing request ID or submission key. Provider history marked requested/running is awaited without buying repeated imports. Incomplete provider coverage remains visible, even after all currently available local pages have been captured.

Replies starts with matched conversations. Filters also show all conversations or distinguish unresolved identity evidence, resolved profiles with no prospect, and ambiguous ownership. Counts report all imported messages, matched human inbound messages, unresolved human inbound messages, resolved human inbound messages without a prospect, and cadences stopped by LinkedIn replay. Shared imported totals are shown for each workspace; matched totals are specific to that workspace. The API accepts `backfill`, `backfill-status`, and `upgrade` actions on `/api/replies/linkedin` with an `accountKey`; the older `sync` action starts the same resumable backfill.

An explicitly authorized connection replacement retains the private local account key and verifies that the completed hosted login belongs to the same LinkedIn member. Reimported conversations and messages merge by provider IDs when those remain stable. If reconnect changes provider IDs too, only unique exact sender-ID, direction, timestamp, text, and attachment-metadata matches across the old and new connections can merge a conversation. Ambiguous or same-connection duplicates are retained. Manual assignments and original review/message IDs remain intact. Old conversations remain visible, but sending is disabled until the replacement account has supplied their current conversation IDs. After Force reconnect, resume the saved history import explicitly once the verified replacement is attached.

Backfill displays sender progress and the provider’s returned daily lookup limit. Once reported headroom is exhausted, it waits until the provider’s reset timestamp and resumes automatically. Accepted requests are still checked by request ID while the daily allowance is exhausted. Permission, payment, and wallet-budget failures continue to stop the job for review.

### Remove or replace a connection without deleting messages

In **Replies → Connections & reply preferences → LinkedIn**, **Remove connection** revokes OneShot access and removes the account from the connection list across workspaces. Imported messages, conversation keys, and workspace/prospect assignments stay saved. The removed connection cannot send or continue importing history, and background refresh cannot restore it.

If normal Reconnect fails, **Force reconnect** disconnects the old provider account and opens a fresh login. Sign into the same LinkedIn member: the replacement is checked before being attached to the existing local history. Both actions require confirmation and cancel pending provider sends. Force reconnect leaves history imports paused until you explicitly resume them.

Force reconnect cannot bypass an unavailable connection service. If disconnection succeeds but opening the new login fails, the account stays visible for retry and all imported messages remain saved.
