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
