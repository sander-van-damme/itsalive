import { SETTINGS_DIALOG } from "./settings";

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const panel = icon(
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16m-5-10 2 2-2 2"/>',
);
const plus = icon('<path d="M12 5v14M5 12h14"/>');
const close = icon('<path d="m6 6 12 12M18 6 6 18"/>');
const chevron = icon('<path d="m8 10 4 4 4-4"/>');
const more = icon(
  '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
);
const microphone = icon(
  '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
);
const app = icon(
  '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>',
);
const chat = icon(
  '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/><path d="M7 9h9M7 13h6"/>',
);

export const SHELL_VIEW = `
<main class="workspace" aria-label="Application">
  <div id="developer-panel" class="developer-toolbar" hidden>
    <div role="tablist" aria-label="Developer views">
      <button type="button" role="tab" aria-selected="true" aria-controls="preview" data-tab="preview">Application</button>
      <button type="button" role="tab" aria-selected="false" aria-controls="source" data-tab="source" tabindex="-1">Source</button>
      <button type="button" role="tab" aria-selected="false" aria-controls="history" data-tab="history" tabindex="-1">History</button>
    </div>
    <span id="revision-label" class="hint"></span>
    <button id="close-developer" type="button" class="icon-button" aria-label="Close developer tools">${close}</button>
  </div>
  <div id="preview" class="view">
    <div id="welcome">
      <h1>What would you like to do?</h1>
      <p>Describe your goal. Your application will appear here.</p>
      <button id="welcome-create" type="button" class="primary">Create an app</button>
    </div>
    <div id="app-container"></div>
  </div>
  <section id="source" class="view" aria-label="Source editor" hidden>
    <div class="source-toolbar"><label>File <select id="source-file" aria-label="Source file"></select></label><button id="apply-source" type="button" class="primary">Apply source</button></div>
    <textarea id="source-code" aria-label="Source code" spellcheck="false"></textarea>
    <p class="hint">Changes are checked before updating the running application.</p>
  </section>
  <section id="history" class="view" aria-labelledby="history-title" hidden>
    <div class="view-heading"><h2 id="history-title">Restore a previous version</h2><button type="button" class="icon-button" data-tab="preview" aria-label="Back to application">${close}</button></div>
    <p class="hint">Your saved application data stays with you.</p><div id="revision-list"></div>
  </section>
</main>
<aside class="rail conversation" aria-label="Assistant">
  <header class="rail-header">
    <button id="rail-toggle" type="button" class="icon-button" aria-label="Collapse assistant" aria-expanded="true" aria-controls="rail-content">${panel}</button>
    <details id="app-switcher" class="popover-anchor app-switcher">
      <summary aria-label="Switch application"><strong id="app-name">Your apps</strong>${chevron}</summary>
      <nav id="app-list" class="popover" aria-label="Applications"></nav>
    </details>
    <button id="new-app" type="button" class="icon-button" aria-label="New app" title="New app">${plus}</button>
  </header>
  <div id="rail-content">
    <div id="chat" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text"><div class="chat-intro"><p>Tell me what you would like help with.</p></div></div>
    <div id="suggestion" class="assistance-prompt" hidden></div>
    <div id="proposal" class="assistance-prompt" hidden></div>
    <div class="statusbar"><span id="status" role="status" aria-live="polite">Ready</span></div>
    <form id="chat-form"><label for="message" class="sr-only">Message</label><textarea id="message" placeholder="Ask or describe a change…" rows="2"></textarea><div class="composer-actions"><button type="button" id="speak" class="quiet" aria-label="Speak your message">${microphone}<span>Speak</span></button><button type="submit" aria-label="Send" class="primary">Send</button></div></form>
    <footer class="rail-footer"><span id="provider-badge" class="hint">Connect AI to begin</span><button id="settings" type="button" class="quiet" aria-label="Settings">Settings</button><details id="more-options" class="popover-anchor"><summary class="icon-button" aria-label="More options">${more}</summary><nav class="popover" aria-label="More options"><button id="backup" type="button">Backup &amp; restore</button><button id="restore-version" type="button" data-tab="history">Restore previous version</button><button id="developer-toggle" type="button" aria-expanded="false" aria-controls="developer-panel">Developer tools</button><button id="export-log" type="button" hidden>Export diagnostics</button></nav></details></footer>
  </div>
</aside>
<nav class="mobile-navigation" aria-label="Workspace views"><button id="mobile-app" type="button" aria-label="View application" aria-pressed="false">${app}<span>Application</span></button><button id="mobile-assistant" type="button" aria-label="View assistant" aria-pressed="true">${chat}<span>Assistant</span></button></nav>
<dialog id="create-dialog" aria-labelledby="create-title"><button type="button" class="dialog-close icon-button" data-close aria-label="Close new app">${close}</button><form id="create-form"><h2 id="create-title">New app</h2><label>What would you like to do?<textarea name="idea" rows="4" required autofocus placeholder="I want to learn violin chords and scales."></textarea></label><label>App name <span class="hint">(optional)</span><input name="name" aria-label="App name" maxlength="80" autocomplete="off" placeholder="Give it a name"></label><div class="dialog-actions"><button type="button" data-close class="quiet">Cancel</button><button type="submit" class="primary">Create app</button></div></form></dialog>
${SETTINGS_DIALOG}
<dialog id="backup-dialog" aria-labelledby="backup-title"><button type="button" class="dialog-close icon-button" data-close aria-label="Close backup and restore">${close}</button><h2 id="backup-title">Backup &amp; restore</h2><p>Save your applications, conversations and supported app data in a backup file.</p><p class="hint">Backups are unencrypted and can contain personal data. Provider keys are excluded. Close other app tabs before continuing. The backup reports any storage it could not include.</p><div class="backup-actions"><button id="download-backup" type="button" class="primary">Download backup</button><label class="file-button">Restore backup<input id="restore-file" type="file" accept=".json,.itsalive,application/json"></label><button id="cancel-backup" type="button" class="quiet" hidden>Cancel operation</button></div><section id="restore-confirmation" class="restore-confirmation" aria-labelledby="restore-confirm-title" hidden><h3 id="restore-confirm-title">Replace your current workspace?</h3><p id="restore-confirm-description">Restoring this backup replaces your applications, conversations and saved app data on this device.</p><div class="dialog-actions"><button id="cancel-restore" type="button" class="quiet">Cancel restore</button><button id="confirm-restore" type="button" class="primary">Restore this backup</button></div></section><p id="backup-status" role="status"></p><div class="dialog-actions"><button type="button" data-close class="quiet">Close</button></div></dialog>`;

