# QBK Eventbrite Webhook Receiver

Tiny public receiver for Eventbrite webhooks. Eventbrite sends a small JSON payload with an `api_url`; this service stores that raw payload and a readable summary.

## Routes

- `POST /eventbrite/webhook/<secret>` receives Eventbrite webhooks.
- `GET /eventbrite/events/<secret>` returns readable recent events.
- `GET /eventbrite/raw/<secret>` returns raw saved records.
- `GET /health` returns a simple health check.

## Environment

- `WEBHOOK_SECRET` protects webhook and read routes.
- `EVENTBRITE_OAUTH_TOKEN` is optional. When set, the receiver fetches richer order, attendee, and event details from Eventbrite.
- `DATA_DIR` defaults to `data`.

Render's filesystem is not a permanent database. The receiver also writes readable summaries to the service logs, and the recent-events endpoint is intended for quick inspection after deliveries.
