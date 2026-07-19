import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import WebSocket from "ws";

import type {
  CodexAppController,
  CodexAppModel,
  CodexAppReasoningEffort,
  CodexAppRunRequest,
  CodexAppRunResult,
} from "./types.js";

const execFileAsync = promisify(execFile);
const delay = (milliseconds: number) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const INSPECTOR_PORT_START = 9_229;
const INSPECTOR_PORT_COUNT = 21;
const INSPECTOR_REQUEST_TIMEOUT_MS = 45_000;
const UI_TIMEOUT_MS = 10_000;

const MODEL_LABELS: Record<CodexAppModel, string> = {
  luna: "5.6 Luna",
  terra: "5.6 Terra",
  sol: "5.6 Sol",
};

const REASONING_LABELS: Record<CodexAppReasoningEffort, string> = {
  low: "Light",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

const REASONING_VALUES: Record<CodexAppReasoningEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

type InspectorPage = {
  webSocketDebuggerUrl?: string;
};

type RuntimeResult = {
  result?: {
    exceptionDetails?: {
      text?: string;
      exception?: { description?: string };
    };
    result?: {
      subtype?: string;
      description?: string;
      value?: unknown;
    };
  };
  error?: unknown;
};

type PendingRequest = {
  resolve(result: RuntimeResult): void;
  reject(error: Error): void;
};

type PreparedTask = {
  continued: boolean;
  expectedThreadKey: string | null;
  existingThreadKeys: string[];
};

export type ElectronCodexAppControllerOptions = {
  appPath: string;
  startupTimeoutMs?: number;
};

class CodexMainInspectorClient {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as RuntimeResult & {
        id?: number;
      };
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    socket.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    socket.on("close", () => {
      const error = new Error("The Codex main-process inspector closed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  static async open(executable: string): Promise<CodexMainInspectorClient> {
    const pid = await mainPid(executable);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const page of await inspectorPages()) {
        if (!page.webSocketDebuggerUrl) continue;
        let client: CodexMainInspectorClient | null = null;
        try {
          client = new CodexMainInspectorClient(
            await connectWebSocket(page.webSocketDebuggerUrl),
          );
          const count = await client.evaluateMain<number>(
            "process.mainModule.require('electron').BrowserWindow.getAllWindows().length",
          );
          if (count > 0) return client;
        } catch {
          // Other Node processes may have inspectors in the scanned range.
        }
        client?.socket.close();
      }

      if (attempt === 0) {
        process.kill(pid, "SIGUSR1");
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if ((await inspectorPages()).length > 0) break;
          await delay(100);
        }
      }
    }
    throw new Error("Could not connect to the Codex Electron main process");
  }

  evaluateMain<T>(expression: string): Promise<T> {
    return this.request("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as Promise<T>;
  }

  evaluateWorker<T>(javascript: string): Promise<T> {
    return this.evaluateMain<T>(`
      (() => {
        const {app, BrowserWindow, Menu} = process.mainModule.require('electron');
        const workerId = globalThis.__triggerCodexWorkerId;
        const worker = workerId == null ? null : BrowserWindow.fromId(workerId);
        if (worker == null || worker.isDestroyed()) {
          throw new Error('The Trigger Codex worker is not running');
        }
        worker.setOpacity(0);
        worker.setFocusable(false);
        worker.setIgnoreMouseEvents(true);
        worker.setSkipTaskbar(true);
        return worker.webContents.executeJavaScript(${JSON.stringify(javascript)});
      })()
    `);
  }

  ensureWorker(
    ownerToken: string,
    restoreBundleId: string | null,
  ): Promise<{ created: boolean; id: number }> {
    return this.evaluateMain(`
      (async () => {
        const {app, BrowserWindow, Menu} = process.mainModule.require('electron');
        const ownerToken = ${JSON.stringify(ownerToken)};
        const restoreBundleId = ${JSON.stringify(restoreBundleId)};
        const restorePreviousApplication = () => {
          if (!restoreBundleId || !/^[A-Za-z0-9._-]+$/.test(restoreBundleId)) return;
          process.mainModule.require('child_process').execFile(
            '/usr/bin/osascript',
            ['-e', 'tell application id "' + restoreBundleId + '" to activate'],
            () => {},
          );
        };
        const existingId = globalThis.__triggerCodexWorkerId;
        const existing = existingId == null ? null : BrowserWindow.fromId(existingId);
        if (existing != null && !existing.isDestroyed()) {
          globalThis.__triggerCodexWorkerOwner = ownerToken;
          existing.setOpacity(0);
          existing.setFocusable(false);
          existing.setIgnoreMouseEvents(true);
          existing.setSkipTaskbar(true);
          return {created: false, id: existing.id};
        }

        const windowsBefore = BrowserWindow.getAllWindows();
        const activeWindow = BrowserWindow.getFocusedWindow();
        const primaryWindow = activeWindow ?? windowsBefore.find(window => window.isVisible());
        let worker = null;
        const onWindowCreated = (_event, window) => {
          if (windowsBefore.includes(window)) return;
          worker = window;
          window.setOpacity(0);
          window.setFocusable(false);
          window.setIgnoreMouseEvents(true);
          window.setSkipTaskbar(true);
          window.hide();
          restorePreviousApplication();
        };
        app.on('browser-window-created', onWindowCreated);
        try {
          const fileMenu = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
          const newWindow = fileMenu?.submenu?.items.find(item =>
            item.label === 'New Window' || item.accelerator === 'CmdOrCtrl+Shift+N'
          );
          if (newWindow == null) throw new Error('Codex New Window command was not found');
          newWindow.click(null, primaryWindow, {triggeredByAccelerator: false});

          const deadline = Date.now() + ${UI_TIMEOUT_MS};
          while (worker == null && Date.now() < deadline) {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
          }
          if (worker == null) throw new Error('Codex did not create the hidden worker');
          worker.setOpacity(0);
          worker.setFocusable(false);
          worker.setIgnoreMouseEvents(true);
          worker.setSkipTaskbar(true);
          worker.setTitle('Trigger Codex Worker');
          worker.showInactive();
          restorePreviousApplication();
          setTimeout(restorePreviousApplication, 25);
          globalThis.__triggerCodexWorkerId = worker.id;
          globalThis.__triggerCodexWorkerOwner = ownerToken;
          if (activeWindow != null && !activeWindow.isDestroyed()) activeWindow.focus();
          return {created: true, id: worker.id};
        } finally {
          app.removeListener('browser-window-created', onWindowCreated);
        }
      })()
    `);
  }

  waitForWorkerReady(): Promise<void> {
    return this.evaluateMain<true | { __triggerError: string }>(`
      (async () => {
        try {
          const {BrowserWindow} = process.mainModule.require('electron');
          const workerId = globalThis.__triggerCodexWorkerId;
          const worker = workerId == null ? null : BrowserWindow.fromId(workerId);
          if (worker == null || worker.isDestroyed()) {
            throw new Error('The Trigger Codex worker is not running');
          }
          const deadline = Date.now() + ${UI_TIMEOUT_MS};
          while (worker.webContents.isLoading() && Date.now() < deadline) {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
          }
          while (Date.now() < deadline) {
            const ready = await worker.webContents.executeJavaScript(
              "Boolean(document.querySelector('[data-codex-composer=true]'))"
            );
            if (ready) return true;
            await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
          }
          throw new Error('Timed out waiting for the hidden Codex worker');
        } catch (error) {
          return {__triggerError: error instanceof Error ? error.message : String(error)};
        }
      })()
    `).then((result) => {
      if (result !== true) throw new Error(result.__triggerError);
    });
  }

  closeWorker(ownerToken: string): Promise<{ closed: boolean; id: number | null }> {
    return this.evaluateMain(`
      (() => {
        if (globalThis.__triggerCodexWorkerOwner !== ${JSON.stringify(ownerToken)}) {
          return {closed: false, id: null};
        }
        const {BrowserWindow} = process.mainModule.require('electron');
        const workerId = globalThis.__triggerCodexWorkerId;
        const worker = workerId == null ? null : BrowserWindow.fromId(workerId);
        globalThis.__triggerCodexWorkerId = null;
        globalThis.__triggerCodexWorkerOwner = null;
        if (worker == null || worker.isDestroyed()) {
          return {closed: false, id: workerId ?? null};
        }
        worker.destroy();
        return {closed: true, id: workerId};
      })()
    `);
  }

  navigateWorkerToThread(threadId: string): Promise<void> {
    return this.evaluateMain<true | { __triggerError: string }>(`
      (async () => {
        try {
          const {BrowserWindow} = process.mainModule.require('electron');
          const workerId = globalThis.__triggerCodexWorkerId;
          const worker = workerId == null ? null : BrowserWindow.fromId(workerId);
          if (worker == null || worker.isDestroyed()) {
            throw new Error('The Trigger Codex worker is not running');
          }
          const current = new URL(worker.webContents.getURL());
          current.pathname = '/index.html';
          current.search = '';
          current.searchParams.set(
            'initialRoute',
            ${JSON.stringify(`/local/${threadId}`)}
          );
          await worker.loadURL(current.toString());
          const deadline = Date.now() + ${UI_TIMEOUT_MS};
          while (worker.webContents.isLoading() && Date.now() < deadline) {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
          }
          while (Date.now() < deadline) {
            const ready = await worker.webContents.executeJavaScript(
              "Boolean(document.querySelector('[data-codex-composer=true]'))"
            );
            if (ready) return true;
            await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
          }
          throw new Error('Timed out opening Codex task ${threadId}');
        } catch (error) {
          return {__triggerError: error instanceof Error ? error.message : String(error)};
        }
      })()
    `).then((result) => {
      if (result !== true) throw new Error(result.__triggerError);
    });
  }

  prepareTask(options: {
    projectPath: string | null;
    projectName: string | null;
    threadId: string | null;
    modelLabel: string;
    reasoningLabel: string;
    reasoningValue: string;
  }): Promise<PreparedTask> {
    const serialized = JSON.stringify(options);
    return this.evaluateWorker<PreparedTask | { __triggerError: string }>(`
      (async () => {
        const options = ${serialized};
        const wait = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
        const waitFor = async (read, description, milliseconds = ${UI_TIMEOUT_MS}) => {
          const deadline = Date.now() + milliseconds;
          while (Date.now() < deadline) {
            const value = read();
            if (value) return value;
            await wait(50);
          }
          throw new Error('Timed out waiting for ' + description);
        };
        const fire = element => {
          if (!element) throw new Error('Attempted to click a missing element');
          for (const type of ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
            element.dispatchEvent(new EventType(type, {
              bubbles: true,
              cancelable: true,
              button: 0,
              view: window,
            }));
          }
        };
        const dismissMenus = async () => {
          for (let index = 0; index < 3; index += 1) {
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape',
              code: 'Escape',
              bubbles: true,
            }));
            await wait(30);
          }
        };
        const menuItem = (text, exact = false) => [...document.querySelectorAll('[role=menuitem]')]
          .find(element => exact
            ? element.innerText.trim() === text
            : element.innerText.trim().startsWith(text));

        await dismissMenus();
        const existingThreadKeys = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
          .map(element => element.getAttribute('data-app-action-sidebar-thread-id'))
          .filter(Boolean);

        let continued = false;
        let expectedThreadKey = null;
        if (options.threadId) {
          const threadRow = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
            .find(element => {
              const key = element.getAttribute('data-app-action-sidebar-thread-id');
              return key === options.threadId || key?.endsWith(':' + options.threadId);
            });
          expectedThreadKey = threadRow?.getAttribute('data-app-action-sidebar-thread-id')
            ?? 'local:' + options.threadId;
          await waitFor(
            () => document.querySelector('[data-codex-composer=true]'),
            'the existing task composer'
          );
          continued = true;
        } else if (options.projectPath === null) {
          const newTask = [...document.querySelectorAll('button')]
            .find(button => {
              const text = button.innerText.trim();
              return text === 'New chat' || text === 'New task';
            });
          if (!newTask) throw new Error('The global New chat button was not found');
          fire(newTask);
          await waitFor(
            () => document.querySelector('[data-codex-composer=true]'),
            'the projectless task composer'
          );
          const clearProject = document.querySelector('[data-clear-project-button=true]');
          if (clearProject) {
            fire(clearProject);
            await waitFor(
              () => document.querySelector('[data-composer-navigation-target=workspace-project]')
                ?.getAttribute('aria-label') === 'Choose project',
              'the project to be cleared'
            );
          }
        } else {
          const expectedLabels = [
            'Start new chat in ' + options.projectName,
            'Start new task in ' + options.projectName,
          ];
          const projectRow = [...document.querySelectorAll('[data-app-action-sidebar-project-row]')]
            .find(element => element.getAttribute('data-app-action-sidebar-project-id') === options.projectPath);
          const projectButton = [
            ...(projectRow?.querySelectorAll('button') ?? []),
            ...document.querySelectorAll('button[aria-label^="Start new chat in "]'),
            ...document.querySelectorAll('button[aria-label^="Start new task in "]'),
          ].find(button => expectedLabels.includes(button.getAttribute('aria-label')));
          if (!projectButton) {
            throw new Error(
              'The configured project is not present in the Codex sidebar: ' + options.projectPath
            );
          }
          if (projectButton.disabled) {
            throw new Error('The configured project is unavailable in Codex');
          }
          fire(projectButton);
          await waitFor(
            () => document.querySelector('[data-codex-composer=true]'),
            'the project task composer'
          );
          await waitFor(
            () => document.querySelector('[data-composer-navigation-target=workspace-project]')
              ?.textContent.trim() === options.projectName,
            'project ' + options.projectName + ' to be selected'
          );
        }

        const intelligence = await waitFor(
          () => document.querySelector('[data-codex-intelligence-trigger=true]'),
          'the model selector'
        );
        fire(intelligence);
        const modelControl = await waitFor(
          () => [...document.querySelectorAll('[role=menuitem]')]
            .find(element => element.getAttribute('aria-label')?.startsWith('Model ')),
          'the model menu'
        );
        fire(modelControl);
        await waitFor(() => menuItem(options.modelLabel), 'model ' + options.modelLabel);
        fire(menuItem(options.modelLabel));
        await wait(200);

        let effortControl = [...document.querySelectorAll('[role=menuitem]')]
          .find(element => element.getAttribute('aria-label')?.startsWith('Effort '));
        if (!effortControl) {
          const updatedIntelligence = await waitFor(
            () => document.querySelector('[data-codex-intelligence-trigger=true]'),
            'the updated model selector'
          );
          fire(updatedIntelligence);
          effortControl = await waitFor(
            () => [...document.querySelectorAll('[role=menuitem]')]
              .find(element => element.getAttribute('aria-label')?.startsWith('Effort ')),
            'the effort menu'
          );
        }
        fire(effortControl);
        await waitFor(
          () => menuItem(options.reasoningLabel),
          'effort ' + options.reasoningLabel
        );
        fire(menuItem(options.reasoningLabel));
        await wait(250);
        await dismissMenus();

        const selected = document.querySelector('[data-codex-intelligence-trigger=true]');
        if (!selected?.innerText.includes(options.modelLabel)) {
          throw new Error('Codex did not select model ' + options.modelLabel);
        }
        if (selected.getAttribute('data-selected-reasoning-effort') !== options.reasoningValue) {
          throw new Error('Codex did not select reasoning ' + options.reasoningLabel);
        }

        return {continued, expectedThreadKey, existingThreadKeys};
      })().catch(error => ({
        __triggerError: error instanceof Error ? error.message : String(error),
      }))
    `).then((result) => {
      if ("__triggerError" in result) throw new Error(result.__triggerError);
      return result;
    });
  }

  attachFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) return Promise.resolve();
    const serialized = JSON.stringify(paths);
    return this.evaluateMain<true | { __triggerError: string }>(`
      (async () => {
        const {BrowserWindow, dialog} = process.mainModule.require('electron');
        const workerId = globalThis.__triggerCodexWorkerId;
        const worker = workerId == null ? null : BrowserWindow.fromId(workerId);
        if (worker == null || worker.isDestroyed()) {
          throw new Error('The Trigger Codex worker is not running');
        }
        const paths = ${serialized};
        const originalAsync = dialog.showOpenDialog;
        const originalSync = dialog.showOpenDialogSync;
        let pickerUsed = false;
        dialog.showOpenDialog = async () => {
          pickerUsed = true;
          return {canceled: false, filePaths: paths};
        };
        dialog.showOpenDialogSync = () => {
          pickerUsed = true;
          return paths;
        };
        try {
          const clicked = await worker.webContents.executeJavaScript(${JSON.stringify(`
            (async () => {
              const wait = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
              const fire = element => {
                if (!element) throw new Error('The attachment control is unavailable');
                for (const type of ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                  const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
                  element.dispatchEvent(new EventType(type, {
                    bubbles: true,
                    cancelable: true,
                    button: 0,
                    view: window,
                  }));
                }
              };
              const add = document.querySelector('[data-composer-navigation-target=add-context]');
              if (!add) throw new Error('The attachment control is unavailable');
              add.click();
              const deadline = Date.now() + 5000;
              let item = null;
              while (Date.now() < deadline) {
                item = [...document.querySelectorAll('button, [role=menuitem]')]
                  .find(element => {
                    const text = element.innerText.trim();
                    return text.startsWith('Files and folders') ||
                      text.startsWith('Attach files');
                  });
                if (item) break;
                await wait(50);
              }
              if (!item) {
                const available = [...document.querySelectorAll('[role=menuitem]')]
                  .map(element => element.innerText.trim())
                  .filter(Boolean)
                  .join(', ');
                throw new Error(
                  'The Attach files menu item was not found. Control: ' +
                  add.outerHTML + '. Available items: ' + available
                );
              }
              item.click();
              return true;
            })()
          `)});
          if (!clicked) throw new Error('Codex did not open its attachment picker');
          const deadline = Date.now() + 5000;
          while (!pickerUsed && Date.now() < deadline) {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
          }
          if (!pickerUsed) {
            throw new Error('Codex did not request attachment paths');
          }
          await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
          return true;
        } catch (error) {
          return {__triggerError: error instanceof Error ? error.message : String(error)};
        } finally {
          dialog.showOpenDialog = originalAsync;
          dialog.showOpenDialogSync = originalSync;
        }
      })()
    `).then((result) => {
      if (result !== true) throw new Error(result.__triggerError);
    });
  }

  submitPrompt(prompt: string, prepared: PreparedTask): Promise<void> {
    const serialized = JSON.stringify({ prompt, prepared });
    return this.evaluateWorker<true | { __triggerError: string }>(`
      (async () => {
        const {prompt, prepared} = ${serialized};
        const wait = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
        const waitFor = async (read, description, milliseconds = ${UI_TIMEOUT_MS}) => {
          const deadline = Date.now() + milliseconds;
          while (Date.now() < deadline) {
            const value = read();
            if (value) return value;
            await wait(50);
          }
          throw new Error('Timed out waiting for ' + description);
        };
        const fire = element => {
          if (!element) throw new Error('Attempted to click a missing element');
          for (const type of ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
            element.dispatchEvent(new EventType(type, {
              bubbles: true,
              cancelable: true,
              button: 0,
              view: window,
            }));
          }
        };

        try {
          const editor = await waitFor(
            () => document.querySelector('[data-codex-composer=true]'),
            'the prompt editor'
          );
          editor.focus();
          document.execCommand('selectAll', false, null);
          if (!document.execCommand('insertText', false, prompt)) {
            throw new Error('Could not insert text into the Codex composer');
          }
          await wait(100);

          let container = editor;
          while (container.parentElement && !container.querySelector('[data-codex-intelligence-trigger=true]')) {
            container = container.parentElement;
          }
          const sendButton = [...container.querySelectorAll('button')]
            .find(button => {
              const aria = button.getAttribute('aria-label');
              if (aria === 'Send' || aria === 'Send message') return true;
              return !button.hasAttribute('data-composer-navigation-target') &&
                !aria && !button.disabled && button.getBoundingClientRect().width > 0;
            });
          if (!sendButton || sendButton.disabled) {
            throw new Error(prepared.continued
              ? 'The existing Codex task is busy and cannot accept a new prompt'
              : 'The Codex submit button is unavailable');
          }
          fire(sendButton);
          await waitFor(
            () => editor.innerText.trim() === '',
            'Codex to accept the submitted prompt'
          );
          return true;
        } catch (error) {
          return {__triggerError: error instanceof Error ? error.message : String(error)};
        }
      })()
    `).then((result) => {
      if (result !== true) throw new Error(result.__triggerError);
    });
  }

  async closeInspector(): Promise<void> {
    try {
      await this.evaluateMain(
        "setTimeout(() => process.mainModule.require('inspector').close(), 50); true",
      );
    } catch {
      // The inspector closes its own socket before every response is flushed.
    }
    this.socket.close();
  }

  closeSocket(): void {
    this.socket.close();
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    const result = await new Promise<RuntimeResult>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(
          new Error(`Timed out waiting for the Codex inspector (${method})`),
        );
      }, INSPECTOR_REQUEST_TIMEOUT_MS);
      const finish = <T>(operation: (value: T) => void) => (value: T) => {
        clearTimeout(timeout);
        operation(value);
      };
      this.pending.set(id, {
        resolve: finish(resolvePromise),
        reject: finish(rejectPromise),
      });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timeout);
        rejectPromise(error);
      });
    });

    if (result.error) throw new Error(JSON.stringify(result.error));
    const exception = result.result?.exceptionDetails;
    if (exception) {
      throw new Error(
        exception.exception?.description ??
          exception.text ??
          "Codex inspector evaluation failed",
      );
    }
    const runtime = result.result?.result;
    if (runtime?.subtype === "error") {
      throw new Error(runtime.description ?? "Codex inspector evaluation failed");
    }
    return runtime?.value;
  }
}

