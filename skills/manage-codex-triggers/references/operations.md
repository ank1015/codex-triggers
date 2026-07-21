# Codex Triggers operations and handoff

## Contents

- App readiness
- Tailscale webhook readiness
- External webhook handoff
- Apple Shortcuts
- Common provider patterns
- Failure and completion reporting
- Troubleshooting ladder

## App readiness

The Trigger backend lives inside the **Codex Triggers** desktop app. The app
must remain open for webhooks, schedules, Service listeners, and Delivery jobs
to run.

When `GET /health` is unreachable:

1. If the user already authorized Trigger work, try to open **Codex Triggers**
   with an available app/computer tool. On macOS, a shell fallback is:

   ```sh
   open -a "Codex Triggers"
   ```

2. Wait briefly and retry `GET /health`.
3. If the app cannot be found or health remains unavailable, ask the user to
   open **Codex Triggers** and leave it running. State that no changes were
   made yet.
4. After the user confirms, retry health and continue from the original task;
   do not make them restate the request.

Do not ask the user to run backend commands or know the control port.

## Tailscale webhook readiness

Only webhook Triggers need a public Tailscale URL. Schedules and Service
Triggers do not.

Call `GET /v1/public-webhook-url` before creating a webhook Trigger.

| State | Meaning | User experience |
|---|---|---|
| `publicWebhookUrl` is present | Funnel is ready | Continue without discussion. |
| Error says tunnel has not started | Funnel is off | Tell the user to open **Codex Triggers → Settings** and enable **Tailscale tunnel for webhooks**. Offer to enable it through the API; call `PUT /v1/settings/webhook-tunnel` only after approval. |
| Error says Tailscale is stopped, logged out, or unavailable | Tailscale itself is not ready | Ask the user to open Tailscale, sign in/connect if needed, then enable the tunnel in Codex Triggers Settings. If computer tools can safely open Tailscale, do so; do not attempt login or account selection without the user. |
| Funnel update returns an operational or CLI error | The route was not changed | Keep the app and Trigger system intact. Quote only the useful error summary, suggest opening Tailscale and retrying the Settings toggle, then re-read status. Do not repeatedly toggle. |

Enabling Funnel exposes only the webhook gateway path. Still obtain approval
because this creates public ingress. Never claim the webhook is reachable until
`GET /v1/public-webhook-url` returns a URL.

## External webhook handoff

After creation, the Trigger side is not fully useful until the sender is wired.
Choose one finish path:

### Configure it for the user

Use this path when the user asked Codex to finish setup and a provider API,
browser session, or computer tool is available.

1. Verify the exact account, repository, workspace, shortcut, or device and the
   event to subscribe to.
2. Open the provider's current official instructions when its UI or event
   contract may have changed.
3. Configure the generated secret webhook URL, event, content type, and signing
   secret if applicable.
4. Avoid unrelated provider settings.
5. Send or request one safe test event, then inspect the Trigger execution,
   notification, and Delivery job.

### Give the user exact steps

Use this path when the user prefers manual setup or provider/device access is
unavailable. Include:

- where to navigate, using current provider labels;
- the full generated URL and `POST` method;
- `Content-Type: application/json` when the sender supports headers;
- the exact event selection;
- the expected JSON body or field mapping;
- any signing-secret step and the Trigger secret name;
- a safe test action and what success looks like in Codex Triggers and Codex.

If setup cannot be verified, say “Trigger created; external webhook setup is
still pending” rather than “done.”

## Apple Shortcuts

For a Shortcut that sends data into Codex Triggers, create a webhook Trigger
and provide steps tailored to the requested Shortcut input.

Typical Share Sheet text Shortcut:

1. In Shortcuts, create a Shortcut and open its details.
2. Enable **Show in Share Sheet** and restrict accepted input to **Text** when
   appropriate.
3. Add **Get Contents of URL**.
4. Set URL to the generated Trigger webhook URL.
5. Set method to `POST`.
6. Set request body to **JSON** and map a field such as `text` to **Shortcut
   Input**. Shortcuts performs JSON escaping.
7. Add **Show Notification** such as “Sent to Codex.” Do not promise the Codex
   response is returned to Shortcuts; Delivery is asynchronous.
8. Test from a harmless piece of selected text and verify the Delivery job.

