---
name: manage-codex-triggers
description: Create, inspect, test, update, and delete local Codex Trigger automations through the Codex Triggers HTTP API, with every notification delivered as a templated task through Codex app-server. Use when a user wants an external webhook, Apple Shortcut, third-party provider integration, schedule, directory or system listener, or other event to run custom code; when configuring Trigger secrets or Tailscale webhook ingress; or when troubleshooting Trigger executions and Delivery jobs.
---

# Manage Codex Triggers

Operate the local Codex Triggers service through its HTTP API. Prefer one
combined create call for a new Trigger plus its Codex Delivery.

Use `http://127.0.0.1:47831` unless the user provides another control origin.
Start with `GET /health` and follow the readiness flow below before asking the
user to troubleshoot.

Read [references/api.md](references/api.md) before creating or changing a
Trigger system. Read [references/trigger-code.md](references/trigger-code.md)
when writing Trigger code or an output schema. For webhook setup, app startup,
Tailscale failures, and external-service handoff, also read
[references/operations.md](references/operations.md).

## Readiness and recovery

Treat Codex Triggers like a native part of the Codex workflow. Resolve safe,
reversible prerequisites when possible instead of turning them into homework.

1. Call `GET /health`.
2. If it is unreachable and the user already asked to create, inspect, test, or
   repair a Trigger, try to open the **Codex Triggers** app with an available
   app/computer tool. On macOS, `open -a "Codex Triggers"` is an acceptable
   fallback. Wait briefly and retry health.
3. If launching is unavailable, the app is not installed, or health still
   fails, tell the user exactly: open **Codex Triggers** and leave it running.
   Explain that its local Trigger API must be available, then resume as soon as
   they confirm. Do not imply that any Trigger was created.
4. For operational API errors, preserve completed work, report the failing
   stage in plain language, and give the shortest recovery step. Retry only
   safe reads automatically. If a create/update request is rejected because of
   an agent-generated payload or schema mistake, correct it, revalidate the
   whole request, and retry once without making the user fix implementation
   details. Never repeat an unchanged mutation or enter a retry loop. Ask the
   user only when the error exposes a genuinely unresolved product choice,
   credential, permission, or external dependency.

## Creation workflow

1. Translate the requested automation into:
   - one Trigger lifecycle: `webhook`, `schedule`, or `service`;
   - creator-defined TypeScript code;
   - a stable `{ message, data }` notification shape;
   - the Codex app-server Delivery configuration and input template.
2. Call `GET /v1/triggers` and inspect likely matches before creating anything.
   If the requested automation already exists, offer to inspect, test, or
   update it instead of silently creating a duplicate.
3. Resolve meaningful choices with the user before creating anything.
4. For webhook systems, call `GET /v1/public-webhook-url`. If no URL exists,
   interpret its `error` and follow the Tailscale recovery table in
   `references/operations.md`. Tell the user how to turn on **Tailscale tunnel
   for webhooks** in Codex Triggers Settings. Offer to enable it through the
   API when tools are available, but enable it only with approval.
5. Present a compact final plan: event, behavior, notification fields, Codex
   destination, secrets needed, and external setup needed. Obtain confirmation
   unless the user already clearly authorized the fully specified creation.
6. Call `POST /v1/trigger-systems`. Do not create the Trigger and Delivery with
   separate calls unless attaching a Delivery to an existing Trigger.
7. Configure secrets through the secret endpoint after creation. Never embed
   secret values in Trigger code, Delivery templates, names, logs, or summaries.
8. Test the lowest-impact path, then inspect executions, notifications, and
   Delivery jobs. Report IDs, URLs, test outcome, and any remaining external
   provider setup.
9. For webhooks, finish the external handoff: either configure the provider
   using available tools when the user authorized it, or give exact current
   steps for that provider, including the generated URL, HTTP method, body,
   headers, event selection, and how to test it. Do not end with only “register
   this webhook.”

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

Choose `projectPath` by the work Codex must perform, not by the agent's current
working directory. Use an existing project directory only when the task needs
that project's files or tools. Use `""` for summaries, personal workflows,
generic webhook processing, or other work unrelated to a codebase. Never attach
a Trigger to the current repository merely because Codex happens to be running
there. For file-oriented Service Triggers, the watched directory may be the
project only when Codex needs filesystem access there.

When the user asks Codex to choose, prefer `luna`, `medium`, `persistent`, and a
new thread per event. Prefer a reusable thread only when events form one ongoing
conversation or task.

For credentials, identify required secret names and ask the user whether they
want to provide the values for API configuration or set them themselves. Do not
invent credentials. Do not echo a received secret after storing it.

For third-party webhook registration, if the user has not said who should
perform it, show the generated webhook URL and ask whether they want exact
instructions or want Codex to configure the provider using available
browser/computer tools. Before acting, confirm the provider, account or
repository, event selection, and that changing the external webhook
configuration is authorized.

When the user already asked Codex to configure the external service, use the
available provider/API/browser/computer tools rather than asking them to repeat
the work. If authentication, device access, or a provider-only confirmation
blocks automation, complete the Trigger side and give a precise handoff from
the exact stopping point. Use current official provider documentation when UI
labels, payloads, signatures, or event names may have changed.

For webhook URLs:

- Treat the full generated URL as a credential because it contains the Trigger
  token. Show it only when needed for setup; never log or publish it.
- Explain that webhook delivery is asynchronous: the sender receives an
  acknowledgement, while the Codex result appears in the configured task.
- Identify whether provider signature verification needs an additional secret.
  Do not confuse the secret URL token with a provider signing secret.

Ask before enabling or disabling Tailscale Funnel, deleting a Trigger system,
rotating a webhook token, replacing code, or changing an existing Delivery's
thread destination—unless the user's current request already explicitly
authorizes that exact action.

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

## Troubleshooting

Diagnose from ingress to Delivery; do not guess or recreate the Trigger first:

1. Confirm app health and, for external webhooks, public URL readiness.
2. Inspect the latest execution. No execution means the event did not reach the
   Trigger; a failed execution means Trigger code or upstream work failed.
3. Inspect notifications. A successful execution with no notification means
   the handler emitted nothing; a notification proves Trigger output succeeded.
4. Inspect the matching Delivery job. `queued` is waiting, `running` means
   Codex is working, `succeeded` is complete, and `failed` contains the Delivery
   problem.
5. Change only the failing layer, preserve unrelated configuration, and verify
   with one safe new event.

For an exposed webhook URL, an explicit request such as “rotate it” or “fix it
now” authorizes rotation. Otherwise ask first. Rotation immediately invalidates
the old URL; incoming events will not reach the Trigger until every external
sender is updated. It does not retroactively fail existing notifications or
Codex tasks.
