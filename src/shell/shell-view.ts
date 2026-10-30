import { SETTINGS_DIALOG, ONBOARDING_DIALOG } from "./settings";
import type { ResponseSpeed } from "../ai/types";

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const collapsePanel = icon(
  '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m7-11-3 3 3 3"/>',
);
const expandPanel = icon(
  '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m4-11 3 3-3 3"/>',
);
const plus = icon('<path d="M12 5v14M5 12h14"/>');
const close = icon('<path d="m6 6 12 12M18 6 6 18"/>');
const more = icon(
  '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
);
const settingsIcon = icon(
  '<path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z"/><circle cx="12" cy="12" r="3"/>',
);
const historyIcon = icon('<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6m3-3v6l4 2"/>');
const renameIcon = icon(
  '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z"/>',
);
const microphone = icon('<path d="M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4"/>');
const app = icon(
  '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
);
const chat = icon(
  '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z"/><path d="M7 9h8M7 13h5"/>',
);
const speed = icon(
  '<path d="M4 17a9 9 0 1 1 16 0M12 12l5-5"/><circle cx="12" cy="12" r="1"/>',
);
const theme = icon(
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
);
const arrow = icon('<path d="M5 12h14m-6-6 6 6-6 6"/>');
const mark =
  '<svg viewBox="0 0 40 40" width="32" height="32" aria-hidden="true"><path fill="currentColor" d="M20 2c4 9 9 14 18 18-9 4-14 9-18 18C16 29 11 24 2 20 11 16 16 11 20 2Z"/><circle cx="20" cy="20" r="5" fill="var(--surface)"/></svg>';

