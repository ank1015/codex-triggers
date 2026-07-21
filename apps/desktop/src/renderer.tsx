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
  X,
} from "lucide-react";

import { IDEA_TOPICS, IDEAS, type IdeaTopic } from "./ideas.js";
import type {
  CodexModel,
  CodexReasoningEffort,
  DeliveryRunStatus,
  TriggerSummary,
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

async function ensureMacosNotificationPermission(): Promise<void> {
  const permission = await window.desktop.requestMacosNotificationPermission();
  if (permission === "unavailable") {
    throw new Error("Native notifications are not available on this Mac.");
  }
  if (permission !== "authorized" && permission !== "provisional") {
    throw new Error(
      "Allow notifications for Codex Triggers in System Settings → Notifications.",
    );
  }
}

function macosNotificationPermissionMessage(
  permission: Awaited<
    ReturnType<typeof window.desktop.getMacosNotificationPermission>
  >,
): string {
  return permission === "denied" || permission === "restricted"
    ? "Notifications are disabled for Codex Triggers in macOS."
    : "Allow notifications so Codex Triggers can alert you when a Trigger runs.";
}

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
        <img className="app-logo" src="./logo-2.png" alt="Codex Triggers" />
      )}
      {onSettings ? (
        <button
          className="settings-button"
          type="button"
          aria-label="Settings"
          onClick={onSettings}
        >
          <Settings aria-hidden="true" size={18} strokeWidth={1.8} />
        </button>
      ) : (
        <span className="header-action-spacer" aria-hidden="true" />
      )}
    </header>
  );
}

function triggerKindLabel(kind: TriggerSummary["kind"]): string {
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
  trigger: TriggerSummary;
  onOpen: (trigger: TriggerSummary) => void;
}) {
  return (
    <button
      className={`trigger-card${trigger.enabled ? "" : " trigger-card-inactive"}`}
      type="button"
      aria-label={`Open ${trigger.name}`}
      onClick={() => onOpen(trigger)}
    >
      <div className="trigger-card-meta">
        <span
          className={`trigger-status-indicator${trigger.enabled ? "" : " trigger-status-indicator-inactive"}`}
          aria-hidden="true"
        />
        <span>{trigger.enabled ? "Active" : "Inactive"}</span>
      </div>
      <h2>{trigger.name}</h2>
      <p>{triggerKindLabel(trigger.kind)} Trigger</p>
    </button>
  );
}

