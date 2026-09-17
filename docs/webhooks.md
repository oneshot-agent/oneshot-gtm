# Webhooks

The dashboard server binds `127.0.0.1` only. Keep unsigned intake endpoints private or protect them at your reverse proxy.

## Trigger webhooks

Two JSON endpoints feed warm product signals through the normal ICP filter and review queue:

- `POST /api/triggers/signup` requires `name`, `email`, and `phone`; optional fields are `signupContext`, `callWindow`, and `linkedinUrl`. Accepted ICP matches enqueue the `concierge` play.
- `POST /api/triggers/cal-no-show` requires `name`, `email`, `company`, `missedAt`, and `rescheduleLink`; optional fields are `phone`, `whatTheyWanted`, and `linkedinUrl`. Accepted ICP matches enqueue `demo-no-show`.

Valid matches return `202`; ICP rejections return `200` with `accepted: false`; malformed JSON or fields return `400`. Signup deliveries deduplicate by lowercase email, while no-shows deduplicate by lowercase `email + missedAt`.

Set `WEBHOOK_SECRET` to authenticate both endpoints. Send `X-Webhook-Signature: t=<unix-seconds>,v1=<hex>` where the hex value is an HMAC-SHA256 of `<timestamp>.<raw JSON body>`. Signed deliveries are accepted for five minutes and may be used only once. When the secret is unset, intake remains unsigned for backwards-compatible local use.
