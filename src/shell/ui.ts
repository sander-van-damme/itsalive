import { createIcons, icons } from 'lucide';

declare const __ITSALIVE_COMMIT__: string;
const BUILD_COMMIT = typeof __ITSALIVE_COMMIT__ === 'string' && __ITSALIVE_COMMIT__.trim() ? __ITSALIVE_COMMIT__.trim() : 'development';

export interface AppSummary { id: string; name: string }
export interface ChatLine { role: 'user' | 'assistant' | 'system'; content: string }
export interface InteractionPrompt { id: string; content: string; intentPlaceholder: string; confirmLabel: string; dismissLabel: string }
export interface ResumePrompt { id: string; content: string; actionLabel: string }
export const DEFAULT_HISTORY_CONTEXT_TOKENS = 12_000;
export interface SettingsValue { apiKey: string; historyContextTokens: number }
export interface UsageValue {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  costComplete: boolean;
  latestContextTokens?: number;
  contextCapacity?: number;
  keyUsage?: number;
  keyLimit?: number | null;
  keyLimitRemaining?: number | null;
}
export type RuntimeViewState = 'loading' | 'ready' | 'problem';
type RailView = 'workspace' | 'launcher' | 'creation' | 'settings';
type MobileView = 'app' | 'chat';

export interface ShellActions {
  createApp(goal: string): Promise<void>;
  selectApp(id: string): Promise<void>;
  deleteApp(id: string): Promise<void>;
  sendMessage(content: string): Promise<void>;
  stopAgent(): void;
  resumePausedRun(id: string): Promise<void>;
  resolveInteractionPrompt(id: string, intent?: string): Promise<void>;
  renameApp(name: string): Promise<void>;
  saveSettings(value: SettingsValue): Promise<void>;
  refreshUsage(): Promise<void>;
  checkDiagnostics(): Promise<number>;
  exportLogs(): Promise<void>;
  reloadApp(): void;
}

const esc = (value: string) => value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'IA';
const compactTokens = (value: number) => value < 1_000 ? String(Math.round(value)) : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const money = (value: number) => String.fromCharCode(36) + (value > 0 && value < 1 ? value.toFixed(4) : value.toFixed(2));
function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  const viewportLimit = Math.max(120, Math.min(260, Math.floor(window.innerHeight * 0.3)));
  textarea.style.height = `${Math.min(textarea.scrollHeight, viewportLimit)}px`;
  textarea.style.overflowY = textarea.scrollHeight > viewportLimit ? 'auto' : 'hidden';
}
export function friendlyError(error: unknown, appName = 'This app'): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/iframe|not connected|not available|not ready/i.test(message)) return `${appName} isn't ready yet. Try reloading it.`;
  if (/timed? out|timeout/i.test(message)) return `${appName} took too long to respond. Try again.`;
  return `Something went wrong while working on ${appName}. Try again.`;
}

export class ShellUI {
  private view: RailView = 'launcher';
  private mobileView: MobileView = 'chat';
  private apps: AppSummary[] = [];
  private active?: AppSummary;
  private messages: ChatLine[] = [];
  private interactionPrompt?: InteractionPrompt;
  private resumePrompt?: ResumePrompt;
  private settings: SettingsValue = { apiKey: '', historyContextTokens: DEFAULT_HISTORY_CONTEXT_TOKENS };
  private modelContextTokens?: number;
  private usage: UsageValue = { requests: 0, inputTokens: 0, outputTokens: 0, costComplete: true };
  private usageOpen = false;
  private busy = false;
  private agentProgress = '';
  private appUpdating = false;
  private runtimeState: RuntimeViewState = 'ready';
  private collapsed = localStorage.getItem('itsalive.sidebar') === 'collapsed';
  private theme = localStorage.getItem('itsalive.theme') ?? 'light';
  private switcherOpen = false;
  private actionsOpen = false;
  private chatNearBottom = true;
  private settingsNotice = '';

  constructor(private readonly mount: HTMLElement, private readonly actions: ShellActions) {
    this.renderShell();
    document.addEventListener('keydown', this.handleDocumentKeydown);
  }

