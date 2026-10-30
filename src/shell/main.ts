import "./styles.css";
import { SHELL_VIEW, initializeShellView } from "./shell-view";
import { SettingsController, type SettingsOptions } from "./settings";
import { Workspace } from "./workspace";
import {
  AIService,
  defaultAIConfig,
  normalizeAIConfig,
  missingProviderRoles,
  CodingHarness,
  converse,
  BehaviorAdvisor,
  LiveVoice,
  demoAIConfig,
} from "../ai";
import { AIError } from "../ai/providers";
import {
  accountSession,
  completeAccountCallback,
  redactAccountDiagnostic,
} from "../ai/connection";
import {
  findReferencedApps,
  type ClarificationChoice,
  type ConversationEnvironment,
} from "../ai/conversation";
import {
  emptyPreferenceMemory,
  normalizePreferenceMemory,
  applyMemoryChanges,
  mergePreferenceEdits,
  getMemoryContext,
  PREFERENCE_MEMORY_SETTING,
  type PreferenceMemory,
} from "../ai/memory";
import { serviceTierFor, type ResponseSpeed } from "../ai/types";
import { BUILD_INFO, buildLabel } from "../shared/build";
import { failureEvidence } from "../shared/errors";
import type {
  ProviderCredentials,
  AIConfig,
  AIRole,
  ApplicationAIRequest,
  UsageRecord,
} from "../ai/types";
import type { BehaviorObservation, ChatMessage } from "../shared/types";

const root = document.querySelector<HTMLDivElement>("#shell")!;
root.innerHTML = SHELL_VIEW;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const workspace = new Workspace($("app-container"));
workspace.diagnostics.sanitizeDiagnostic = redactAccountDiagnostic;
let config: AIConfig = defaultAIConfig();
let credentials: ProviderCredentials = {};
try {
  const stored: unknown = JSON.parse(
    localStorage.getItem("itsalive.credentials") ?? "{}",
  );
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const provider of ["openai"] as const) {
      const value = (stored as Record<string, unknown>)[provider];
      if (typeof value === "string" && value.trim())
        credentials[provider] = value.trim();
    }
  }
} catch {
  /* invalid local credentials can be replaced in Settings */
}
let ai: AIService;
let advisor: BehaviorAdvisor;
let coding = false;
let codingController: AbortController | undefined;
let codingStage = "Building your application…";
let workTimer: ReturnType<typeof setInterval> | undefined;
let voice: LiveVoice | undefined;
let voiceStarting = false;
let microphoneEnabled = true;
let usageWrites: Promise<void> = Promise.resolve();
let backupController: AbortController | null = null;
let activeTab = "preview";
let personalization: PreferenceMemory = emptyPreferenceMemory();
function voiceContextText() {
  return JSON.stringify({
    currentApp: workspace.current
      ? {
          id: workspace.current.id,
          name: workspace.current.name,
          revisionId: workspace.revision?.id,
        }
      : null,
    preferences: getMemoryContext(
      personalization,
      workspace.current?.id ?? "workspace",
    ),
    availableApps:
      "Ask the companion for actual saved app context when inspecting or comparing apps.",
  });
}
let workContext: { appId: string; correlationId: string } | undefined;
const presentedErrors = new WeakSet<object>();
const errorContexts = new WeakMap<
  object,
  { appId: string; correlationId: string }
