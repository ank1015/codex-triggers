# Trigger Architecture

## Overview

Trigger is a local automation runtime for hosting small TypeScript programs on
one device. A program runs because it receives a public webhook, reaches a
scheduled time, or needs to remain alive and listen for something continuously.

Every Trigger ultimately produces a validated output for the notification
system. The notification destinations will be designed separately.

Trigger provides three execution models:

1. **Webhook Trigger** — short-lived code invoked by an external webhook.
2. **Scheduled Trigger** — short-lived code invoked at a configured time.
3. **Service Trigger** — persistent, creator-defined code that can listen for
   anything.

Webhook and Scheduled Triggers should be preferred when they fit. A Service
Trigger is the general fallback for behavior that requires a continuously
running listener or persistent in-memory state.

## High-level architecture

```text
                            Tailscale Funnel
                                  |
                                  v
External systems ---> Public webhook gateway
                                  |
                                  v
                             Execution queue <--- Scheduler
                                  |
                                  v
                       Short-lived job runtime
                                  |
                                  +-------------------+
                                                      |
Control API ---> Service Trigger manager              |
                       |                              |
                       v                              v
              Managed Worker Threads ----------> Validated outputs
                                                      |
                                                      v
                                             Notification system
```

The webhook gateway, scheduler, control API, execution queue, Service Trigger
manager, and notification system belong to the Trigger host. Creators provide
only their Trigger code and configuration.

## Webhook Triggers

A Webhook Trigger is invoked through the shared public webhook gateway. An
individual Trigger does not bind its own public port.

The public route has an opaque, rotatable secret, for example:

```text
ANY /hooks/v1/:endpointId/:secret
```

Only the public webhook gateway is exposed through Tailscale Funnel. The
control API, scheduler, execution history, secrets, and Service Triggers are
not exposed publicly.

A request is authenticated and bounded by the gateway, persisted as an
execution, and dispatched to short-lived Trigger code. The default public
response should be an immediate success response so that arbitrary Trigger
work does not hold the webhook connection open. Provider-specific synchronous
responses can be added later if a concrete integration requires them.

Example:

```ts
export default async function run(request, ctx) {
  const event = await request.json();

  const result = {
    message: `Received ${event.type}`,
    data: event,
  };

  await ctx.notify(result);
}
```

## Scheduled Triggers

A Scheduled Trigger uses the same short-lived execution runtime as a Webhook
Trigger. The difference is only how the execution begins.

Schedules may eventually include:

- Cron expressions
- One-time timestamps
- An explicit timezone
- A missed-run policy such as `skip`, `latest`, or `all`

Scheduled code may perform arbitrary work such as API calls, formatting, secret
access, and notification production.

Example:

```ts
export default async function run(event, ctx) {
  const response = await fetch("https://api.example.com/status");
  const status = await response.json();

  await ctx.notify({
    message: `Daily status: ${status.summary}`,
    data: {
      scheduledFor: event.scheduledFor,
      status,
    },
  });
}
```

## Service Triggers

A Service Trigger is a general, persistent program. It is appropriate whenever
code must remain alive to listen for events or maintain state.

Possible uses include:

- Filesystem watchers
- macOS idle, sleep, wake, or application events
- Local sockets or listening servers
- WebSockets
- Database subscriptions
- Message queues
- Clipboard listeners
- Hardware events
- Custom event emitters
- Any other long-running listener written by the creator

Trigger does not need to provide a predefined collector or permission model for
every possible event. The creator implements the listener with normal code and
the machine access of the user running Trigger.

Example:

```ts
import { watch } from "node:fs/promises";

export default {
  async start(ctx) {
    const events = watch("/Users/me/Desktop", {
      signal: ctx.signal,
    });

    for await (const event of events) {
      await ctx.notify({
        message: `Desktop changed: ${event.filename}`,
        data: event,
      });
    }
  },
};
```

