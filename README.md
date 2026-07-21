# Trigger

Trigger is a local TypeScript automation runtime with three execution models:

- **Webhook Triggers** run short-lived code after a request reaches a public,
  secret webhook URL.
- **Scheduled Triggers** run short-lived code from a cron expression or
  one-time timestamp.
- **Service Triggers** run creator-defined, persistent listeners in managed
  Worker Threads.

Every Trigger sends schema-validated `{ message, data }` outputs to a durable
notification outbox. Deliveries can subscribe to a Trigger and turn each new
Notification into durable jobs for one or more predefined Delivery Services.
The standalone backend includes three Codex Delivery Services. The Electron
desktop host intentionally enables only the cleaner `codex-app-server` adapter.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the Trigger design and
[DELIVERY_ARCHITECTURE.md](./DELIVERY_ARCHITECTURE.md) for the Delivery design.
Agents and developers unfamiliar with the system should read
[`context.md`](./context.md) before operating the API.

## Project structure

```text
apps/
├── desktop/             Electron host and small backend-status UI
└── trigger/
    ├── src/
    │   ├── config/      Runtime configuration
    │   ├── delivery/    Delivery domain, queue, persistence, registry, and API
    │   ├── domain/      Types and validation contracts
    │   ├── http/        Public and private Hono applications
    │   ├── orchestration/ Queue, scheduler, services, and Trigger lifecycle
    │   ├── persistence/ SQLite storage
    │   └── runtime/     Code compilation and Worker Thread execution
    ├── test/            End-to-end tests grouped by Trigger type
    └── scripts/         Build cleanup and Tailscale commands
packages/
└── codex-triggers/      Small `npx` installer for GitHub release builds
```

## Requirements

- Node.js 24 or newer
- pnpm
- Tailscale, if public webhooks are needed

## Run

```sh
pnpm install
pnpm dev
```

Trigger starts two separate listeners:

- Private control API: `http://127.0.0.1:47831`
- Public webhook gateway: `http://127.0.0.1:47832`

Set `TRIGGER_ADMIN_TOKEN` to require a bearer token on every `/v1/*` control
route. Configuration variables are listed in [`.env.example`](./.env.example).
Webhook request bodies are limited to 10 MB by default and can be adjusted with
`TRIGGER_MAX_WEBHOOK_BYTES`.

Production commands:

```sh
pnpm build
pnpm start
```

## Run the desktop app

```sh
pnpm install
pnpm desktop
```

`Trigger Desktop` is an Electron app that embeds the same Trigger backend in
its main process. While the app is running, other local processes can use the
normal listeners:

- Control API: `http://127.0.0.1:47831`
- Webhook gateway: `http://127.0.0.1:47832`

The desktop window shows both addresses and the active data directory. On
macOS, closing the window leaves the application and backend running; quit the
application to stop Trigger. Desktop data defaults to Electron's application
data directory. Set `TRIGGER_DATA_DIR` to use a specific directory instead.

The desktop host registers only `codex-app-server`. The standalone host started
with `pnpm dev` or `pnpm start` continues to register all three current Codex
adapters. API formats are shared. Trigger Desktop always keeps its control API
unauthenticated on loopback and ignores `TRIGGER_ADMIN_TOKEN`; the standalone
host retains the optional token setting.

## Install the desktop beta

Initial macOS builds can be installed or updated without cloning this repo:

```sh
npx codex-triggers@latest
```

The installer downloads the release matching the Mac's processor, verifies its
SHA-256 checksum, installs it to `~/Applications/Codex Triggers.app`, applies a
local ad-hoc signature, and launches it. Existing Trigger data lives outside
the application bundle and is preserved during updates. On first launch, click
**Let's Start** to verify that Codex app-server is available and install or
update the bundled Codex Trigger skill.

To build the release archive for the current Mac locally:

```sh
pnpm desktop:package
```

Artifacts are written to `apps/desktop/release/`. A `v*` Git tag runs the
release workflow for Apple Silicon and Intel Macs and attaches both archives
and checksum files to the matching GitHub Release. Publishing the npm installer
requires the repository's `NPM_TOKEN` secret.

## Expose webhooks with Tailscale

With Trigger running:

```sh
pnpm funnel
pnpm funnel:status
```

This exposes only the dedicated webhook listener on `TRIGGER_PUBLIC_PORT`. The
control API remains on its separate loopback port. Trigger uses the scoped
`/codex-triggers` Funnel path so other Funnel routes on the device are left
alone. Remove only this route with:

```sh
pnpm funnel:reset
```

Set `TRIGGER_PUBLIC_URL` to the Funnel HTTPS origin so creation responses return
the externally usable webhook URL when managing Funnel outside Trigger.

Trigger Desktop can manage this route from **Settings → Tailscale tunnel for
webhooks**. Agents can discover the current public base URL through:

```text
GET /v1/public-webhook-url
```

