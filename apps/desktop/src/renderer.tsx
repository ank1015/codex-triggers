import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";

import type {
  ActiveTrigger,
  CodexModel,
  CodexReasoningEffort,
  DeliveryRunStatus,
  TriggerPageData,
  TriggerRunStatus,
  WebhookTunnelSettings,
} from "./shared.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1_000,
      retry: 1,
      refetchOnWindowFocus: "always",
    },
  },
});

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

function TriggerCard({
  trigger,
  onOpen,
}: {
  trigger: ActiveTrigger;
  onOpen: (trigger: ActiveTrigger) => void;
}) {
  return (
    <button
      className="trigger-card"
      type="button"
      aria-label={`Open ${trigger.name}`}
      onClick={() => onOpen(trigger)}
    >
      <div className="trigger-card-meta">
        <span className="active-indicator" aria-hidden="true" />
        <span>Active</span>
      </div>
      <h2>{trigger.name}</h2>
      <p>{triggerKindLabel(trigger.kind)} Trigger</p>
    </button>
  );
}

function ActiveTriggers({
  onCreate,
  onOpenTrigger,
}: {
  onCreate: () => void;
  onOpenTrigger: (trigger: ActiveTrigger) => void;
}) {
  const {
    data: triggers = [],
    error,
  } = useQuery({
    queryKey: ["active-triggers"],
    queryFn: () => window.desktop.listActiveTriggers(),
    refetchInterval: 1_000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (error) console.error("Could not load active Triggers", error);
  }, [error]);

  return (
    <main className="main-content">
      <h1 className="active-triggers-title">Active Triggers</h1>
      <section className="trigger-grid" aria-label="Active Triggers">
        {triggers.map((trigger) => (
          <TriggerCard
            key={trigger.id}
            trigger={trigger}
            onOpen={onOpenTrigger}
          />
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

function runStatusLabel(
  triggerStatus: TriggerRunStatus,
  deliveryStatus: DeliveryRunStatus | null,
): string {
  if (deliveryStatus === "succeeded") return "Completed";
  if (deliveryStatus === "failed") return "Codex failed";
  if (deliveryStatus === "running") return "Codex is working";
  if (deliveryStatus === "queued") return "Waiting for Codex";
  switch (triggerStatus) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "timed_out":
      return "Timed out";
    case "interrupted":
      return "Interrupted";
  }
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function TriggerPage({
  trigger,
  onDeleted,
}: {
  trigger: ActiveTrigger;
  onDeleted: () => void;
}) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const queryKey = ["trigger-page", trigger.id] as const;
  const { data, error, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const page = await window.desktop.getTriggerPage(trigger.id);
      if (!page) throw new Error("Trigger not found");
      return page;
    },
    refetchInterval: 1_000,
    refetchIntervalInBackground: true,
  });
  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      window.desktop.setTriggerEnabled(trigger.id, enabled),
    onSuccess: (page) => {
      queryClient.setQueryData(queryKey, page);
      void queryClient.invalidateQueries({ queryKey: ["active-triggers"] });
    },
  });
  const showInCodexMutation = useMutation({
    mutationFn: (showInCodex: boolean) =>
      window.desktop.setCodexShowInCodex(trigger.id, showInCodex),
    onSuccess: (page) => queryClient.setQueryData(queryKey, page),
  });
  const codexOptionsMutation = useMutation({
    mutationFn: (options: Parameters<typeof window.desktop.setCodexOptions>[1]) =>
      window.desktop.setCodexOptions(trigger.id, options),
    onSuccess: (page) => queryClient.setQueryData(queryKey, page),
  });
  const deleteMutation = useMutation({
    mutationFn: () => window.desktop.deleteTrigger(trigger.id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["active-triggers"] });
      onDeleted();
    },
  });

  if (isLoading) {
    return <main className="main-content trigger-detail-content" />;
  }
  if (error || !data) {
    return (
      <main className="main-content trigger-detail-content">
        <p className="trigger-page-error">
          {error instanceof Error ? error.message : "Could not load Trigger"}
        </p>
      </main>
    );
  }

  const openThread = (threadId: string) => {
    void window.desktop.openCodexThread(threadId).catch((openError: unknown) => {
      console.error("Could not open Codex task", openError);
    });
  };

  return (
    <main
      className="main-content trigger-detail-content"
      aria-label={`Trigger: ${data.trigger.name}`}
      data-trigger-id={data.trigger.id}
    >
      <div className="trigger-detail-heading">
        <h1>{data.trigger.name}</h1>
        <button
          className="toggle-switch"
          type="button"
          role="switch"
          aria-label="Trigger enabled"
          aria-checked={data.trigger.enabled}
          disabled={enabledMutation.isPending}
          onClick={() => enabledMutation.mutate(!data.trigger.enabled)}
        >
          <span />
        </button>
      </div>

      <section className="detail-section" aria-labelledby="event-title">
        <h2 id="event-title">Event</h2>
        <div className="detail-card event-card">
          <span className="trigger-type-badge">
            {triggerKindLabel(data.trigger.kind)} Trigger
          </span>
          <details className="code-disclosure">
            <summary>
              <span>View trigger code</span>
              <ChevronDown aria-hidden="true" size={16} />
            </summary>
            <pre className="code-block"><code>{data.event.code}</code></pre>
          </details>
        </div>
      </section>

      <section className="detail-section" aria-labelledby="codex-options-title">
        <h2 id="codex-options-title">Codex Options</h2>
        {data.codex ? (
          <div className="detail-card codex-options-card">
            <div className="codex-prompt">
              <span className="detail-label">System Prompt</span>
              <pre><code>{data.codex.prompt}</code></pre>
            </div>

            <div className="codex-options-grid">
              <label className="codex-option-field">
                <span>Model</span>
                <select
                  aria-label="Codex model"
                  value={data.codex.model}
                  disabled={codexOptionsMutation.isPending}
                  onChange={(event) =>
                    codexOptionsMutation.mutate({
                      model: event.target.value as CodexModel,
                    })
                  }
                >
                  <option value="luna">Luna</option>
                  <option value="terra">Terra</option>
                  <option value="sol">Sol</option>
                </select>
              </label>
              <label className="codex-option-field">
                <span>Reasoning</span>
                <select
                  aria-label="Codex reasoning"
                  value={data.codex.reasoningEffort}
                  disabled={codexOptionsMutation.isPending}
                  onChange={(event) =>
                    codexOptionsMutation.mutate({
                      reasoningEffort: event.target.value as CodexReasoningEffort,
                    })
                  }
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">Extra high</option>
                </select>
              </label>
              <div>
                <span>Project / Working Directory</span>
                <p>{data.codex.projectPath || "No project"}</p>
              </div>
              {data.codex.threadId ? (
                <div>
                  <span>Thread ID</span>
                  <p>{data.codex.threadId}</p>
                </div>
              ) : null}
            </div>

            {codexOptionsMutation.error ? (
              <p className="inline-action-error">
                {codexOptionsMutation.error instanceof Error
                  ? codexOptionsMutation.error.message
                  : "Could not update Codex options"}
              </p>
            ) : null}

            <div className="codex-persistence-row">
              <div>
                <span>Show in Codex</span>
                <p>Save created tasks in the Codex sidebar.</p>
              </div>
              <button
                className="toggle-switch"
                type="button"
                role="switch"
                aria-label="Show in Codex"
                aria-checked={data.codex.showInCodex}
                disabled={showInCodexMutation.isPending}
                onClick={() =>
                  showInCodexMutation.mutate(!data.codex!.showInCodex)
                }
              >
                <span />
              </button>
            </div>
          </div>
        ) : (
          <div className="detail-card empty-detail-card">
            No Codex Delivery is configured.
          </div>
        )}
      </section>

      <section className="detail-section" aria-labelledby="recent-triggers-title">
        <h2 id="recent-triggers-title">Recent Triggers</h2>
        <div className="detail-card recent-runs-card">
          {data.recentRuns.length === 0 ? (
            <p className="empty-recent-runs">This Trigger has not run yet.</p>
          ) : (
            <ul className="recent-runs-list">
              {data.recentRuns.map((run) => (
                <li key={run.id}>
                  <div className="recent-run-copy">
                    <p>{run.message ?? "Trigger run"}</p>
                    <span>{formatTimestamp(run.createdAt)}</span>
                    {run.deliveryError ?? run.error ? (
                      <small>{run.deliveryError ?? run.error}</small>
                    ) : null}
                  </div>
                  <div className="recent-run-actions">
                    <span
                      className={`run-status run-status-${run.deliveryStatus ?? run.status}`}
                      role="status"
                      aria-live="polite"
                    >
                      {runStatusLabel(run.status, run.deliveryStatus)}
                    </span>
                    {data.codex?.showInCodex &&
                    run.deliveryStatus === "succeeded" &&
                    run.threadId ? (
                      <button
                        className="open-codex-button"
                        type="button"
                        onClick={() => openThread(run.threadId!)}
                      >
                        Open in Codex
                        <ExternalLink aria-hidden="true" size={14} />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="detail-section danger-section" aria-labelledby="danger-title">
        <h2 id="danger-title">Danger Zone</h2>
        <div className="detail-card danger-card">
          <div>
            <strong>Delete Trigger</strong>
            <p>Remove this Trigger, its Delivery, and its history.</p>
          </div>
          <button
            className="delete-trigger-button"
            type="button"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 aria-hidden="true" size={15} />
            Delete
          </button>
        </div>
      </section>

      {deleteDialogOpen ? (
        <div className="dialog-backdrop">
          <div
            className="confirmation-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            aria-describedby="delete-dialog-description"
          >
            <h2 id="delete-dialog-title">Delete this Trigger?</h2>
            <p id="delete-dialog-description">
              This permanently deletes “{data.trigger.name}”, its Delivery, and
              its execution history.
            </p>
            {deleteMutation.error ? (
              <p className="dialog-error">
                {deleteMutation.error instanceof Error
                  ? deleteMutation.error.message
                  : "Could not delete Trigger"}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                className="dialog-cancel-button"
                type="button"
                autoFocus
                disabled={deleteMutation.isPending}
                onClick={() => setDeleteDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                className="dialog-delete-button"
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete Trigger"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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

type Page = "home" | "create" | "trigger" | "settings";

function App() {
  const [page, setPage] = useState<Page>("home");
  const [selectedTrigger, setSelectedTrigger] = useState<ActiveTrigger | null>(
    null,
  );
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

  const openTrigger = (trigger: ActiveTrigger) => {
    setSelectedTrigger(trigger);
    setPage("trigger");
  };

  const pageContent = (() => {
    switch (page) {
      case "home":
        return (
          <ActiveTriggers
            onCreate={() => setPage("create")}
            onOpenTrigger={openTrigger}
          />
        );
      case "create":
        return <CreateTriggerPage />;
      case "trigger":
        return selectedTrigger ? (
          <TriggerPage
            trigger={selectedTrigger}
            onDeleted={() => {
              setSelectedTrigger(null);
              setPage("home");
            }}
          />
        ) : null;
      case "settings":
        return <SettingsPage />;
    }
  })();

  return (
    <div className="app-shell">
      <Header
        onBack={page === "home" ? undefined : goBack}
        onSettings={page === "settings" ? undefined : openSettings}
      />
      {pageContent}
    </div>
  );
}

const rootElement = document.querySelector("#root");
if (!rootElement) throw new Error("React root element is missing");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