### Lifecycle

Creators do not start or manage child processes. The Trigger host owns the
Service Trigger lifecycle:

1. Start the Trigger when it is enabled.
2. Provide an abort signal for graceful shutdown.
3. Stop it when disabled, updated, or when the host shuts down.
4. Restart it after a crash using bounded backoff.
5. Capture logs, health, and restart history.
6. Force termination if graceful cleanup does not finish in time.

Each Service Trigger runs in a host-managed Node.js Worker Thread. This keeps a
single OS process while preventing a blocking listener or uncaught exception
from directly taking down the webhook gateway and scheduler. Worker Threads are
an operational isolation boundary, not a security sandbox.

Starting child processes, clusters, or additional Worker Threads from Trigger
code is unsupported. Static validation can reject the relevant imports as a
guardrail, but Service Trigger code is considered trusted local code rather
than hostile code.

## Trigger output and notification

All Trigger types communicate with the notification system through
`ctx.notify()`:

```ts
await ctx.notify({
  message: "Required human-readable message",
  data: {
    // Trigger-specific structured output
  },
});
```

The platform-level output envelope always requires `message`. Each Trigger may
define a JSON Schema for its `data` value. Every call to `ctx.notify()` is
validated against the active Trigger revision before it is delivered.

Using `ctx.notify()` supports both execution lifecycles:

- A short-lived Webhook or Scheduled Trigger usually emits once.
- A persistent Service Trigger may emit zero, one, or many notifications over
  its lifetime.

The notification system receives validated outputs through a durable outbox.
For now, a recording notifier can persist them without sending them anywhere.

## Shared host responsibilities

The Trigger host provides:

- Public webhook routing
- Tailscale Funnel integration
- Private control API
- Schedule calculation and dispatch
- Durable short-lived execution queue
- Service Trigger supervision
- Trigger code and configuration revisions
- Output-schema validation
- Secrets and configuration storage
- Structured logs and execution history
- Notification outbox and delivery adapters
- Graceful startup, shutdown, and recovery

## Persistence

SQLite is the source of truth for this single-device system. The initial domain
will need records for:

- Triggers
- Immutable Trigger revisions
- Webhook endpoints
- Schedules
- Short-lived executions
- Service Trigger state and restart history
- Logs
- Validated outputs
- Notification delivery attempts

Short-lived executions move through durable states such as:

```text
received -> queued -> running -> succeeded
                            -> failed
                            -> timed_out
                            -> interrupted
```

Scheduled occurrences need stable identities so restarts cannot accidentally
create duplicate runs. Service Triggers need persisted desired state so the
host knows which services to restore after startup.

## Public and private networking

Trigger should use separate listeners:

- **Public webhook listener** — bound to a dedicated loopback port and exposed
  through Tailscale Funnel.
- **Private control listener** — bound separately and available only on the
  device initially. Tailnet-only administration may be added later.

This separation ensures that a tunnel configuration cannot expose management
routes merely because they share a Hono application with public hooks.

Service Triggers may create their own local listeners when that is their
purpose, but Trigger does not automatically expose those listeners publicly.
External webhook integrations should normally use the shared webhook gateway.

## Selection rule

Choose the narrowest execution model that fits:

```text
External webhook only?       -> Webhook Trigger
Time-based execution only?   -> Scheduled Trigger
Must remain alive/listen?    -> Service Trigger
```

A Trigger may eventually combine webhook and scheduled entry points when both
belong to the same automation. Persistent listening remains a Service Trigger
because it requires a different lifecycle.

## Current trust model

Trigger code is created or approved by the local user and is treated as trusted
code. Incoming webhook data and other external inputs are untrusted.

The architecture should protect reliability through validation, timeouts,
Worker Thread supervision, bounded queues, and resource accounting. It does not
claim to safely execute malicious third-party code. Supporting hostile code
would require a stronger process, container, or virtual-machine boundary.

