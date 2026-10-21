import "./styles.css";
import { Workspace } from "./workspace";
import {
  AIService,
  defaultAIConfig,
  ROLE_LABELS,
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
root.innerHTML = `
<aside class="sidebar"><a class="brand" href="/" aria-label="It's Alive home"><span class="brand-mark">a<span>✳</span></span><span>it's alive<span class="beta">BETA / 02</span></span></a>
<div class="sidebar-heading">YOUR WORKSPACE</div><button id="new-app" aria-label="New app" class="primary new-app"><span>＋</span> New app</button><nav id="app-list" aria-label="Applications"></nav>
<div class="sidebar-bottom"><span class="local-dot"></span> Stored on this device<button id="settings" title="Settings" aria-label="Settings" class="quiet">⚙ Settings</button><button id="backup" title="Backup & restore" aria-label="Backup & restore" class="quiet">↗ Backup & restore</button></div></aside>
<main class="workspace"><header class="topbar"><div><span class="breadcrumb">Workspace <span>/</span></span> <strong id="app-name">A place to begin</strong></div><div class="top-actions"><span id="provider-badge" class="pill">Demo mode</span><button id="export-log" title="Export diagnostics" aria-label="Export diagnostics" class="quiet">Export diagnostics</button></div></header>
<div class="work-area"><section class="app-panel"><div class="app-toolbar"><div role="tablist" aria-label="Application views"><button role="tab" aria-selected="true" data-tab="preview">Preview</button><button role="tab" aria-selected="false" data-tab="source">Source</button><button role="tab" aria-selected="false" data-tab="history">History</button></div><span class="live-label"><i></i> LIVE</span></div>
<div id="preview" class="view"><div id="welcome"><div class="welcome-mark">✳</div><div class="eyebrow">SOFTWARE THAT GROWS WITH YOU</div><h1>Make room for<br><em>your next idea.</em></h1><p>A small tool. A learning companion. Something entirely your own.<br>Start a space, then shape it through conversation.</p><button id="welcome-create" class="primary">Create your first app <span>↗</span></button><div class="welcome-note">Private by origin. Saved in your browser. Always yours.</div></div><div id="app-container"></div></div>
<div id="source" class="view" hidden><div class="source-toolbar"><label>File <select id="source-file" aria-label="Source file"></select></label><button id="apply-source" class="primary">Apply source</button></div><textarea id="source-code" aria-label="Source code" spellcheck="false"></textarea><p class="hint">Changes are checked before they reach your running app. A failed build keeps your current revision.</p></div>
<div id="history" class="view" hidden><h2>Your app, over time</h2><p class="hint">Restore any revision. Your saved application data stays with you.</p><div id="revision-list"></div></div>
<footer class="statusbar"><span id="status" role="status">Ready when you are</span><span id="revision-label">LOCAL FIRST</span></footer></section>
<aside class="conversation"><div class="conversation-heading"><div><span class="assistant-orb">✳</span><strong>Make it yours</strong></div><span class="hint">YOUR AI COLLABORATOR</span></div><div id="chat" aria-live="polite"><div class="chat-intro"><h2>What could this become?</h2><p>Describe what you need, ask a question, or work through an idea. We can build it together.</p><span class="demo-note">Demo mode uses scripted responses. Connect a provider in Settings for real AI.</span></div></div><div id="suggestion" hidden></div><div id="proposal" hidden></div><form id="chat-form"><label for="message" class="sr-only">Message</label><textarea id="message" placeholder="What would you like to make?" rows="3"></textarea><div class="composer-actions"><button type="button" id="speak" class="quiet" aria-label="Speak your message">◉ Speak</button><button type="submit" aria-label="Send" class="primary">Send ↑</button></div></form><div class="conversation-foot">Changes happen when you choose.</div></aside></div></main>
<dialog id="create-dialog"><form id="create-form"><div class="eyebrow">A NEW BEGINNING</div><h2>What are we making?</h2><label>App name<input name="name" aria-label="App name" required maxlength="80" placeholder="My little idea"></label><label>Describe your idea <span class="hint">(optional)</span><textarea name="idea" rows="3" placeholder="A simple habit tracker for…"></textarea></label><div class="dialog-actions"><button type="button" data-close class="quiet">Cancel</button><button type="submit" class="primary">Create app</button></div></form></dialog>
<dialog id="settings-dialog"><form id="settings-form"><div class="eyebrow">YOUR PREFERENCES</div><h2>Make yourself at home.</h2><p class="hint">Provider keys stay on this shell origin and are excluded from backups.</p><div class="key-grid"><label>OpenAI API key<input id="openai-key" type="password" autocomplete="off"></label><label>OpenRouter API key<input id="openrouter-key" type="password" autocomplete="off"></label></div><h3>Models by role</h3><p class="hint">Select a provider and its exact model ID. Set prices per million tokens to enable spending estimates.</p><div id="model-routes"></div><div class="limit-grid"><label>Requests / minute<input id="request-limit" type="number" min="1" max="1000"></label><label>Concurrent requests<input id="concurrency-limit" type="number" min="1" max="20"></label><label>Budget (USD)<input id="budget-limit" type="number" min="0" step="0.01"></label></div><label class="checkbox"><input id="observe" type="checkbox"> Offer occasional suggestions based on repeated clicks</label><p class="hint">Only aggregate click patterns are observed. No camera, cursor stream, or raw audio is stored. Suggestions are optional.</p><label class="checkbox"><input id="debug" type="checkbox"> Detailed diagnostics (DEBUG)</label><label class="checkbox"><input id="capture-content" type="checkbox"> Include AI prompts and responses in DEBUG logs</label><p class="hint">Logs are bounded and redacted, but prompts can contain private content. Export with care.</p><div class="dialog-actions"><button type="button" data-close class="quiet">Cancel</button><button type="submit" class="primary">Save settings</button></div></form></dialog>
<dialog id="backup-dialog"><div class="eyebrow">TAKE YOUR WORK WITH YOU</div><h2>Your apps, packed to go.</h2><p>Download source, revisions, conversations, and accessible application storage. Restore the archive on another browser using the same site.</p><p class="hint">Application data may contain secrets. Keep the archive somewhere safe. Provider keys are excluded. Other open tabs and service workers may prevent a consistent snapshot; the archive reports limitations.</p><div class="backup-actions"><button id="download-backup" class="primary">Download backup</button><label class="file-button">Restore backup<input id="restore-file" type="file" accept=".json,.itsalive,application/json"></label><button id="cancel-backup" class="quiet" hidden>Cancel operation</button></div><p id="backup-status" role="status"></p><div class="dialog-actions"><button type="button" data-close class="quiet">Close</button></div></dialog>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const workspace = new Workspace($("app-container"));
let config: AIConfig = defaultAIConfig();
let credentials: Partial<Record<"openai" | "openrouter", string>> = {};
try {
  credentials = JSON.parse(
    localStorage.getItem("itsalive.credentials") ?? "{}",
  );
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
  setStatus(error instanceof Error ? error.message : String(error));
  console.error(error);
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
    .querySelectorAll<HTMLButtonElement>("[data-tab]")
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
  if (!workspace.current) {
    $("chat").replaceChildren();
    return;
  }
  const appId = workspace.current.id;
  const messages = await workspace.repo.listChat(appId);
  if (workspace.current?.id !== appId) return;
  const chat = $("chat");
  if (!messages.length) {
    chat.innerHTML =
      '<div class="chat-intro"><h2>A fresh start.</h2><p>What would you like this app to do? Tell me a little about your idea.</p><span class="demo-note">Demo uses scripted responses. Configure a provider for real AI.</span></div>';
    return;
  }
  chat.replaceChildren(
    ...messages.map((message) => {
      const bubble = element("div", undefined, `chat-message ${message.role}`);
      bubble.append(
        element("span", message.role === "user" ? "YOU" : "IT’S ALIVE"),
        element("p", message.content),
      );
      return bubble;
    }),
  );
  chat.scrollTop = chat.scrollHeight;
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
  $("welcome").hidden = !!workspace.current;
  $("app-name").textContent = workspace.current?.name ?? "A place to begin";
  $("revision-label").textContent = workspace.revision
    ? `REV ${workspace.revision.id.slice(0, 6).toUpperCase()}`
    : "LOCAL FIRST";
  if (activeTab === "source") renderSource();
  if (activeTab === "history") await renderHistory();
  await renderChat();
}
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
async function runCoding(intent: string) {
  if (coding) throw new Error("A change is already in progress");
  if (!workspace.revision) throw new Error("Create an application first");
  coding = true;
  const base = workspace.revision;
  const codingContext = context();
  setStatus("Working on your idea…");
  const requireSameApp = () => {
    if (
      workspace.current?.id !== base.appId ||
      workspace.revision?.id !== base.id ||
      workspace.isBackingUp
    )
      throw new Error(
        "The application changed while this coding request was running. Please start again from the latest revision.",
      );
  };
  try {
    const harness = new CodingHarness(ai, {
      compile: (project) => {
        requireSameApp();
        return workspace.compiler.compile(project, crypto.randomUUID());
      },
      verify: (artifact) => {
        requireSameApp();
        return workspace.verify(artifact, codingContext);
      },
      commit: (project, artifact, baseRevisionId) => {
        requireSameApp();
        return workspace.applyProject(
          project,
          baseRevisionId,
          intent,
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
    await appendMessage("assistant", result.summary, base.appId);
    $("proposal").hidden = true;
    if (result.revisionId && workspace.current?.id === base.appId) {
      const feedback = element("div", undefined, "feedback");
      feedback.append(element("span", "Did this change help?"));
      for (const [label, helpful] of [
        ["Yes", true],
        ["Not yet", false],
      ] as const) {
        const button = element("button", label, "quiet");
        button.onclick = () =>
          action(async () => {
            await workspace.diagnostics.record(
              "adaptation.feedback",
              { helpful },
              { appId: base.appId, revisionId: result.revisionId },
            );
            feedback.textContent = "Thanks — feedback saved.";
          });
        feedback.append(button);
      }
      $("chat").append(feedback);
    }
  } finally {
    coding = false;
  }
}
function showProposal(intent: string) {
  const appId = workspace.current?.id;
  const box = $("proposal");
  box.hidden = false;
  box.replaceChildren(element("p", intent));
  const button = element("button", "Apply change", "primary");
  button.onclick = () =>
    action(async () => {
      if (workspace.current?.id !== appId)
        throw new Error("Open the application this change was proposed for");
      await runCoding(intent);
    });
  const dismiss = element("button", "Not now", "quiet");
  dismiss.onclick = () => {
    box.hidden = true;
  };
  box.append(button, dismiss);
}
async function observe(observation: BehaviorObservation) {
  if (!workspace.current || workspace.isBackingUp) return;
  const suggestion = await advisor.observe(observation, context());
  if (!suggestion || suggestion.appId !== workspace.current?.id) return;
  const box = $("suggestion");
  box.hidden = false;
  box.replaceChildren(
    element("span", "A THOUGHT", "eyebrow"),
    element("p", suggestion.explanation),
  );
  const accept = element("button", "Apply suggestion", "primary");
  accept.onclick = () =>
    action(async () => {
      if (workspace.current?.id !== suggestion.appId)
        throw new Error("Open the application this suggestion belongs to");
      box.hidden = true;
      const accepted = advisor.resolve(suggestion.id, "accepted");
      if (accepted) await runCoding(accepted.changeRequest);
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
    .querySelector<HTMLInputElement>("input")
    ?.focus();
}
$("new-app").onclick = showCreate;
$("welcome-create").onclick = showCreate;
document
  .querySelectorAll<HTMLButtonElement>("[data-close]")
  .forEach(
    (button) => (button.onclick = () => button.closest("dialog")?.close()),
  );
document
  .querySelectorAll<HTMLButtonElement>("[data-tab]")
  .forEach((button) => (button.onclick = () => showTab(button.dataset.tab!)));
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
$<HTMLFormElement>("create-form").onsubmit = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  action(async () => {
    await workspace.createApp(String(form.get("name")));
    $<HTMLDialogElement>("create-dialog").close();
    showTab("preview");
    const idea = String(form.get("idea") ?? "").trim();
    if (idea) {
      await appendMessage("user", idea);
      await runCoding(idea);
    }
  });
};
$<HTMLFormElement>("chat-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    if (workspace.isBackingUp)
      throw new Error("Finish the backup or restore first");
    const input = $<HTMLTextAreaElement>("message");
    const text = input.value.trim();
    if (!text) return;
    if (!workspace.current) {
      await workspace.createApp("My new app");
    }
    const appId = workspace.current!.id;
    const requestContext = context();
    input.value = "";
    const history = await workspace.repo.listChat(appId);
    await appendMessage("user", text, appId);
    const reply = await converse(
      ai,
      text,
      history.map((m) => ({ role: m.role, content: m.content })),
      requestContext,
    );
    await appendMessage("assistant", reply.reply, appId);
    if (reply.changeRequest && workspace.current?.id === appId)
      showProposal(reply.changeRequest);
  });
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
deeper.onclick = () =>
  action(async () => {
    if (workspace.isBackingUp)
      throw new Error("Finish the backup or restore first");
    if (reasoning) throw new Error("Deeper analysis is already running");
    const text = $<HTMLTextAreaElement>("message").value.trim();
    if (!text || !workspace.current)
      throw new Error("Write a question in an open app first");
    const appId = workspace.current.id;
    const requestContext = context();
    reasoning = true;
    deeper.disabled = true;
    try {
      const history = await workspace.repo.listChat(appId);
      await appendMessage("user", text, appId);
      $<HTMLTextAreaElement>("message").value = "";
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
  });
$("settings").onclick = () => {
  $<HTMLInputElement>("openai-key").value = credentials.openai ?? "";
  $<HTMLInputElement>("openrouter-key").value = credentials.openrouter ?? "";
  const routes = $("model-routes");
  routes.replaceChildren();
  for (const [role, label] of Object.entries(ROLE_LABELS)) {
    if (role === "speech") continue;
    const route = config.routes[role as AIRole];
    const row = element("div", undefined, "model-row");
    row.dataset.role = role;
    row.append(element("label", label));
    const provider = element("select");
    provider.setAttribute("aria-label", `${label} provider`);
    provider.className = "provider";
    for (const id of ["demo", "openai", "openrouter"]) {
      const option = element(
        "option",
        id === "demo" ? "Demo" : id === "openai" ? "OpenAI" : "OpenRouter",
      );
      option.value = id;
      provider.append(option);
    }
    provider.value = route.provider;
    const model = element("input");
    model.value = route.model;
    model.className = "model";
    model.setAttribute("aria-label", `${label} model`);
    row.append(provider, model);
    for (const [field, caption] of [
      ["inputPerMillion", "Input $/M"],
      ["outputPerMillion", "Output $/M"],
    ] as const) {
      const input = element("input");
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.value = String(route[field]);
      input.dataset.field = field;
      input.setAttribute("aria-label", `${label} ${caption}`);
      input.title = caption;
      row.append(input);
    }
    routes.append(row);
  }
  $<HTMLInputElement>("request-limit").value = String(
    config.limits.requestsPerMinute,
  );
  $<HTMLInputElement>("concurrency-limit").value = String(
    config.limits.concurrency,
  );
  $<HTMLInputElement>("budget-limit").value = String(config.limits.budgetUSD);
  $<HTMLInputElement>("observe").checked = workspace.observe;
  $<HTMLInputElement>("debug").checked = workspace.diagnostics.debug;
  $<HTMLInputElement>("capture-content").checked = config.captureContent;
  $<HTMLDialogElement>("settings-dialog").showModal();
};
$<HTMLFormElement>("settings-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    if (workspace.isBackingUp)
      throw new Error("Finish the backup or restore before saving settings");
    const next = structuredClone(config);
    document.querySelectorAll<HTMLElement>(".model-row").forEach((row) => {
      const route = next.routes[row.dataset.role as AIRole];
      route.provider = row.querySelector<HTMLSelectElement>(".provider")!
        .value as typeof route.provider;
      route.model = row.querySelector<HTMLInputElement>(".model")!.value;
      for (const field of ["inputPerMillion", "outputPerMillion"] as const)
        route[field] = Number(
          row.querySelector<HTMLInputElement>(`[data-field="${field}"]`)!.value,
        );
    });
    next.limits = {
      requestsPerMinute: Number($<HTMLInputElement>("request-limit").value),
      concurrency: Number($<HTMLInputElement>("concurrency-limit").value),
      budgetUSD: Number($<HTMLInputElement>("budget-limit").value),
    };
    next.captureContent = $<HTMLInputElement>("capture-content").checked;
    ai.configure(next);
    config = next;
    credentials = {
      openai: $<HTMLInputElement>("openai-key").value.trim(),
      openrouter: $<HTMLInputElement>("openrouter-key").value.trim(),
    };
    localStorage.setItem("itsalive.credentials", JSON.stringify(credentials));
    await workspace.repo.setSetting("ai.config", config);
    workspace.observe = $<HTMLInputElement>("observe").checked;
    workspace.diagnostics.debug = $<HTMLInputElement>("debug").checked;
    await workspace.repo.setSetting("privacy", {
      observe: workspace.observe,
      debug: workspace.diagnostics.debug,
    });
    $("provider-badge").textContent =
      config.routes.conversation.provider === "demo"
        ? "Demo mode"
        : config.routes.conversation.model;
    $<HTMLDialogElement>("settings-dialog").close();
    if (workspace.current) await workspace.openApp(workspace.current.id);
    setStatus("Settings saved");
  });
};
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
$<HTMLInputElement>("restore-file").onchange = () =>
  action(async () => {
    const file = $<HTMLInputElement>("restore-file").files?.[0];
    if (file)
      await backupOperation((signal) => workspace.importBackup(file, signal));
  });
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
  $("provider-badge").textContent =
    config.routes.conversation.provider === "demo"
      ? "Demo mode"
      : config.routes.conversation.model;
}
async function initialize() {
  await configureAI();
  speech = new SpeechInput({
    onText: (text) => {
      $<HTMLTextAreaElement>("message").value = text;
    },
    onState: (active) => {
      listening = active;
      $("speak").textContent = active ? "■ Stop" : "◉ Speak";
      setStatus(active ? "Listening…" : "Ready");
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