  setApps(apps: AppSummary[], activeId?: string): void {
    const previousId = this.active?.id;
    this.apps = apps;
    this.active = apps.find(app => app.id === activeId);
    if (this.active) this.view = 'workspace';
    else if (this.view === 'workspace') this.view = 'launcher';
    if (previousId !== this.active?.id) {
      this.switcherOpen = false;
      this.actionsOpen = false;
      this.mobileView = 'chat';
      this.interactionPrompt = undefined;
      this.resumePrompt = undefined;
    }
    this.renderStagePlaceholder();
    this.renderRail();
  }

  setMessages(messages: ChatLine[]): void {
    this.rememberChatPosition();
    this.messages = messages;
    if (this.view === 'workspace') this.renderPanel();
  }

  setInteractionPrompt(prompt: InteractionPrompt | undefined): void {
    this.interactionPrompt = prompt;
    if (this.view === 'workspace') this.renderPanel();
  }

  setResumePrompt(prompt: ResumePrompt | undefined): void {
    this.resumePrompt = prompt;
    if (this.view === 'workspace') this.renderPanel();
  }

  setSettings(settings: Partial<SettingsValue>): void { this.settings = { ...this.settings, ...settings }; }
  setModelContextCapacity(tokens: number | undefined): void {
    this.modelContextTokens = tokens;
    const node = this.mount.querySelector<HTMLElement>('[data-model-context]');
    if (node) node.textContent = `Auto Router context capacity: ${tokens == null ? 'Not loaded yet' : `${tokens.toLocaleString()} tokens`}. This is loaded from OpenRouter rather than hardcoded.`;
  }

