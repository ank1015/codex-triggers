# Trigger code contracts

## Contents

- Notification contract
- Context
- Webhook Trigger
- Scheduled Trigger
- Service Trigger
- Safety and validation

## Notification contract

Every notification is exactly:

```ts
{
  message: string
  data: JSONValue
}
```

`outputSchema` validates only `data`. Keep `data` stable because Delivery
templates depend on its fields. Prefer concise human-readable `message` text and
structured details in `data`.

Webhook and scheduled handlers may return one notification or call
`ctx.notify()` multiple times. Service Triggers call `ctx.notify()`.

## Context

```ts
ctx.triggerId
ctx.executionId
ctx.signal
ctx.untilStopped()
ctx.notify({ message, data })
ctx.secrets.get("NAME")
ctx.log.debug(...values)
ctx.log.info(...values)
ctx.log.warn(...values)
ctx.log.error(...values)
```

Console output is captured in execution logs. Worker environment variables are
empty; use `ctx.secrets.get()` for credentials.

## Webhook Trigger

The handler receives a standard `Request` and context:

```ts
export default async function run(request, ctx) {
  const payload = await request.json()
  const token = ctx.secrets.get("PROVIDER_TOKEN")

  const response = await fetch(`https://api.example.com/items/${payload.id}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) throw new Error(`Provider returned ${response.status}`)
  const item = await response.json()

  return {
    message: `Item received: ${item.title}`,
    data: {
      id: String(item.id),
      title: String(item.title),
      url: String(item.url),
    },
  }
}
```

Use the generated secret webhook URL for provider registration. Provider
signature validation belongs in this handler when required.

## Scheduled Trigger

The handler receives a schedule event and context:

```ts
export default async function run(event, ctx) {
  const response = await fetch("https://api.example.com/status")
  if (!response.ok) throw new Error(`Status API returned ${response.status}`)
  const status = await response.json()

  return {
    message: `Scheduled check at ${event.scheduledFor}`,
    data: {
      scheduledFor: event.scheduledFor,
      status: String(status.state),
    },
  }
}
```

Cron example:

```json
{
  "kind": "cron",
  "expression": "0 9 * * *",
  "timezone": "Asia/Kolkata"
}
```

One-time example:

```json
{
  "kind": "once",
  "expression": "2026-08-01T09:00:00+05:30",
  "timezone": "Asia/Kolkata"
}
```

## Service Trigger

Export an object with `start(ctx)`. Keep the listener in the managed Worker
Thread and stop through `ctx.signal`.

```ts
import { watch } from "node:fs/promises"

export default {
  async start(ctx) {
    for await (const event of watch("/absolute/path", { signal: ctx.signal })) {
      await ctx.notify({
        message: `File changed: ${event.filename ?? "unknown"}`,
        data: {
          eventType: event.eventType,
          filename: event.filename ?? null,
        },
      })
    }
  },
}
```

Service code may watch files, host a route or socket, subscribe to a queue, or
maintain a connection. The host starts, stops, restores, and restarts its Worker
Thread.

Filesystem watchers often emit more than one event for a single file. Debounce
concurrent events in memory and persist a stable file signature such as
`filename + size + mtimeMs` when duplicate work would be harmful. In-memory
sets alone reset whenever the app or Service Trigger restarts; a startup scan
can then emit the same still-present file again.

## Safety and validation

- Use TypeScript or JavaScript ESM.
- Use normal Node built-ins, `fetch`, and timers.
- Do not create child processes, clusters, or additional Worker Threads.
- Do not call `process.exit`, `process.abort`, or `process.kill`.
- Keep webhook and schedule work within `timeoutMs`.
- Throw on meaningful upstream failures so execution history is accurate.
- Avoid logging secrets or entire authorization headers.
- Make the output schema strict enough to protect Delivery templates.
- Require fields used by a Delivery template in `outputSchema`; otherwise a
  missing value fails the individual Delivery job.
