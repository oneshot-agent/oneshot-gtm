# Webhooks

The dashboard server binds `127.0.0.1` only. Keep unsigned intake endpoints private or protect them at your reverse proxy.

## Trigger webhooks

Two JSON endpoints feed warm product signals through the normal ICP filter and review queue:

- `POST /api/triggers/signup` requires `name`, `email`, and `phone`; optional fields are `signupContext`, `callWindow`, and `linkedinUrl`. Accepted ICP matches enqueue the `concierge` play.
- `POST /api/triggers/cal-no-show` requires `name`, `email`, `company`, `missedAt`, and `rescheduleLink`; optional fields are `phone`, `whatTheyWanted`, and `linkedinUrl`. Accepted ICP matches enqueue `demo-no-show`.

Valid matches return `202`; ICP rejections return `200` with `accepted: false`; malformed JSON or fields return `400`. Signup deliveries deduplicate by lowercase email, while no-shows deduplicate by lowercase `email + missedAt`.

Set `WEBHOOK_SECRET` to authenticate both endpoints. Send `X-Webhook-Signature: t=<unix-seconds>,v1=<hex>` where the hex value is an HMAC-SHA256 of `<timestamp>.<raw JSON body>`. Signed deliveries are accepted for five minutes and may be used only once. When the secret is unset, intake remains unsigned for backwards-compatible local use.

## LinkedIn reply webhook

Public LinkedIn inbox APIs require partner approval, so the server exposes a provider-neutral intake that Expandi, Zapier, Make, n8n, or another automation can map into. Set a random bearer secret in `/setup` or the workspace `.env`:

```bash
LINKEDIN_REPLY_WEBHOOK_SECRET=<random-32+-character-secret>
```

Then send one stable event ID per actual reply. At least one of `linkedinUrl` or `email` is required; when both match different prospects the request is rejected.

```bash
curl -X POST http://127.0.0.1:3030/api/triggers/linkedin-reply \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <secret>' \
  -d '{
    "source": "expandi",
    "eventId": "provider-event-123",
    "occurredAt": "2026-09-01T12:00:00Z",
    "linkedinUrl": "https://www.linkedin.com/in/example-person"
  }'
```

Successful responses include `duplicate`, `prospectId`, `cadencesStopped`, and `inFlightSends`. Retries of the same `source + eventId` succeed without applying the event twice. The endpoint stops OneShot email; the source tool remains responsible for stopping its own LinkedIn automation.

The same thing by hand: on `/cadences`, **Mark LinkedIn reply** records the cross-channel reply and stops every active or paused cadence for that prospect. Connection acceptance alone does nothing, message text is not retained, and an email already handed to a sender cannot be recalled. A LinkedIn reply resets breakup-revive's cold clock just like an email reply; it does not receive fake email-play attribution.
