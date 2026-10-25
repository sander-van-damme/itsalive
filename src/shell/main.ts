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
import { accountSession } from "../ai/connection";
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
let microphoneEnabled = true;
let usageWrites: Promise<void> = Promise.resolve();
let backupController: AbortController | null = null;
let activeTab = "preview";
const setStatus = (message: string) => {
  if (coding && message === "Ready") message = codingStage;
  if ($("status").textContent === message) return;
  $("status").textContent = message;
  $("status").title = message;
};
workspace.onStatus = setStatus;
const context = () => ({
  appId: workspace.current?.id ?? "workspace",
  correlationId: crypto.randomUUID(),
});
function report(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  void workspace.diagnostics.record(
    "operation.failed",
    { message: detail, ...(error instanceof AIError ? error.detail : {}) },
    context(),
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
    const row = element("div", undefined, "revision-row");
    const info = element("div");
    info.append(
      element("strong", revision.message),
      element("small", new Date(revision.createdAt).toLocaleString()),
    );
    const button = element(
      "button",
      revision.id === workspace.revision?.id ? "Current" : "Restore",
      "quiet",
    );
    button.disabled = revision.id === workspace.revision?.id;
    button.onclick = () => action(() => workspace.rollback(revision.id));
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
      element("span", message.role === "user" ? "You" : "It's Alive"),
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
  const draft = workspace.current
    ? await workspace.repo.getCodingCheckpoint(workspace.current.id)
    : undefined;
  $("retry-work").hidden =
    coding || !draft || draft.baseRevisionId !== workspace.revision?.id;
  if (activeTab === "history") await renderHistory();
  await renderChat();
}
const shellView = initializeShellView({ showTab });
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
  status: "offered" | "unresolved" | "resolved" | "dismissed";
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
  resolve(): void;
  reject(error: unknown): void;
}
const queuedEdits: QueuedEdit[] = [];
async function runCoding(
  intent: string,
  originalRequest = intent,
  level: WorkLevel = "medium",
  resume = false,
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
      await runCoding(intent, originalRequest, level, resume);
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
  const codingContext = context();
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
    const harness = new CodingHarness(ai, {
      loadCheckpoint: (appId) => workspace.repo.getCodingCheckpoint(appId),
      saveCheckpoint: (checkpoint) =>
        workspace.repo.saveCodingCheckpoint(checkpoint),
      clearCheckpoint: (appId, checkpointId) =>
        workspace.repo.clearCodingCheckpoint(appId, checkpointId),
      onProgress: ({ stage }) => {
        codingStage = {
          understanding: "Understanding your request…",
          building: "Building your application…",
          checking: "Checking the application…",
          repairing: "Fixing a problem found during checking…",
          finishing: "Finishing your application…",
          recovering: "Resuming your saved progress…",
        }[stage];
        setStatus(codingStage);
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
      commit: (project, artifact, baseRevisionId) => {
        requireSameApp();
        return workspace.applyProject(
          project,
          baseRevisionId,
          originalRequest,
          artifact,
          codingContext.correlationId,
        );
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
    // Worker summaries are diagnostics, never an unfiltered technical chat response.
    await appendMessage(
      "assistant",
      "Ready to try. Let me know what you'd like to adjust.",
      base.appId,
    );
    if (workspace.current?.id === base.appId) {
      $("proposal").hidden = true;
      setStatus("Ready to try");
      shellView.setMobileView("app");
    }
  } catch (error) {
    await workspace.diagnostics.record(
      "coding.failed",
      { message: String(error) },
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
            : "I couldn't complete that change. Your previous app is still available. Ask me to retry, or download diagnostic logs in Settings.",
      base.appId,
    );
    setStatus(
      `${cancelled ? "Stopped" : "Couldn’t finish"}${progressSaved ? " — progress saved" : ""}`,
    );
    if (!cancelled) throw error;
  } finally {
    coding = false;
    codingController = undefined;
    clearInterval(workTimer);
    $("status").classList.remove("is-active");
    $("cancel-work").hidden = true;
    $("work-elapsed").hidden = true;
    if (workspace.current?.id === base.appId) {
      const draft = await workspace.repo
        .getCodingCheckpoint(base.appId)
        .catch(() => undefined);
      $("retry-work").hidden =
        !draft || draft.baseRevisionId !== workspace.revision?.id;
    }
    if (controller.signal.aborted) {
      for (const queued of queuedEdits.splice(0))
        queued.reject(new Error("Queued change cancelled."));
    }
    if (workspace.current?.id === base.appId) await renderChat();
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
      void runCoding(next.intent, next.originalRequest, next.level).then(
        next.resolve,
        next.reject,
      );
      break;
    }
  }
}
function showConfirmation(
  intent: string,
  reason: string,
  originalRequest: string,
  level: WorkLevel = "medium",
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
      await runCoding(intent, originalRequest, level);
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
  onboarding.open(
    "Connect your AI to create your app. Your request will continue automatically.",
  );
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
  if (coding)
    throw new Error(
      "Wait for the current change to finish before creating an app.",
    );
  await workspace.createApp(name.trim() || "New app", idea);
  await workspace.repo.setSetting(
    `app.explicitName.${workspace.current!.id}`,
    !!name.trim(),
  );
  $<HTMLDialogElement>("create-dialog").close();
  showTab("preview");
  await sendMessage(idea);
}
async function sendMessage(
  text: string,
  expectedAppId: string | null = workspace.current?.id ?? null,
  liveHistory: Array<{ role: "user" | "assistant"; content: string }> = [],
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
  const requestContext = context();
  const history = await workspace.repo.listChat(appId);
  const attempts = await feedbackAttempts(appId);
  const unresolved =
    attempts.at(-1)?.status === "unresolved" ? attempts.at(-1) : undefined;
  await appendMessage("user", text, appId);
  setStatus("Understanding your request…");
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
  );
  if (
    reply.appName &&
    workspace.current?.id === appId &&
    workspace.revision?.parent === null &&
    !(await workspace.repo.getSetting<boolean>(`app.explicitName.${appId}`))
  ) {
    await workspace.renameApp(reply.appName);
  }
  await appendMessage("assistant", reply.reply, appId);
  if (workspace.current?.id !== appId) return;
  if (reply.intent === "change" && reply.changeRequest)
    await runCoding(
      reply.changeRequest,
      unresolved?.originalRequest ?? text,
      unresolved ? "high" : reply.workLevel,
    );
  else if (
    reply.intent === "confirm" &&
    reply.changeRequest &&
    reply.confirmationReason
  )
    showConfirmation(
      reply.changeRequest,
      reply.confirmationReason,
      text,
      reply.workLevel,
    );
  else setStatus("Ready");
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
      if (!input.value) input.value = text;
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
  canSave: () => {
    if (workspace.isBackingUp)
      throw new Error("Finish the backup or restore before saving settings.");
    if (coding || ai.activeRequestCount > 0 || voice?.active)
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
    await workspace.repo.setSetting("privacy", {
      observe: value.observe,
      debug: value.debug,
    });
    refreshProviderBadge();
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
      $<HTMLTextAreaElement>("message").value = pendingText;
      pendingText = "";
      shellView.showAssistant();
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
    download(
      new Blob(
        [
          JSON.stringify(
            {
              version: 3,
              appVersion: "2.0.0-beta.2",
              browser: navigator.userAgent,
              connection: ai.health,
              exportedAt: new Date().toISOString(),
              diagnostics: await workspace.repo.listDiagnostics(),
              usage: ai.usage,
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
  if (config.routes.conversation.provider === "chatgpt") {
    const account = await accountSession().catch(() => undefined);
    if (account?.sharing && account.connected)
      credentials.chatgpt = "connected";
    else delete credentials.chatgpt;
  }
  const service = new AIService(config, {
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
  const privacy = await workspace.repo.getSetting<{
    observe: boolean;
    debug: boolean;
  }>("privacy");
  workspace.observe = false; // Suggestions do not enable passive interaction tracking.
  workspace.diagnostics.debug = privacy?.debug ?? false;
  refreshProviderBadge();
}
$("speak").onclick = () =>
  action(async () => {
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
    const history = workspace.current
      ? await workspace.repo.listChat(workspace.current.id)
      : [];
    const usage = ai.startVoice(context());
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
    $<HTMLInputElement>("voice-audio").checked = config.voiceReplies !== false;
    voice = new LiveVoice({
      key: credentials.openai,
      spokenReplies: config.voiceReplies !== false,
      history: history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      onState: (state) => {
        $("voice-panel").hidden = state === "closed";
        $("speak").setAttribute("aria-pressed", String(state !== "closed"));
        $("voice-status").textContent = {
          connecting: "Connecting voice…",
          listening: "Listening — you can keep talking while I work.",
          closing: "Ending conversation…",
          closed: "Voice conversation ended.",
        }[state];
        $<HTMLButtonElement>("voice-stop").disabled = state === "closing";
      },
      onTranscript: (role, text) => {
        transcripts[role] += text;
        (role === "user" ? userCaption : assistantCaption).textContent =
          `${role === "user" ? "You" : "It's Alive"}: ${transcripts[role]}`;
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
              message.role === "assistant" && !previousMessages.has(message.id),
          )
          .map((message) => message.content)
          .join("\n");
      },
      onUsage: (seconds, final, confirmed) =>
        usage.update(seconds, final, confirmed),
      onError: report,
    });
    await voice.start();
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
  await configureAI();
  workspace.onRestored = configureAI;
  workspace.beforeBackup = async () => {
    if (coding || ai.activeRequestCount > 0 || voice?.active)
      throw new Error(
        "Finish active requests and the voice conversation before starting a backup or restore",
      );
    await usageWrites;
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