function Triggers({
  onCreate,
  onOpenTrigger,
}: {
  onCreate: () => void;
  onOpenTrigger: (trigger: TriggerSummary) => void;
}) {
  const {
    data: triggers = [],
    error,
  } = useQuery({
    queryKey: ["triggers"],
    queryFn: () => window.desktop.listTriggers(),
    refetchInterval: 1_000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (error) console.error("Could not load Triggers", error);
  }, [error]);

  return (
    <main className="main-content">
      <h1 className="triggers-title">Triggers</h1>
      <section className="trigger-grid" aria-label="Triggers">
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
  trigger: TriggerSummary;
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
      void queryClient.invalidateQueries({ queryKey: ["triggers"] });
    },
  });
  const macosNotificationMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (enabled) await ensureMacosNotificationPermission();
      return await window.desktop.setMacosNotificationsEnabled(
        trigger.id,
        enabled,
      );
    },
    onSuccess: (page) => {
      queryClient.setQueryData(queryKey, page);
      void queryClient.invalidateQueries({ queryKey: ["triggers"] });
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
      void queryClient.invalidateQueries({ queryKey: ["triggers"] });
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

      <section className="detail-section" aria-labelledby="notifications-title">
        <h2 id="notifications-title">Notifications</h2>
        <div className="detail-card notification-options-card">
          <div>
            <strong>macOS Notification</strong>
            <p>Show a notification when this Trigger emits an event.</p>
          </div>
          <button
            className="toggle-switch"
            type="button"
            role="switch"
            aria-label="macOS Notification"
            aria-checked={data.trigger.macosNotificationsEnabled}
            disabled={macosNotificationMutation.isPending}
            onClick={() =>
              macosNotificationMutation.mutate(
                !data.trigger.macosNotificationsEnabled,
              )
            }
          >
            <span />
          </button>
        </div>
        {macosNotificationMutation.error ? (
          <p className="inline-action-error">
            {macosNotificationMutation.error instanceof Error
              ? macosNotificationMutation.error.message
              : "Could not update macOS notifications"}
          </p>
        ) : null}
      </section>

      <section className="detail-section" aria-labelledby="codex-options-title">
        <h2 id="codex-options-title">Codex Options</h2>
        {data.codex ? (
          <div className="detail-card codex-options-card">
            <div className="codex-prompt">
              <span className="detail-label">Template prompt</span>
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

const ideaTopicLabels = new Map(
  IDEA_TOPICS.map(({ id, label }) => [id, label]),
);

function CreateTriggerPage() {
  const [selectedTopics, setSelectedTopics] = useState<readonly IdeaTopic[]>(
    [],
  );

  const toggleTopic = (topic: IdeaTopic) => {
    setSelectedTopics((current) =>
      current.includes(topic)
        ? current.filter((selected) => selected !== topic)
        : [...current, topic],
    );
  };
  const visibleIdeas =
    selectedTopics.length === 0
      ? IDEAS
      : IDEAS.filter((idea) =>
          idea.tags.some((tag) => selectedTopics.includes(tag)),
        );

  const askCodex = (prompt?: string) => {
    void window.desktop.openCodexNewChat(prompt).catch((error: unknown) => {
      console.error("Could not open Codex", error);
    });
  };

  return (
    <main className="main-content create-trigger-content">
      <h1 className="create-trigger-title">Create Trigger</h1>

      <section className="codex-skill-card" aria-label="Create with Codex">
        <p>Create ANY trigger by just asking Codex for it using the official skill</p>
        <button
          className="ask-codex-button"
          type="button"
          onClick={() => askCodex()}
        >
          Ask Codex
        </button>
      </section>

      <h2 className="pre-made-title">Ideas</h2>
      <div
        className="idea-topic-chips"
        role="group"
        aria-label="Filter ideas by topic"
      >
        {IDEA_TOPICS.map((topic) => (
          <button
            key={topic.id}
            className="topic-chip"
            type="button"
            aria-pressed={selectedTopics.includes(topic.id)}
            onClick={() => toggleTopic(topic.id)}
          >
            {topic.label}
          </button>
        ))}
      </div>
      {visibleIdeas.length === 0 ? (
        <p className="empty-ideas">No ideas in these topics yet.</p>
      ) : (
        <section className="idea-grid" aria-label="Trigger ideas">
          {visibleIdeas.map((idea) => (
            <button
              key={idea.id}
              className="idea-card"
              type="button"
              aria-label={`Ask Codex to create: ${idea.title}`}
              onClick={() => askCodex(idea.prompt)}
            >
              <h3>{idea.title}</h3>
              <p>{idea.description}</p>
              <div className="idea-card-tags" aria-hidden="true">
                {idea.tags.map((tag) => (
                  <span key={tag}>{ideaTopicLabels.get(tag)}</span>
                ))}
              </div>
            </button>
          ))}
        </section>
      )}
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

function ReminderBanner({
  message,
  onClose,
  onAction,
}: {
  message: string;
  onClose: () => void;
  onAction: () => void;
}) {
  return (
    <aside className="funnel-banner" role="status">
      <button
        className="funnel-banner-content"
        type="button"
        onClick={onAction}
      >
        {message}
      </button>
      <button
        className="funnel-banner-close"
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
      >
        <X aria-hidden="true" size={14} strokeWidth={2} />
      </button>
    </aside>
  );
}

function OnboardingPage({
  onComplete,
  pending,
  error,
  onDismissError,
}: {
  onComplete: () => void;
  pending: boolean;
  error: string | null;
  onDismissError: () => void;
}) {
  return (
    <div className="onboarding-page">
      <main className="onboarding-content">
        <h1>Codex Triggers</h1>
        <button
          className="onboarding-start-button"
          type="button"
          disabled={pending}
          onClick={onComplete}
        >
          {pending ? "Setting up…" : "Let's Start"}
        </button>
      </main>
      {error ? (
        <aside className="onboarding-error-toast" role="alert">
          <p>{error}</p>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={onDismissError}
          >
            <X aria-hidden="true" size={14} strokeWidth={2} />
          </button>
        </aside>
      ) : null}
    </div>
  );
}

type Page = "home" | "create" | "trigger" | "settings";

function MainApplication({
  requestedTrigger,
}: {
  requestedTrigger: TriggerSummary | null;
}) {
  const [page, setPage] = useState<Page>("home");
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerSummary | null>(
    null,
  );
  const [settingsReturnPage, setSettingsReturnPage] = useState<
    Exclude<Page, "settings">
  >("home");
  const [funnelBannerVisible, setFunnelBannerVisible] = useState(false);
  const [notificationPermissionError, setNotificationPermissionError] =
    useState<string | null>(null);

  useEffect(() => {
    if (!requestedTrigger) return;
    setSelectedTrigger(requestedTrigger);
    setPage("trigger");
  }, [requestedTrigger]);

  useEffect(() => {
    let cancelled = false;
    void window.desktop
      .getWebhookTunnelSettings()
      .then((settings) => {
        if (!cancelled && !settings.enabled) setFunnelBannerVisible(true);
      })
      .catch(() => {
        // If Tailscale status can't be read, skip the reminder.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.desktop.listTriggers(),
      window.desktop.getMacosNotificationPermission(),
    ]).then(([triggers, permission]) => {
      if (
        !cancelled &&
        triggers.some(({ macosNotificationsEnabled }) =>
          macosNotificationsEnabled
        ) &&
        permission !== "authorized" &&
        permission !== "provisional"
      ) {
        setNotificationPermissionError(
          macosNotificationPermissionMessage(permission),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const openSettings = () => {
    if (page !== "settings") setSettingsReturnPage(page);
    setPage("settings");
  };

  const goBack = () => {
    setPage(page === "settings" ? settingsReturnPage : "home");
  };

  const openTrigger = (trigger: TriggerSummary) => {
    setSelectedTrigger(trigger);
    setPage("trigger");
  };

  const pageContent = (() => {
    switch (page) {
      case "home":
        return (
          <Triggers
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
      {page === "home" &&
      (funnelBannerVisible || notificationPermissionError) ? (
        <div className="home-reminder-stack">
          {funnelBannerVisible ? (
            <ReminderBanner
              message="Turn on Tailscale funneling for external webhook events"
              onClose={() => setFunnelBannerVisible(false)}
              onAction={() => {
                setFunnelBannerVisible(false);
                openSettings();
              }}
            />
          ) : null}
          {notificationPermissionError ? (
            <ReminderBanner
              message={notificationPermissionError}
              onClose={() => setNotificationPermissionError(null)}
              onAction={() => {
                void window.desktop
                  .getMacosNotificationPermission()
                  .then(async (permission) => {
                    if (
                      permission === "denied" ||
                      permission === "restricted"
                    ) {
                      await window.desktop.openMacosNotificationSettings();
                      return;
                    }
                    await ensureMacosNotificationPermission();
                    setNotificationPermissionError(null);
                  })
                  .catch(() =>
                    setNotificationPermissionError(
                      "Could not enable macOS notifications.",
                    ),
                  );
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function App() {
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [requestedTrigger, setRequestedTrigger] =
    useState<TriggerSummary | null>(null);

  useEffect(() => {
    const removeListener = window.desktop.onOpenTrigger((trigger) => {
      setRequestedTrigger(trigger);
      void window.desktop.getPendingTriggerNavigation(trigger.id);
    });
    void window.desktop
      .getPendingTriggerNavigation()
      .then((trigger) => {
        if (trigger) setRequestedTrigger(trigger);
      });
    return removeListener;
  }, []);
  const onboarding = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => window.desktop.getOnboardingStatus(),
    staleTime: Infinity,
    retry: false,
  });
  const completeOnboardingMutation = useMutation({
    mutationFn: async (notificationPermission: Promise<void>) => {
      await notificationPermission.catch(() => undefined);
      const result = await window.desktop.completeOnboarding();
      if (!result.completed) throw new Error(result.error);
      return result;
    },
    onMutate: () => setErrorDismissed(false),
    onSuccess: () => {
      queryClient.setQueryData(["onboarding"], { completed: true });
    },
  });

  if (onboarding.isLoading) {
    return <div className="app-shell" />;
  }
  if (!onboarding.data?.completed) {
    const rawError = completeOnboardingMutation.error ?? onboarding.error;
    const error =
      !errorDismissed && rawError
        ? rawError instanceof Error
          ? rawError.message
          : "Codex Triggers setup could not be completed."
        : null;
    return (
      <OnboardingPage
        pending={completeOnboardingMutation.isPending}
        error={error}
        onDismissError={() => setErrorDismissed(true)}
        onComplete={() => {
          const permission = ensureMacosNotificationPermission();
          completeOnboardingMutation.mutate(permission);
        }}
      />
    );
  }

  return <MainApplication requestedTrigger={requestedTrigger} />;
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