export const SHELL_VIEW = `
<aside class="rail conversation" aria-label="Assistant">
  <header class="rail-header">
    <button id="app-title" type="button" class="app-title" aria-label="Rename current app" title="Rename app"><span class="app-mark">${mark}</span><strong id="app-name">Your apps</strong>${renameIcon}</button>
    <button id="rail-toggle" type="button" class="icon-button" aria-label="Collapse assistant" title="Collapse assistant" aria-expanded="true" aria-controls="rail-content">${collapsePanel}</button>
  </header>
  <nav class="rail-actions" aria-label="Workspace shortcuts">
    <details id="app-switcher" class="popover-anchor app-switcher">
      <summary class="icon-button" aria-label="Switch application" title="Switch application">${app}</summary>
      <nav id="app-list" class="popover" aria-label="Applications"></nav>
    </details>
    <button id="new-app" type="button" class="icon-button" aria-label="New app" title="New app">${plus}</button>
    <button id="rail-chat" type="button" class="icon-button" aria-label="Open chat" title="Open chat">${chat}</button>
    <button id="rail-history" type="button" class="icon-button" aria-label="Version history" title="Version history">${historyIcon}</button>
    <button id="speak" type="button" class="live-entry" aria-label="Start voice conversation" title="Start a live conversation" aria-pressed="false">${microphone}<span class="rail-label">Talk live</span></button>
  </nav>
  <div id="rail-content">
    <div id="chat" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text"></div>
    <div id="suggestion" class="assistance-prompt" hidden></div>
    <div id="proposal" class="assistance-prompt" hidden></div>
    <div id="clarification" class="assistance-prompt clarification" aria-label="Choose an answer" hidden></div>
    <section id="voice-panel" class="voice-panel" aria-label="Live conversation" hidden>
      <div class="voice-heading"><span class="voice-symbol" aria-hidden="true">${microphone}</span><div><h2>Live conversation</h2><p id="voice-status" role="status"></p></div></div>
      <div id="voice-captions" aria-live="off"></div>
      <div class="voice-actions"><button id="voice-mute" type="button" class="quiet">Mute microphone</button><button id="voice-stop" type="button" class="quiet danger">End conversation</button></div>
      <label class="checkbox"><input id="voice-audio" type="checkbox" checked>Spoken replies</label>
    </section>
    <div class="statusbar"><span id="status" role="status" aria-live="polite">Ready</span><span id="work-elapsed" class="hint" aria-live="off" hidden></span><button id="cancel-work" type="button" class="quiet" hidden>Cancel</button><button id="retry-work" type="button" class="quiet" hidden>Try again</button></div>
    <form id="chat-form"><label for="message" class="sr-only">Message</label><textarea id="message" placeholder="Ask or describe a change…" rows="2"></textarea><div class="composer-actions"><span class="composer-hint" aria-hidden="true">Shift + Enter for a new line</span><button type="submit" aria-label="Send" class="primary">${arrow}<span class="sr-only">Send</span></button></div></form>
    <button id="provider-badge" type="button" class="hint quiet">Connect AI to begin</button>
  </div>
  <footer class="rail-footer">
    <details id="speed-menu" class="popover-anchor control-menu">
      <summary class="quiet" aria-label="Response speed" title="Response speed">${speed}<span id="workspace-speed-label" class="rail-label">Standard</span></summary>
      <div class="popover"><label for="workspace-speed">Response speed</label><select id="workspace-speed"><option value="standard">Standard</option><option value="faster">Faster</option><option value="fastest">Fastest</option></select><p class="hint">Faster responses may cost more.</p></div>
    </details>
    <button id="workspace-spend" type="button" class="quiet usage-counter" title="Estimated API spending this month" aria-label="Estimated API spending this month: $0.00"><span id="workspace-spend-value">$0.00</span><span id="workspace-spend-unknown" class="usage-unknown" hidden aria-hidden="true">*</span></button>
    <details id="theme-menu" class="popover-anchor control-menu">
      <summary class="icon-button" aria-label="Appearance" title="Appearance">${theme}</summary>
      <div class="popover"><label for="theme-choice">Appearance</label><select id="theme-choice"><option value="system">Use device setting</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
    </details>
    <button id="rail-settings" type="button" class="icon-button collapsed-settings" aria-label="Open settings" title="Settings">${settingsIcon}</button>
    <details id="more-options" class="popover-anchor"><summary class="icon-button" aria-label="More options" title="More options">${more}</summary><nav class="popover" aria-label="More options"><button id="settings" type="button">${settingsIcon}Settings</button><button id="rename-app" type="button">${renameIcon}Rename app</button><button id="restore-version" type="button" data-tab="history">${historyIcon}Version history</button></nav></details>
  </footer>
</aside>
<main class="workspace" aria-label="Application">
  <div id="preview" class="view">
    <section id="welcome" aria-labelledby="welcome-title">
      <header class="welcome-header"><div class="brand">${mark}<span>It's Alive</span></div><div class="welcome-tools"><button id="welcome-theme" type="button" class="icon-button" aria-label="Change appearance" title="Change appearance">${theme}</button><button id="welcome-settings" type="button" class="quiet">Settings</button></div></header>
      <div class="welcome-content"><div class="welcome-art" aria-hidden="true"><span></span><span></span><span></span></div><h1 id="welcome-title">What would you like to do?</h1><button id="welcome-create" type="button" class="primary welcome-primary">Create an app ${plus}</button>
        <div class="welcome-examples" aria-label="Ideas to get started"><button type="button" data-goal="Help me learn to play violin chords."><span class="example-icon" aria-hidden="true">♫</span><strong>Learn something</strong><span>Practice violin chords</span>${arrow}</button><button type="button" data-goal="Create a focused work timer with breaks."><span class="example-icon" aria-hidden="true">◷</span><strong>Find your focus</strong><span>A timer with breaks</span>${arrow}</button><button type="button" data-goal="Help me organize the tasks for my next project."><span class="example-icon" aria-hidden="true">☷</span><strong>Make a plan</strong><span>Keep a project on track</span>${arrow}</button></div>
      </div>
    </section>
    <div id="app-container"></div>
    <section id="creation-progress" class="creation-progress" aria-label="Creating application" hidden><div class="creation-orbit" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><h1 id="creation-name">Your new app</h1><p id="creation-caption" role="status">Creating your app…</p></section>
  </div>
  <section id="history" class="view" aria-labelledby="history-title" hidden><div class="view-heading"><div><h2 id="history-title">Version history</h2><p class="hint">Restoring changes the app, not its saved data. Later versions remain available.</p></div><button type="button" class="icon-button" data-tab="preview" aria-label="Back to application">${close}</button></div><div id="revision-list"></div></section>
</main>
<nav class="mobile-navigation" aria-label="Workspace views"><button id="mobile-app" type="button" aria-label="View application" aria-pressed="false">${app}<span>Application</span></button><button id="mobile-assistant" type="button" aria-label="View assistant" aria-pressed="true">${chat}<span>Assistant</span></button></nav>
<dialog id="create-dialog" aria-labelledby="create-title"><button type="button" class="dialog-close icon-button" data-close aria-label="Close new app">${close}</button><form id="create-form"><h2 id="create-title">What would you like to make?</h2><label>What would you like to do?<textarea name="idea" rows="4" required autofocus placeholder="Tell me what you want help with…"></textarea></label><label>App name <span class="hint">(optional)</span><input name="name" aria-label="App name" maxlength="80" autocomplete="off" placeholder="You can name it later"></label><div class="dialog-actions"><button type="button" data-close class="quiet">Cancel</button><button type="submit" class="primary">Create app</button></div></form></dialog>
${SETTINGS_DIALOG}
${ONBOARDING_DIALOG}
<dialog id="rename-dialog" aria-labelledby="rename-title"><button type="button" class="dialog-close icon-button" data-close aria-label="Close rename app">${close}</button><form id="rename-form"><h2 id="rename-title">Rename app</h2><label>App name<input id="rename-name" name="name" required maxlength="80" autocomplete="off"></label><div class="dialog-actions"><button type="button" data-close class="quiet">Cancel</button><button type="submit" class="primary">Save name</button></div></form></dialog>
<dialog id="build-conflict-dialog" aria-labelledby="build-conflict-title"><button type="button" class="dialog-close icon-button" data-close aria-label="Close current work options">${close}</button><h2 id="build-conflict-title">This app is still being updated</h2><p>When should I start your new app?</p><div class="choice-actions"><button id="build-conflict-wait" type="button" class="primary">When this change is ready</button><button id="build-conflict-cancel" type="button" class="quiet">Stop this change and start now</button><button type="button" class="quiet" data-close>Go back</button></div></dialog>
<dialog id="backup-dialog" aria-labelledby="backup-title"><button type="button" class="dialog-close icon-button" data-close aria-label="Close backup and restore">${close}</button><h2 id="backup-title">Back up or restore all apps</h2><p class="hint">API keys are excluded.</p><div class="backup-actions"><button id="download-backup" type="button" class="primary">Download backup</button><label class="file-button">Restore backup<input id="restore-file" type="file" accept=".json,.itsalive,application/json"></label><button id="cancel-backup" type="button" class="quiet" hidden>Cancel operation</button></div><details class="backup-details"><summary>What's included?</summary><p>Your apps, saved versions, conversations and supported app data. Backups are unencrypted, so keep them somewhere private.</p><p>Browser permissions, cookies and some browser-managed storage cannot be transferred. Close other app tabs for a consistent backup.</p></details><section id="restore-confirmation" class="restore-confirmation" aria-labelledby="restore-confirm-title" hidden><h3 id="restore-confirm-title">Replace your current workspace?</h3><p id="restore-confirm-description">Restoring replaces your apps, conversations and saved app data on this device.</p><div class="dialog-actions"><button id="cancel-restore" type="button" class="quiet">Cancel restore</button><button id="confirm-restore" type="button" class="primary">Restore this backup</button></div></section><p id="backup-status" role="status"></p><details id="backup-result-details" class="backup-details" hidden><summary>Backup details</summary><div id="backup-result-report"></div></details><div class="dialog-actions"><button type="button" data-close class="quiet">Close</button></div></dialog>`;

