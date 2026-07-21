# Codex Triggers installer

Install or update Codex Triggers on macOS:

```bash
npx codex-triggers@latest
```

The installer downloads the release matching the Mac's processor, installs it
to `~/Applications/Codex Triggers.app`, locally signs the app, and opens it.

Codex Triggers requires the Codex desktop app and its `codex app-server`
runtime. The first-run screen verifies that runtime and installs the bundled
`manage-codex-triggers` skill.

Re-run the same command to update the app. Existing Triggers and settings are
stored outside the application bundle and are preserved.