export class ElectronCodexAppController implements CodexAppController {
  private readonly ownerToken = randomUUID();
  private lockTail: Promise<void> = Promise.resolve();
  private watchdogStarted = false;
  private workerClaimed = false;
  private shuttingDown = false;

  constructor(private readonly options: ElectronCodexAppControllerOptions) {}

  async deliver(request: CodexAppRunRequest): Promise<CodexAppRunResult> {
    return await this.withLock(async () => {
      if (this.shuttingDown) throw new Error("Codex App delivery is shutting down");
      this.startWatchdog();
      this.throwIfAborted(request.signal);
      await this.ensureAppRunning();
      const project = await this.savedProject(request.projectPath);
      const attachments = await this.attachmentPaths(request.attachments);
      const sessionsBefore = request.threadId ? null : await this.sessionFiles();
      const client = await this.preservingFrontmostApplication(() =>
        CodexMainInspectorClient.open(this.executablePath()),
      );
      try {
        await this.preservingFrontmostApplication((frontmostApplication) =>
          client.ensureWorker(this.ownerToken, frontmostApplication),
        );
        this.workerClaimed = true;
        await this.preservingFrontmostApplication(() =>
          client.waitForWorkerReady(),
        );
        if (request.threadId) {
          await this.preservingFrontmostApplication(() =>
            client.navigateWorkerToThread(request.threadId!),
          );
        }
        const prepared = await this.preservingFrontmostApplication(() =>
          client.prepareTask({
            projectPath: project.path,
            projectName: project.name,
            threadId: request.threadId ?? null,
            modelLabel: MODEL_LABELS[request.model],
            reasoningLabel: REASONING_LABELS[request.reasoningEffort],
            reasoningValue: REASONING_VALUES[request.reasoningEffort],
          }),
        );
        this.throwIfAborted(request.signal);
        await this.preservingFrontmostApplication(() =>
          client.attachFiles(attachments),
        );
        await this.preservingFrontmostApplication(() =>
          client.submitPrompt(request.prompt, prepared),
        );
      } finally {
        await this.preservingFrontmostApplication(() =>
          client.closeInspector(),
        );
      }

      this.throwIfAborted(request.signal);
      if (request.threadId) return { threadId: request.threadId };
      if (!sessionsBefore) throw new Error("Codex session snapshot is missing");
      return {
        threadId: await this.findNewSession(sessionsBefore, request.prompt),
      };
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.lockTail;
    if (!this.workerClaimed) return;
    if (!(await this.isAppRunning())) return;
    let client: CodexMainInspectorClient | null = null;
    try {
      client = await this.preservingFrontmostApplication(() =>
        CodexMainInspectorClient.open(this.executablePath()),
      );
      await this.preservingFrontmostApplication(() =>
        client!.closeWorker(this.ownerToken),
      );
      this.workerClaimed = false;
      await this.preservingFrontmostApplication(() =>
        client!.closeInspector(),
      );
      client = null;
    } catch (error) {
      console.error(
        "Could not close the Trigger Codex worker:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      client?.closeSocket();
    }
  }

  private startWatchdog(): void {
    if (this.watchdogStarted) return;
    this.watchdogStarted = true;
    const script = new URL("./worker-watchdog.mjs", import.meta.url);
    const child = spawn(
      process.execPath,
      [
        script.pathname,
        String(process.pid),
        this.ownerToken,
        this.executablePath(),
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  }

  private async ensureAppRunning(): Promise<void> {
    if (await this.isAppRunning()) return;
    const appPath = resolve(this.options.appPath);
    const details = await stat(appPath).catch(() => null);
    if (!details?.isDirectory()) {
      throw new Error(`Codex App was not found: ${appPath}`);
    }
    await execFileAsync("open", [appPath]);
    const deadline =
      Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (await this.isAppRunning()) return;
      await delay(250);
    }
    throw new Error("Timed out waiting for Codex App to start");
  }

  private async isAppRunning(): Promise<boolean> {
    const executable = this.executablePath();
    const { stdout } = await execFileAsync("ps", ["-axo", "command="]);
    return stdout
      .split("\n")
      .map((command) => command.trim())
      .some(
        (command) =>
          command === executable || command.startsWith(`${executable} `),
      );
  }

  private executablePath(): string {
    return join(resolve(this.options.appPath), "Contents", "MacOS", "ChatGPT");
  }

  private async preservingFrontmostApplication<T>(
    operation: (frontmostApplication: string | null) => Promise<T>,
  ): Promise<T> {
    const frontmostApplication = await frontmostApplicationBundleId();
    try {
      return await operation(frontmostApplication);
    } finally {
      await this.restoreFrontmostApplication(frontmostApplication);
      await delay(25);
      await this.restoreFrontmostApplication(frontmostApplication);
      await delay(75);
      await this.restoreFrontmostApplication(frontmostApplication);
    }
  }

  private async restoreFrontmostApplication(
    previousBundleId: string | null,
  ): Promise<void> {
    if (!previousBundleId || process.platform !== "darwin") return;
    const codexBundleId = await bundleIdentifier(this.options.appPath);
    if (!codexBundleId || previousBundleId === codexBundleId) return;
    const currentBundleId = await frontmostApplicationBundleId();
    if (currentBundleId !== codexBundleId) return;
    await activateApplication(previousBundleId);
  }

  private async savedProject(projectPath: string): Promise<{
    path: string | null;
    name: string | null;
  }> {
    if (projectPath.trim() === "") return { path: null, name: null };
    const normalized = resolve(projectPath);
    const details = await stat(normalized).catch(() => null);
    if (!details?.isDirectory()) {
      throw new Error(`Codex App projectPath is not a directory: ${normalized}`);
    }
    const statePath = resolve(
      process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
      ".codex-global-state.json",
    );
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      "electron-saved-workspace-roots"?: string[];
    };
    const roots = (state["electron-saved-workspace-roots"] ?? []).map((root) =>
      resolve(root),
    );
    if (!roots.includes(normalized)) {
      throw new Error(
        `Codex App project is not saved: ${normalized}. Add it to Codex first.`,
      );
    }
    return { path: normalized, name: basename(normalized) };
  }

  private async attachmentPaths(attachments: string[]): Promise<string[]> {
    return await Promise.all(
      attachments.map(async (attachment) => {
        const path = resolve(attachment);
        if (!(await stat(path).catch(() => null))) {
          throw new Error(`Codex App attachment does not exist: ${path}`);
        }
        return path;
      }),
    );
  }

  private sessionsRoot(): string {
    return resolve(
      process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
      "sessions",
    );
  }

  private async sessionFiles(): Promise<Set<string>> {
    try {
      const entries = await readdir(this.sessionsRoot(), { recursive: true });
      return new Set(
        entries
          .filter((entry) => entry.endsWith(".jsonl"))
          .map((entry) => join(this.sessionsRoot(), entry)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw error;
    }
  }

  private async findNewSession(
    previous: Set<string>,
    prompt: string,
  ): Promise<string> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = await this.sessionFiles();
      for (const path of current) {
        if (previous.has(path)) continue;
        try {
          const contents = await readFile(path, "utf8");
          const lines = contents.split("\n").filter(Boolean);
          const events = lines.map((line) => JSON.parse(line) as {
            type?: string;
            payload?: {
              id?: string;
              session_id?: string;
              type?: string;
              role?: string;
              message?: string;
              content?: Array<{ type?: string; text?: string }>;
            };
          });
          const expectedPrompt = prompt.trim();
          const matchesPrompt = (value: string | undefined) => {
            const normalized = value?.trim();
            return normalized === expectedPrompt ||
              normalized?.endsWith(expectedPrompt) === true;
          };
          const hasPrompt = events.some((event) => {
            if (
              event.type === "event_msg" &&
              event.payload?.type === "user_message"
            ) {
              return matchesPrompt(event.payload.message);
            }
            if (
              event.type === "response_item" &&
              event.payload?.role === "user"
            ) {
              return event.payload.content?.some(
                (item) =>
                  item.type === "input_text" &&
                  matchesPrompt(item.text),
              );
            }
            return false;
          });
          if (!hasPrompt) continue;
          const firstEvent = JSON.parse(lines[0]!) as {
            payload?: { id?: string; session_id?: string };
          };
          const id = firstEvent.payload?.id ?? firstEvent.payload?.session_id;
          if (id) return id;
        } catch {
          // A new session can be observed while its first event is being written.
        }
      }
      await delay(100);
    }
    throw new Error("Timed out waiting for Codex to persist the new task");
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Codex App delivery was aborted");
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.lockTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function mainPid(executable: string): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  const pids = stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter(
      (match): match is RegExpMatchArray =>
        match !== null &&
        (match[2] === executable || match[2]!.startsWith(`${executable} `)),
    )
    .map((match) => Number(match[1]));
  if (pids.length === 0) throw new Error("Codex App is not running");
  return Math.min(...pids);
}

async function bundleIdentifier(appPath: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("defaults", [
      "read",
      join(resolve(appPath), "Contents", "Info.plist"),
      "CFBundleIdentifier",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function frontmostApplicationBundleId(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js',
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function activateApplication(bundleId: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(bundleId)) return;
  try {
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      `tell application id "${bundleId}" to activate`,
    ]);
  } catch {
    // Focus restoration is best effort and must not fail a delivery.
  }
}

async function inspectorPages(): Promise<InspectorPage[]> {
  const pages: InspectorPage[] = [];
  await Promise.all(
    Array.from({ length: INSPECTOR_PORT_COUNT }, (_, index) =>
      INSPECTOR_PORT_START + index,
    ).map(async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(200),
        });
        if (!response.ok) return;
        const found = (await response.json()) as InspectorPage[];
        pages.push(...found.filter((page) => page.webSocketDebuggerUrl));
      } catch {
        // Most inspector ports are expected to be closed.
      }
    }),
  );
  return pages;
}

async function connectWebSocket(url: string): Promise<WebSocket> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.terminate();
      rejectPromise(new Error("Timed out connecting to the Codex inspector"));
    }, 5_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolvePromise(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
}