It returns `{ "publicWebhookUrl": string | null, "error": string | null }`.
When no public URL is available, `publicWebhookUrl` is `null` and `error`
explains whether the tunnel has not been started or Tailscale is unavailable.
Tunnel state can also be read and changed through `GET` and `PUT
/v1/settings/webhook-tunnel`; the PUT body is `{ "enabled": boolean }`.

## Create a Webhook Trigger

```sh
curl -X POST http://127.0.0.1:47831/v1/triggers \
  -H 'content-type: application/json' \
  -d '{
    "name": "Issue webhook",
    "kind": "webhook",
    "code": "export default async function run(request, ctx) { const body = await request.json(); await ctx.notify({ message: `Issue: ${body.title}`, data: body }); }",
    "outputSchema": { "type": "object" }
  }'
```

The response contains `webhookUrl` and the only copy of its token. Calls to the
URL are persisted and return `202` before Trigger code finishes.

## Create a Scheduled Trigger

```sh
curl -X POST http://127.0.0.1:47831/v1/triggers \
  -H 'content-type: application/json' \
  -d '{
    "name": "Morning check",
    "kind": "schedule",
    "schedule": {
      "kind": "cron",
      "expression": "0 9 * * *",
      "timezone": "Asia/Kolkata"
    },
    "code": "export default async function run(event, ctx) { const response = await fetch(`https://example.com/status`); await ctx.notify({ message: `Morning check`, data: { scheduledFor: event.scheduledFor, status: response.status } }); }",
    "outputSchema": { "type": "object" }
  }'
```

For a one-time schedule, use `"kind": "once"` and an ISO-8601 timestamp as the
expression.

## Create a Service Trigger

```sh
curl -X POST http://127.0.0.1:47831/v1/triggers \
  -H 'content-type: application/json' \
  -d '{
    "name": "Desktop watcher",
    "kind": "service",
    "code": "import { watch } from `node:fs/promises`; export default { async start(ctx) { for await (const event of watch(`/Users/me/Desktop`, { signal: ctx.signal })) { await ctx.notify({ message: `Desktop changed`, data: event }); } } }",
    "outputSchema": { "type": "object" }
  }'