  setUsage(usage: UsageValue): void {
    this.usage = { ...usage };
    this.renderRail();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy) { this.agentProgress = ''; this.appUpdating = false; }
    this.renderStageState();
    this.renderRail();
  }

  setAgentProgress(message: string, appUpdating = false): void {
    this.agentProgress = message.trim() || 'Working…';
    this.appUpdating = appUpdating;
    this.renderStageState();
    if (this.view === 'workspace') this.renderPanel();
  }

  setConnectionStatus(tone: 'working' | 'connected' | 'error'): void {
    this.runtimeState = tone === 'error' ? 'problem' : tone === 'working' ? 'loading' : 'ready';
    this.renderStageState();
    this.renderRail();
  }

  showError(error: unknown): void {
    const technical = error instanceof Error ? error.message : String(error);
    console.error('[itsalive] UI operation failed', error);
    this.messages.push({ role: 'system', content: friendlyError(technical, this.active?.name) });
    if (this.active) this.view = 'workspace';
    this.renderRail();
  }

  private renderShell(): void {
    document.documentElement.dataset.theme = this.theme;
    this.mount.innerHTML = `
      <main class="shell ${this.collapsed ? 'collapsed' : ''}" data-mobile-view="${this.mobileView}">
        <section class="stage" aria-label="Active application">
          <div class="app-frame-wrap"></div>
          <div class="stage-state" data-stage-state hidden></div>
          <button class="mobile-view-button" data-mobile-chat type="button">
            <i data-lucide="message-circle" aria-hidden="true"></i><span>Chat</span>
          </button>
        </section>
        <aside class="rail" aria-label="AI workspace"></aside>
      </main>`;
    this.renderStagePlaceholder();
    this.renderRail();
  }

  private renderStagePlaceholder(): void {
    const wrap = this.mount.querySelector<HTMLElement>('.app-frame-wrap');
    if (wrap && !wrap.querySelector('iframe')) {
      wrap.innerHTML = `<div class="empty-stage"><span class="empty-logo">IA</span><strong>${this.active ? 'Loading…' : 'Your next idea starts here'}</strong><p>${this.active ? esc(this.active.name) : 'Create or choose an app to begin.'}</p></div>`;
    }
    this.renderStageState();
  }

  private renderStageState(): void {
    const node = this.mount.querySelector<HTMLElement>('[data-stage-state]');
    if (!node) return;
    const isProblem = Boolean(this.active) && this.runtimeState === 'problem';
    const isUpdating = Boolean(this.active) && this.busy && this.appUpdating && !isProblem;
    node.className = isUpdating ? 'stage-state updating' : 'stage-state';
    node.hidden = !isProblem && !isUpdating;
    if (isProblem) node.innerHTML = `<strong>${esc(this.active!.name)} couldn't load.</strong><p>Try reloading the app.</p><button class="action" data-stage-retry type="button">Try again</button>`;
    else if (isUpdating) node.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(this.agentProgress || 'Updating the app…')}</span>`;
    else node.replaceChildren();
    node.querySelector<HTMLButtonElement>('[data-stage-retry]')?.addEventListener('click', () => this.actions.reloadApp());
  }

  mountFrame(frame: HTMLIFrameElement | undefined): void {
    if (!frame) return;
    const wrap = this.mount.querySelector('.app-frame-wrap');
    if (!wrap) return;
    wrap.replaceChildren(frame);
    frame.className = 'app-frame';
    frame.title = `${this.active?.name ?? 'itsalive app'} application`;
  }

  private renderRail(): void {
    document.documentElement.dataset.theme = this.theme;
    const shell = this.mount.querySelector<HTMLElement>('.shell');
    shell?.classList.toggle('collapsed', this.collapsed);
    shell?.setAttribute('data-mobile-view', this.mobileView);
    const rail = this.mount.querySelector<HTMLElement>('.rail');
    if (!rail) return;
    rail.innerHTML = `${this.renderWorkspaceHeader()}<section class="panel" data-panel></section>${this.renderGlobalActions()}`;
    this.bindHeader(rail);
    this.renderPanel();
    createIcons({ icons });
  }

  private renderWorkspaceHeader(): string {
    const appControl = this.active ? `
      <div class="menu-anchor workspace-app">
        <button class="app-trigger" data-switcher type="button" aria-haspopup="menu" aria-expanded="${this.switcherOpen}">
          <span class="app-icon">${esc(initials(this.active.name))}</span>
          <span class="app-name">${esc(this.active.name)}</span><i data-lucide="chevron-down" aria-hidden="true"></i>
        </button>
        ${this.switcherOpen ? this.renderAppSwitcher() : ''}
      </div>
      <div class="menu-anchor">
        <button class="icon-button quiet" data-app-menu type="button" aria-label="App actions" aria-haspopup="menu" aria-expanded="${this.actionsOpen}"><i data-lucide="ellipsis" aria-hidden="true"></i></button>
        ${this.actionsOpen ? this.renderAppMenu() : ''}
      </div>` : `<button class="wordmark" data-launcher type="button" aria-label="Open your apps"><span class="brand-mark">IA</span><strong>itsalive</strong></button>`;
    return `<header class="workspace-header">
      <button class="icon-button collapse-button" data-collapse type="button" aria-label="${this.collapsed ? 'Expand' : 'Collapse'} sidebar"><i data-lucide="panel-right-${this.collapsed ? 'open' : 'close'}" aria-hidden="true"></i></button>
      <div class="expanded-header">${appControl}</div>
    </header>`;
  }

  private renderAppSwitcher(): string {
    return `<div class="popover app-switcher" role="menu" aria-label="Switch app">
      <div class="menu-list">${this.apps.map(app => `<button type="button" role="menuitem" class="menu-item" data-select-app="${esc(app.id)}" ${app.id === this.active?.id ? 'aria-current="true"' : ''}><span class="app-icon small">${esc(initials(app.name))}</span><span>${esc(app.name)}</span>${app.id === this.active?.id ? '<i data-lucide="check" aria-hidden="true"></i>' : ''}</button>`).join('')}</div>
      <button type="button" role="menuitem" class="menu-item new-app" data-new><i data-lucide="plus" aria-hidden="true"></i><span>New app</span></button>
    </div>`;
  }

  private renderAppMenu(): string {
    return `<div class="popover app-menu" role="menu" aria-label="App actions">
      <button class="menu-item" role="menuitem" type="button" data-rename><i data-lucide="pencil" aria-hidden="true"></i><span>Rename app</span></button>
      <button class="menu-item" role="menuitem" type="button" data-reload><i data-lucide="refresh-cw" aria-hidden="true"></i><span>Reload app</span></button>
      <button class="menu-item danger" role="menuitem" type="button" data-delete><i data-lucide="trash-2" aria-hidden="true"></i><span>Delete app</span></button>
    </div>`;
  }

  private renderGlobalActions(): string {
    const sessionTotal = this.usage.inputTokens + this.usage.outputTokens;
    const tokenLabel = `${compactTokens(sessionTotal)} tok`;
    const compactCost = this.usage.cost !== undefined ? money(this.usage.cost) : this.usage.requests ? 'price n/a' : '$0.00';
    const usageLabel = `${tokenLabel} · ${compactCost}`;
    const usageAria = this.usage.costComplete
      ? `${tokenLabel}; session cost ${compactCost}`
      : `${tokenLabel}; known priced cost ${compactCost}; some requests did not report a price`;
    const context = this.usage.latestContextTokens !== undefined && this.usage.contextCapacity !== undefined
      ? `${compactTokens(this.usage.latestContextTokens)} / ${compactTokens(this.usage.contextCapacity)}`
      : 'Not measured yet';
    const keySpend = this.usage.keyUsage !== undefined ? money(this.usage.keyUsage) : 'Not loaded';
    const remaining = typeof this.usage.keyLimitRemaining === 'number' ? money(this.usage.keyLimitRemaining) : this.usage.keyLimitRemaining === null ? 'No key limit' : 'Not loaded';
    const cost = this.usage.cost !== undefined ? money(this.usage.cost) : this.usage.requests ? 'Not reported' : '$0.00';
    const costLabel = this.usage.costComplete ? 'Session cost' : 'Known session cost';
    const costNote = !this.usage.costComplete && this.usage.requests
      ? '<p class="usage-note">Some AI requests did not report a price. The known cost is only the priced portion of this session.</p>'
      : '';
    const usagePopover = this.usageOpen ? `<div class="popover usage-popover" data-usage-popover>
        <strong>OpenRouter usage</strong>
        <dl>
          <div><dt>This session</dt><dd>${esc(compactTokens(this.usage.inputTokens))} in · ${esc(compactTokens(this.usage.outputTokens))} out</dd></div>
          <div><dt>${esc(costLabel)}</dt><dd>${esc(cost)}</dd></div>
          <div><dt>Current context</dt><dd>${esc(context)}</dd></div>
          <div><dt>Key spend</dt><dd>${esc(keySpend)}</dd></div>
          <div><dt>Key remaining</dt><dd>${esc(remaining)}</dd></div>
        </dl>
        ${costNote}
      </div>` : '';
    return `<nav class="global-actions" aria-label="Global controls">
      <button class="icon-button quiet" data-mobile-app type="button" aria-label="View app"><i data-lucide="panel-left" aria-hidden="true"></i><span>App</span></button>
      <div class="usage-anchor">
        <button class="usage-button ${this.usageOpen ? 'active' : ''}" data-usage type="button" aria-label="OpenRouter usage: ${esc(usageAria)}" aria-expanded="${this.usageOpen}"><i data-lucide="circle-gauge" aria-hidden="true"></i><span>${esc(usageLabel)}</span></button>
        ${usagePopover}
      </div>
      <button class="icon-button quiet ${this.view === 'settings' ? 'active' : ''}" data-settings type="button" aria-label="Settings"><i data-lucide="settings" aria-hidden="true"></i><span>Settings</span></button>
      <button class="icon-button quiet" data-theme type="button" aria-label="Use ${this.theme === 'light' ? 'dark' : 'light'} theme"><i data-lucide="${this.theme === 'light' ? 'moon' : 'sun'}" aria-hidden="true"></i><span>Theme</span></button>
    </nav>`;
  }

  private bindHeader(rail: HTMLElement): void {
    rail.querySelector<HTMLButtonElement>('[data-collapse]')!.onclick = () => {
      this.collapsed = !this.collapsed;
      localStorage.setItem('itsalive.sidebar', this.collapsed ? 'collapsed' : 'expanded');
      this.renderRail();
    };
    rail.querySelector<HTMLButtonElement>('[data-usage]')!.onclick = () => {
      this.usageOpen = !this.usageOpen;
      if (this.usageOpen) { this.switcherOpen = false; this.actionsOpen = false; }
      this.renderRail();
      if (this.usageOpen) void this.actions.refreshUsage();
    };
    rail.querySelector<HTMLButtonElement>('[data-theme]')!.onclick = () => {
      this.usageOpen = false;
      this.theme = this.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('itsalive.theme', this.theme);
      this.renderRail();
    };
    rail.querySelector<HTMLButtonElement>('[data-settings]')!.onclick = () => { this.usageOpen = false; this.view = this.view === 'settings' && this.active ? 'workspace' : 'settings'; this.collapsed = false; this.renderRail(); };
    rail.querySelector<HTMLButtonElement>('[data-switcher]')?.addEventListener('click', () => { this.switcherOpen = !this.switcherOpen; this.actionsOpen = false; this.usageOpen = false; this.renderRail(); this.focusFirstMenuItem(); });
    rail.querySelector<HTMLButtonElement>('[data-app-menu]')?.addEventListener('click', () => { this.actionsOpen = !this.actionsOpen; this.switcherOpen = false; this.usageOpen = false; this.renderRail(); this.focusFirstMenuItem(); });
    rail.querySelector<HTMLButtonElement>('[data-launcher]')?.addEventListener('click', () => { this.view = 'launcher'; this.renderRail(); });
    rail.querySelector<HTMLButtonElement>('[data-mobile-app]')!.onclick = () => { this.mobileView = 'app'; this.renderRail(); };
    this.mount.querySelector<HTMLButtonElement>('[data-mobile-chat]')!.onclick = () => { this.mobileView = 'chat'; this.renderRail(); };
    rail.querySelectorAll<HTMLButtonElement>('[data-select-app]').forEach(button => button.onclick = () => { this.switcherOpen = false; this.view = 'workspace'; void this.actions.selectApp(button.dataset.selectApp ?? ''); });
    rail.querySelector<HTMLButtonElement>('[data-new]')?.addEventListener('click', () => { this.switcherOpen = false; this.beginCreation(); });
    rail.querySelector<HTMLButtonElement>('[data-rename]')?.addEventListener('click', () => this.handleRename());
    rail.querySelector<HTMLButtonElement>('[data-reload]')?.addEventListener('click', () => { this.actionsOpen = false; this.actions.reloadApp(); this.renderRail(); });
    rail.querySelector<HTMLButtonElement>('[data-delete]')?.addEventListener('click', () => this.handleDelete());
  }

  private renderPanel(): void {
    const panel = this.mount.querySelector<HTMLElement>('[data-panel]');
    if (!panel) return;
    if (this.view === 'settings') this.renderSettings(panel);
    else if (this.view === 'creation') this.renderCreation(panel);
    else if (!this.active || this.view === 'launcher') this.renderLauncher(panel);
    else this.renderChat(panel);
    createIcons({ icons });
  }

  private renderLauncher(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-heading"><h1>Your apps</h1><p>Choose an app or start something new.</p></header>
      <div class="scroll launcher-content">
        <div class="launcher-list">${this.apps.map(app => `<button class="launcher-item" data-launch-app="${esc(app.id)}" type="button"><span class="app-icon">${esc(initials(app.name))}</span><strong>${esc(app.name)}</strong><i data-lucide="arrow-right" aria-hidden="true"></i></button>`).join('')}</div>
        <button class="action primary full-width" data-create type="button"><i data-lucide="plus" aria-hidden="true"></i>Create new app</button>
      </div>`;
    panel.querySelectorAll<HTMLButtonElement>('[data-launch-app]').forEach(button => button.onclick = () => void this.actions.selectApp(button.dataset.launchApp ?? ''));
    panel.querySelector<HTMLButtonElement>('[data-create]')!.onclick = () => this.beginCreation();
  }

  private renderChat(panel: HTMLElement): void {
    const interactionPrompt = this.interactionPrompt && !this.busy
      ? `<div class="message assistant interaction-prompt" data-interaction-prompt="${esc(this.interactionPrompt.id)}">
          <span>${esc(this.interactionPrompt.content)}</span>
          <label class="sr-only" for="interaction-intent">What did you expect to happen?</label>
          <textarea id="interaction-intent" data-prompt-intent rows="2" placeholder="${esc(this.interactionPrompt.intentPlaceholder)}"></textarea>
          <div class="prompt-actions">
            <button class="action primary" data-prompt-confirm type="button" disabled>${esc(this.interactionPrompt.confirmLabel)}</button>
            <button class="action" data-prompt-dismiss type="button">${esc(this.interactionPrompt.dismissLabel)}</button>
          </div>
        </div>`
      : '';
    const resumePrompt = this.resumePrompt
      ? `<div class="message assistant interaction-prompt" data-resume-prompt="${esc(this.resumePrompt.id)}">
          <span>${esc(this.resumePrompt.content)}</span>
          <div class="prompt-actions">
            <button class="action primary" data-resume-run type="button" ${this.busy ? 'disabled' : ''}>${esc(this.resumePrompt.actionLabel)}</button>
          </div>
        </div>`
      : '';
    const prompts = `${resumePrompt}${interactionPrompt}`;
    const messages = this.messages.length || prompts
      ? `${this.messages.map(message => `<div class="message ${message.role}">${esc(message.content)}</div>`).join('')}${prompts}`
      : `<div class="empty-chat"><i data-lucide="wand-sparkles" aria-hidden="true"></i><strong>What should we change?</strong><p>Ask for a feature, design change, fix, or anything else.</p></div>`;
    const composerAction = this.busy
      ? `<button class="send stop" data-stop type="button" aria-label="Stop agent"><i data-lucide="square" aria-hidden="true"></i></button>`
      : `<button class="send" type="submit" aria-label="Send message"><i data-lucide="arrow-up" aria-hidden="true"></i></button>`;
    const progress = this.busy
      ? `<div class="working-state" role="status"><span class="spinner" aria-hidden="true"></span>${esc(this.agentProgress || 'Working…')}</div>`
      : '';
    panel.innerHTML = `<div class="chat-stream" data-stream aria-live="polite">${messages}${progress}</div>
      <form class="composer" data-composer><div class="composer-box"><label class="sr-only" for="message">Message</label><textarea id="message" rows="1" placeholder="Ask me to change anything…" ${this.busy ? 'disabled' : ''}></textarea>${composerAction}</div></form>`;
    const stream = panel.querySelector<HTMLElement>('[data-stream]')!;
    if (this.chatNearBottom) stream.scrollTop = stream.scrollHeight;
    stream.onscroll = () => { this.chatNearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80; };
    const intentInput = panel.querySelector<HTMLTextAreaElement>('[data-prompt-intent]');
    const intentConfirm = panel.querySelector<HTMLButtonElement>('[data-prompt-confirm]');
    if (intentInput && intentConfirm) {
      intentInput.addEventListener('input', () => { intentConfirm.disabled = !intentInput.value.trim(); });
    }
    const resolvePrompt = (intent?: string) => {
      const current = this.interactionPrompt;
      if (!current) return;
      panel.querySelectorAll<HTMLButtonElement>('[data-prompt-confirm], [data-prompt-dismiss]').forEach(button => { button.disabled = true; });
      if (intentInput) intentInput.disabled = true;
      void this.actions.resolveInteractionPrompt(current.id, intent?.trim() || undefined);
    };
    intentConfirm?.addEventListener('click', () => resolvePrompt(intentInput?.value));
    panel.querySelector<HTMLButtonElement>('[data-prompt-dismiss]')?.addEventListener('click', () => resolvePrompt());
    panel.querySelector<HTMLButtonElement>('[data-resume-run]')?.addEventListener('click', event => {
      const current = this.resumePrompt;
      if (!current) return;
      (event.currentTarget as HTMLButtonElement).disabled = true;
      void this.actions.resumePausedRun(current.id);
    });
    panel.querySelector<HTMLButtonElement>('[data-stop]')?.addEventListener('click', event => {
      (event.currentTarget as HTMLButtonElement).disabled = true;
      this.actions.stopAgent();
    });
    const form = panel.querySelector<HTMLFormElement>('[data-composer]')!;
    const textarea = panel.querySelector<HTMLTextAreaElement>('#message')!;
    const resize = () => resizeComposerTextarea(textarea);
    textarea.oninput = resize;
    resize();
    form.onsubmit = event => { event.preventDefault(); if (this.busy) return; const content = textarea.value.trim(); if (!content) return; textarea.value = ''; resize(); this.chatNearBottom = true; void this.actions.sendMessage(content); };
    textarea.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !this.busy) { event.preventDefault(); form.requestSubmit(); } };
  }

  private renderCreation(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-heading flow-heading"><button class="icon-button quiet" data-cancel type="button" aria-label="Cancel"><i data-lucide="arrow-left" aria-hidden="true"></i></button><div><h1>What do you want to make?</h1><p>Describe the app you have in mind. You can refine it after the first version appears.</p></div></header>
      <div class="creation-status" data-create-status aria-live="polite">Include the behavior or details that matter most to you.</div>
      <form class="composer" data-create-form><div class="composer-box"><label class="sr-only" for="goal">Describe your app</label><textarea id="goal" rows="1" required autofocus placeholder="Describe your app…"></textarea><button class="send" type="submit" aria-label="Start building"><i data-lucide="arrow-up" aria-hidden="true"></i></button></div></form>`;
    panel.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = () => { this.view = this.active ? 'workspace' : 'launcher'; this.renderRail(); };
    const form = panel.querySelector<HTMLFormElement>('[data-create-form]')!;
    const goal = panel.querySelector<HTMLTextAreaElement>('#goal')!;
    const resize = () => resizeComposerTextarea(goal);
    goal.oninput = resize;
    resize();
    form.onsubmit = event => { event.preventDefault(); void this.handleCreateApp(panel, form, goal); };
    goal.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
  }

  private async handleCreateApp(panel: HTMLElement, form: HTMLFormElement, goal: HTMLTextAreaElement): Promise<void> {
    const content = goal.value.trim();
    if (!content) return;
    goal.disabled = true;
    const submit = form.querySelector<HTMLButtonElement>('button')!;
    submit.disabled = true;
    const status = panel.querySelector<HTMLElement>('[data-create-status]')!;
    status.className = 'creation-status pending';
    status.textContent = 'Starting your app…';
    try {
      await this.actions.createApp(content);
    } catch (error) {
      status.className = 'creation-status failure';
      status.textContent = friendlyError(error, 'your new app');
      goal.disabled = false;
      submit.disabled = false;
      goal.focus();
    }
  }

  private renderSettings(panel: HTMLElement): void {
    const contextCapacity = this.modelContextTokens == null ? 'Not loaded yet' : `${this.modelContextTokens.toLocaleString()} tokens`;
    panel.innerHTML = `<header class="panel-heading flow-heading"><button class="icon-button quiet" data-close-settings type="button" aria-label="Close settings"><i data-lucide="arrow-left" aria-hidden="true"></i></button><div><h1>Settings</h1><p>${esc(this.settingsNotice || 'Configure OpenRouter and testing controls.')}</p></div></header>
      <form class="scroll settings-form" data-settings-form>
        <section class="settings-section" aria-labelledby="openrouter-heading"><h2 id="openrouter-heading">OpenRouter</h2>
          <p>All AI requests use OpenRouter Auto.</p>
          <div class="field"><label for="apiKey">OpenRouter API key</label><input id="apiKey" type="password" required value="${esc(this.settings.apiKey)}" autocomplete="off" placeholder="Paste your OpenRouter API key"></div>
          <p class="security-note">Stored locally in this browser and never shared with generated apps. Avoid saving it on shared devices.</p>
          <p class="security-note" data-model-context>Auto Router context capacity: ${esc(contextCapacity)}. This is loaded from OpenRouter rather than hardcoded.</p>
          <p class="security-note">Session usage and key spend are shown in the usage control at the bottom of the sidebar.</p>
        </section>
        <section class="settings-section" aria-labelledby="context-test-heading"><h2 id="context-test-heading">Context testing</h2>
          <p>Use this while testing to vary how much prior shell history can be sent on each agent turn.</p>
          <div class="field"><label for="historyContextTokens">History budget (tokens)</label><input id="historyContextTokens" type="number" min="0" step="1000" required value="${this.settings.historyContextTokens}"></div>
          <p class="security-note">This budget applies only to prior history. The system prompt, app prompt, current request and latest observations are handled separately. The live model context capacity remains the hard safety ceiling.</p>
          <button class="action primary full-width" type="submit">Save</button><div class="settings-result" data-result role="status"></div>
        </section>
        <section class="settings-section build-info"><h2>Build</h2><p>Commit <code data-build-commit>${esc(BUILD_COMMIT)}</code></p></section>
        <section class="settings-section diagnostics">
          <h2>Diagnostics</h2>
          <p data-diagnostics-status role="status">Check logging before a test to confirm diagnostics are being saved locally.</p>
          <div class="diagnostics-actions">
            <button class="action" type="button" data-check-diagnostics>Check logging</button>
            <button class="action" type="button" data-export><i data-lucide="download" aria-hidden="true"></i>Export session logs</button>
          </div>
        </section>
      </form>`;
    panel.querySelector<HTMLButtonElement>('[data-close-settings]')!.onclick = () => { this.view = this.active ? 'workspace' : 'launcher'; this.renderRail(); };
    panel.querySelector<HTMLButtonElement>('[data-check-diagnostics]')!.onclick = () => void this.handleCheckDiagnostics(panel);
    panel.querySelector<HTMLButtonElement>('[data-export]')!.onclick = () => void this.handleExportLogs(panel);
    panel.querySelector<HTMLFormElement>('[data-settings-form]')!.onsubmit = event => { event.preventDefault(); void this.handleSaveSettings(panel); };
  }

  private async handleCheckDiagnostics(panel: HTMLElement): Promise<void> {
    const status = panel.querySelector<HTMLElement>('[data-diagnostics-status]')!;
    const button = panel.querySelector<HTMLButtonElement>('[data-check-diagnostics]')!;
    button.disabled = true;
    status.textContent = 'Checking logging…';
    try {
      const count = await this.actions.checkDiagnostics();
      status.textContent = `Logging works — ${count.toLocaleString()} diagnostic ${count === 1 ? 'entry is' : 'entries are'} stored locally.`;
    } catch (error) {
      console.error('[itsalive] Diagnostic self-check failed', error);
      status.textContent = 'Logging check failed. Do not start a test yet.';
    } finally {
      button.disabled = false;
    }
  }

  private async handleExportLogs(panel: HTMLElement): Promise<void> {
    const status = panel.querySelector<HTMLElement>('[data-diagnostics-status]')!;
    const button = panel.querySelector<HTMLButtonElement>('[data-export]')!;
    button.disabled = true;
    status.textContent = 'Preparing diagnostic export…';
    try {
      await this.actions.exportLogs();
      status.textContent = 'Diagnostic export created.';
    } catch (error) {
      console.error('[itsalive] Diagnostic export failed', error);
      status.textContent = 'Diagnostic export failed. Do not start a test yet.';
    } finally {
      button.disabled = false;
    }
  }

  private async handleSaveSettings(panel: HTMLElement): Promise<void> {
    const result = panel.querySelector<HTMLElement>('[data-result]')!;
    const button = panel.querySelector<HTMLButtonElement>('button[type=submit]')!;
    result.className = 'settings-result pending'; result.textContent = 'Testing…'; button.disabled = true;
    const historyContextTokens = Number(panel.querySelector<HTMLInputElement>('#historyContextTokens')!.value);
    const value: SettingsValue = {
      apiKey: panel.querySelector<HTMLInputElement>('#apiKey')!.value.trim(),
      historyContextTokens: Number.isFinite(historyContextTokens) ? Math.max(0, Math.floor(historyContextTokens)) : DEFAULT_HISTORY_CONTEXT_TOKENS,
    };
    try {
      await this.actions.saveSettings(value);
      this.settings = value;
      this.settingsNotice = '';
      result.className = 'settings-result success';
      result.textContent = 'API key saved. OpenRouter connection works.';
      if (!this.apps.length && !this.active) { this.view = 'creation'; this.renderRail(); return; }
    }
    catch { result.className = 'settings-result failure'; result.textContent = 'We couldn’t connect to OpenRouter. Check your API key and try again.'; }
    finally { if (button.isConnected) button.disabled = false; }
  }

  private handleDelete(): void {
    if (!this.active) return;
    this.actionsOpen = false;
    if (confirm(`Delete “${this.active.name}”?\n\nThis removes the app and its conversation history.`)) void this.actions.deleteApp(this.active.id);
    else this.renderRail();
  }

  private beginCreation(): void {
    if (!this.settings.apiKey.trim()) {
      this.settingsNotice = 'Add and test your OpenRouter API key before creating an app.';
      this.view = 'settings'; this.collapsed = false; this.renderRail(); return;
    }
    this.view = 'creation'; this.renderRail();
  }

  private handleRename(): void {
    if (!this.active) return;
    this.actionsOpen = false;
    const name = prompt('Rename app', this.active.name);
    if (name !== null && name.trim() && name.trim() !== this.active.name) void this.actions.renameApp(name);
    else this.renderRail();
  }

  private rememberChatPosition(): void {
    const stream = this.mount.querySelector<HTMLElement>('[data-stream]');
    if (stream) this.chatNearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
  }

  private focusFirstMenuItem(): void { requestAnimationFrame(() => this.mount.querySelector<HTMLButtonElement>('[role="menu"] button')?.focus()); }
  private handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || (!this.switcherOpen && !this.actionsOpen && !this.usageOpen)) return;
    this.switcherOpen = false; this.actionsOpen = false; this.usageOpen = false; this.renderRail();
  };
}
