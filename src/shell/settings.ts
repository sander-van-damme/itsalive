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

export const SETTINGS_DIALOG = `
<dialog id="settings-dialog" aria-labelledby="settings-title">
 <button type="button" class="dialog-close quiet" data-close aria-label="Close settings">×</button>
 <form id="settings-form">
  <h2 id="settings-title">Settings</h2><p id="settings-intro" class="hint">Make yourself at home. Good defaults are already selected.</p>
  <section class="settings-section" aria-labelledby="connection-title">
   <h3 id="connection-title">AI connection</h3>
   <label>Connect with<select id="ai-provider"><option value="openai">OpenAI API key</option><option value="chatgpt">ChatGPT plan</option></select></label>
   <div id="api-key-settings"><label>OpenAI API key<input id="ai-key" type="password" autocomplete="off" spellcheck="false"></label>
   <p class="hint">Stored on this browser, excluded from backups. <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Get an API key</a>.</p></div>
   <div id="chatgpt-settings" hidden><p class="hint">Use your eligible ChatGPT plan for application work, including the allowance shared with Codex.</p>
    <button type="button" id="chatgpt-connect" class="primary">Continue with ChatGPT</button><button type="button" id="chatgpt-disconnect" class="quiet" hidden>Sign out</button>
    <p id="chatgpt-status" role="status"></p><p class="hint">Account sign-in uses the connection helper on your device. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage ChatGPT usage</a></p>
    <details id="connection-help"><summary>Set up the connection helper</summary><p class="hint">For a local installation, run <code>npm run connection</code> in the application folder, then return here. ChatGPT plan access is available for eligible local installations. Your ChatGPT tokens stay on your device.</p></details>
    <label>OpenAI API key for voice (optional)<input id="voice-api-key" type="password" autocomplete="off" spellcheck="false"></label><p class="hint">Live voice uses separate OpenAI API usage.</p>
   </div>
   <details class="advanced-settings"><summary>AI choices</summary><p class="hint">We choose the right level for each task. You can change these defaults.</p><div id="model-routes"></div></details>
   <label for="response-speed">Response speed</label><input id="response-speed" type="range" min="0" max="2" step="1" value="0" aria-describedby="speed-description"><div class="speed-labels"><span>Standard</span><span>Faster</span><span>Fastest</span></div><p id="speed-description" class="hint"></p>
   <button type="button" id="check-connection" class="quiet">Check connection</button>
  </section>
  <details class="settings-section"><summary>Usage</summary>
   <p id="usage-summary" class="hint"></p><label class="checkbox"><input id="budget-enabled" type="checkbox">Enable spending limit</label>
   <div id="budget-options" hidden><label>Monthly limit (USD)<input id="budget-limit" type="number" min="0.01" max="100000" step="0.01"></label><p class="hint">Estimated OpenAI API spending on this browser, including voice. Resets on the first day of each month (UTC). ChatGPT plan limits are managed in ChatGPT.</p></div>
  </details>
  <details class="settings-section"><summary>Backup and restore</summary><p>Save or restore all your apps, conversations, settings and supported app data.</p><button id="backup" type="button" class="quiet">Back up or restore all apps</button></details>
  <details class="settings-section"><summary>Help and diagnostics</summary><label class="checkbox"><input id="debug" type="checkbox">Debug logging</label><p class="hint">Record extra detail to help investigate problems. Basic errors are always saved. Keys and AI prompts are excluded; logs can include app details.</p><button id="export-log" type="button" class="quiet">Download diagnostic logs</button><p id="diagnostic-status" class="hint" role="status"></p></details>
  <p id="settings-status" class="dialog-status" role="status" aria-live="polite"></p>
  <div class="dialog-actions"><button type="button" data-close class="quiet">Cancel</button><button id="save-settings" type="submit" class="primary">Save settings</button></div>
 </form>
</dialog>`;