```

The host starts, stops, restores, and restarts the Worker Thread. Service code
is trusted local code with ordinary filesystem and network access. Creating
child processes, clusters, or additional Worker Threads from Trigger code is
unsupported.

Manage its lifecycle with:

```text
POST /v1/triggers/:id/start
POST /v1/triggers/:id/stop
```

## Trigger context

Trigger code receives a context containing:

```ts
ctx.triggerId
ctx.executionId
ctx.signal
ctx.untilStopped()
ctx.notify({ message, data })
ctx.secrets.get(name)
ctx.log.debug(...values)
ctx.log.info(...values)
ctx.log.warn(...values)
ctx.log.error(...values)
```

Webhook and Scheduled handlers may also return one `{ message, data }` object as
shorthand for `ctx.notify()`.

Configure secrets without returning their values from read APIs:

```text
GET    /v1/triggers/:id/secrets
PUT    /v1/triggers/:id/secrets/:name   { "value": "..." }
DELETE /v1/triggers/:id/secrets/:name
```

Secret names use uppercase environment-style names such as `GITHUB_TOKEN`.

## Delivery

The Delivery core runs inside the same host process. It does not open another
port. A Delivery follows exactly one Trigger and contains one or more configured
Delivery Services. When that Trigger records a Notification, SQLite creates one
queued Delivery Job per configured service in the same transaction.

Agents should normally create a Trigger and its Delivery together:

```text
POST /v1/trigger-systems
```

The request contains the ordinary Trigger body under `trigger` and a Delivery
body without `triggerId` under `delivery`. Trigger validates both halves first,
wires the Delivery before enabling the Trigger, and removes the entire new
system if creation fails. Separate `/v1/triggers` and `/v1/deliveries` routes
remain available for management and advanced workflows.

```json
{
  "trigger": {
    "name": "New pull request",
    "kind": "webhook",
    "code": "export default async function run(request) { const body = await request.json(); return { message: `PR: ${body.title}`, data: body } }",
    "outputSchema": { "type": "object" }
  },
  "delivery": {
    "name": "Send pull requests to Codex",
    "services": [
      {
        "type": "codex-app-server",
        "config": {
          "projectPath": "/Users/me/project",
          "newThread": true,
          "model": "luna",
          "reasoningEffort": "medium",
          "threadMode": "persistent"
        },
        "input": { "prompt": "{{message}}" }
      }
    ]
  }
}
```

Discover the adapters registered by the host:

```text
GET /v1/delivery-services
```

The standalone registry contains `codex-cli`, `codex-app-server`, and
`codex-app`; the Electron desktop registry contains only `codex-app-server`.
Always use the discovery endpoint instead of assuming which adapters a host
enabled. All adapters reuse the device's existing Codex authentication. The CLI
adapter uses the official Codex TypeScript SDK, the app-server adapter uses
Codex's JSONL protocol without opening the Codex app, and the App adapter
submits through the real Electron composer.

Configured service input may recursively reference Notification values:

```json
{
  "prompt": "Handle {{data.id}}: {{message}}",
  "attachments": "{{data.attachments}}"
}
```

An exact expression such as `{{data.attachments}}` preserves its JSON type.
Missing values fail only that service's Delivery Job. See
[DELIVERY_ARCHITECTURE.md](./DELIVERY_ARCHITECTURE.md) for the full contract.

Create a Codex CLI Delivery:

```json
{
  "name": "Handle new pull requests",
  "triggerId": "trigger-uuid",
  "enabled": true,
  "services": [
    {
      "type": "codex-cli",
      "config": {
        "projectPath": "/Users/me/projects/example",
        "newThread": true,
        "model": "luna",
        "reasoningEffort": "medium"
      },
      "input": {
        "prompt": "Review {{data.title}}.\n\n{{data.description}}",
        "images": "{{data.images}}"
      }
    }
  ]
}
```

`projectPath` may be an empty string for work without a project; those runs use
`data/trigger/codex-workspace`. `sandboxMode` is optional and defaults to
`danger-full-access`. `timeoutMs` is optional and has no default timeout.

When `newThread` is `false`, `threadId` may identify an existing Codex thread.
If it is omitted, the first Delivery creates a thread and stores its ID back in
the configured service. Later Notifications resume that thread. The Delivery
Job waits for Codex to finish but intentionally stores no final response or
usage result.

Create a Codex app-server Delivery:

```json
{
  "name": "Dispatch pull requests in the background",
  "triggerId": "trigger-uuid",
  "enabled": true,
  "services": [
    {
      "type": "codex-app-server",
      "config": {
        "projectPath": "/Users/me/projects/example",
        "newThread": false,
        "model": "luna",
        "reasoningEffort": "medium",
        "threadMode": "persistent"
      },
      "input": {
        "prompt": "Review {{data.title}}.\n\n{{data.description}}",
        "images": "{{data.images}}"
      }
    }
  ]
}
```

`threadMode: "persistent"` writes a normal Codex session and allows reusable
threads across Trigger restarts. Such tasks are eligible for the Codex desktop
sidebar, but an already-open app may need to reload its sidebar.
`threadMode: "ephemeral"` writes no session and never appears in the sidebar;
it requires `newThread: true`. The job remains running until Codex emits the
matching `turn/completed` event. Completed turns succeed; failed or interrupted
turns fail the job. `images` accepts local paths and HTTP or HTTPS image URLs.

Create a Codex App Delivery:

```json
{
  "name": "Handle new pull requests in Codex App",
  "triggerId": "trigger-uuid",
  "enabled": true,
  "services": [
    {
      "type": "codex-app",
      "config": {
        "projectPath": "/Users/me/projects/example",
        "newThread": false,
        "model": "luna",
        "reasoningEffort": "medium"
      },
      "input": {
        "prompt": "Review {{data.title}}.\n\n{{data.description}}",
        "attachments": "{{data.attachments}}"
      }
    }
  ]
}
```

For `codex-app`, an empty `projectPath` means a projectless task. Non-empty
projects must already be present in Codex. `attachments` is an optional array
of absolute local file or folder paths. With `newThread: false`, the first task
ID is persisted and later Notifications continue that task. The job succeeds
after the message is submitted and the task ID is captured; it does not wait
for Codex to finish.

The App adapter owns one dedicated Codex window shared by all App deliveries
and serializes access to it. The window is invisible and non-focusable. Trigger
starts Codex normally when needed, preserves the macOS app that was frontmost
while creating its worker, and never force-quits Codex. No special app launcher
is required. Configure the app path with `TRIGGER_CODEX_APP_PATH` in
[`.env.example`](./.env.example).

## Control API

```text
GET    /health
GET    /v1/triggers
POST   /v1/triggers
GET    /v1/triggers/:id
PATCH  /v1/triggers/:id
DELETE /v1/triggers/:id
GET    /v1/triggers/:id/revisions
POST   /v1/triggers/:id/revisions/:revisionId/activate
POST   /v1/triggers/:id/run
POST   /v1/triggers/:id/start
POST   /v1/triggers/:id/stop
POST   /v1/triggers/:id/rotate-webhook
GET    /v1/executions
GET    /v1/executions/:id
GET    /v1/notifications
GET    /v1/delivery-services
GET    /v1/deliveries
POST   /v1/deliveries
GET    /v1/deliveries/:id
PATCH  /v1/deliveries/:id
DELETE /v1/deliveries/:id
GET    /v1/delivery-jobs
GET    /v1/delivery-jobs/:id
```

Changing code or its output schema creates an immutable revision. Queued
executions retain the revision they were created with.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm test:codex-live
pnpm build
```

The end-to-end suite covers real HTTP listeners, webhook authentication,
scheduled dispatch, output validation, immutable revisions, secret injection,
Service supervision, Delivery planning and templating, independent Delivery Job
failures, and restart behavior.