export interface ShellViewActions {
  showTab(tab: string): void;
}

/** Only switches visibility. The application frame is never replaced by navigation. */
export function initializeShellView(actions: ShellViewActions) {
  const root = document.querySelector<HTMLElement>("#shell")!;
  const get = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const setMobileView = (view: "app" | "assistant") => {
    root.dataset.mobileView = view;
    get("mobile-app").setAttribute("aria-pressed", String(view === "app"));
    get("mobile-assistant").setAttribute(
      "aria-pressed",
      String(view === "assistant"),
    );
  };
  const setCollapsed = (collapsed: boolean) => {
    root.classList.toggle("rail-collapsed", collapsed);
    get("rail-toggle").setAttribute("aria-expanded", String(!collapsed));
    get("rail-toggle").setAttribute(
      "aria-label",
      collapsed ? "Expand assistant" : "Collapse assistant",
    );
    localStorage.setItem(
      "itsalive.sidebar",
      collapsed ? "collapsed" : "expanded",
    );
  };
  const closePopovers = () => {
    root
      .querySelectorAll<HTMLDetailsElement>(".popover-anchor")
      .forEach((details) => {
        details.open = false;
      });
  };
  const showView = (tab: string) => {
    actions.showTab(tab);
    closePopovers();
    setMobileView("app");
    root
      .querySelectorAll<HTMLButtonElement>('[role="tab"]')
      .forEach((button) => {
        button.tabIndex = button.dataset.tab === tab ? 0 : -1;
      });
  };
  const setDeveloper = (enabled: boolean) => {
    get("developer-panel").hidden = !enabled;
    get("developer-toggle").setAttribute("aria-expanded", String(enabled));
    get("export-log").hidden = !enabled;
    if (!enabled) showView("preview");
    closePopovers();
  };
  get("rail-toggle").onclick = () =>
    setCollapsed(!root.classList.contains("rail-collapsed"));
  get("mobile-app").onclick = () => setMobileView("app");
  get("mobile-assistant").onclick = () => {
    setCollapsed(false);
    setMobileView("assistant");
  };
  get("developer-toggle").onclick = () =>
    setDeveloper(get("developer-panel").hidden);
  get("close-developer").onclick = () => setDeveloper(false);
  root.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.onclick = () => showView(button.dataset.tab!);
    if (button.getAttribute("role") === "tab")
      button.addEventListener("keydown", (event) => {
        const tabs = [
          ...root.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
        ];
        const index = tabs.indexOf(button);
        const next =
          event.key === "ArrowRight"
            ? (index + 1) % tabs.length
            : event.key === "ArrowLeft"
              ? (index + tabs.length - 1) % tabs.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        const target = tabs[next]!;
        showView(target.dataset.tab!);
        target.focus();
      });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((button) => {
    button.onclick = () => button.closest("dialog")?.close();
  });
  root.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => {
    let opener: HTMLElement | null = null;
    dialog.addEventListener("beforetoggle", (event) => {
      if ((event as Event & { newState: string }).newState === "open")
        opener = document.activeElement as HTMLElement;
    });
    dialog.addEventListener("close", () => {
      if (!opener?.isConnected || opener.closest("dialog")) return;
      const disclosure = opener.closest<HTMLDetailsElement>("details");
      const target =
        disclosure && !disclosure.open
          ? disclosure.querySelector<HTMLElement>("summary")
          : opener;
      if (target?.getClientRects().length) target.focus();
      else {
        const mobile = get("mobile-app");
        (mobile.getClientRects().length ? mobile : get("rail-toggle")).focus();
      }
    });
  });
  get("app-list").addEventListener("click", closePopovers);
  get("new-app").addEventListener("click", closePopovers);
  get("more-options").addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button")) closePopovers();
  });
  document.addEventListener("click", (event) => {
    root
      .querySelectorAll<HTMLDetailsElement>(".popover-anchor[open]")
      .forEach((details) => {
        if (!details.contains(event.target as Node)) details.open = false;
      });
  });
  document.addEventListener("keydown", (event) => {
    const dialog = [
      ...root.querySelectorAll<HTMLDialogElement>("dialog[open]"),
    ].at(-1);
    if (
      dialog &&
      event.key === "Tab" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      // Native modal dialogs make the page inert, but Chromium can still move
      // sequential focus into browser chrome. Keep keyboard navigation inside
      // the current dialog, including when Advanced reveals additional fields.
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href], summary, [tabindex]",
        ),
      ].filter(
        (node) =>
          node.tabIndex >= 0 &&
          !node.matches(":disabled") &&
          !node.closest("[hidden], [inert]") &&
          node.getClientRects().length > 0 &&
          getComputedStyle(node).visibility !== "hidden",
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        dialog.tabIndex = -1;
        dialog.focus();
      } else if (
        !focusable.includes(active as HTMLElement) ||
        (event.shiftKey && active === first) ||
        (!event.shiftKey && active === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      return;
    }
    if (event.key !== "Escape" || dialog) return;
    const open = root.querySelector<HTMLDetailsElement>(
      ".popover-anchor[open]",
    );
    if (open) {
      event.preventDefault();
      closePopovers();
      open.querySelector<HTMLElement>("summary")?.focus();
    }
  });
  setCollapsed(localStorage.getItem("itsalive.sidebar") === "collapsed");
  setMobileView("assistant");
  return {
    setMobileView,
    showAssistant() {
      setCollapsed(false);
      setMobileView("assistant");
      get("message").focus();
    },
  };
}
