import { createIcons, icons } from 'lucide';

declare const __ITSALIVE_COMMIT__: string;
const BUILD_COMMIT = typeof __ITSALIVE_COMMIT__ === 'string' && __ITSALIVE_COMMIT__.trim() ? __ITSALIVE_COMMIT__.trim() : 'development';

export interface AppSummary { id: string; name: string; prompt: string; createdAt: number; updatedAt: number }
export interface ChatLine { id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }
export interface SettingsValue { apiKey: string }
export type RuntimeViewState = 'loading' | 'ready' | 'working' | 'problem';
type RailView = 'workspace' | 'launcher' | 'creation' | 'settings';
type MobileView = 'app' | 'chat';

export interface ShellActions {
  createApp(input: { name: string; prompt: string }): Promise<void>;
  selectApp(id: string): Promise<void>;
  deleteApp(id: string): Promise<void>;
  sendMessage(content: string): Promise<void>;
  renameApp(name: string): Promise<void>;
  saveSettings(value: SettingsValue): Promise<void>;
  designApp(goal: string): Promise<{ name: string; prompt: string }>;
  exportLogs(): Promise<void>;
  reloadApp(): void;
}

const esc = (value: string) => value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'IA';
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
  private settings: SettingsValue = { apiKey: '' };
  private busy = false;
  private runtimeState: RuntimeViewState = 'ready';
  private runtimeDetail = '';
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
    }
    this.renderStagePlaceholder();
    this.renderRail();
  }

  setMessages(messages: ChatLine[]): void {
    this.rememberChatPosition();
    this.messages = messages;
    if (this.view === 'workspace') this.renderPanel();
  }

  setSettings(settings: Partial<SettingsValue>): void { this.settings = { ...this.settings, ...settings }; }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.renderRail();
  }

  setConnectionStatus(status: string, tone: 'idle' | 'working' | 'connected' | 'error'): void {
    this.runtimeDetail = status;
    this.runtimeState = tone === 'error' ? 'problem' : tone === 'working' ? 'loading' : 'ready';
    this.renderStageState();
    this.renderRail();
  }

  showError(error: unknown): void {
    const technical = error instanceof Error ? error.message : String(error);
    console.error('[itsalive] UI operation failed', error);
    this.messages.push({ id: crypto.randomUUID(), role: 'system', content: friendlyError(technical, this.active?.name), timestamp: Date.now() });
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
    node.hidden = !isProblem;
    if (isProblem) node.innerHTML = `<strong>${esc(this.active!.name)} couldn't load.</strong><p>Try reloading the app.</p><button class="action" data-stage-retry type="button">Try again</button>`;
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
    return `<nav class="global-actions" aria-label="Global controls">
      <button class="icon-button quiet" data-mobile-app type="button" aria-label="View app"><i data-lucide="panel-left" aria-hidden="true"></i><span>App</span></button>
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
    rail.querySelector<HTMLButtonElement>('[data-theme]')!.onclick = () => {
      this.theme = this.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('itsalive.theme', this.theme);
      this.renderRail();
    };
    rail.querySelector<HTMLButtonElement>('[data-settings]')!.onclick = () => { this.view = this.view === 'settings' && this.active ? 'workspace' : 'settings'; this.collapsed = false; this.renderRail(); };
    rail.querySelector<HTMLButtonElement>('[data-switcher]')?.addEventListener('click', () => { this.switcherOpen = !this.switcherOpen; this.actionsOpen = false; this.renderRail(); this.focusFirstMenuItem(); });
    rail.querySelector<HTMLButtonElement>('[data-app-menu]')?.addEventListener('click', () => { this.actionsOpen = !this.actionsOpen; this.switcherOpen = false; this.renderRail(); this.focusFirstMenuItem(); });
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
    panel.innerHTML = `<header class="panel-heading"><p class="eyebrow">Workspace</p><h1>Your apps</h1><p>Choose an app or start something new.</p></header>
      <div class="scroll launcher-content">
        <div class="launcher-list">${this.apps.map(app => `<button class="launcher-item" data-launch-app="${esc(app.id)}" type="button"><span class="app-icon">${esc(initials(app.name))}</span><strong>${esc(app.name)}</strong><i data-lucide="arrow-right" aria-hidden="true"></i></button>`).join('')}</div>
        <button class="action primary full-width" data-create type="button"><i data-lucide="plus" aria-hidden="true"></i>Create new app</button>
      </div>`;
    panel.querySelectorAll<HTMLButtonElement>('[data-launch-app]').forEach(button => button.onclick = () => void this.actions.selectApp(button.dataset.launchApp ?? ''));
    panel.querySelector<HTMLButtonElement>('[data-create]')!.onclick = () => this.beginCreation();
  }

  private renderChat(panel: HTMLElement): void {
    const messages = this.messages.length
      ? this.messages.map(message => `<div class="message ${message.role}">${esc(message.content)}</div>`).join('')
      : `<div class="empty-chat"><i data-lucide="wand-sparkles" aria-hidden="true"></i><strong>Make ${esc(this.active!.name)} yours</strong><p>Ask for a feature, design change, fix, or anything else.</p></div>`;
    panel.innerHTML = `${this.busy ? '<div class="working-state"><span class="spinner" aria-hidden="true"></span>Working…</div>' : ''}
      <div class="chat-stream" data-stream aria-live="polite">${messages}${this.busy ? '<div class="thinking" aria-label="AI is thinking"><i></i><i></i><i></i></div>' : ''}</div>
      <form class="composer" data-composer><div class="composer-box"><label class="sr-only" for="message">Message</label><textarea id="message" rows="1" placeholder="Ask me to change anything…" ${this.busy ? 'disabled' : ''}></textarea><button class="send" type="submit" aria-label="Send message" ${this.busy ? 'disabled' : ''}><i data-lucide="arrow-up" aria-hidden="true"></i></button></div></form>`;
    const stream = panel.querySelector<HTMLElement>('[data-stream]')!;
    if (this.chatNearBottom) stream.scrollTop = stream.scrollHeight;
    stream.onscroll = () => { this.chatNearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80; };
    const form = panel.querySelector<HTMLFormElement>('[data-composer]')!;
    const textarea = panel.querySelector<HTMLTextAreaElement>('#message')!;
    const resize = () => { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`; };
    textarea.oninput = resize;
    form.onsubmit = event => { event.preventDefault(); const content = textarea.value.trim(); if (!content) return; textarea.value = ''; resize(); this.chatNearBottom = true; void this.actions.sendMessage(content); };
    textarea.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
  }

  private renderCreation(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-heading flow-heading"><button class="icon-button quiet" data-cancel type="button" aria-label="Cancel"><i data-lucide="arrow-left" aria-hidden="true"></i></button><div><h1>What do you want to make?</h1><p>Describe the app you have in mind.</p></div></header>
      <div class="creation-chat" data-creation><div class="message assistant">Tell me what you want your app to help you do.</div></div>
      <form class="composer" data-create-form><div class="composer-box"><label class="sr-only" for="goal">Describe your app</label><textarea id="goal" rows="1" required autofocus placeholder="Describe your app…"></textarea><button class="send" type="submit" aria-label="Send description"><i data-lucide="arrow-up" aria-hidden="true"></i></button></div></form>`;
    panel.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = () => { this.view = this.active ? 'workspace' : 'launcher'; this.renderRail(); };
    const form = panel.querySelector<HTMLFormElement>('[data-create-form]')!;
    const goal = panel.querySelector<HTMLTextAreaElement>('#goal')!;
    form.onsubmit = event => { event.preventDefault(); void this.handleDesignApp(panel, form, goal); };
    goal.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
  }

  private async handleDesignApp(panel: HTMLElement, form: HTMLFormElement, goal: HTMLTextAreaElement): Promise<void> {
    const content = goal.value.trim();
    if (!content) return;
    goal.value = ''; goal.disabled = true;
    const submit = form.querySelector<HTMLButtonElement>('button')!; submit.disabled = true;
    const chat = panel.querySelector<HTMLElement>('[data-creation]')!;
    chat.insertAdjacentHTML('beforeend', `<div class="message user">${esc(content)}</div><div class="thinking"><i></i><i></i><i></i></div>`);
    try {
      const draft = await this.actions.designApp(content);
      chat.querySelector('.thinking')?.remove();
      const proposal = document.createElement('div');
      proposal.className = 'creation-proposal';
      proposal.innerHTML = `<span class="app-icon">${esc(initials(draft.name))}</span><div><strong>${esc(draft.name)}</strong><p>${esc(draft.prompt)}</p></div><button class="action primary" type="button">Create app</button>`;
      proposal.querySelector<HTMLButtonElement>('button')!.onclick = () => void this.actions.createApp(draft);
      chat.append(proposal);
    } catch (error) {
      chat.querySelector('.thinking')?.remove();
      chat.insertAdjacentHTML('beforeend', `<div class="message system">${esc(friendlyError(error, 'your new app'))}</div>`);
      goal.disabled = false; submit.disabled = false;
    }
  }

  private renderSettings(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-heading flow-heading"><button class="icon-button quiet" data-close-settings type="button" aria-label="Close settings"><i data-lucide="arrow-left" aria-hidden="true"></i></button><div><h1>Settings</h1><p>${esc(this.settingsNotice || 'Add your OpenRouter API key.')}</p></div></header>
      <form class="scroll settings-form" data-settings-form>
        <section class="settings-section" aria-labelledby="openrouter-heading"><h2 id="openrouter-heading">OpenRouter</h2>
          <p>All AI requests use OpenRouter Auto.</p>
          <div class="field"><label for="apiKey">OpenRouter API key</label><input id="apiKey" type="password" required value="${esc(this.settings.apiKey)}" autocomplete="off" placeholder="Paste your OpenRouter API key"></div>
          <p class="security-note">The key is stored by this site in your browser and is never shared with generated apps. Avoid saving a key on a shared device.</p>
          <button class="action primary full-width" type="submit">Save</button><div class="settings-result" data-result role="status"></div>
        </section>
        <section class="settings-section build-info"><h2>Build</h2><p>Commit <code data-build-commit>${esc(BUILD_COMMIT)}</code></p></section>
        <section class="settings-section diagnostics"><h2>Diagnostics</h2><p>Download technical session details for troubleshooting.</p><button class="action" type="button" data-export><i data-lucide="download" aria-hidden="true"></i>Export session logs</button></section>
      </form>`;
    panel.querySelector<HTMLButtonElement>('[data-close-settings]')!.onclick = () => { this.view = this.active ? 'workspace' : 'launcher'; this.renderRail(); };
    panel.querySelector<HTMLButtonElement>('[data-export]')!.onclick = () => void this.actions.exportLogs();
    panel.querySelector<HTMLFormElement>('[data-settings-form]')!.onsubmit = event => { event.preventDefault(); void this.handleSaveSettings(panel); };
  }

  private async handleSaveSettings(panel: HTMLElement): Promise<void> {
    const result = panel.querySelector<HTMLElement>('[data-result]')!;
    const button = panel.querySelector<HTMLButtonElement>('button[type=submit]')!;
    result.className = 'settings-result pending'; result.textContent = 'Testing…'; button.disabled = true;
    const value: SettingsValue = { apiKey: panel.querySelector<HTMLInputElement>('#apiKey')!.value.trim() };
    try { await this.actions.saveSettings(value); this.settings = value; this.settingsNotice = ''; result.className = 'settings-result success'; result.textContent = 'API key saved. OpenRouter connection works. You can now create an app.'; }
    catch { result.className = 'settings-result failure'; result.textContent = 'We couldn’t connect to OpenRouter. Check your API key and try again.'; }
    finally { button.disabled = false; }
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
    if (event.key !== 'Escape' || (!this.switcherOpen && !this.actionsOpen)) return;
    this.switcherOpen = false; this.actionsOpen = false; this.renderRail();
  };
}