For non-text automations, specify the exact Shortcut variable mappings. For
images or files, first confirm whether the desired payload fits the 10 MB
webhook limit and whether the Trigger expects multipart data, a URL, or JSON.
Do not assume an iPhone can reach a Mac-only localhost URL; always use the
generated Tailscale Funnel webhook URL.

## Common provider patterns

Use these as checklists, then confirm current labels in official documentation.

### GitHub

- Repository: **Settings → Webhooks → Add webhook**.
- Payload URL: generated Trigger webhook URL.
- Content type: `application/json`.
- Select only the requested event, such as **Issue comments** or **Pull
  requests**, rather than all events.
- Recommend a GitHub webhook secret and store it as a Trigger secret, commonly
  `GITHUB_WEBHOOK_SECRET`; implement `X-Hub-Signature-256` validation when used.
- Use GitHub's recent delivery/test facility and verify one matching event.

### Stripe

- Create a webhook endpoint in the correct Stripe account and mode (test or
  live).
- Subscribe only to requested event types, such as
  `payment_intent.succeeded` or `checkout.session.completed`.
- Store the Stripe endpoint signing secret as a Trigger secret such as
  `STRIPE_WEBHOOK_SECRET` and validate Stripe's signature in Trigger code.
- Test in Stripe test mode first unless the user explicitly authorizes live
  configuration.

### Generic webhook sender

Provide a copyable example only after creation:

```sh
curl -X POST '<generated-webhook-url>' \
  -H 'content-type: application/json' \
  --data '{"sample":true}'
```

Replace the body with the Trigger's real expected fields. Do not include a real
secret URL in reusable docs, logs, or public output.

## Failure and completion reporting

Report progress in stages:

1. **Trigger created** — include name and Trigger ID.
2. **Public ingress ready** — only after a public URL is returned.
3. **External sender configured** — name the provider/event, or clearly mark it
   pending and give the remaining steps.
4. **End-to-end verified** — summarize the test event, notification, and Codex
   Delivery status.

If Delivery is still running, say Codex is working; do not call it complete.
If a failure occurs, distinguish Trigger-code failure, external webhook setup,
Tailscale ingress, and Codex Delivery so the user knows what to fix.

For HTTP validation errors on a request Codex generated, inspect the field-level
error, correct the request, re-check related schema/template fields, and retry
once. Examples include a required JSON Schema property missing from
`properties`, an invalid model/reasoning value, or an ephemeral thread paired
with `newThread: false`. The combined create endpoint is atomic, so a rejected
request leaves no partial Trigger system. Do not ask the user to repair JSON or
API shapes. Do not retry when the missing value is a user decision, secret,
permission, or external account choice.

## Troubleshooting ladder

Inspect the system in order and stop at the first failing boundary:

| Evidence | Interpretation | Next action |
|---|---|---|
| Health unavailable | Desktop host is not running or ready | Follow app readiness; do not mutate anything. |
| Public URL unavailable | External ingress is unavailable | Follow the Tailscale state table. |
| Provider reports delivery failure and no execution exists | Request did not reach or was rejected by the webhook gateway | Check sender URL, method, body size, and whether an old rotated URL is still configured. |
| Execution is `failed` or `timed_out` | Trigger code or an upstream call failed | Inspect execution logs and error; fix only code, secret, payload handling, or timeout involved. |
| Execution succeeded but no notification exists | Handler returned/emitted no notification | Inspect handler branches and output validation. |
| Notification exists but no Delivery job exists | Delivery may be disabled, missing, or not attached | Inspect the Trigger's Delivery configuration. |
| Delivery is `queued` | Work has not started | Wait briefly and re-read once. |
| Delivery is `running` | Codex is actively working | Tell the user it is running; do not report completion. |
| Delivery failed | Codex app-server configuration or turn failed | Report the job error, inspect the Delivery, and change only the bad setting. |
| Service state is `failed` | The persistent listener crashed | Inspect its latest execution and logs; do not confuse an old host-restart lifecycle record with a failed notification. |

When repairing, preserve the Trigger, its secret URL, and historical data unless
the required fix specifically changes them. Do not delete and recreate as a
generic recovery method.

When rotating a leaked webhook URL:

1. Identify the exact Trigger.
2. Rotate immediately if the user's request clearly authorizes it; otherwise
   ask for confirmation.
3. State that the old URL can no longer invoke the Trigger.
4. Update every known external sender when authorized, or give exact update
   steps. Until then, new external events will not reach the Trigger.
5. Remove/redact the leaked text when tools and authorization permit, although
   rotation remains the security fix.
