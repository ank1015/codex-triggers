import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, Plus, Settings } from "lucide-react";

import type {
  ActiveTrigger,
  WebhookTunnelSettings,
} from "./shared.js";

function Header({
  onBack,
  onSettings,
}: {
  onBack: (() => void) | undefined;
  onSettings: (() => void) | undefined;
}) {
  return (
    <header className="app-header">
      {onBack ? (
        <button className="header-icon-button" type="button" aria-label="Go back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={22} strokeWidth={1.8} />
        </button>
      ) : (
        <img className="app-logo" src="./logo.jpg" alt="Codex Triggers" />
      )}
      {onSettings ? (
        <button
          className="settings-button"
          type="button"
          aria-label="Settings"
          onClick={onSettings}
        >
          <Settings aria-hidden="true" size={21} strokeWidth={1.8} />
        </button>
      ) : (
        <span className="header-action-spacer" aria-hidden="true" />
      )}
    </header>
  );
}

function triggerKindLabel(kind: ActiveTrigger["kind"]): string {
  switch (kind) {
    case "webhook":
      return "Webhook";
    case "schedule":
      return "Scheduled";
    case "service":
      return "Service";
  }
}

function TriggerCard({ trigger }: { trigger: ActiveTrigger }) {
  return (
    <article className="trigger-card">
      <div className="trigger-card-meta">
        <span className="active-indicator" aria-hidden="true" />
        <span>Active</span>
      </div>
      <h2>{trigger.name}</h2>
      <p>{triggerKindLabel(trigger.kind)} Trigger</p>
    </article>
  );
}

function ActiveTriggers({ onCreate }: { onCreate: () => void }) {
  const [triggers, setTriggers] = useState<ActiveTrigger[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.desktop
      .listActiveTriggers()
      .then((activeTriggers) => {
        if (!cancelled) setTriggers(activeTriggers);
      })
      .catch((error: unknown) => {
        console.error("Could not load active Triggers", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="main-content">
      <h1 className="active-triggers-title">Active Triggers</h1>
      <section className="trigger-grid" aria-label="Active Triggers">
        {triggers.map((trigger) => (
          <TriggerCard key={trigger.id} trigger={trigger} />
        ))}
        <button
          className="add-trigger-card"
          type="button"
          aria-label="Create a Trigger"
          onClick={onCreate}
        >
          <Plus aria-hidden="true" size={28} strokeWidth={1.6} />
        </button>
      </section>
    </main>
  );
}

function CreateTriggerPage() {
  const askCodex = () => {
    void window.desktop.openCodexNewChat().catch((error: unknown) => {
      console.error("Could not open Codex", error);
    });
  };

  return (
    <main className="main-content create-trigger-content">
      <h1 className="create-trigger-title">Create Trigger</h1>

      <section className="codex-skill-card" aria-label="Create with Codex">
        <p>Create ANY trigger by just asking Codex for it using the official skill</p>
        <button className="ask-codex-button" type="button" onClick={askCodex}>
          Ask Codex
        </button>
      </section>

      <h2 className="pre-made-title">Pre-Made Triggers</h2>
    </main>
  );
}

function SettingsPage() {
  const [settings, setSettings] = useState<WebhookTunnelSettings | null>(null);
  const [updating, setUpdating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.desktop
      .getWebhookTunnelSettings()
      .then((loadedSettings) => {
        if (!cancelled) setSettings(loadedSettings);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setActionError(
            error instanceof Error ? error.message : "Could not read Tailscale status",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleTunnel = async () => {
    if (!settings || updating) return;
    setUpdating(true);
    setActionError(null);
    try {
      setSettings(
        await window.desktop.setWebhookTunnelEnabled(!settings.enabled),
      );
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not update Tailscale Funnel",
      );
    } finally {
      setUpdating(false);
    }
  };

  const error = actionError ?? settings?.error ?? null;

  return (
    <main className="main-content settings-content">
      <h1 className="settings-title">Settings</h1>

      <section className="settings-card" aria-label="Webhook settings">
        <div className="setting-copy">
          <h2>Tailscale tunnel for webhooks</h2>
          <p>Expose Trigger webhook URLs securely through Tailscale Funnel.</p>
          {settings?.enabled && settings.publicWebhookUrl ? (
            <code className="public-webhook-url">{settings.publicWebhookUrl}</code>
          ) : null}
          {error ? <p className="setting-error">{error}</p> : null}
        </div>

        <button
          className="toggle-switch"
          type="button"
          role="switch"
          aria-label="Tailscale tunnel for webhooks"
          aria-checked={settings?.enabled ?? false}
          disabled={!settings || updating}
          onClick={() => void toggleTunnel()}
        >
          <span />
        </button>
      </section>
    </main>
  );
}

type Page = "home" | "create" | "settings";

function App() {
  const [page, setPage] = useState<Page>("home");
  const [settingsReturnPage, setSettingsReturnPage] = useState<
    Exclude<Page, "settings">
  >("home");

  const openSettings = () => {
    if (page !== "settings") setSettingsReturnPage(page);
    setPage("settings");
  };

  const goBack = () => {
    setPage(page === "settings" ? settingsReturnPage : "home");
  };

  return (
    <div className="app-shell">
      <Header
        onBack={page === "home" ? undefined : goBack}
        onSettings={page === "settings" ? undefined : openSettings}
      />
      {page === "home" ? (
        <ActiveTriggers onCreate={() => setPage("create")} />
      ) : page === "create" ? (
        <CreateTriggerPage />
      ) : (
        <SettingsPage />
      )}
    </div>
  );
}

const rootElement = document.querySelector("#root");
if (!rootElement) throw new Error("React root element is missing");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