>();
let pendingWorkAction: (() => Promise<void>) | undefined;
let conflictAction: (() => Promise<void>) | undefined;
let latestConversation = 0;
const conversationPlans = new Map<string, Promise<void>>();
const planningControllers = new Set<AbortController>();
const hasPendingWork = () => coding || conversationPlans.size > 0;
interface FailedConversation {
  text: string;
  liveHistory: Array<{ role: "user" | "assistant"; content: string }>;
  revisionId: string;
  failedAt: number;
}
async function refreshRetry() {
  const appId = workspace.current?.id;
  if (!appId) {
    $("retry-work").hidden = true;
    return;
  }
  const [draft, failed] = await Promise.all([
    workspace.repo.getCodingCheckpoint(appId),
    workspace.repo.getSetting<FailedConversation | null>(
      `conversation.retry.${appId}`,
    ),
  ]);
  if (workspace.current?.id !== appId) return;
  $("retry-work").hidden =
    hasPendingWork() ||
    !(
      draft?.baseRevisionId === workspace.revision?.id ||
      failed?.revisionId === workspace.revision?.id
    );
}
function continuePendingAction() {
  if (!hasPendingWork() && !queuedEdits.length && pendingWorkAction) {
    const next = pendingWorkAction;
    pendingWorkAction = undefined;
    action(next);
  }
}
const setStatus = (message: string) => {
  if (coding && message === "Ready") message = codingStage;
  if ($("status").textContent === message) return;
  $("status").textContent = message;
  $("status").title = message;
  if (workContext)
    void workspace.diagnostics.record(
      "ui.progress.presented",
      { message },
      workContext,
    );
};
workspace.onStatus = setStatus;
workspace.onApplying = (_appId, active) => {
  $<HTMLButtonElement>("cancel-work").disabled = active;
  $<HTMLButtonElement>("build-conflict-cancel").disabled = active;
  if (active) setStatus("Saving your verified change…");
};
workspace.onWarning = (message) => {
  const warning =
    document.getElementById("workspace-warning") ??
    element("div", undefined, "assistance-prompt");
  warning.id = "workspace-warning";
  warning.setAttribute("role", "status");
  warning.replaceChildren(element("p", message));
  const dismiss = element("button", "Dismiss", "quiet");
  dismiss.onclick = () => warning.remove();
  warning.append(dismiss);
  $("chat").after(warning);
};
const context = () => ({
  appId: workspace.current?.id ?? "workspace",
  correlationId: crypto.randomUUID(),
});
function report(error: unknown) {
  if (error && typeof error === "object" && presentedErrors.has(error)) return;
  const detail = error instanceof Error ? error.message : String(error);
  void workspace.diagnostics.record(
    "operation.failed",
    {
      error: failureEvidence(error),
      ...(error instanceof AIError ? error.detail : {}),
    },
    error && typeof error === "object"
      ? (errorContexts.get(error) ?? context())
      : context(),
  );
  const message =
    error instanceof AIError
      ? error.message
      : /key|credential|provider|connect|authentication|401|403/i.test(detail)
        ? "AI couldn't connect. Check your provider and API key in Settings, then try again."
        : /budget|limit|429|rate/i.test(detail)
          ? "An AI usage limit was reached. Check your limits in Settings or try again later."
          : /network|fetch|offline/i.test(detail)
            ? "The connection was interrupted. Check your internet connection and try again."
            : /already|wait|finish|backup|restore|write a question|describe|characters|microphone|speech|recognition|Type your message/i.test(
                  detail,
                )
              ? detail
              : "That didn't work. Your last working application is safe. Please try again.";
  setStatus(message);
}
function action(fn: () => Promise<unknown>) {
  void fn().catch(report);
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function showTab(tab: string) {
  activeTab = tab;
  for (const name of ["preview", "history"]) $(name).hidden = name !== tab;
  if (tab === "history") action(renderHistory);
}
async function renderHistory() {
  const list = $("revision-list");
  list.replaceChildren();
  if (!workspace.current) return;
  const appId = workspace.current.id;
  const revisions = await workspace.repo.listRevisions(appId);
  if (workspace.current?.id !== appId) return;
  for (const revision of revisions.reverse()) {
    const initialSetup =
      revision.parent === null && revision.message === "Created application";
    const row = element("div", undefined, "revision-row");
    const info = element("div");
    info.append(
      element("strong", initialSetup ? "Initial setup" : revision.message),
      element("small", new Date(revision.createdAt).toLocaleString()),
    );
    const button = element(
      "button",
      revision.id === workspace.revision?.id
        ? "Current"
        : initialSetup
          ? "Setup"
          : "Restore",
      "quiet",
    );
    button.disabled = initialSetup || revision.id === workspace.revision?.id;
    if (initialSetup)
      button.title = "Your app had not been created at this point.";
    button.onclick = () =>
      action(async () => {
        if (hasPendingWork())
          showWorkConflict(async () => {
            await workspace.rollback(revision.id);
          }, "restore this version");
        else await workspace.rollback(revision.id);
      });
    row.append(info, button);
    list.append(row);
  }
}
async function renderChat() {
  const chat = $("chat");
  if (!workspace.current) {
    chat.innerHTML =
      '<div class="chat-intro first-run-chat"><h2>What would you like to do?</h2><p>Describe a goal to create an app.</p></div>';
    delete chat.dataset.appId;
    return;
  }
  const appId = workspace.current.id;
  const messages = await workspace.repo.listChat(appId);
  if (workspace.current?.id !== appId) return;
  const changedApp = chat.dataset.appId !== appId;
  const nearBottom =
    chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  const known = new Set(messages.map((message) => message.id));
  const reset =
    changedApp ||
    [...chat.querySelectorAll<HTMLElement>("[data-message-id]")].some(
      (node) => !known.has(node.dataset.messageId!),
    );
  if (reset) {
    chat.setAttribute("aria-live", "off");
    chat.replaceChildren();
    chat.dataset.appId = appId;
    requestAnimationFrame(() => {
      if (chat.dataset.appId === appId)
        chat.setAttribute("aria-live", "polite");
    });
  }
  if (!messages.length) {
    chat.innerHTML = '<p class="chat-intro">What would you like help with?</p>';
    return;
  }
  chat.querySelector(".chat-intro")?.remove();
  const displayed = new Set(
    [...chat.querySelectorAll<HTMLElement>("[data-message-id]")].map(
      (node) => node.dataset.messageId,
    ),
  );
  for (const message of messages) {
    if (displayed.has(message.id)) continue;
    const bubble = element("div", undefined, `chat-message ${message.role}`);
    bubble.dataset.messageId = message.id;
    bubble.append(
      element("span", message.role === "user" ? "You" : "Assistant"),
      element("p", message.content),
    );
    chat.append(bubble);
  }
  await renderFeedback(appId);
  if (changedApp || nearBottom) chat.scrollTop = chat.scrollHeight;
}
async function render() {
  const apps = await workspace.repo.listApps();
  const list = $("app-list");
  list.replaceChildren(
    ...apps.map((app) => {
      const button = element(
        "button",
        undefined,
        `app-link${app.id === workspace.current?.id ? " selected" : ""}`,
      );
      button.append(
        element("span", "◇", "app-icon"),
        element("span", app.name),
      );
      button.onclick = () =>
        action(async () => {
          $("proposal").hidden = true;
          $("suggestion").hidden = true;
          $("clarification").hidden = true;
          if (hasPendingWork() && app.id !== workspace.current?.id) {
            showWorkConflict(
              () => workspace.openApp(app.id),
              `open ${app.name}`,
            );
            return;
          }
          await workspace.openApp(app.id);
        });
      return button;
    }),
  );
  root.classList.toggle("has-app", !!workspace.current);
  $("welcome").hidden = !!workspace.current;
  $("app-name").textContent = workspace.current?.name ?? "Your apps";
  $<HTMLTextAreaElement>("message").placeholder = workspace.current
    ? "Ask or describe a change…"
    : "Describe the app you want to create…";
  $<HTMLButtonElement>("rename-app").disabled = !workspace.current;
  $<HTMLButtonElement>("restore-version").disabled = !workspace.current;
  $<HTMLButtonElement>("rail-history").disabled = !workspace.current;
  $<HTMLButtonElement>("app-title").disabled = !workspace.current;
  await refreshRetry();
  if (activeTab === "history") await renderHistory();
  await renderChat();
  if (voice?.active) voice.updateContext(voiceContextText());
}
const shellView = initializeShellView({
  showTab,
  onSpeedChange: (speed) => action(() => changeSpeed(speed)),
  onUsageClick: () => {
    settings.open();
    const usage = $("usage-summary").closest("details");
    if (usage) usage.open = true;
    $("usage-summary").scrollIntoView({ block: "nearest" });
  },
});
function refreshUsage() {
  if (!ai) return;
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const records = ai.usage.filter((row) => row.timestamp >= start);
  const known = records.filter(
    (row) => row.status !== "pending" && row.costStatus !== "unknown",
  );
  shellView.setUsage(
    known.reduce((sum, row) => sum + row.costUSD, 0),
    records.filter((row) => row.costStatus === "unknown").length,
  );
}
async function changeSpeed(speed: ResponseSpeed) {
  const next = structuredClone(config);
  next.speed = speed;
  for (const [role, route] of Object.entries(next.routes))
    if (role !== "speech")
      route.serviceTier = serviceTierFor(route.model, speed);
  ai.configure(next);
  config = next;
  await workspace.repo.setSetting("ai.config", config);
  shellView.setSpeed(speed);
  await workspace.diagnostics.record(
    "preferences.speed.changed",
    { speed, appliesTo: "subsequent_requests" },
    context(),
  );
  refreshProviderBadge();
}
function showWorkConflict(
  next: () => Promise<void>,
  actionLabel = "start your new app",
) {
  conflictAction = next;
  const dialog = $<HTMLDialogElement>("build-conflict-dialog");
  dialog.querySelector("p")!.textContent = `When should I ${actionLabel}?`;
  $("build-conflict-wait").textContent = "After this change finishes";
  $("build-conflict-cancel").textContent = "Stop this change and continue";
  if (!dialog.open) dialog.showModal();
  void workspace.diagnostics.record(
    "ui.operation.blocked",
    { operation: actionLabel, reason: "work_in_progress" },
    workContext ?? context(),
  );
}
for (const [id, cancel] of [
  ["build-conflict-wait", false],
  ["build-conflict-cancel", true],
] as const)
  $(id).onclick = () => {
    pendingWorkAction = conflictAction;
    conflictAction = undefined;
    $<HTMLDialogElement>("build-conflict-dialog").close();
    $<HTMLDialogElement>("create-dialog").close();
    if (!hasPendingWork()) {
      const next = pendingWorkAction;
      pendingWorkAction = undefined;
      if (next) action(next);
    } else if (cancel) {
      codingController?.abort();
      for (const controller of planningControllers) controller.abort();
    } else setStatus("Your next action will start when this change finishes.");
  };
$<HTMLDialogElement>("build-conflict-dialog").addEventListener("close", () => {
  conflictAction = undefined;
});
workspace.onChange = () => action(render);
async function appendMessage(
  role: ChatMessage["role"],
  content: string,
  appId = workspace.current?.id,
) {
  if (!appId) return;
  await workspace.repo.appendChat({
    id: crypto.randomUUID(),
    appId,
    role,
    content,
    createdAt: Date.now(),
  });
  if (workspace.current?.id === appId) await renderChat();
}
interface FeedbackAttempt {
  id: string;
  appId: string;
  revisionId: string;
  originalRequest: string;
  intent: string;
  status: "offered" | "unresolved" | "resolved" | "dismissed" | "superseded";
  createdAt: number;
}
async function feedbackAttempts(appId: string): Promise<FeedbackAttempt[]> {
  return (
    (await workspace.repo.getSetting<FeedbackAttempt[]>(`feedback.${appId}`)) ??
    []
  );
}
async function saveFeedback(attempt: FeedbackAttempt) {
  const attempts = await feedbackAttempts(attempt.appId);
  const next = attempts.filter((item) => item.id !== attempt.id);
  next.push(attempt);
  await workspace.repo.setSetting(`feedback.${attempt.appId}`, next);
}
async function renderFeedback(appId: string) {
  const attempts = await feedbackAttempts(appId);
  if (workspace.current?.id !== appId) return;
  $("chat")
    .querySelectorAll(".feedback")
    .forEach((node) => node.remove());
  const attempt = attempts.at(-1);
  if (
    coding ||
    !attempt ||
    attempt.status !== "offered" ||
    attempt.revisionId !== workspace.revision?.id
  )
    return;
  const feedback = element("div", undefined, "feedback");
  feedback.append(element("span", "Did this change help?"));
  for (const [label, status] of [
    ["Yes", "resolved"],
    ["Not yet", "unresolved"],
    ["Dismiss", "dismissed"],
  ] as const) {
    const button = element("button", label, "quiet");
    button.onclick = () =>
      action(async () => {
        if (workspace.current?.id !== appId) return;
        feedback.remove();
        attempt.status = status;
        await saveFeedback(attempt);
        await workspace.diagnostics.record(
          "adaptation.feedback",
          {
            helpful:
              status === "resolved"
                ? true
                : status === "unresolved"
                  ? false
                  : null,

            feedbackId: attempt.id,
          },
          { appId, revisionId: attempt.revisionId },
        );
        if (status !== "unresolved") return;
        shellView.showAssistant();
        await appendMessage("user", "Not yet.", appId);
        // Inspect deterministic evidence before asking the user to explain a known failure.
        const inspection = await workspace.inspect().catch(() => null);
        if (workspace.current?.id !== appId) return;
        if (inspection?.errors.length) {
          await appendMessage(
            "assistant",
            "I found a problem while checking the app. I'll investigate and try to fix it.",
            appId,
          );
          await runCoding(
            `${attempt.intent}\nThe previous attempt did not help. Investigate these observed runtime errors and repair the original goal: ${JSON.stringify(inspection.errors)}`,
            attempt.originalRequest,
          );
        } else {
          await appendMessage(
            "assistant",
            "What's still not working as you expected?",
            appId,
          );
          $<HTMLTextAreaElement>("message").focus();
        }
      });
    feedback.append(button);
  }
  $("chat")
    .querySelectorAll(".feedback")
    .forEach((node) => node.remove());
  $("chat").append(feedback);
}
type WorkLevel = "low" | "medium" | "high";
interface QueuedEdit {
  level: WorkLevel;
  appId: string;
  intent: string;
  originalRequest: string;
  operation?: { correlationId: string; startedAt: number };
  resolve(): void;
  reject(error: unknown): void;
}
const queuedEdits: QueuedEdit[] = [];
async function runCoding(
  intent: string,
  originalRequest = intent,
  level: WorkLevel = "medium",
  resume = false,
  operation?: { correlationId: string; startedAt: number },
) {
  const role = (
    {
      low: "coding-simple",
      medium: "coding-standard",
      high: "coding-complex",
    } as const
  )[level];
  const requestedAppId = workspace.current?.id;
  if (
    !requireAIReady(async () => {
      if (requestedAppId && workspace.current?.id !== requestedAppId)
        await workspace.openApp(requestedAppId);
      await runCoding(intent, originalRequest, level, resume, operation);
    }, [role])
  )
    return;
  if (coding) {
    if (!requestedAppId || queuedEdits.length >= 8)
      throw new Error(
        "Several changes are already waiting. Let them finish before adding more.",
      );
    setStatus("Your next change is queued. You can keep talking.");
    return new Promise<void>((resolve, reject) =>
      queuedEdits.push({
        level,
        appId: requestedAppId,
        intent,
        originalRequest,
        operation,
        resolve,
        reject,
      }),
    );
  }
  if (!workspace.revision)
    throw new Error("Describe the application you'd like first.");
  coding = true;
  codingController = new AbortController();
  const controller = codingController;
  $("status").classList.add("is-active");
  $("cancel-work").hidden = false;
  $<HTMLButtonElement>("cancel-work").disabled = false;
  $("retry-work").hidden = true;
  $("work-elapsed").hidden = false;
  const started = performance.now();
  const updateElapsed = () => {
    const seconds = Math.floor((performance.now() - started) / 1000);
    $("work-elapsed").textContent =
      seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  updateElapsed();
  workTimer = setInterval(updateElapsed, 1000);
  $("chat")
    .querySelectorAll(".feedback")
    .forEach((node) => node.remove());
  const base = workspace.revision;
  let committedRevisionId: string | undefined;
  const codingContext = {
    ...context(),
    ...(operation ? { correlationId: operation.correlationId } : {}),
  };
  workContext = codingContext;
  shellView.setCreating(base.parent === null, workspace.current?.name);
  $("clarification").hidden = true;
  const updates = new Set<string>();
  const showWorkUpdate = async (message: string) => {
    setStatus(message);
    if (updates.has(message)) return;
    updates.add(message);
    await appendMessage("assistant", message, base.appId);
    if (voice?.active) voice.reportProgress(message);
    await workspace.diagnostics.record(
      "coding.progress.delivered",
      { message },
      codingContext,
    );
  };
  codingStage =
    base.parent === null ? "Creating your app…" : "Working on your changes…";
  setStatus(codingStage);
  const requireSameApp = () => {
    if (
      workspace.current?.id !== base.appId ||
      workspace.revision?.id !== base.id ||
      workspace.isBackingUp
    )
      throw new Error(
        "The application changed while this request was running. Please try again in the app you want to change.",
      );
  };
  try {
    const previousAttempts = await feedbackAttempts(base.appId);
    for (const attempt of previousAttempts.filter(
      (item) => item.status === "offered",
    )) {
      attempt.status = "superseded";
      await saveFeedback(attempt);
    }
    const harness = new CodingHarness(ai, {
      loadCheckpoint: (appId) => workspace.repo.getCodingCheckpoint(appId),
      saveCheckpoint: (checkpoint) =>
        workspace.repo.saveCodingCheckpoint(checkpoint),
      clearCheckpoint: (appId, checkpointId) =>
        workspace.repo.clearCodingCheckpoint(appId, checkpointId),
      onProgress: ({ stage, message }) => {
        codingStage =
          message ??
          {
            understanding: "Planning the changes…",
            building: "Building your application…",
            checking: "Checking the application…",
            repairing: "Fixing a problem found during checking…",
            finishing: "Finishing your application…",
            recovering: "Resuming your saved progress…",
          }[stage];
        setStatus(codingStage);
      },
      onActivity: async (activity) => {
        const result = await workspace.setActivity(activity, base.appId);
        await showWorkUpdate(activity.message);
        return result;
      },
      onEvent: ({ event, data, level }) => {
        void workspace.diagnostics.record(event, data, codingContext, level);
      },
      compile: (project) => {
        requireSameApp();
        setStatus("Checking the changes…");
        return workspace.compiler.compile(project, crypto.randomUUID());
      },
      verify: (artifact) => {
        requireSameApp();
        setStatus("Checking the changes…");
        return workspace.verify(artifact, codingContext);
      },
      commit: async (project, artifact, baseRevisionId) => {
        requireSameApp();
        const revisionId = await workspace.applyProject(
          project,
          baseRevisionId,
          originalRequest,
          artifact,
          codingContext.correlationId,
          controller.signal,
        );
        committedRevisionId = revisionId;
        return revisionId;
      },
      inspect: () => {
        requireSameApp();
        return workspace.inspect();
      },
      onTool: (event) => {
        void workspace.diagnostics.record("coding.tool", event, codingContext);
      },
    });
    const result = await harness.run({
      project: structuredClone(base.project),
      baseRevisionId: base.id,
      intent,
      originalRequest,
      resume,
      signal: controller.signal,
      authorized: true,
      role,
      context: codingContext,
    });
    await workspace.diagnostics.record(
      "coding.complete",
      { changedFiles: result.changedFiles },
      codingContext,
    );
    await saveFeedback({
      id: crypto.randomUUID(),
      appId: base.appId,
      revisionId: result.revisionId,
      originalRequest,
      intent,
      status: "offered",
      createdAt: Date.now(),
    });
    const completion = await describeCompletion(
      result.summary,
      originalRequest,
      { ...codingContext, signal: controller.signal },
    );
    await appendMessage("assistant", completion, base.appId);
    await workspace.diagnostics.record(
      "adaptation.feedback.offered",
      { originalRequest, feedbackRevision: result.revisionId },
      codingContext,
    );
    if (workspace.current?.id === base.appId) {
      $("proposal").hidden = true;
      setStatus("Ready to try");
      shellView.setMobileView("app");
      await workspace.diagnostics.record(
        "ui.result.presented",
        {
          outcome: "applied",
          revisionId: result.revisionId,
          promptToReadyMs:
            performance.now() - (operation?.startedAt ?? started),
        },
        codingContext,
      );
    }
  } catch (error) {
    if (committedRevisionId) {
      await workspace.diagnostics
        .record(
          "coding.completion-report.failed",
          {
            error: failureEvidence(error),
            committedRevisionId,
          },
          codingContext,
        )
        .catch(() => undefined);
      workspace.onWarning(
        "Your change is ready, but its conversation update could not be saved. The app and version history contain the change.",
      );
      setStatus("Ready to try");
      return;
    }
    await workspace.diagnostics.record(
      controller.signal.aborted ? "coding.cancelled" : "coding.failed",
      { error: failureEvidence(error), cancelled: controller.signal.aborted },
      codingContext,
    );
    const cancelled = controller.signal.aborted;
    const savedDraft = await workspace.repo
      .getCodingCheckpoint(base.appId)
      .catch(() => undefined);
    const progressSaved = !!savedDraft && savedDraft.baseRevisionId === base.id;
    await appendMessage(
      "assistant",
      cancelled
        ? progressSaved
          ? "Stopped. Your progress is saved. Choose Try again when you’re ready to continue."
          : "Stopped. Your working app is safe. Ask me to try again when you’re ready."
        : error instanceof AIError
          ? error.message
          : base.parent === null
            ? "I couldn't finish creating your app. Your request is saved. You can ask me to retry or download diagnostic logs in Settings."
            : "I couldn't apply this change. Your working app is safe. Choose Try again to repair the saved work.",
      base.appId,
    );
    setStatus(
      `${cancelled ? "Stopped" : "Couldn’t finish"}${progressSaved ? " — progress saved" : ""}`,
    );
    if (!cancelled) {
      if (error && typeof error === "object") presentedErrors.add(error);
      throw error;
    }
  } finally {
    await workspace.clearActivity(base.appId).catch(() => undefined);
    coding = false;
    codingController = undefined;
    clearInterval(workTimer);
    $("status").classList.remove("is-active");
    $("cancel-work").hidden = true;
    $("work-elapsed").hidden = true;
    shellView.setCreating(false);
    workContext = undefined;
    await refreshRetry().catch(() => undefined);
    if (controller.signal.aborted) {
      for (const queued of queuedEdits.splice(0)) {
        const cancelled = new DOMException(
          "Queued change cancelled.",
          "AbortError",
        );
        presentedErrors.add(cancelled);
        void workspace.diagnostics.record(
          "coding.cancelled",
          { queued: true },
          {
            appId: queued.appId,
            correlationId:
              queued.operation?.correlationId ?? codingContext.correlationId,
          },
        );
        queued.reject(cancelled);
      }
    }
    if (workspace.current?.id === base.appId)
      await renderChat().catch(() => undefined);
    while (queuedEdits.length) {
      const next = queuedEdits.shift()!;
      if (workspace.current?.id !== next.appId) {
        next.reject(
          new Error(
            "The app changed before a queued request began. Open the intended app and try again.",
          ),
        );
        continue;
      }
      void runCoding(
        next.intent,
        next.originalRequest,
        next.level,
        false,
        next.operation,
      ).then(next.resolve, next.reject);
      break;
    }
    continuePendingAction();
  }
}
async function describeCompletion(
  summary: string,
  request: string,
  requestContext: {
    appId: string;
    correlationId: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const clean = summary.trim();
  // A goal-oriented worker summary can be used directly. Rephrase technical summaries through the companion.
  if (
    clean &&
    !/(?:\b(?:tsx?|jsx?|webpack|vite|typescript|compile[dr]?|implementation|tool call|source code)\b|(?:src|node_modules)\/|```)/i.test(
      clean,
    )
  )
    return clean;
  try {
    const response = await ai.generate(
      "conversation",
      {
        messages: [
          {
            role: "system",
            content:
              "Explain a successfully applied application change to its user in one or two concise sentences. Say what they can now try, using only the supplied verified completion summary and request. Do not expose file names, tools, compilation, dependencies or internal machinery. Do not claim tests or capabilities beyond the evidence. Return plain text.",
          },
          {
            role: "user",
            content: JSON.stringify({ request, verifiedSummary: clean }),
          },
        ],
      },
      requestContext,
    );
    return response.text.trim() || "Your changes are ready to try.";
  } catch {
    return "Your changes are ready to try.";
  }
}
function showConfirmation(
  intent: string,
  reason: string,
  originalRequest: string,
  level: WorkLevel = "medium",
  operation?: { correlationId: string; startedAt: number },
) {
  const appId = workspace.current?.id;
  const revisionId = workspace.revision?.id;
  const box = $("proposal");
  box.hidden = false;
  box.replaceChildren(element("p", reason));
  const button = element("button", "Confirm this change", "primary");
  button.onclick = () =>
    action(async () => {
      if (
        workspace.current?.id !== appId ||
        workspace.revision?.id !== revisionId
      )
        throw new Error(
          "This application changed after the question was asked. Please request the change again.",
        );
      box.hidden = true;
      await appendMessage("user", "Confirm this change.", appId);
      await runCoding(intent, originalRequest, level, false, operation);
    });
  const dismiss = element("button", "Cancel", "quiet");
  dismiss.onclick = () => {
    box.hidden = true;
  };
  box.append(button, dismiss);
}
async function observe(observation: BehaviorObservation) {
  if (
    !workspace.current ||
    workspace.isBackingUp ||
    missingProviderRoles(config, credentials, ["decision"]).length
  )
    return;
  const suggestion = await advisor.observe(observation, context());
  if (!suggestion || suggestion.appId !== workspace.current?.id) return;
  const box = $("suggestion");
  box.hidden = false;
  box.replaceChildren(element("p", suggestion.explanation));
  const accept = element("button", "Try this", "quiet");
  accept.onclick = () =>
    action(async () => {
      if (workspace.current?.id !== suggestion.appId)
        throw new Error("Open the application this suggestion belongs to");
      box.hidden = true;
      const accepted = advisor.resolve(suggestion.id, "accepted");
      if (accepted)
        await runCoding(accepted.changeRequest, accepted.explanation);
    });
  const dismiss = element("button", "Dismiss", "quiet");
  dismiss.onclick = () => {
    advisor.resolve(suggestion.id, "dismissed");
    box.hidden = true;
  };
  box.append(accept, dismiss);
}
workspace.onBehavior = (observation) => action(() => observe(observation));
function showCreate() {
  $<HTMLDialogElement>("create-dialog").showModal();
  $<HTMLInputElement>("create-form")
    .querySelector<HTMLTextAreaElement>("textarea")
    ?.focus();
}
$("new-app").onclick = showCreate;
$("welcome-create").onclick = showCreate;
let pendingRequest: (() => Promise<void>) | undefined;
let pendingText = "";
function requireAIReady(
  resume: () => Promise<void>,
  roles: readonly AIRole[] = ["conversation"],
  draftText = "",
): boolean {
  if (!missingProviderRoles(config, credentials, roles).length) return true;
  pendingRequest = resume;
  pendingText = draftText;
  onboarding.open();
  return false;
}
async function createFromGoal(name: string, idea: string) {
  if (!idea.trim())
    throw new Error("Describe what you want your application to help you do.");
  if (
    !requireAIReady(
      () => createFromGoal(name, idea),
      ["conversation", "coding-standard"],
      idea,
    )
  )
    return;
  if (hasPendingWork()) {
    showWorkConflict(() => createFromGoal(name, idea));
    return;
  }
  await workspace.createApp(name.trim() || "New app", idea);
  $<HTMLFormElement>("create-form").reset();
  await workspace.repo.setSetting(
    `app.explicitName.${workspace.current!.id}`,
    !!name.trim(),
  );
  $<HTMLDialogElement>("create-dialog").close();
  showTab("preview");
  await sendMessage(idea);
}
function renderClarification(choices: ClarificationChoice[], appId: string) {
  const box = $("clarification");
  box.replaceChildren();
  box.hidden = !choices.length;
  for (const choice of choices) {
    const button = element(
      "button",
      choice.label,
      "quiet clarification-choice",
    );
    button.type = "button";
    button.onclick = () =>
      action(async () => {
        if (workspace.current?.id !== appId) return;
        box.hidden = true;
        await workspace.diagnostics.record(
          "conversation.choice.selected",
          { value: choice.value },
          context(),
        );
        await sendMessage(choice.value, appId);
      });
    box.append(button);
  }
  if (choices.length) {
    const other = element("button", "Something else…", "quiet");
    other.type = "button";
    other.onclick = () => {
      box.hidden = true;
      $<HTMLTextAreaElement>("message").focus();
    };
    box.append(other);
  }
}
async function sendMessage(
  text: string,
  expectedAppId: string | null = workspace.current?.id ?? null,
  liveHistory: Array<{ role: "user" | "assistant"; content: string }> = [],
  retrying = false,
) {
  if (workspace.isBackingUp)
    throw new Error("Finish the backup or restore first.");
  if (!text.trim()) return;
  if (
    !requireAIReady(
      () => sendMessage(text, expectedAppId, liveHistory),
      ["conversation"],
      text,
    )
  )
    return;
  if (expectedAppId && workspace.current?.id !== expectedAppId)
    await workspace.openApp(expectedAppId);
  if (expectedAppId === null || !workspace.current) {
    await workspace.createApp("New app", text);
    await workspace.repo.setSetting(
      `app.explicitName.${workspace.current!.id}`,
      false,
    );
  }
  const appId = workspace.current!.id;
  if (/^(?:try again|retry|continue|resume)[.!?\s]*$/i.test(text.trim())) {
    if (hasPendingWork()) {
      setStatus("Your request is already in progress.");
      return;
    }
    const failed = await workspace.repo.getSetting<FailedConversation | null>(
      `conversation.retry.${appId}`,
    );
    if (failed && failed.revisionId === workspace.revision?.id) {
      await appendMessage("user", text, appId);
      await sendMessage(failed.text, appId, failed.liveHistory, true);
      return;
    }
    const draft = await workspace.repo.getCodingCheckpoint(appId);
    if (draft && draft.baseRevisionId === workspace.revision?.id) {
      await appendMessage("user", text, appId);
      await runCoding(
        draft.intent,
        draft.originalRequest ?? draft.intent,
        draft.role === "coding-complex"
          ? "high"
          : draft.role === "coding-simple"
            ? "low"
            : "medium",
        true,
      );
      return;
    }
  }
  const conversationTurn = ++latestConversation;
  const operation = {
    correlationId: crypto.randomUUID(),
    startedAt: performance.now(),
  };
  const planController = new AbortController();
  planningControllers.add(planController);
  let delegated = false;
  const startingRevision = workspace.revision!.id;
  const previousPlan = conversationPlans.get(appId) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previousPlan.catch(() => {}).then(() => gate);
  conversationPlans.set(appId, tail);
  let unlocked = false;
  const releasePlan = () => {
    if (unlocked) return;
    unlocked = true;
    unlock();
    if (conversationPlans.get(appId) === tail) conversationPlans.delete(appId);
  };
  await previousPlan.catch(() => {});
  try {
    planController.signal.throwIfAborted();
    const requestContext = {
      appId,
      correlationId: operation.correlationId,
      signal: planController.signal,
    };
    await workspace.diagnostics.record(
      "conversation.started",
      { retrying, revisionId: startingRevision },
      requestContext,
    );
    const history = await workspace.repo.listChat(appId);
    const attempts = await feedbackAttempts(appId);
    const unresolved =
      attempts.at(-1)?.status === "unresolved" ? attempts.at(-1) : undefined;
    if (!retrying) await appendMessage("user", text, appId);
    for (const attempt of attempts.filter(
      (item) => item.status === "offered",
    )) {
      attempt.status = "superseded";
      await saveFeedback(attempt);
    }
    $("chat")
      .querySelectorAll(".feedback")
      .forEach((node) => node.remove());
    $("retry-work").hidden = true;
    $("clarification").hidden = true;
    setStatus("Looking into that…");
    const apps = await workspace.repo.listApps();
    const activeApp = apps.find((app) => app.id === appId)!;
    const currentRevision = await workspace.repo.getRevision(
      activeApp.currentRevision,
    );
    const referencedApps = await Promise.all(
      findReferencedApps(text, apps)
        .filter((app) => app.id !== appId)
        .map(async (app) => ({
          id: app.id,
          name: app.name,
          revisionId: app.currentRevision,
          project: (await workspace.repo.getRevision(app.currentRevision))
            ?.project,
        })),
    );
    const inspection =
      workspace.current?.id === appId
        ? await workspace.inspect().catch(async (error) => {
            await workspace.diagnostics.record(
              "conversation.inspection.failed",
              { error: failureEvidence(error) },
              requestContext,
            );
            return null;
          })
        : null;
    const environment: ConversationEnvironment = {
      activeApp: {
        id: appId,
        name: activeApp.name,
        revisionId: currentRevision?.id,
        project: currentRevision?.project,
        state: activeApp.state,
        inspection,
      },
      availableApps: apps.map(({ id, name }) => ({ id, name })),
      referencedApps,
      memory: personalization,
    };
    const reply = await converse(
      ai,
      text,
      [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        ...liveHistory,
      ],
      requestContext,
      unresolved
        ? { originalRequest: unresolved.originalRequest, unresolved: true }
        : undefined,
      environment,
    );
    planController.signal.throwIfAborted();
    await workspace.repo.setSetting(`conversation.retry.${appId}`, null);
    await workspace.diagnostics.record(
      "conversation.intent",
      {
        intent: reply.intent,
        decisionSummary: reply.decisionSummary,
        originalRequest: text,
        changeRequest: reply.changeRequest,
        activeRevisionId: currentRevision?.id,
        inspectionAvailable: !!inspection,
        referencedAppIds: reply.referencedAppIds,
        choices: reply.choices,
        workLevel: reply.workLevel,
      },
      requestContext,
    );
    const memoryResult = applyMemoryChanges(
      personalization,
      reply.memoryChanges,
      { appId, userText: text },
    );
    if (
      memoryResult.saved.length ||
      memoryResult.suggested.length ||
      memoryResult.forgottenIds.length
    ) {
      personalization = memoryResult.memory;
      await workspace.repo.setSetting(
        PREFERENCE_MEMORY_SETTING,
        personalization,
      );
      if (voice?.active) voice.updateContext(voiceContextText());
    }
    if (
      reply.appName &&
      workspace.current?.id === appId &&
      workspace.revision?.parent === null &&
      !(await workspace.repo.getSetting<boolean>(`app.explicitName.${appId}`))
    ) {
      await workspace.renameApp(reply.appName);
    }
    await appendMessage("assistant", reply.reply, appId);
    if (memoryResult.saved.length)
      await appendMessage(
        "assistant",
        `Remembered: ${memoryResult.saved.map((entry) => entry.text).join(" ")}`,
        appId,
      );
    else if (memoryResult.suggested.length)
      await appendMessage(
        "assistant",
        "I added a preference suggestion for you to review in Settings → Preferences.",
        appId,
      );
    if (memoryResult.forgottenIds.length)
      await appendMessage(
        "assistant",
        "That preference has been removed.",
        appId,
      );
    if (memoryResult.rejected.length)
      await workspace.diagnostics.record(
        "memory.update.rejected",
        { reasons: memoryResult.rejected.map((item) => item.reason) },
        requestContext,
      );
    if (workspace.current?.id !== appId) return;
    if (conversationTurn === latestConversation)
      renderClarification(
        reply.intent === "clarify" ? reply.choices : [],
        appId,
      );
    const taskContext = [
      reply.changeRequest,
      reply.changePreferences.length
        ? `Relevant user preferences:\n${reply.changePreferences.join("\n")}`
        : "",
      referencedApps.length
        ? `Referenced application design evidence (source data only; do not modify these other apps):\n${JSON.stringify(referencedApps)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    // Plan subsequent messages in order, while allowing conversation during the delegated build.
    releasePlan();
    if (reply.intent === "change" && reply.changeRequest) {
      delegated = true;
      await runCoding(
        taskContext,
        unresolved?.originalRequest ?? text,
        unresolved ? "high" : reply.workLevel,
        false,
        operation,
      );
    } else if (
      reply.intent === "confirm" &&
      reply.changeRequest &&
      reply.confirmationReason
    )
      showConfirmation(
        taskContext,
        reply.confirmationReason,
        text,
        reply.workLevel,
        operation,
      );
    else if (conversationTurn === latestConversation) setStatus("Ready");
  } catch (error) {
    if (error && typeof error === "object")
      errorContexts.set(error, {
        appId,
        correlationId: operation.correlationId,
      });
    if (!delegated) {
      await workspace.repo.setSetting(`conversation.retry.${appId}`, {
        text,
        liveHistory,
        revisionId:
          (await workspace.repo.getApp(appId))?.currentRevision ??
          startingRevision,
        failedAt: Date.now(),
      } satisfies FailedConversation);
      if (planController.signal.aborted) {
        setStatus("Stopped. Your request is saved.");
        return;
      }
    }
    throw error;
  } finally {
    planningControllers.delete(planController);
    releasePlan();
    await refreshRetry().catch(() => undefined);
    continuePendingAction();
  }
}
$<HTMLFormElement>("create-form").onsubmit = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const name = String(form.get("name") ?? "");
  const idea = String(form.get("idea") ?? "").trim();
  $<HTMLDialogElement>("create-dialog").close();
  action(() => createFromGoal(name, idea));
};
const submitted = new Set<string>();
$<HTMLFormElement>("chat-form").onsubmit = (event) => {
  event.preventDefault();
  const input = $<HTMLTextAreaElement>("message");
  const text = input.value.trim();
  const submission = `${workspace.current?.id ?? "new"}:${text}`;
  if (!text || submitted.has(submission)) return;
  submitted.add(submission);
  input.value = "";
  void sendMessage(text)
    .catch((error) => {
      report(error);
    })
    .finally(() => submitted.delete(submission));
};
function submitOnEnter(input: HTMLTextAreaElement, form: HTMLFormElement) {
  input.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      if (!event.repeat) form.requestSubmit();
    }
  });
}
submitOnEnter(
  $<HTMLTextAreaElement>("message"),
  $<HTMLFormElement>("chat-form"),
);
submitOnEnter(
  $<HTMLFormElement>("create-form").querySelector<HTMLTextAreaElement>(
    "textarea",
  )!,
  $<HTMLFormElement>("create-form"),
);
function refreshProviderBadge() {
  const badge = $("provider-badge");
  const test =
    config.testProviderEnabled &&
    config.routes.conversation.provider === "demo";
  const missing = missingProviderRoles(config, credentials).length > 0;
  const state = ai?.health.state ?? "unchecked";
  badge.textContent = test
    ? "Scripted test provider"
    : missing
      ? "Connect AI"
      : {
          unchecked: "AI not checked",
          checking: "Checking AI…",
          ready: "AI connected",
          error: "AI needs attention",
        }[state];
  badge.hidden = !test && !missing && state === "ready";
  badge.dataset.state = missing ? "unchecked" : state;
  badge.title =
    ai?.health.message ??
    (ai?.health.checkedAt
      ? `Last successful check: ${new Date(ai.health.checkedAt).toLocaleString()}`
      : "Connect and check AI in Settings.");
}
const settingsOptions: SettingsOptions = {
  getState: () => ({
    config,
    credentials,
    observe: workspace.observe,
    debug: workspace.diagnostics.debug,
  }),
  getService: () => ai,
  getPersonalization: () => structuredClone(personalization),
  onSavePersonalization: async (value, base) => {
    personalization = mergePreferenceEdits(personalization, base, value);
    await workspace.repo.setSetting(PREFERENCE_MEMORY_SETTING, personalization);
    if (voice?.active) voice.updateContext(voiceContextText());
    await workspace.diagnostics.record(
      "preferences.memory.updated",
      {
        enabled: personalization.enabled,
        entries: personalization.entries.length,
      },
      context(),
    );
  },
  canSave: () => {
    if (workspace.isBackingUp)
      throw new Error("Finish the backup or restore before saving settings.");
    if (
      hasPendingWork() ||
      ai.activeRequestCount > 0 ||
      voice?.active ||
      voiceStarting
    )
      throw new Error(
        "Finish or cancel the current work before changing the AI connection. Other preferences can be saved now.",
      );
  },
  onSave: async (value) => {
    ai.configure(value.config);
    config = normalizeAIConfig(value.config);
    credentials = value.credentials;
    localStorage.setItem(
      "itsalive.credentials",
      JSON.stringify({ openai: credentials.openai }),
    );
    await workspace.repo.setSetting("ai.config", config);
    await workspace.setObservation(value.observe);
    workspace.diagnostics.debug = value.debug;
    config.captureContent = value.debug;
    ai.configure(config);
    await workspace.repo.setSetting("privacy", {
      observe: value.observe,
      debug: value.debug,
    });
    refreshProviderBadge();
    shellView.setSpeed(config.speed ?? "standard");
    refreshUsage();
    if (!coding) setStatus("Settings saved");
  },
  onSaved: async () => {
    const resume = pendingRequest;
    pendingRequest = undefined;
    pendingText = "";
    if (resume) await resume();
  },
  onError: report,
  onAccountDisconnected: () => {
    delete credentials.chatgpt;
    ai.resetHealth();
    refreshProviderBadge();
  },
};
const settings = new SettingsController(settingsOptions);
const onboarding = new SettingsController({
  ...settingsOptions,
  onboarding: true,
});
$("provider-badge").onclick = () => settings.open();
$("settings").onclick = () => {
  $<HTMLDetailsElement>("more-options").open = false;
  settings.open();
};
for (const dialogId of ["settings-dialog", "onboarding-dialog"])
  $<HTMLDialogElement>(dialogId).addEventListener("close", () => {
    if ($<HTMLDialogElement>(dialogId).returnValue === "saved") return;
    pendingRequest = undefined;
    if (pendingText) {
      if (workspace.current) {
        $<HTMLTextAreaElement>("message").value = pendingText;
        shellView.showAssistant();
      } else showCreate();
      pendingText = "";
    }
  });
$("cancel-work").onclick = () => {
  if (!codingController) return;
  setStatus("Stopping safely…");
  $<HTMLButtonElement>("cancel-work").disabled = true;
  codingController.abort();
};
$("retry-work").onclick = () => action(() => sendMessage("Try again"));
$("rename-app").onclick = () => {
  if (!workspace.current) return;
  $<HTMLInputElement>("rename-name").value = workspace.current.name;
  $<HTMLDialogElement>("rename-dialog").showModal();
  $<HTMLInputElement>("rename-name").focus();
};
$<HTMLFormElement>("rename-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    const name = $<HTMLInputElement>("rename-name").value.trim();
    if (!name || !workspace.current) return;
    await workspace.renameApp(name);
    await workspace.repo.setSetting(
      `app.explicitName.${workspace.current.id}`,
      true,
    );
    $<HTMLDialogElement>("rename-dialog").close();
  });
};
$("export-log").onclick = () =>
  action(async () => {
    const accounting = await ai.flushUsage();
    const snapshot = await workspace.diagnostics.snapshot();
    const serverBuild = await fetch("/api/build", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    })
      .then((response) =>
        response.ok
          ? response.json()
          : { unavailable: true, status: response.status },
      )
      .catch(() => ({ unavailable: true }));
    download(
      new Blob(
        [
          JSON.stringify(
            {
              version: 4,
              appVersion: BUILD_INFO.version,
              build: { client: BUILD_INFO, server: serverBuild },
              browser: navigator.userAgent,
              connection: ai.health,
              exportedAt: new Date().toISOString(),
              ...snapshot,
              accounting,
              inFlight: {
                coding,
                textRequests: ai.activeRequestCount,
                voice: voice?.active ?? false,
              },
              configuration: {
                ...config,
                browserTheme:
                  localStorage.getItem("itsalive.theme") ?? "system",
              },
              activeApp: workspace.current
                ? {
                    id: workspace.current.id,
                    revisionId: workspace.revision?.id,
                  }
                : null,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      "itsalive-diagnostics.json",
    );
    $("diagnostic-status").textContent = "Diagnostic logs downloaded.";
  });
$("backup").onclick = () => $<HTMLDialogElement>("backup-dialog").showModal();
workspace.onBackupProgress = (progress) => {
  $("backup-status").textContent =
    `${progress.detail} (${progress.completed}/${progress.total})`;
};
async function backupOperation(
  operation: (signal: AbortSignal) => Promise<void>,
) {
  if (backupController)
    throw new Error("A backup operation is already running");
  backupController = new AbortController();
  $("cancel-backup").hidden = false;
  $("backup-status").textContent = "Working… Keep this window open.";
  try {
    await operation(backupController.signal);
    $("backup-status").textContent = workspace.backupSummary;
    const details = workspace.backupDetails;
    $("backup-result-report").replaceChildren(
      ...details.map((detail) => element("p", detail)),
    );
    $("backup-result-details").hidden = !details.length;
  } catch (error) {
    $("backup-status").textContent =
      error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    backupController = null;
    $("cancel-backup").hidden = true;
  }
}
$("download-backup").onclick = () =>
  action(() =>
    backupOperation(async (signal) => {
      download(
        await workspace.exportBackup(signal),
        "itsalive-backup.itsalive",
      );
    }),
  );
let pendingRestore: File | undefined;
function cancelRestore() {
  pendingRestore = undefined;
  $("restore-confirmation").hidden = true;
  $<HTMLInputElement>("restore-file").value = "";
}
$<HTMLInputElement>("restore-file").onchange = () => {
  pendingRestore = $<HTMLInputElement>("restore-file").files?.[0];
  if (!pendingRestore) {
    cancelRestore();
    return;
  }
  $("restore-confirm-description").textContent =
    `Restoring “${pendingRestore.name}” replaces all applications, conversations and saved app data on this device. Download a backup first if you want to keep your current apps.`;
  $("restore-confirmation").hidden = false;
  $("cancel-restore").focus();
};
$("cancel-restore").onclick = () => {
  cancelRestore();
  $("download-backup").focus();
};
$("confirm-restore").onclick = () =>
  action(async () => {
    const file = pendingRestore;
    cancelRestore();
    if (file)
      await backupOperation((signal) => workspace.importBackup(file, signal));
  });
$<HTMLDialogElement>("backup-dialog").addEventListener("close", cancelRestore);
$("cancel-backup").onclick = () => backupController?.abort();

async function configureAI() {
  const saved = await workspace.repo.getSetting<AIConfig>("ai.config");
  config = saved?.version === 3 ? normalizeAIConfig(saved) : defaultAIConfig();
  if (saved?.version === 3)
    await workspace.repo.setSetting("ai.config", config);
  // A test URL is a session-only development choice, never persisted by accident.
  if (
    import.meta.env.DEV &&
    new URLSearchParams(location.search).get("test-provider") === "scripted"
  )
    config = demoAIConfig();
  else if (
    config.testProviderEnabled ||
    Object.values(config.routes).some((route) => route.provider === "demo")
  )
    config = defaultAIConfig();
  const privacy = await workspace.repo.getSetting<{
    observe: boolean;
    debug: boolean;
  }>("privacy");
  workspace.observe = false;
  workspace.diagnostics.debug = privacy?.debug ?? false;
  config.captureContent = workspace.diagnostics.debug;
  personalization = normalizePreferenceMemory(
    await workspace.repo.getSetting(PREFERENCE_MEMORY_SETTING),
  );
  if (config.routes.conversation.provider === "chatgpt") {
    const account = await accountSession().catch(() => undefined);
    if (account?.sharing && account.connected)
      credentials.chatgpt = "connected";
    else delete credentials.chatgpt;
  }
  const service = new AIService(config, {
    sanitizeDiagnostic: redactAccountDiagnostic,
    beforeRequest: () => {
      if (workspace.isBackingUp)
        throw new Error("AI requests are paused during backup and restoration");
    },
    credentials: () => credentials,
    onHealth: () => refreshProviderBadge(),
    log: (event) => {
      void workspace.diagnostics.record(
        event.event,
        event.data,
        { appId: event.appId, correlationId: event.correlationId },
        event.level,
      );
    },
    onUsage: (record) => {
      usageWrites = usageWrites
        .catch(() => {})
        .then(() => workspace.repo.recordUsage(record));
      void usageWrites.catch(() => {
        void workspace.diagnostics
          .record("accounting.persistence.failed", {
            reason: "browser_storage_write_failed",
          })
          .catch(() => undefined);
      });
      queueMicrotask(refreshUsage);
      return usageWrites;
    },
  });
  ai = service;
  ai.importUsage(
    (await workspace.repo.getSetting<UsageRecord[]>("ai.usage")) ?? [],
  );
  advisor = new BehaviorAdvisor(ai);
  workspace.onAI = (payload, appId, signal) =>
    ai.application(payload as ApplicationAIRequest, {
      appId,
      correlationId: crypto.randomUUID(),
      signal,
    });
  shellView.setSpeed(config.speed ?? "standard");
  refreshUsage();
  const build = document.getElementById("build-info");
  if (build) {
    build.textContent = buildLabel();
    build.title = `${BUILD_INFO.subject}\nBuilt ${BUILD_INFO.builtAt}`;
  }
  refreshProviderBadge();
}
$("speak").onclick = () =>
  action(async () => {
    if (voiceStarting) return;
    if (voice?.active) {
      voice.stop();
      return;
    }
    if (!credentials.openai) {
      settings.open(
        "Add an OpenAI API key to use live voice. Your ChatGPT plan can still power application work.",
      );
      return;
    }
    if (workspace.isBackingUp)
      throw new Error("Finish the backup or restore first.");
    voiceStarting = true;
    shellView.showAssistant();
    try {
      const history = workspace.current
        ? await workspace.repo.listChat(workspace.current.id)
        : [];
      const voiceContext = context();
      const usage = ai.startVoice(voiceContext);
      const transcripts: { user: string; assistant: string } = {
        user: "",
        assistant: "",
      };
      const captions = $("voice-captions");
      captions.replaceChildren();
      const userCaption = element("p");
      const assistantCaption = element("p");
      captions.append(userCaption, assistantCaption);
      microphoneEnabled = true;
      $("voice-mute").textContent = "Mute microphone";
      $<HTMLInputElement>("voice-audio").checked =
        config.voiceReplies !== false;
      voice = new LiveVoice({
        key: credentials.openai,
        model: config.routes.speech.model,
        debug: workspace.diagnostics.debug,
        initialContext: voiceContextText(),
        spokenReplies: config.voiceReplies !== false,
        history: history.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        onState: (state) => {
          $("voice-panel").hidden = state === "closed";
          $("speak").setAttribute("aria-pressed", String(state !== "closed"));
          $("speak").setAttribute(
            "aria-label",
            state === "closed"
              ? "Start voice conversation"
              : "End voice conversation",
          );
          $("speak").title =
            state === "closed"
              ? "Start a live conversation"
              : "End this conversation";
          $("speak").querySelector(".rail-label")!.textContent =
            state === "closed" ? "Talk live" : "End conversation";
          $("voice-status").textContent = {
            connecting: "Connecting voice…",
            listening: "Listening — you can keep talking while I work.",
            closing: "Ending conversation…",
            closed: "Voice conversation ended.",
          }[state];
          $<HTMLButtonElement>("voice-stop").disabled = state === "closing";
          if (state === "closed") {
            microphoneEnabled = false;
            $("voice-mute").textContent = "Microphone off";
          }
        },
        onPhase: (phase) => {
          const label: Record<string, string> = {
            permission: "Allow your microphone to start talking.",
            media: "Microphone ready…",
            offer: "Preparing your conversation…",
            ice: "Connecting your microphone…",
            "session-create": "Connecting to live conversation…",
            context: "Restoring your conversation…",
            answer: "Starting your conversation…",
          };
          if (label[phase]) $("voice-status").textContent = label[phase]!;
        },
        onDiagnostic: (event, data, level) => {
          void workspace.diagnostics.record(event, data, voiceContext, level);
        },
        onTranscript: (role, text) => {
          transcripts[role] += text;
          (role === "user" ? userCaption : assistantCaption).textContent =
            `${role === "user" ? "You" : "Assistant"}: ${transcripts[role]}`;
          captions.scrollTop = captions.scrollHeight;
        },
        onDelegate: async (text, liveHistory) => {
          const appId = workspace.current?.id;
          const previousMessages = new Set(
            appId
              ? (await workspace.repo.listChat(appId)).map(
                  (message) => message.id,
                )
              : [],
          );
          await sendMessage(text, appId ?? null, liveHistory);
          if (!workspace.current)
            return "Ask the user to connect AI in Settings before continuing.";
          if (appId && workspace.current.id !== appId)
            return "The user switched apps before the action finished. Do not claim the new app changed.";
          const messages = await workspace.repo.listChat(
            appId ?? workspace.current.id,
          );
          return messages
            .filter(
              (message) =>
                message.role === "assistant" &&
                !previousMessages.has(message.id),
            )
            .map((message) => message.content)
            .join("\n");
        },
        onUsage: (seconds, final, confirmed, details) => {
          usage.update(seconds, final, confirmed, details);
          refreshUsage();
        },
        onError: (error) => {
          const message =
            error.message || "Live conversation couldn't connect. Try again.";
          setStatus(message);
          $("voice-status").textContent = message;
          void workspace.diagnostics.record(
            "voice.error.presented",
            { error: failureEvidence(error), message },
            voiceContext,
          );
        },
      });
      await voice.start();
    } finally {
      voiceStarting = false;
    }
  });
$("voice-stop").onclick = () => voice?.stop();
$("voice-mute").onclick = () => {
  microphoneEnabled = !microphoneEnabled;
  voice?.setMicrophone(microphoneEnabled);
  $("voice-mute").textContent = microphoneEnabled
    ? "Mute microphone"
    : "Unmute microphone";
};
$<HTMLInputElement>("voice-audio").onchange = () => {
  config.voiceReplies = $<HTMLInputElement>("voice-audio").checked;
  voice?.setSpokenReplies(config.voiceReplies);
  action(() => workspace.repo.setSetting("ai.config", config));
};
window.addEventListener("pagehide", () => voice?.stop());
async function initialize() {
  if (await completeAccountCallback()) return;
  await configureAI();
  console.info(
    "It's Alive",
    buildLabel(),
    BUILD_INFO.subject,
    BUILD_INFO.builtAt,
  );
  await workspace.diagnostics.record("session.build", {
    build: BUILD_INFO,
    browser: navigator.userAgent,
  });
  workspace.onRestored = configureAI;
  workspace.beforeBackup = async () => {
    if (
      hasPendingWork() ||
      ai.activeRequestCount > 0 ||
      voice?.active ||
      voiceStarting
    )
      throw new Error(
        "Finish active requests and the voice conversation before starting a backup or restore",
      );
    const settlement = await ai.flushUsage();
    if (settlement.pendingWrites || settlement.unpersistedRecords.length)
      throw new Error(
        "Recent usage could not be saved yet. Keep this tab open and try the backup again.",
      );
    await usageWrites;
    await workspace.diagnostics.flush();
  };
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __itsalive: {
        getProject: () => structuredClone(workspace.revision?.project),
        getRevision: () => structuredClone(workspace.revision),
        getApp: () => structuredClone(workspace.current),
        listApps: () => workspace.repo.listApps(),
        createApp: (name: string) => workspace.createApp(name),
        openApp: (id: string) => workspace.openApp(id),
        edit: (
          files: Record<string, string>,
          dependencies?: Record<string, string>,
        ) => workspace.edit(files, dependencies),
        inspect: () => workspace.inspect(),
        setActivity: (activity: { message: string; targets: string[] }) =>
          workspace.setActivity(activity),
        clearActivity: () => workspace.clearActivity(),
        exportBackup: () => workspace.exportBackup(),
        importBackup: (blob: Blob) => workspace.importBackup(blob),
        diagnostics: () => workspace.repo.listDiagnostics(),
        setObservation: (enabled: boolean) => workspace.setObservation(enabled),
        observe: (target: string, count = 4) =>
          observe({ kind: "repeated-click", target, count, durationMs: 1200 }),
        rollback: (id: string) => workspace.rollback(id),
        compiler: workspace.compiler,
      },
    });
  }
  const apps = await workspace.repo.listApps();
  const last = localStorage.getItem("itsalive.lastApp");
  const active = apps.find((a) => a.id === last) ?? apps[0];
  if (active) await workspace.openApp(active.id);
  await render();
  // Reload is not permission to repeat paid connection probes. Health stays
  // unchecked until an actual request succeeds or the user checks Settings.
}
action(initialize);
