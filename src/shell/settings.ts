import {
  CATEGORY_ROLES,
  MODEL_CHOICES,
  defaultModelRoute,
  missingProviderRoles,
  serviceTierFor,
  type AIConfig,
  type ModelCategory,
  type ProviderCredentials,
  type ResponseSpeed,
} from "../ai/types";
import type { AIService } from "../ai/service";
import { accountSession, companionFetch } from "../ai/connection";
import {
  acceptPreferenceMemory,
  emptyPreferenceMemory,
  forgetPreferenceMemory,
  normalizePreferenceMemory,
  updatePreferenceMemoryEntry,
  type PreferenceMemory,
} from "../ai/memory";
import "./settings.css";

function settingsDialog(onboarding = false) {
  const markup = `
<dialog id="settings-dialog" aria-labelledby="settings-title">
 <button type="button" class="dialog-close quiet" data-close aria-label="${onboarding ? "Close AI setup" : "Close settings"}">×</button>
 <form id="settings-form">
  <h2 id="settings-title">${onboarding ? "Connect your AI" : "Settings"}</h2><p id="settings-intro" class="hint" hidden></p>
  ${onboarding ? '<ol class="setup-steps" aria-label="Setup progress"><li id="connection-step" aria-current="step">1 · Connect</li><li id="spending-step">2 · Spending</li></ol>' : ""}
  <${onboarding ? "section" : "details"} id="connection-section" class="settings-section" aria-labelledby="connection-title">
   <${onboarding ? "h3" : "summary"} id="connection-title">AI connection</${onboarding ? "h3" : "summary"}>
   <label>Connect with<select id="ai-provider"><option value="openai">OpenAI API key</option><option value="chatgpt">ChatGPT plan</option></select></label>
   <div id="api-key-settings"><label>OpenAI API key<input id="ai-key" type="password" autocomplete="off" spellcheck="false"></label>
   <p class="hint">Stored locally in this browser. Excluded from backups. <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Get an API key</a>.</p></div>
   <div id="chatgpt-settings" hidden><p class="hint">Use the allowance shared with Codex on an eligible ChatGPT plan.</p>
    <button type="button" id="chatgpt-connect" class="primary">Continue with ChatGPT</button><button type="button" id="chatgpt-disconnect" class="quiet" hidden>Sign out</button>
    <p id="chatgpt-status" role="status"></p><p class="hint">Stored on this device. Excluded from backups. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage plan usage</a></p>
    <details id="connection-help"><summary>Connection help</summary><p class="hint">Website sign-in needs a registered ChatGPT connection with plan usage enabled. Local installations can also run <code>npm run connection</code> in the application folder.</p></details>
    <label>OpenAI API key for voice (optional)<input id="voice-api-key" type="password" autocomplete="off" spellcheck="false"></label><p class="hint">Live voice uses separate OpenAI API usage.</p>
   </div>
   <button type="button" id="check-connection" class="quiet">Check connection</button>
   <details class="advanced-settings" ${onboarding ? "hidden" : ""}><summary>Advanced AI choices</summary><div id="model-routes"></div></details>
   <input id="response-speed" type="hidden" value="0"><span id="speed-description" hidden></span>
  </${onboarding ? "section" : "details"}>
  <${onboarding ? "section" : "details"} id="spending-section" class="settings-section" ${onboarding ? "hidden" : ""}>
   <${onboarding ? "h3" : "summary"} id="usage-title">${onboarding ? "Set a spending limit" : "Usage"}</${onboarding ? "h3" : "summary"}>
   <p id="usage-summary" class="hint" ${onboarding ? "hidden" : ""}></p>
   <label for="budget-slider">Monthly API spending <output id="budget-value"></output></label>
   <input id="budget-slider" type="range" min="0" max="101" step="1" value="101" aria-describedby="budget-description">
   <div class="budget-scale"><span>$0</span><span>No limit</span></div>
   <input id="budget-enabled" type="checkbox" hidden>
   <div id="budget-options" hidden><label>Exact monthly limit (USD)<input id="budget-limit" type="number" min="0" step="0.01"></label></div>
   <p id="budget-description" class="hint">Optional. Pauses new requests at the limit; work already running may exceed it. Resets monthly (UTC). ChatGPT plan limits are managed in ChatGPT.</p>
  </${onboarding ? "section" : "details"}>
  ${
    onboarding
      ? ""
      : `<details class="settings-section"><summary>Your preferences</summary>
  <label for="general-instructions">General instructions</label><textarea id="general-instructions" rows="4" placeholder="How would you like the assistant to work with you?"></textarea>
  <label class="checkbox"><input id="memory-enabled" type="checkbox">Remember my preferences</label><p class="hint">Preferences can apply across your apps. You can edit or forget them here.</p><div id="memory-entries" class="memory-entries"></div></details>
  <details class="settings-section"><summary>Backup and restore</summary><button id="backup" type="button" class="quiet">Back up or restore all apps</button></details>
  <details class="settings-section"><summary>Help and diagnostics</summary><label class="checkbox"><input id="debug" type="checkbox">Debug logging</label><p class="hint">Includes prompts, replies and app details. Keys and sign-in credentials are excluded.</p><button id="export-log" type="button" class="quiet">Download diagnostic logs</button><p id="diagnostic-status" class="hint" role="status"></p><p id="build-info" class="hint"></p></details>`
  }
  <p id="settings-status" class="dialog-status" role="status" aria-live="polite"></p>
  <div class="dialog-actions"><button type="button" data-close class="quiet">Cancel</button>${onboarding ? '<button type="button" id="setup-back" class="quiet" hidden>Back</button>' : ""}<button id="save-settings" type="submit" class="primary">${onboarding ? "Continue" : "Save settings"}</button></div>
 </form>
</dialog>`;
  if (!onboarding) return markup;
  return markup
    .replace(
      /id="([^"]+)"/g,
      (_, id) =>
        `id="${id === "settings-dialog" ? "onboarding-dialog" : `onboarding-${id}`}"`,
    )
    .replace(
      /(aria-labelledby|aria-describedby|for)="([^"]+)"/g,
      (_, attribute, id) => `${attribute}="onboarding-${id}"`,
    );
}
export const SETTINGS_DIALOG = settingsDialog();
export const ONBOARDING_DIALOG = settingsDialog(true);

