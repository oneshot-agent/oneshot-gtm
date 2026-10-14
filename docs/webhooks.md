# Webhooks

Two events enter from outside: a signup and a missed demo. Both go through the ICP gate and land in the queue like any other row.

| Endpoint                         | Required                                                 | Optional                                     | Queues         |
| -------------------------------- | -------------------------------------------------------- | -------------------------------------------- | -------------- |
| `POST /api/triggers/signup`      | `name`, `email`, `phone`                                 | `signupContext`, `callWindow`, `linkedinUrl` | `concierge`    |
| `POST /api/triggers/cal-no-show` | `name`, `email`, `company`, `missedAt`, `rescheduleLink` | `phone`, `whatTheyWanted`, `linkedinUrl`     | `demo-no-show` |

A match returns `202`. An ICP rejection returns `200` with `accepted: false`. Bad JSON or fields return `400`. Signups dedupe by email; no-shows by email and `missedAt`.

## Signing

Set `WEBHOOK_SECRET` and both endpoints require a signature:

```
X-Webhook-Signature: t=<unix-seconds>,v1=<hex>
```

The hex is an HMAC-SHA256 of `<timestamp>.<raw JSON body>`. A signed delivery is accepted for five minutes and only once.

Without the secret the endpoints accept unsigned posts. The server binds `127.0.0.1` only. If you put it behind a proxy, set the secret first.