export interface ShellViewActions {
  showTab(tab: string): void;
  onSpeedChange?(speed: ResponseSpeed): void;
  onUsageClick?(): void;
}

export type ShellTheme = "system" | "light" | "dark";

/** Only switches visibility. The application frame is never replaced by navigation. */
export function initializeShellView(actions: ShellViewActions) {
  const root = document.querySelector<HTMLElement>("#shell")!;
  const get = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const mediaTheme = matchMedia("(prefers-color-scheme: dark)");
  let themePreference: ShellTheme = "system";
  const setTheme = (choice: ShellTheme) => {
    themePreference = choice;
    document.documentElement.dataset.theme =
      choice === "system" ? (mediaTheme.matches ? "dark" : "light") : choice;
    get<HTMLSelectElement>("theme-choice").value = choice;
    get("welcome-theme").title = `Appearance: ${choice}`;
    localStorage.setItem("itsalive.theme", choice);
  };
  const savedTheme = localStorage.getItem("itsalive.theme");
  setTheme(
    savedTheme === "light" || savedTheme === "dark" ? savedTheme : "system",
  );
  mediaTheme.addEventListener("change", () => {
    if (themePreference === "system") setTheme("system");
  });
  get<HTMLSelectElement>("theme-choice").onchange = (event) =>
    setTheme((event.currentTarget as HTMLSelectElement).value as ShellTheme);
  get("welcome-theme").onclick = () =>
    setTheme(
      document.documentElement.dataset.theme === "dark" ? "light" : "dark",
    );
  const setSpeed = (value: ResponseSpeed) => {
    get<HTMLSelectElement>("workspace-speed").value = value;
    const label = {
      standard: "Standard",
      faster: "Faster",
      fastest: "Fastest",
    }[value];
    get("workspace-speed-label").textContent = label;
    const summary = get("speed-menu").querySelector("summary")!;
    summary.setAttribute("aria-label", `Response speed: ${label}`);
    summary.title = `Response speed: ${label}`;
  };
  get<HTMLSelectElement>("workspace-speed").onchange = (event) => {
    const value = (event.currentTarget as HTMLSelectElement)
      .value as ResponseSpeed;
    setSpeed(value);
    actions.onSpeedChange?.(value);
  };
  const setUsage = (estimateUSD: number, unknownCount = 0) => {
    const cost = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(Number.isFinite(estimateUSD) ? estimateUSD : 0);
    get("workspace-spend-value").textContent = cost;
    get("workspace-spend-unknown").hidden = unknownCount === 0;
    const description = `Estimated API spending this month: ${cost}${unknownCount ? `; ${unknownCount} requests have unknown cost` : ""}`;
    get("workspace-spend").setAttribute("aria-label", description);
    get("workspace-spend").title = description;
  };
  get("workspace-spend").onclick = () => {
    if (actions.onUsageClick) actions.onUsageClick();
    else get("settings").click();
  };
  get("app-title").onclick = () => get("rename-app").click();
  get("rail-settings").onclick = () => get("settings").click();
  get("welcome-settings").onclick = () => get("settings").click();
  get("rail-history").onclick = () => get("restore-version").click();
  root.querySelectorAll<HTMLButtonElement>("[data-goal]").forEach((button) => {
    button.onclick = () => {
      const goal =
        get<HTMLFormElement>("create-form").querySelector<HTMLTextAreaElement>(
          "textarea",
        )!;
      goal.value = button.dataset.goal!;
      get("welcome-create").click();
    };
  });
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
    get("rail-toggle").title = collapsed
      ? "Expand assistant"
      : "Collapse assistant";
    get("rail-toggle").innerHTML = collapsed ? expandPanel : collapsePanel;
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
  };
  get("rail-toggle").onclick = () =>
    setCollapsed(!root.classList.contains("rail-collapsed"));
  get("mobile-app").onclick = () => setMobileView("app");
  get("mobile-assistant").onclick = () => {
    setCollapsed(false);
    setMobileView("assistant");
  };
  get("rail-chat").onclick = () => {
    setCollapsed(false);
    setMobileView("assistant");
    get("message").focus();
  };
  get("speak").addEventListener("click", () => {
    setCollapsed(false);
    setMobileView("assistant");
  });
  root.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.onclick = () => showView(button.dataset.tab!);
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
        const fallback = root.classList.contains("has-app")
          ? mobile.getClientRects().length
            ? mobile
            : get("rail-toggle")
          : get("welcome-create");
        fallback.focus();
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
    setCollapsed,
    setTheme,
    setSpeed,
    setUsage,
    setCreating(creating: boolean, name?: string) {
      get("creation-progress").hidden = !creating;
      get("creation-name").textContent =
        name && name !== "New app" ? name : "Your new app";
      get("app-container").setAttribute("aria-busy", String(creating));
    },
    showAssistant() {
      setCollapsed(false);
      setMobileView("assistant");
      get("message").focus();
    },
  };
}