export interface SettingsState {
  config: AIConfig;
  credentials: ProviderCredentials;
  observe: boolean;
  debug: boolean;
}
export interface SettingsOptions {
  onboarding?: boolean;
  getState(): SettingsState;
  getService(): AIService;
  canSave?(): void;
  onSave(value: SettingsState): Promise<void>;
  onSaved?(): Promise<void>;
  onError?(error: unknown): void;
  onAccountDisconnected?(): void;
  getPersonalization?(): PreferenceMemory;
  onSavePersonalization?(
    value: PreferenceMemory,
    base: PreferenceMemory,
  ): Promise<void>;
}
const SPEEDS: ResponseSpeed[] = ["standard", "faster", "fastest"];
export class SettingsController {
  private snapshot!: SettingsState;
  private connected = false;
  private accountModels?: Array<{ id: string; name: string }>;
  private accountCheck = 0;
  private checking: AbortController | null = null;
  private signingIn: AbortController | null = null;
  private dialog: HTMLDialogElement;
  private setupStep = 1;
  private preferences = emptyPreferenceMemory();
  private preferenceBase = emptyPreferenceMemory();
  constructor(private readonly options: SettingsOptions) {
    this.dialog = document.getElementById(
      options.onboarding ? "onboarding-dialog" : "settings-dialog",
    ) as HTMLDialogElement;
    this.get<HTMLFormElement>("settings-form").addEventListener("input", () => {
      if (!this.checking) this.setStatus("");
    });
    this.get<HTMLFormElement>("settings-form").onsubmit = (event) => {
      event.preventDefault();
      void this.save();
    };
    this.get<HTMLSelectElement>("ai-provider").onchange = () => {
      this.disclose();
      this.renderModels();
      if (this.get<HTMLSelectElement>("ai-provider").value === "chatgpt")
        void this.refreshAccount();
    };
    this.get<HTMLInputElement>("budget-enabled").onchange = () =>
      this.disclose();
    this.get<HTMLInputElement>("budget-slider").oninput = () => {
      const amount = Number(this.get<HTMLInputElement>("budget-slider").value);
      this.get<HTMLInputElement>("budget-enabled").checked = amount !== 101;
      if (amount !== 101)
        this.get<HTMLInputElement>("budget-limit").value = String(amount);
      this.disclose();
    };
    this.get<HTMLInputElement>("budget-limit").oninput = () =>
      this.renderBudget();
    if (options.onboarding)
      this.get("setup-back").onclick = () => this.showStep(1);
    this.get("check-connection").onclick = () => void this.check();
    this.get("chatgpt-connect").onclick = () => void this.connectAccount();
    this.get("chatgpt-disconnect").onclick = () =>
      void this.disconnectAccount();
    this.dialog.addEventListener("close", () => {
      this.checking?.abort();
      this.signingIn?.abort();
    });
    this.get<HTMLFormElement>("settings-form").addEventListener(
      "invalid",
      (event) => {
        const parent = (event.target as HTMLElement).closest("details");
        if (parent) parent.open = true;
      },
      true,
    );
  }
  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    return document.getElementById(
      this.options.onboarding ? `onboarding-${id}` : id,
    ) as T;
  }
  open(message?: string) {
    this.accountCheck++;
    this.snapshot = structuredClone(this.options.getState());
    this.get("model-routes").replaceChildren();
    const { config, credentials, debug } = this.snapshot;
    const provider =
      config.routes.conversation.provider === "chatgpt" ? "chatgpt" : "openai";
    this.get<HTMLSelectElement>("ai-provider").value = provider;
    this.get<HTMLInputElement>("ai-key").value = credentials.openai ?? "";
    this.get<HTMLInputElement>("voice-api-key").value =
      credentials.openai ?? "";
    this.connected = !!credentials.chatgpt;
    this.get<HTMLInputElement>("budget-enabled").checked =
      config.limits.budgetEnabled === true;
    this.get<HTMLInputElement>("budget-limit").value = String(
      config.limits.budgetUSD,
    );
    if (!this.options.onboarding) {
      this.get<HTMLInputElement>("debug").checked = debug;
      this.preferences = normalizePreferenceMemory(
        this.options.getPersonalization?.(),
      );
      this.preferenceBase = structuredClone(this.preferences);
      this.get<HTMLTextAreaElement>("general-instructions").value =
        this.preferences.instructions;
      this.get<HTMLInputElement>("memory-enabled").checked =
        this.preferences.enabled;
      this.renderMemory();
      this.get<HTMLDetailsElement>("connection-section").open = !!message;
    } else this.showStep(1);
    this.get<HTMLInputElement>("response-speed").value = String(
      SPEEDS.indexOf(config.speed ?? "standard"),
    );
    this.get("usage-summary").textContent =
      `Recorded spending estimate this month: $${this.options.getService().periodSpentUSD.toFixed(2)}.${this.options.getService().unknownCostCount ? ` ${this.options.getService().unknownCostCount} ${this.options.getService().unknownCostCount === 1 ? "request has" : "requests have"} an unknown cost.` : ""}`;
    this.get("settings-intro").textContent = message ?? "";
    this.get("settings-intro").hidden = !message;
    this.renderModels();
    this.setStatus("");
    this.disclose();
    this.dialog.returnValue = "";
    if (!this.dialog.open) this.dialog.showModal();
    if (this.options.onboarding || message) this.get("ai-provider").focus();
    if (provider === "chatgpt") void this.refreshAccount();
  }
  private showStep(step: number) {
    this.setupStep = step;
    this.get("connection-section").hidden = step !== 1;
    this.get("spending-section").hidden = step !== 2;
    this.get("setup-back").hidden = step !== 2;
    this.get("connection-step").setAttribute(
      "aria-current",
      step === 1 ? "step" : "false",
    );
    this.get("spending-step").setAttribute(
      "aria-current",
      step === 2 ? "step" : "false",
    );
    this.get("settings-title").textContent =
      step === 1 ? "Connect your AI" : "Set your spending";
    this.get("save-settings").textContent =
      step === 1 ? "Continue" : "Start creating";
    this.setStatus("");
    if (this.dialog.open)
      this.get(step === 1 ? "ai-provider" : "budget-slider").focus();
  }
  private renderBudget() {
    const enabled = this.get<HTMLInputElement>("budget-enabled").checked;
    const amount = Number(this.get<HTMLInputElement>("budget-limit").value);
    const label = enabled ? `$${amount.toFixed(2)}` : "No limit";
    this.get("budget-value").textContent = label;
    this.get<HTMLInputElement>("budget-slider").value = enabled
      ? String(Math.min(100, amount))
      : "101";
    this.get("budget-slider").setAttribute("aria-valuetext", label);
  }
  private renderMemory() {
    const list = this.get("memory-entries");
    list.replaceChildren();
    if (!this.preferences.entries.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No remembered preferences yet.";
      list.append(empty);
    }
    for (const entry of this.preferences.entries) {
      const item = document.createElement("article");
      item.className = "memory-entry";
      const text = document.createElement("p");
      text.textContent = entry.text;
      const meta = document.createElement("p");
      meta.className = "hint";
      meta.textContent = `${entry.scope === "all-apps" ? "All apps" : "One app"} · ${entry.status === "suggested" ? "Suggested · awaiting your approval" : entry.source === "explicit" ? "You asked to remember this" : "Accepted preference"}`;
      const controls = document.createElement("div");
      controls.className = "memory-actions";
      const action = (label: string, run: () => void) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quiet";
        button.textContent = label;
        button.onclick = () => {
          try {
            run();
            this.setStatus("");
          } catch (error) {
            this.setStatus(
              error instanceof Error
                ? error.message
                : "Could not update this preference.",
              true,
            );
          }
        };
        controls.append(button);
      };
      action("Edit", () => {
        const input = document.createElement("textarea");
        input.value = entry.text;
        input.rows = 3;
        input.setAttribute("aria-label", "Edit preference");
        text.replaceWith(input);
        controls.replaceChildren();
        action("Keep change", () => {
          this.preferences = updatePreferenceMemoryEntry(
            this.preferences,
            entry.id,
            input.value,
          );
          this.renderMemory();
        });
        action("Cancel", () => this.renderMemory());
        input.focus();
      });
      if (entry.status === "suggested")
        action("Accept", () => {
          this.preferences = acceptPreferenceMemory(this.preferences, entry.id);
          this.renderMemory();
        });
      action("Forget", () => {
        this.preferences = forgetPreferenceMemory(this.preferences, entry.id);
        this.renderMemory();
      });
      item.append(text, meta, controls);
      if (entry.sourceQuote) {
        const source = document.createElement("details");
        const title = document.createElement("summary");
        title.textContent = "From your message";
        const quote = document.createElement("blockquote");
        quote.textContent = entry.sourceQuote;
        source.append(title, quote);
        item.append(source);
      }
      list.append(item);
    }
  }
  private renderModels() {
    const account =
      this.get<HTMLSelectElement>("ai-provider").value === "chatgpt";
    const previous = Object.fromEntries(
      Object.keys(CATEGORY_ROLES).map((category) => [
        category,
        this.get<HTMLSelectElement>(`model-${category}`)?.value,
      ]),
    );
    this.get("model-routes").replaceChildren();
    for (const [category, roles] of Object.entries(CATEGORY_ROLES)) {
      const route = this.snapshot.config.routes[roles[0]!];
      const label = document.createElement("label");
      label.textContent =
        category === "voice"
          ? "Live voice"
          : category[0]!.toUpperCase() + category.slice(1);
      const select = document.createElement("select");
      select.id = `${this.options.onboarding ? "onboarding-" : ""}model-${category}`;
      select.setAttribute("aria-label", `${label.textContent} model`);
      const choices =
        category === "voice"
          ? [{ id: "gpt-live-1", name: "GPT-Live 1" }]
          : account && this.accountModels
            ? this.accountModels
            : MODEL_CHOICES;
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.id;
        option.textContent = choice.name;
        select.append(option);
      }
      const preferred = previous[category] || route.model;
      select.value = choices.some((choice) => choice.id === preferred)
        ? preferred
        : choices.some(
              (choice) =>
                choice.id ===
                defaultModelRoute("openai", category as ModelCategory).model,
            )
          ? defaultModelRoute("openai", category as ModelCategory).model
          : (choices[0]?.id ?? "");
      select.required = true;
      select.disabled =
        account &&
        category !== "voice" &&
        (!this.connected || !this.accountModels);
      label.append(select);
      this.get("model-routes").append(label);
    }
  }
  private disclose() {
    const account =
      this.get<HTMLSelectElement>("ai-provider").value === "chatgpt";
    this.get("api-key-settings").hidden = account;
    this.get("chatgpt-settings").hidden = !account;
    const enabled = this.get<HTMLInputElement>("budget-enabled").checked;
    this.get("budget-options").hidden = !enabled;
    this.get<HTMLInputElement>("budget-limit").disabled = !enabled;
    this.get<HTMLInputElement>("budget-limit").required = enabled;
    this.renderBudget();
    this.speedDescription();
  }
  private speedDescription() {
    const index = Number(this.get<HTMLInputElement>("response-speed").value);
    this.get<HTMLInputElement>("response-speed").setAttribute(
      "aria-valuetext",
      ["Standard", "Faster", "Fastest"][index]!,
    );
    if (this.get<HTMLSelectElement>("ai-provider").value === "chatgpt") {
      this.get("speed-description").textContent =
        index === 0
          ? "Usual plan usage. Quality stays the same at every speed."
          : "May use more plan allowance. Available speeds depend on your plan.";
      return;
    }
    this.get("speed-description").textContent = [
      "Usual cost. Quality stays the same at every speed.",
      "Higher cost — typically 2× for model responses.",
      "Highest cost — up to 6× for supported models.",
    ][index]!;
  }
  private draft(): SettingsState {
    const next = structuredClone(this.snapshot);
    const provider = this.get<HTMLSelectElement>("ai-provider").value as
      | "openai"
      | "chatgpt";
    next.credentials = {
      openai: this.get<HTMLInputElement>(
        provider === "openai" ? "ai-key" : "voice-api-key",
      ).value.trim(),
      ...(this.connected ? { chatgpt: "connected" } : {}),
    };
    const speed =
      SPEEDS[Number(this.get<HTMLInputElement>("response-speed").value)]!;
    next.config.speed = speed;
    next.config.version = 3;
    for (const [category, roles] of Object.entries(CATEGORY_ROLES)) {
      const savedRoute = this.snapshot.config.routes[roles[0]!];
      const model =
        provider === "chatgpt" &&
        !this.accountModels &&
        savedRoute.provider === "chatgpt"
          ? savedRoute.model
          : this.get<HTMLSelectElement>(`model-${category}`).value;
      const choice = MODEL_CHOICES.find((choice) => choice.id === model);
      const route = {
        ...defaultModelRoute(
          category === "voice" ? "openai" : provider,
          category as ModelCategory,
        ),
        model,
        serviceTier: serviceTierFor(model, speed),
      };
      if (choice) {
        route.inputPerMillion = choice.input;
        route.outputPerMillion = choice.output;
        route.cachedInputPerMillion = choice.cachedInput;
        route.cacheWritePerMillion = choice.input * 1.25;
      }
      for (const role of roles) {
        const previous = this.snapshot.config.routes[role];
        if (
          previous.provider !== route.provider ||
          previous.model !== model ||
          speed !== (this.snapshot.config.speed ?? "standard")
        ) {
          next.config.routes[role] = { ...route };
        }
      }
    }
    // Explicit URL test sessions retain their deterministic routing, never a visible provider choice.
    if (this.snapshot.config.testProviderEnabled) {
      next.config.routes = structuredClone(this.snapshot.config.routes);
      next.config.testProviderEnabled = true;
    }
    next.config.limits = {
      ...next.config.limits,
      budgetEnabled: this.get<HTMLInputElement>("budget-enabled").checked,
      budgetUSD: Number(this.get<HTMLInputElement>("budget-limit").value),
      budgetPeriod: "month",
    };
    if (!this.options.onboarding)
      next.debug = this.get<HTMLInputElement>("debug").checked;
    next.config.captureContent = next.debug;
    return next;
  }
  private connectionChanged(next: SettingsState) {
    return (
      providerConfigurationIdentity(next.config) !==
        providerConfigurationIdentity(this.snapshot.config) ||
      (next.credentials.openai ?? "") !==
        (this.snapshot.credentials.openai ?? "") ||
      (next.credentials.chatgpt ?? "") !==
        (this.snapshot.credentials.chatgpt ?? "")
    );
  }
  private setStatus(message: string, error = false) {
    const node = this.get("settings-status");
    node.textContent = message;
    node.setAttribute("role", error ? "alert" : "status");
  }
  private async validate(
    next: SettingsState,
    signal: AbortSignal,
    force = false,
  ) {
    if (missingProviderRoles(next.config, next.credentials).length)
      throw new Error("Add an OpenAI API key or connect your ChatGPT account.");
    await this.options.getService().testConfiguration(
      next.config,
      next.credentials,
      {
        appId: "settings",
        correlationId: crypto.randomUUID(),
        signal,
      },
      { force },
    );
  }
  private async check() {
    if (this.checking) return;
    const controller = new AbortController();
    this.checking = controller;
    this.get<HTMLButtonElement>("check-connection").disabled = true;
    try {
      this.setStatus(
        `Checking your connection to ${this.get<HTMLSelectElement>("ai-provider").value === "chatgpt" ? "ChatGPT" : "OpenAI"}…`,
      );
      await this.validate(this.draft(), controller.signal, true);
      this.setStatus("Connected. Your AI is ready.");
    } catch (error) {
      if (!controller.signal.aborted)
        this.setStatus(
          error instanceof Error ? error.message : "Connection check failed.",
          true,
        );
    } finally {
      this.checking = null;
      this.get<HTMLButtonElement>("check-connection").disabled = false;
    }
  }
  private async save() {
    if (
      this.checking ||
      !this.get<HTMLFormElement>("settings-form").reportValidity()
    )
      return;
    const controller = new AbortController();
    this.checking = controller;
    this.get<HTMLButtonElement>("save-settings").disabled = true;
    try {
      const next = this.draft();
      if (
        this.options.onboarding
          ? this.setupStep === 1
          : this.connectionChanged(next)
      ) {
        this.options.canSave?.();
        this.setStatus("Checking your AI connection…");
        await this.validate(next, controller.signal);
      }
      controller.signal.throwIfAborted();
      if (this.options.onboarding && this.setupStep === 1) {
        this.showStep(2);
        return;
      }
      await this.options.onSave(next);
      if (!this.options.onboarding && this.options.onSavePersonalization) {
        const preferences = {
          ...this.preferences,
          instructions: this.get<HTMLTextAreaElement>("general-instructions")
            .value,
          enabled: this.get<HTMLInputElement>("memory-enabled").checked,
        };
        if (JSON.stringify(preferences) !== JSON.stringify(this.preferenceBase))
          await this.options.onSavePersonalization(
            preferences,
            this.preferenceBase,
          );
      }
      this.dialog.close("saved");
      try {
        await this.options.onSaved?.();
      } catch (error) {
        this.options.onError?.(error);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        this.setStatus(
          error instanceof Error
            ? error.message
            : "Settings could not be saved.",
          true,
        );
    } finally {
      this.checking = null;
      this.get<HTMLButtonElement>("save-settings").disabled = false;
    }
  }
  private async refreshAccount() {
    const check = ++this.accountCheck;
    this.accountModels = undefined;
    this.renderModels();
    try {
      const session = await accountSession();
      if (check !== this.accountCheck || !this.dialog.open) return session;
      const granted = session.connected && session.sharing;
      this.get("chatgpt-status").textContent =
        session.error ??
        (session.connected
          ? `${session.email ?? "ChatGPT account"}${session.sharing ? " — plan usage enabled" : " — enable plan usage in ChatGPT"}`
          : "Ready to connect.");
      this.get("chatgpt-disconnect").hidden = !session.connected;
      if (granted) {
        const result = await companionFetch("/models", {
          signal: AbortSignal.timeout(10_000),
        });
        if (!result.ok)
          throw new Error(
            "Your ChatGPT model choices could not be loaded. Please reconnect.",
          );
        const catalog = (await result.json()) as {
          data?: Array<{ id: string }>;
          models?: Array<{
            slug: string;
            display_name: string;
            visibility: string;
          }>;
        };
        if (check !== this.accountCheck || !this.dialog.open) return session;
        this.accountModels = catalog.models
          ? catalog.models
              .filter(
                (model) =>
                  model.visibility === "list" &&
                  typeof model.slug === "string" &&
                  typeof model.display_name === "string",
              )
              .map((model) => ({ id: model.slug, name: model.display_name }))
          : (catalog.data ?? [])
              .filter((model) =>
                MODEL_CHOICES.some((choice) => choice.id === model.id),
              )
              .map((model) => ({
                id: model.id,
                name:
                  MODEL_CHOICES.find((choice) => choice.id === model.id)
                    ?.name ?? model.id,
              }));
        if (!this.accountModels.length)
          throw new Error(
            "No models are available for plan usage on this account. Check your ChatGPT plan settings.",
          );
        this.connected = true;
        this.renderModels();
      } else {
        this.connected = false;
        this.accountModels = undefined;
        delete this.snapshot.credentials.chatgpt;
        this.options.onAccountDisconnected?.();
        this.renderModels();
      }
      return session;
    } catch (error) {
      if (check === this.accountCheck && this.dialog.open) {
        this.connected = false;
        this.accountModels = undefined;
        this.renderModels();
        this.get("chatgpt-status").textContent =
          error instanceof Error
            ? error.message
            : "ChatGPT could not connect. Please try again.";
        // Loading models can refresh credentials and discover a revoked or
        // narrowed grant. Re-read that state instead of retaining the session
        // observed before the request. A transient network failure alone does
        // not revoke the user's saved identity.
        const session = await accountSession().catch(() => undefined);
        if (check !== this.accountCheck || !this.dialog.open) return undefined;
        this.get("chatgpt-disconnect").hidden = !session?.connected;
        if (session && (!session.connected || !session.sharing)) {
          delete this.snapshot.credentials.chatgpt;
          this.options.onAccountDisconnected?.();
        } else if (session?.connected && session.sharing) {
          // A catalog outage alone does not change the saved connection. Keep
          // existing routes so independent preferences can still be saved.
          this.connected = true;
        }
      }
      return undefined;
    }
  }
  private async connectAccount() {
    if (this.signingIn) return;
    const popup = window.open("about:blank", "_blank");
    const controller = new AbortController();
    this.signingIn = controller;
    this.get<HTMLButtonElement>("chatgpt-connect").disabled = true;
    try {
      const response = await companionFetch("/signin", {
        method: "POST",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error("Could not start ChatGPT sign-in.");
      const { url } = (await response.json()) as { url: string };
      if (new URL(url).origin !== "https://auth.openai.com")
        throw new Error("Unexpected sign-in address.");
      if (!popup) throw new Error("Allow the sign-in window, then try again.");
      popup.opener = null;
      popup.location.href = url;
      this.get("chatgpt-status").textContent =
        "Finish signing in in the new window…";
      for (let attempt = 0; attempt < 180; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        controller.signal.throwIfAborted();
        const session = await accountSession(
          AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        );
        if (session.error) throw new Error(session.error);
        if (!session.pending) {
          await this.refreshAccount();
          return;
        }
      }
      throw new Error("Sign-in timed out. Please try again.");
    } catch (error) {
      popup?.close();
      if (!controller.signal.aborted)
        this.get("chatgpt-status").textContent =
          error instanceof Error
            ? error.message
            : "ChatGPT could not connect. Please try again.";
    } finally {
      this.signingIn = null;
      this.get<HTMLButtonElement>("chatgpt-connect").disabled = false;
    }
  }
  private async disconnectAccount() {
    try {
      this.options.canSave?.();
      const response = await companionFetch("/signout", { method: "POST" });
      if (!response.ok) throw new Error("Sign-out could not finish.");
      const result = (await response.json().catch(() => ({}))) as {
        revoked?: boolean;
      };
      this.connected = false;
      this.accountModels = undefined;
      this.options.onAccountDisconnected?.();
      await this.refreshAccount();
      if (result.revoked === false)
        this.get("chatgpt-status").textContent =
          "Signed out on this device. You can also disconnect the app in ChatGPT Settings.";
    } catch (error) {
      this.get("chatgpt-status").textContent =
        error instanceof Error ? error.message : "Could not sign out.";
    }
  }
}

/** Only parameters affecting provider capability checks belong in this identity. No credentials are logged. */
export function providerConfigurationIdentity(config: AIConfig): string {
  return JSON.stringify(
    Object.entries(config.routes).map(([role, route]) => [
      role,
      route.provider,
      route.model,
      route.reasoningEffort,
      route.serviceTier,
    ]),
  );
}
