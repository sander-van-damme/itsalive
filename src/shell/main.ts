import "./styles.css";
import { SHELL_VIEW, initializeShellView } from "./shell-view";
import { SettingsController } from "./settings";
import { Workspace } from "./workspace";
import {
  AIService,
  defaultAIConfig,
  missingProviderRoles,
  CodingHarness,
  converse,
  reason,
  BehaviorAdvisor,
  SpeechInput,
} from "../ai";
import type {
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
let credentials: Partial<Record<"openai" | "openrouter", string>> = {};
try {
  const stored: unknown = JSON.parse(
    localStorage.getItem("itsalive.credentials") ?? "{}",
  );
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const provider of ["openai", "openrouter"] as const) {
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
let speech: SpeechInput;
let listening = false;
let reasoning = false;
let usageWrites: Promise<void> = Promise.resolve();
let backupController: AbortController | null = null;
let activeTab = "preview";
const setStatus = (message: string) => {
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
    { message: detail },
    context(),
  );
  const message =
    /key|credential|provider|connect|authentication|401|403/i.test(detail)
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
  for (const name of ["preview", "source", "history"])
    $(name).hidden = name !== tab;
  document
    .querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab]')
    .forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.tab === tab)),
    );
  if (tab === "source") renderSource();
  if (tab === "history") action(renderHistory);
}
function renderSource() {
  const project = workspace.revision?.project;
  if (!project) return;
  const select = $<HTMLSelectElement>("source-file");
  const selected = select.value;
  select.replaceChildren(
    ...Object.keys(project.files).map((file) => {
      const opt = element("option", file);
      opt.value = file;
      return opt;
    }),
  );
  if (project.files[selected] !== undefined) select.value = selected;
  $<HTMLTextAreaElement>("source-code").value =
    project.files[select.value] ?? "";
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
  $("revision-label").textContent = workspace.revision
    ? `REV ${workspace.revision.id.slice(0, 6).toUpperCase()}`
    : "LOCAL FIRST";
  if (activeTab === "source") renderSource();
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
  await workspace.repo.setSetting(`feedback.${attempt.appId}`, next.slice(-30));
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
            originalRequest: attempt.originalRequest,
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
            `${attempt.intent}\nThe previous attempt did not help. Investigate these observed runtime errors and repair the original goal: ${JSON.stringify(inspection.errors).slice(0, 4000)}`,
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
async function runCoding(intent: string, originalRequest = intent) {
  const requestedAppId = workspace.current?.id;
  if (
    !requireAIReady(async () => {
      if (requestedAppId && workspace.current?.id !== requestedAppId)
        await workspace.openApp(requestedAppId);
      await runCoding(intent, originalRequest);
    }, ["coding-standard"])
  )
    return;
  if (coding)
    throw new Error(
      "A change is already in progress. You can still ask a question.",
    );
  if (!workspace.revision)
    throw new Error("Describe the application you'd like first.");
  coding = true;
  $("chat")
    .querySelectorAll(".feedback")
    .forEach((node) => node.remove());
  const base = workspace.revision;
  const codingContext = context();
  setStatus(
    base.parent === null ? "Creating your app…" : "Working on your changes…",
  );
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
      authorized: true,
      context: codingContext,
    });
    await workspace.diagnostics.record(
      "coding.complete",
      { summary: result.summary, changedFiles: result.changedFiles },
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
    await appendMessage(
      "assistant",
      base.parent === null
        ? "I couldn't create your app yet. Tell me more about what you need, or ask me to try again."
        : "I couldn't complete that change. Your previous app is still available. You can describe the problem or ask me to try again.",
      base.appId,
    );
    throw error;
  } finally {
    coding = false;
    if (workspace.current?.id === base.appId) await renderChat();
  }
}
function showConfirmation(
  intent: string,
  reason: string,
  originalRequest: string,
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
      await runCoding(intent, originalRequest);
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
$<HTMLSelectElement>("source-file").onchange = () => {
  $<HTMLTextAreaElement>("source-code").value =
    workspace.revision?.project.files[
      $<HTMLSelectElement>("source-file").value
    ] ?? "";
};
$("apply-source").onclick = () =>
  action(() =>
    workspace.edit({
      [$<HTMLSelectElement>("source-file").value]:
        $<HTMLTextAreaElement>("source-code").value,
    }),
  );
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
  settings.open(
    "Connect an AI provider to continue. Your request will resume after connection.",
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
  await workspace.createApp(name.trim() || idea.slice(0, 60));
  $<HTMLDialogElement>("create-dialog").close();
  showTab("preview");
  await sendMessage(idea);
}
async function sendMessage(
  text: string,
  expectedAppId: string | null = workspace.current?.id ?? null,
) {
  if (workspace.isBackingUp)
    throw new Error("Finish the backup or restore first.");
  if (!text.trim()) return;
  if (
    !requireAIReady(
      () => sendMessage(text, expectedAppId),
      ["conversation"],
      text,
    )
  )
    return;
  if (expectedAppId && workspace.current?.id !== expectedAppId)
    await workspace.openApp(expectedAppId);
  if (expectedAppId === null || !workspace.current)
    await workspace.createApp(text.slice(0, 60));
  const appId = workspace.current!.id;
  const requestContext = context();
  const history = await workspace.repo.listChat(appId);
  const attempts = await feedbackAttempts(appId);
  const unresolved =
    attempts.at(-1)?.status === "unresolved" ? attempts.at(-1) : undefined;
  await appendMessage("user", text, appId);
  setStatus("Thinking…");
  const reply = await converse(
    ai,
    text,
    history.map((m) => ({ role: m.role, content: m.content })),
    requestContext,
    unresolved
      ? { originalRequest: unresolved.originalRequest, unresolved: true }
      : undefined,
  );
  await appendMessage("assistant", reply.reply, appId);
  if (workspace.current?.id !== appId) return;
  if (reply.intent === "change" && reply.changeRequest)
    await runCoding(reply.changeRequest, unresolved?.originalRequest ?? text);
  else if (
    reply.intent === "confirm" &&
    reply.changeRequest &&
    reply.confirmationReason
  )
    showConfirmation(reply.changeRequest, reply.confirmationReason, text);
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
$<HTMLFormElement>("chat-form").onsubmit = (event) => {
  event.preventDefault();
  const input = $<HTMLTextAreaElement>("message");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  action(() => sendMessage(text));
};
$("speak").onclick = () => {
  if (listening) speech.stop();
  else speech.start();
};
const deeper = element("button", "Think deeper", "quiet");
deeper.type = "button";
deeper.title =
  "Ask the reasoning model; you can continue chatting while it works";
$("chat-form")
  .querySelector(".composer-actions")!
  .insertBefore(deeper, $("chat-form").querySelector("[type=submit]"));
async function runDeeper(text: string, appId: string) {
  if (!requireAIReady(() => runDeeper(text, appId), ["reasoning"], text))
    return;
  if (workspace.isBackingUp)
    throw new Error("Finish the backup or restore first.");
  if (reasoning) throw new Error("Deeper analysis is already running.");
  if (workspace.current?.id !== appId) await workspace.openApp(appId);
  const requestContext = context();
  reasoning = true;
  deeper.disabled = true;
  try {
    const history = await workspace.repo.listChat(appId);
    await appendMessage("user", text, appId);
    const reply = await reason(
      ai,
      text,
      history.map((m) => ({ role: m.role, content: m.content })),
      requestContext,
    );
    await appendMessage("assistant", reply, appId);
  } finally {
    reasoning = false;
    deeper.disabled = false;
  }
}
deeper.onclick = () =>
  action(async () => {
    const input = $<HTMLTextAreaElement>("message");
    const text = input.value.trim();
    if (!text || !workspace.current)
      throw new Error("Write a question in an open app first.");
    input.value = "";
    await runDeeper(text, workspace.current.id);
  });
function refreshProviderBadge() {
  const missing = missingProviderRoles(config, credentials);
  $("provider-badge").textContent = missing.length
    ? "Connect AI"
    : Object.values(config.routes).some((route) => route.provider === "demo")
      ? "Scripted test provider"
      : "AI connected";
}
const settings = new SettingsController({
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
    if (coding || reasoning || ai.activeRequestCount > 0)
      throw new Error(
        "Wait for current AI requests before changing the connection.",
      );
  },
  onSave: async (value) => {
    ai.configure(value.config);
    config = value.config;
    credentials = value.credentials;
    localStorage.setItem("itsalive.credentials", JSON.stringify(credentials));
    await workspace.repo.setSetting("ai.config", config);
    await workspace.setObservation(value.observe);
    workspace.diagnostics.debug = value.debug;
    await workspace.repo.setSetting("privacy", {
      observe: value.observe,
      debug: value.debug,
    });
    refreshProviderBadge();
    setStatus("Settings saved");
  },
  onSaved: async () => {
    const resume = pendingRequest;
    pendingRequest = undefined;
    pendingText = "";
    if (resume) await resume();
  },
  onError: report,
});
$("settings").onclick = () => settings.open();
$<HTMLDialogElement>("settings-dialog").addEventListener("close", () => {
  if ($<HTMLDialogElement>("settings-dialog").returnValue === "saved") return;
  pendingRequest = undefined;
  if (pendingText) {
    $<HTMLTextAreaElement>("message").value = pendingText;
    pendingText = "";
    shellView.showAssistant();
  }
});
$("export-log").onclick = () =>
  action(async () => {
    download(
      new Blob(
        [
          JSON.stringify(
            {
              version: 2,
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
  config =
    (await workspace.repo.getSetting<AIConfig>("ai.config")) ??
    defaultAIConfig();
  const service = new AIService(config, {
    beforeRequest: () => {
      if (workspace.isBackingUp)
        throw new Error("AI requests are paused during backup and restoration");
    },
    credentials: () => credentials,
    log: (event) => {
      void workspace.diagnostics.record(
        event.event,
        event.data,
        { appId: event.appId, correlationId: event.correlationId },
        event.level,
      );
    },
    onUsage: () => {
      const snapshot = service.usage;
      usageWrites = usageWrites
        .catch(() => {})
        .then(() => workspace.repo.setSetting("ai.usage", snapshot));
      void usageWrites.catch((error) =>
        workspace.diagnostics.record("accounting.persistence.failed", {
          message: String(error),
        }),
      );
    },
  });
  ai = service;
  ai.importUsage(
    (await workspace.repo.getSetting<UsageRecord[]>("ai.usage")) ?? [],
  );
  advisor = new BehaviorAdvisor(ai);
  workspace.onAI = (payload, appId) =>
    ai.application(payload as ApplicationAIRequest, {
      appId,
      correlationId: crypto.randomUUID(),
    });
  const privacy = await workspace.repo.getSetting<{
    observe: boolean;
    debug: boolean;
  }>("privacy");
  workspace.observe = privacy?.observe ?? false;
  workspace.diagnostics.debug = privacy?.debug ?? false;
  refreshProviderBadge();
}
async function initialize() {
  await configureAI();
  speech = new SpeechInput({
    onText: (text) => {
      $<HTMLTextAreaElement>("message").value = text;
    },
    onState: (active) => {
      listening = active;
      $("speak").textContent = active ? "Stop listening" : "Speak";
      $("speak").setAttribute("aria-pressed", String(active));
      $("speak").setAttribute(
        "aria-label",
        active ? "Stop listening" : "Speak your message",
      );
      if (active) setStatus("Listening…");
    },
    onError: report,
  });
  workspace.onRestored = configureAI;
  workspace.beforeBackup = async () => {
    if (coding || reasoning || ai.activeRequestCount > 0)
      throw new Error(
        "Wait for active AI requests before starting a backup or restore",
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
}
action(initialize);