export interface SettingsState {
  config: AIConfig;
  credentials: ProviderCredentials;
  observe: boolean;
  debug: boolean;
}
export interface SettingsOptions {
  getState(): SettingsState;
  getService(): AIService;
  canSave?(): void;
  onSave(value: SettingsState): Promise<void>;
  onSaved?(): Promise<void>;
  onError?(error: unknown): void;
  onAccountDisconnected?(): void;
}
const SPEEDS: ResponseSpeed[] = ["standard", "faster", "fastest"];
export class SettingsController {
  private snapshot!: SettingsState;
  private connected = false;
  private accountModels?: Array<{ id: string; name: string }>;
  private accountCheck = 0;
  private checking: AbortController | null = null;
  private signingIn: AbortController | null = null;
  private dialog = document.getElementById(
    "settings-dialog",
  ) as HTMLDialogElement;
  constructor(private readonly options: SettingsOptions) {
    const planEnabled =
      location.hostname.endsWith(".localhost") ||
      import.meta.env.VITE_CHATGPT_PLAN_ENABLED === "1";
    const planChoice = this.get<HTMLSelectElement>(
      "ai-provider",
    ).querySelector<HTMLOptionElement>('option[value="chatgpt"]')!;
    planChoice.disabled = !planEnabled;
    if (!planEnabled)
      planChoice.textContent = "ChatGPT plan (local installations)";
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
    this.get<HTMLInputElement>("response-speed").oninput = () =>
      this.speedDescription();
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
    return document.getElementById(id) as T;
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
    this.get<HTMLInputElement>("debug").checked = debug;
    this.get<HTMLInputElement>("response-speed").value = String(
      SPEEDS.indexOf(config.speed ?? "standard"),
    );
    this.get("usage-summary").textContent =
      `Estimated usage this month: $${this.options.getService().periodSpentUSD.toFixed(2)}.`;
    this.get("settings-intro").textContent =
      message ??
      "Good defaults are already selected. Adjust only what you need.";
    this.renderModels();
    this.setStatus("");
    this.disclose();
    this.dialog.returnValue = "";
    if (!this.dialog.open) this.dialog.showModal();
    this.get("ai-provider").focus();
    if (provider === "chatgpt") void this.refreshAccount();
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
      select.id = `model-${category}`;
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
      const model = this.get<HTMLSelectElement>(`model-${category}`).value;
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
      }
      for (const role of roles) next.config.routes[role] = { ...route };
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
    next.config.captureContent = false;
    next.debug = this.get<HTMLInputElement>("debug").checked;
    return next;
  }
  private connectionChanged(next: SettingsState) {
    return (
      JSON.stringify(next.config.routes) !==
        JSON.stringify(this.snapshot.config.routes) ||
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
  private async validate(next: SettingsState, signal: AbortSignal) {
    if (missingProviderRoles(next.config, next.credentials).length)
      throw new Error("Add an OpenAI API key or connect your ChatGPT account.");
    await this.options
      .getService()
      .testConfiguration(next.config, next.credentials, {
        appId: "settings",
        correlationId: crypto.randomUUID(),
        signal,
      });
  }
  private async check() {
    if (this.checking) return;
    const controller = new AbortController();
    this.checking = controller;
    this.get<HTMLButtonElement>("check-connection").disabled = true;
    try {
      this.setStatus("Checking the connection and application actions…");
      await this.validate(
        this.draft(),
        AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      );
      this.setStatus("Connection checked. Save to use these settings.");
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
      if (this.connectionChanged(next)) {
        this.options.canSave?.();
        this.setStatus("Checking your AI connection…");
        await this.validate(
          next,
          AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        );
      }
      controller.signal.throwIfAborted();
      await this.options.onSave(next);
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
    try {
      const session = await accountSession();
      if (check !== this.accountCheck || !this.dialog.open) return session;
      this.connected = session.connected && session.sharing;
      this.get("chatgpt-status").textContent =
        session.error ??
        (session.connected
          ? `${session.email ?? "ChatGPT account"}${session.sharing ? " — plan usage enabled" : " — enable plan usage in ChatGPT"}`
          : "Ready to connect.");
      this.get("chatgpt-disconnect").hidden = !session.connected;
      if (this.connected) {
        const result = await companionFetch("/models", {
          signal: AbortSignal.timeout(10_000),
        });
        if (!result.ok)
          throw new Error(
            "Your ChatGPT model choices could not be loaded. Please reconnect.",
          );
        const catalog = (await result.json()) as {
          models?: Array<{
            slug: string;
            display_name: string;
            visibility: string;
          }>;
        };
        if (check !== this.accountCheck || !this.dialog.open) return session;
        this.accountModels = (catalog.models ?? [])
          .filter(
            (model) =>
              model.visibility === "list" &&
              typeof model.slug === "string" &&
              typeof model.display_name === "string",
          )
          .map((model) => ({ id: model.slug, name: model.display_name }));
        if (!this.accountModels.length)
          throw new Error(
            "No models are available for plan usage on this account. Check your ChatGPT plan settings.",
          );
        this.renderModels();
      } else {
        this.accountModels = undefined;
        this.renderModels();
      }
      return session;
    } catch (error) {
      if (check === this.accountCheck)
        this.get("chatgpt-status").textContent =
          error instanceof Error && this.connected
            ? error.message
            : "Start the connection helper on this device, then select Continue with ChatGPT.";
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
            : "Start the connection helper and try again.";
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
      this.connected = false;
      this.accountModels = undefined;
      this.options.onAccountDisconnected?.();
      await this.refreshAccount();
    } catch (error) {
      this.get("chatgpt-status").textContent =
        error instanceof Error ? error.message : "Could not sign out.";
    }
  }
}
