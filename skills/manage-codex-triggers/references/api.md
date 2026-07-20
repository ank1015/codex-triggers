# Codex Triggers API

## Contents

- Connection
- Create a complete Trigger system
- Codex app-server Delivery
- Webhook ingress and Tailscale
- Secrets
- Test and inspect
- Update and delete

## Connection

Default control origin:

```text
http://127.0.0.1:47831
```

Health check:

```http
GET /health
```

## Create a complete Trigger system

```http
POST /v1/trigger-systems
Content-Type: application/json
```

Request:

```json
{
  "trigger": {
    "name": "New pull request",
    "kind": "webhook",
    "enabled": true,
    "code": "export default async function run(request) { const body = await request.json(); return { message: `PR opened: ${body.title}`, data: { title: body.title, url: body.html_url } } }",
    "outputSchema": {
      "type": "object",
      "required": ["title", "url"],
      "additionalProperties": false,
      "properties": {
        "title": { "type": "string" },
        "url": { "type": "string" }
      }
    },
    "timeoutMs": 30000
  },
  "delivery": {
    "name": "Handle pull requests in Codex",
    "enabled": true,
    "services": [
      {
        "type": "codex-app-server",
        "config": {
          "projectPath": "/absolute/project/path",
          "newThread": true,
          "model": "luna",
          "reasoningEffort": "medium",
          "threadMode": "persistent"
        },
        "input": {
          "prompt": "Review {{data.title}} at {{data.url}}.\n\n{{message}}"
        }
      }
    ]
  }
}
```

Do not include `delivery.triggerId`; the server wires it to the new Trigger.
Both `enabled` fields default to `true`.

Every item in `delivery.services` must use `"type": "codex-app-server"`.
Codex Triggers delivers every notification through Codex app-server.

The server validates both halves, creates the Trigger disabled, creates the
Delivery, then enables the Trigger. Failure removes the partial system.

Response (`201`):

```json
{
  "trigger": {
    "details": {
      "trigger": { "id": "trigger-uuid", "enabled": true },
      "revision": {},
      "webhook": {},
      "schedule": null,
      "serviceState": null
    },
    "webhookToken": "returned-only-on-creation",
    "webhookUrl": "https://device.ts.net/codex-triggers/hooks/v1/..."
  },
  "delivery": {
    "delivery": {
      "id": "delivery-uuid",
      "triggerId": "trigger-uuid",
      "enabled": true
    },
    "services": []
  }
}
```

Webhook tokens and URLs are secrets. Store or configure the returned URL before
losing the response.

### Trigger fields

```ts
type TriggerInput = {
  name: string
  kind: "webhook" | "schedule" | "service"
  enabled?: boolean
  code: string
  outputSchema?: JSONSchema
  timeoutMs?: number
  schedule?: {
    kind: "cron" | "once"
    expression: string
    timezone: string
  }
}
```

- `schedule` is required only for `schedule` Triggers.
- Cron expressions use the supplied IANA timezone.
- A one-time expression is an ISO-8601 timestamp.
- Webhook and schedule timeout defaults to `30000` and accepts `100..300000`.
- Service timeout must be `0` or omitted.
- `outputSchema` validates notification `data`, not `{ message, data }`.

## Codex app-server Delivery

`codex-app-server` config:

```ts
{
  projectPath: string
  newThread: boolean
  threadId?: string
  model: "luna" | "terra" | "sol"
  reasoningEffort: "low" | "medium" | "high" | "xhigh"
  threadMode: "persistent" | "ephemeral"
}
```

- Use an existing absolute directory for `projectPath`, or `""` for the
  Trigger-managed projectless workspace.
- `newThread: true` creates a new Codex task for each notification.
- `newThread: false` resumes `threadId`. If omitted, the first job creates a
  thread and saves its ID into the Delivery configuration.
- `persistent` writes a normal Codex session and is eligible for the sidebar.
- `ephemeral` is not saved, requires `newThread: true`, and forbids `threadId`.
- A Delivery job remains `running` until Codex emits the matching
  `turn/completed` event. Completed turns succeed; failed or interrupted turns
  fail the job. Trigger stores the persistent thread ID, not the assistant
  response or token usage.

Input:

```ts
{
  prompt: string
  images?: string[]
}
```

Templates may use `{{message}}` and `{{data.path.to.value}}` recursively. An
entire-string expression preserves the JSON type. Missing template values fail
that Delivery job. Add `images` only when the Trigger always emits it; local
paths and HTTP(S) image URLs are accepted.

## Webhook ingress and Tailscale

Discover the current public base URL:

```http
GET /v1/public-webhook-url
```

Available:

```json
{
  "publicWebhookUrl": "https://device.ts.net/codex-triggers",
  "error": null
}
```

Unavailable:

```json
{
  "publicWebhookUrl": null,
  "error": "Tailscale webhook tunnel has not been started"
}
```

Read or change the managed Funnel only with user approval:

```http
GET /v1/settings/webhook-tunnel
PUT /v1/settings/webhook-tunnel
Content-Type: application/json

{ "enabled": true }
```

The managed Funnel occupies `/codex-triggers` and does not reset unrelated
Tailscale routes. If Tailscale itself is stopped, the response includes the
underlying error.

## Secrets

Never put credentials in `code`, `config`, or `input`.

```http
PUT /v1/triggers/:triggerId/secrets/:NAME
Content-Type: application/json

{ "value": "secret-value" }
```

Secret names must match uppercase environment-style names such as
`GITHUB_TOKEN`. Trigger code reads them with `ctx.secrets.get("GITHUB_TOKEN")`.

List names without values:

```http
GET /v1/triggers/:triggerId/secrets
```

Delete:

```http
DELETE /v1/triggers/:triggerId/secrets/:NAME
```

## Test and inspect

Manually run a webhook or schedule Trigger:

```http
POST /v1/triggers/:triggerId/run
Content-Type: application/json

{ "payload": { "sample": true } }
```

For webhook handlers, the payload becomes the synthetic request JSON body.

Inspect:

```text
GET /v1/executions?triggerId=:triggerId
GET /v1/executions/:executionId
GET /v1/notifications?triggerId=:triggerId
GET /v1/delivery-jobs?deliveryId=:deliveryId
GET /v1/delivery-jobs?status=failed
GET /v1/delivery-jobs/:jobId
```

Service Triggers use lifecycle endpoints instead of `/run`:

```text
POST /v1/triggers/:triggerId/start
POST /v1/triggers/:triggerId/stop
```

## Update and delete

```text
GET    /v1/triggers/:id
PATCH  /v1/triggers/:id
DELETE /v1/triggers/:id
POST   /v1/triggers/:id/rotate-webhook

GET    /v1/deliveries/:id
PATCH  /v1/deliveries/:id
DELETE /v1/deliveries/:id
```

Trigger kind and Delivery `triggerId` cannot be changed. A Trigger code change
creates a new immutable revision. Rotating a webhook invalidates the old URL.
Deleting the Trigger cascades to its Delivery and historical jobs.
