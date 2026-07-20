---
name: manage-codex-triggers
description: Create, inspect, test, update, and delete local Codex Trigger automations through the Codex Triggers HTTP API, with every notification delivered as a templated task through Codex app-server. Use when a user wants an external webhook, schedule, directory or system listener, or other event to run custom code; when configuring Trigger secrets or Tailscale webhook ingress; or when troubleshooting Trigger executions and Delivery jobs.
---

# Manage Codex Triggers

Operate the local Codex Triggers service through its HTTP API. Prefer one
combined create call for a new Trigger plus its Codex Delivery.

Use `http://127.0.0.1:47831` unless the user provides another control origin.
Start with `GET /health`. If it is unavailable, ask the user to open Codex
Triggers.

Read [references/api.md](references/api.md) before creating or changing a
Trigger system. Read [references/trigger-code.md](references/trigger-code.md)
when writing Trigger code or an output schema.

## Creation workflow

1. Translate the requested automation into:
   - one Trigger lifecycle: `webhook`, `schedule`, or `service`;
   - creator-defined TypeScript code;
   - a stable `{ message, data }` notification shape;
   - the Codex app-server Delivery configuration and input template.
2. Resolve meaningful choices with the user before creating anything.
3. For webhook systems, call `GET /v1/public-webhook-url`. If no URL exists,
   ask whether to enable the managed Tailscale Funnel. Enable it only after
   approval with `PUT /v1/settings/webhook-tunnel`.
4. Present a compact final plan: event, behavior, notification fields, Codex
   destination, secrets needed, and external setup needed. Obtain confirmation
   unless the user already clearly authorized the fully specified creation.
5. Call `POST /v1/trigger-systems`. Do not create the Trigger and Delivery with
   separate calls unless attaching a Delivery to an existing Trigger.
6. Configure secrets through the secret endpoint after creation. Never embed
   secret values in Trigger code, Delivery templates, names, logs, or summaries.
7. Test the lowest-impact path, then inspect executions, notifications, and
   Delivery jobs. Report IDs, URLs, test outcome, and any remaining external
   provider setup.

## User interaction rules

Ask only for choices that materially affect behavior. Group missing choices in
one concise message and do not re-ask values the user already supplied.

Always resolve:

- **Event:** webhook provider/event, schedule and timezone, or persistent
  listener behavior.
- **Project:** an existing absolute `projectPath`, or `""` for no project.
- **Model:** `luna`, `terra`, or `sol`.
- **Reasoning:** `low`, `medium`, `high`, or `xhigh`.
- **Thread behavior:** a new thread for every event, or one reusable thread.
- **Persistence:** `persistent` or `ephemeral`. Ephemeral requires a new thread
  for every event and never appears in the Codex sidebar.
- **Prompt:** what Codex should do with the notification fields.

When the user asks Codex to choose, prefer `luna`, `medium`, `persistent`, and a
new thread per event. Prefer a reusable thread only when events form one ongoing
conversation or task.

For credentials, identify required secret names and ask the user whether they
want to provide the values for API configuration or set them themselves. Do not
invent credentials. Do not echo a received secret after storing it.

For third-party webhook registration, show the generated webhook URL and ask
whether the user wants instructions or wants Codex to configure the provider
using available browser/computer tools. Before acting, confirm the provider,
account or repository, event selection, and that changing the external webhook
configuration is authorized.

Ask before enabling or disabling Tailscale Funnel. Ask before deleting a
Trigger system, rotating a webhook token, replacing code, or changing an
existing Delivery's thread destination.

## Selection rules

- Use `webhook` when an external system sends HTTP events.
- Use `schedule` for cron or one-time execution.
- Use `service` only when code must remain alive to watch files, maintain a
  socket, subscribe to events, or listen continuously.

Do not create a Service Trigger merely to receive an ordinary webhook or run a
timer. Trigger already owns those lifecycles.

## Verification

For webhook or scheduled Triggers, use `POST /v1/triggers/:id/run` with a safe
sample payload when a synthetic run is appropriate. Service Triggers start when
enabled; inspect their service state and logs instead of calling `/run`.

Verify:

1. the execution reaches `succeeded`;
2. the notification contains the intended `message` and `data`;
3. a Delivery job is created for the new notification;
4. the Delivery job reaches `succeeded` or exposes an actionable error.

The app-server Delivery remains `running` while Codex works and succeeds only
after the matching turn completes. A failed or interrupted Codex turn fails the
Delivery job with an actionable error.
