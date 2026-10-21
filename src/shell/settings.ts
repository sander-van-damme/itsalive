import {
  AI_ROLES,
  ROLE_LABELS,
  defaultModelRoute,
  missingProviderRoles,
  type AIConfig,
  type AIRole,
  type ProviderCredentials,
  type ProviderId,
} from "../ai/types";
import type { AIService } from "../ai/service";

export const SETTINGS_DIALOG = `
<dialog id="settings-dialog" aria-labelledby="settings-title">
  <button type="button" class="dialog-close quiet" data-close aria-label="Close settings">×</button>
  <form id="settings-form">
    <h2 id="settings-title">AI connection</h2>
    <p id="settings-intro" class="hint">Connect an AI provider to create apps and talk with your assistant.</p>
    <div class="settings-stack">
      <label>AI provider<select id="ai-provider"><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option></select></label>
      <label>Model<input id="ai-model" list="suggested-models" required maxlength="160" autocomplete="off"></label>
      <datalist id="suggested-models"><option value="gpt-4.1-mini"></option><option value="openai/gpt-4.1-mini"></option></datalist>
      <label>API key<input id="ai-key" type="password" autocomplete="off" spellcheck="false"></label>
      <p class="hint">Your key stays in this browser and is excluded from backups. <a id="provider-help" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Get an API key</a>.</p>
      <label>Spending limit (USD)<input id="budget-limit" type="number" min="0" step="0.01" required></label>
      <p class="hint">Estimated total AI spending on this device, including connection checks. Set a provider-side limit for a firm spending cap.</p>
    </div>
    <details id="advanced-settings">
      <summary>Advanced</summary>
      <label class="checkbox"><input id="observe" type="checkbox"> Offer occasional suggestions from repeated clicks</label>
      <p class="hint">Suggestions are optional. Only aggregate click patterns are observed.</p>
      <label class="checkbox"><input id="custom-routes" type="checkbox"> Choose different models by role</label>
      <div id="model-routes" hidden></div>
      <div id="additional-keys" class="key-grid" hidden>
        <label>OpenAI API key<input id="openai-key" type="password" autocomplete="off" spellcheck="false"></label>
        <label>OpenRouter API key<input id="openrouter-key" type="password" autocomplete="off" spellcheck="false"></label>
      </div>
      <p class="hint">Default cost estimates use GPT-4.1 mini list prices. Update estimates for custom models; provider prices may change.</p>
      <div class="limit-grid">
        <label>Requests per minute<input id="request-limit" type="number" min="1" max="1000" required></label>
        <label>Concurrent requests<input id="concurrency-limit" type="number" min="1" max="20" required></label>
      </div>
      <label class="checkbox"><input id="debug" type="checkbox"> Detailed diagnostics</label>
      <label class="checkbox"><input id="capture-content" type="checkbox"> Include AI prompts and responses in diagnostic logs</label>
      <p class="hint">Prompts can contain private information. Export logs with care.</p>
      <label class="checkbox"><input id="test-provider" type="checkbox"> Use scripted test provider</label>
      <p id="test-notice" class="hint" hidden>Development only. Scripted responses cannot understand arbitrary goals and do not use a real AI provider.</p>
    </details>
    <p id="settings-status" class="dialog-status" role="status" aria-live="polite"></p>
    <div class="dialog-actions"><button type="button" data-close class="quiet">Cancel</button><button id="save-settings" type="submit" class="primary">Connect and save</button></div>
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
}

/** Form edits are a private draft until validation and connection checks succeed. */
export class SettingsController {
  private snapshot!: SettingsState;
  private draftCredentials: ProviderCredentials = {};
  private primaryProvider: "openai" | "openrouter" = "openai";
  private checking: AbortController | null = null;
  private readonly dialog = document.getElementById(
    "settings-dialog",
  ) as HTMLDialogElement;
  constructor(private readonly options: SettingsOptions) {
    this.get<HTMLFormElement>("settings-form").onsubmit = (event) => {
      event.preventDefault();
      void this.save();
    };
    this.get<HTMLFormElement>("settings-form").addEventListener(
      "invalid",
      (event) => {
        const target = event.target as HTMLElement;
        const disclosure = target.closest("details");
        if (disclosure) disclosure.open = true;
      },
      true,
    );
    this.get<HTMLSelectElement>("ai-provider").onchange = () => {
      this.capturePrimaryKey();
      this.primaryProvider = this.get<HTMLSelectElement>("ai-provider")
        .value as "openai" | "openrouter";
      this.get<HTMLInputElement>("ai-key").value =
        this.draftCredentials[this.primaryProvider] ?? "";
      this.get<HTMLInputElement>("ai-model").value = defaultModelRoute(
        this.primaryProvider,
      ).model;
      this.updateProviderHelp();
      this.syncConversationRoute();
    };
    this.get<HTMLInputElement>("ai-model").oninput = () =>
      this.syncConversationRoute();
    this.get<HTMLInputElement>("ai-key").oninput = () =>
      this.capturePrimaryKey();
    this.get<HTMLInputElement>("custom-routes").onchange = () =>
      this.updateDisclosure();
    this.get<HTMLInputElement>("test-provider").onchange = () =>
      this.updateDisclosure();
    for (const provider of ["openai", "openrouter"] as const) {
      this.get<HTMLInputElement>(`${provider}-key`).oninput = () => {
        this.draftCredentials[provider] = this.get<HTMLInputElement>(
          `${provider}-key`,
        ).value.trim();
        if (provider === this.primaryProvider)
          this.get<HTMLInputElement>("ai-key").value =
            this.draftCredentials[provider] ?? "";
      };
    }
    this.dialog.addEventListener("close", () => {
      this.checking?.abort();
      this.checking = null;
    });
  }
  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
  }
  open(message?: string): void {
    this.snapshot = structuredClone(this.options.getState());
    this.draftCredentials = { ...this.snapshot.credentials };
    const { config } = this.snapshot;
    const route = config.routes.conversation;
    this.primaryProvider =
      route.provider === "openrouter" ? "openrouter" : "openai";
    this.get<HTMLSelectElement>("ai-provider").value = this.primaryProvider;
    this.get<HTMLInputElement>("ai-model").value =
      route.provider === "demo"
        ? defaultModelRoute(this.primaryProvider).model
        : route.model;
    this.get<HTMLInputElement>("ai-key").value =
      this.draftCredentials[this.primaryProvider] ?? "";
    for (const provider of ["openai", "openrouter"] as const)
      this.get<HTMLInputElement>(`${provider}-key`).value =
        this.draftCredentials[provider] ?? "";
    this.get<HTMLInputElement>("budget-limit").value = String(
      config.limits.budgetUSD,
    );
    this.get<HTMLInputElement>("request-limit").value = String(
      config.limits.requestsPerMinute,
    );
    this.get<HTMLInputElement>("concurrency-limit").value = String(
      config.limits.concurrency,
    );
    this.get<HTMLInputElement>("observe").checked = this.snapshot.observe;
    this.get<HTMLInputElement>("debug").checked = this.snapshot.debug;
    this.get<HTMLInputElement>("capture-content").checked =
      config.captureContent;
    this.get<HTMLInputElement>("test-provider").checked =
      !!config.testProviderEnabled && route.provider === "demo";
    this.get<HTMLInputElement>("custom-routes").checked = AI_ROLES.some(
      (role) =>
        role !== "speech" &&
        JSON.stringify(config.routes[role]) !== JSON.stringify(route),
    );
    this.get<HTMLDetailsElement>("advanced-settings").open = false;
    this.get("settings-intro").textContent =
      message ??
      "Connect an AI provider to create apps and talk with your assistant.";
    this.get<HTMLButtonElement>("save-settings").textContent =
      missingProviderRoles(config, this.draftCredentials).length
        ? "Connect and save"
        : "Save settings";
    this.get<HTMLButtonElement>("save-settings").disabled = false;
    this.setStatus("");
    this.renderRoutes();
    this.updateDisclosure();
    this.updateProviderHelp();
    this.dialog.returnValue = "";
    if (!this.dialog.open) this.dialog.showModal();
    this.get<HTMLSelectElement>("ai-provider").focus();
  }
  private capturePrimaryKey(): void {
    this.draftCredentials[this.primaryProvider] =
      this.get<HTMLInputElement>("ai-key").value.trim();
    this.get<HTMLInputElement>(`${this.primaryProvider}-key`).value =
      this.draftCredentials[this.primaryProvider] ?? "";
  }
  private syncConversationRoute(): void {
    const row = this.get("model-routes").querySelector<HTMLElement>(
      '[data-role="conversation"]',
    );
    if (!row) return;
    row.querySelector<HTMLSelectElement>(".provider")!.value =
      this.primaryProvider;
    row.querySelector<HTMLInputElement>(".model")!.value =
      this.get<HTMLInputElement>("ai-model").value;
  }
  private updateProviderHelp(): void {
    this.get<HTMLAnchorElement>("provider-help").href =
      this.primaryProvider === "openai"
        ? "https://platform.openai.com/api-keys"
        : "https://openrouter.ai/settings/keys";
  }
  private updateDisclosure(): void {
    const test = this.get<HTMLInputElement>("test-provider").checked;
    const custom = this.get<HTMLInputElement>("custom-routes").checked;
    this.get("model-routes").hidden = !custom || test;
    this.get("additional-keys").hidden = !custom || test;
    for (const row of this.get(
      "model-routes",
    ).querySelectorAll<HTMLFieldSetElement>("fieldset"))
      row.disabled = !custom || test;
    for (const input of this.get(
      "additional-keys",
    ).querySelectorAll<HTMLInputElement>("input"))
      input.disabled = !custom || test;
    this.get<HTMLInputElement>("custom-routes").disabled = test;
    this.get("test-notice").hidden = !test;
    for (const id of ["ai-provider", "ai-model", "ai-key"])
      this.get<HTMLInputElement>(id).disabled = test;
    this.get<HTMLInputElement>("ai-key").required = !test;
  }
  private renderRoutes(): void {
    const root = this.get("model-routes");
    root.replaceChildren();
    for (const role of AI_ROLES) {
      if (role === "speech") continue;
      const route = this.snapshot.config.routes[role];
      const row = document.createElement("fieldset");
      row.className = "model-row";
      row.dataset.role = role;
      const legend = document.createElement("legend");
      legend.textContent = ROLE_LABELS[role];
      row.append(legend);
      const provider = document.createElement("select");
      provider.className = "provider";
      for (const [value, text] of [
        ["openai", "OpenAI"],
        ["openrouter", "OpenRouter"],
      ]) {
        const option = document.createElement("option");
        option.value = value!;
        option.textContent = text!;
        provider.append(option);
      }
      provider.value =
        route.provider === "demo" ? this.primaryProvider : route.provider;
      this.label(row, "Provider", provider, `${ROLE_LABELS[role]} provider`);
      const model = document.createElement("input");
      model.className = "model";
      model.value =
        route.provider === "demo"
          ? defaultModelRoute(this.primaryProvider).model
          : route.model;
      model.maxLength = 160;
      this.label(row, "Model", model, `${ROLE_LABELS[role]} model`);
      for (const [field, caption] of [
        ["maxOutputTokens", "Maximum output tokens"],
        ["inputPerMillion", "Input price per million tokens (USD)"],
        ["outputPerMillion", "Output price per million tokens (USD)"],
      ] as const) {
        const input = document.createElement("input");
        input.type = "number";
        input.min = field === "maxOutputTokens" ? "1" : "0.001";
        input.step = field === "maxOutputTokens" ? "1" : "any";
        if (field === "maxOutputTokens") input.max = "32768";
        input.dataset.field = field;
        input.value = String(
          route.provider === "demo"
            ? defaultModelRoute(this.primaryProvider)[field]
            : route[field],
        );
        this.label(row, caption, input, `${ROLE_LABELS[role]} ${caption}`);
      }
      model.oninput = () => {
        if (role === "conversation")
          this.get<HTMLInputElement>("ai-model").value = model.value;
      };
      provider.onchange = () => {
        const defaults = defaultModelRoute(provider.value as ProviderId);
        model.value = defaults.model;
        if (role === "conversation") {
          this.capturePrimaryKey();
          this.primaryProvider = provider.value as "openai" | "openrouter";
          this.get<HTMLSelectElement>("ai-provider").value =
            this.primaryProvider;
          this.get<HTMLInputElement>("ai-model").value = model.value;
          this.get<HTMLInputElement>("ai-key").value =
            this.draftCredentials[this.primaryProvider] ?? "";
          this.updateProviderHelp();
        }
        for (const field of ["inputPerMillion", "outputPerMillion"] as const)
          row.querySelector<HTMLInputElement>(`[data-field=${field}]`)!.value =
            String(defaults[field]);
      };
      root.append(row);
    }
  }
  private label(
    row: HTMLElement,
    caption: string,
    control: HTMLElement,
    accessibleName: string,
  ): void {
    const label = document.createElement("label");
    label.textContent = caption;
    control.setAttribute("aria-label", accessibleName);
    label.append(control);
    row.append(label);
  }
  private setStatus(message: string, error = false): void {
    const status = this.get("settings-status");
    status.setAttribute("role", error ? "alert" : "status");
    status.textContent = message;
  }
  private async save(): Promise<void> {
    if (
      this.checking ||
      !this.get<HTMLFormElement>("settings-form").reportValidity()
    )
      return;
    const controller = new AbortController();
    this.checking = controller;
    const save = this.get<HTMLButtonElement>("save-settings");
    save.disabled = true;
    try {
      this.options.canSave?.();
      this.capturePrimaryKey();
      const next = structuredClone(this.snapshot.config);
      const test = this.get<HTMLInputElement>("test-provider").checked;
      next.testProviderEnabled = test;
      if (test) {
        for (const role of AI_ROLES)
          next.routes[role] = defaultModelRoute("demo");
      } else if (this.get<HTMLInputElement>("custom-routes").checked) {
        for (const row of this.get(
          "model-routes",
        ).querySelectorAll<HTMLElement>(".model-row")) {
          const role = row.dataset.role as AIRole;
          const route = next.routes[role];
          route.provider = row.querySelector<HTMLSelectElement>(".provider")!
            .value as ProviderId;
          route.model = row
            .querySelector<HTMLInputElement>(".model")!
            .value.trim();
          for (const field of [
            "inputPerMillion",
            "outputPerMillion",
            "maxOutputTokens",
          ] as const)
            route[field] = Number(
              row.querySelector<HTMLInputElement>(`[data-field=${field}]`)!
                .value,
            );
        }
      } else {
        const route = {
          ...defaultModelRoute(this.primaryProvider),
          model: this.get<HTMLInputElement>("ai-model").value.trim(),
        };
        const previous = this.snapshot.config.routes.conversation;
        if (
          previous.provider === route.provider &&
          previous.model === route.model
        ) {
          route.inputPerMillion = previous.inputPerMillion;
          route.outputPerMillion = previous.outputPerMillion;
          route.maxOutputTokens = previous.maxOutputTokens;
        }
        for (const role of AI_ROLES) next.routes[role] = { ...route };
      }
      next.limits = {
        budgetUSD: Number(this.get<HTMLInputElement>("budget-limit").value),
        requestsPerMinute: Number(
          this.get<HTMLInputElement>("request-limit").value,
        ),
        concurrency: Number(
          this.get<HTMLInputElement>("concurrency-limit").value,
        ),
      };
      next.captureContent =
        this.get<HTMLInputElement>("capture-content").checked;
      const missing = missingProviderRoles(next, this.draftCredentials);
      if (missing.length)
        throw new Error(
          "Add an API key for each selected provider. Additional keys are in Advanced.",
        );
      this.setStatus(
        test
          ? "Saving explicit test configuration…"
          : "Checking your AI connection…",
      );
      await this.options
        .getService()
        .testConfiguration(next, this.draftCredentials, {
          appId: "settings",
          correlationId: crypto.randomUUID(),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30_000),
          ]),
        });
      controller.signal.throwIfAborted();
      await this.options.onSave({
        config: next,
        credentials: { ...this.draftCredentials },
        observe: this.get<HTMLInputElement>("observe").checked,
        debug: this.get<HTMLInputElement>("debug").checked,
      });
      this.dialog.close("saved");
      try {
        await this.options.onSaved?.();
      } catch (error) {
        this.options.onError?.(error);
      }
    } catch (error) {
      if (this.dialog.open && !controller.signal.aborted)
        this.setStatus(
          error instanceof DOMException && error.name === "TimeoutError"
            ? "The connection check took too long. Check your network and try again."
            : error instanceof Error
              ? error.message
              : "Couldn't connect. Check your key and try again.",
          true,
        );
    } finally {
      if (this.checking === controller) this.checking = null;
      save.disabled = false;
    }
  }
}
