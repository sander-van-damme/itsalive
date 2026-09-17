import { createIcons, icons } from 'lucide';
import { ROOT_DOMAIN } from '../shared';

export type ShellTab = 'apps' | 'chat' | 'settings';
export interface AppSummary { slug: string; name: string; prompt: string; createdAt: number; updatedAt: number }
export interface ChatLine { id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }
export interface SettingsValue { provider: string; model: string; endpoint: string; apiKey: string; maxContextTokens: number; maxOutputTokens: number }

export interface ShellActions {
  createApp(input: { name: string; slug: string; prompt: string }): Promise<void>;
  selectApp(slug: string): Promise<void>;
  deleteApp(slug: string): Promise<void>;
  updatePrompt(prompt: string): Promise<void>;
  sendMessage(content: string): Promise<void>;
  saveSettings(value: SettingsValue): Promise<void>;
  designApp(goal: string): Promise<{ name: string; slug: string; prompt: string }>;
  exportLogs(): Promise<void>;
  reloadApp(): void;
}

const esc = (value: string) => value.replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[c] ?? c);

export class ShellUI {
  private tab: ShellTab = 'apps';
  private apps: AppSummary[] = [];
  private active?: AppSummary;
  private messages: ChatLine[] = [];
  private settings: SettingsValue = { provider: 'openai', model: 'gpt-5-mini', endpoint: '', apiKey: '', maxContextTokens: 128000, maxOutputTokens: 8192 };
  private busy = false;
  private status = 'Ready';
  private statusTone: 'idle' | 'working' | 'connected' | 'error' = 'idle';
  private collapsed = localStorage.getItem('itsalive.sidebar') === 'collapsed';
  private theme = localStorage.getItem('itsalive.theme') ?? 'light';

  constructor(private readonly mount: HTMLElement, private readonly actions: ShellActions) { this.render(); }

  setApps(apps: AppSummary[], activeSlug?: string): void {
    this.apps = apps;
    this.active = apps.find(a => a.slug === activeSlug);
    this.render();
  }
  setMessages(messages: ChatLine[]): void { this.messages = messages; if (this.tab === 'chat') this.render(); }
  setSettings(settings: Partial<SettingsValue>): void { this.settings = { ...this.settings, ...settings }; }
  setBusy(busy: boolean, status = busy ? 'Agent is working' : 'Ready', tone: 'idle' | 'working' | 'connected' | 'error' = busy ? 'working' : 'idle'): void { this.busy = busy; this.status = status; this.statusTone = tone; this.renderStatus(); if (this.tab === 'chat') this.renderPanel(); }
  setConnectionStatus(status: string, tone: 'idle' | 'working' | 'connected' | 'error'): void { this.status = status; this.statusTone = tone; this.renderStatus(); }
  showError(message: string): void { this.messages.push({ id: crypto.randomUUID(), role: 'system', content: `Error: ${message}`, timestamp: Date.now() }); this.tab = 'chat'; this.render(); }

  private render(): void {
    document.documentElement.dataset.theme = this.theme;
    this.mount.innerHTML = `<main class="shell ${this.collapsed ? 'collapsed' : ''}">
      <section class="stage" aria-label="Active application">
        <div class="status-pill" data-tone="${this.statusTone}"><span class="status-dot"></span><span data-status>${esc(this.status)}</span></div>
        <div class="app-frame-wrap"><div class="empty-stage"><div><i data-lucide="sparkles" size="30"></i><strong>${this.active ? 'Loading app…' : 'Create an app to begin'}</strong><p>${this.active ? esc(this.active.name) : 'Your itsalive apps will appear here.'}</p></div></div></div>
      </section>
      <aside class="rail">
        <header class="brand"><span class="brand-mark"><i data-lucide="sprout" size="16"></i></span><strong>itsalive</strong><div class="header-actions"><button class="header-button" data-theme title="Toggle day/night mode"><i data-lucide="${this.theme === 'light' ? 'moon' : 'sun'}" size="15"></i></button><button class="header-button ${this.tab === 'settings' ? 'active':''}" data-settings title="Settings"><i data-lucide="settings" size="15"></i></button><button class="header-button" data-collapse title="${this.collapsed ? 'Expand' : 'Collapse'} sidebar"><i data-lucide="panel-right-${this.collapsed ? 'open' : 'close'}" size="15"></i></button></div></header>
        <nav class="tabs" aria-label="Workspace">
          ${this.tabButton('apps','layout-grid','Apps')}${this.tabButton('chat','message-circle','Chat')}
        </nav>
        <section class="panel" data-panel></section>
      </aside>
    </main>`;
    this.mount.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.onclick = () => { this.tab = button.dataset.tab as ShellTab; this.render(); });
    this.mount.querySelector<HTMLButtonElement>('[data-settings]')!.onclick = () => { this.tab = 'settings'; this.collapsed = false; localStorage.setItem('itsalive.sidebar', 'expanded'); this.render(); };
    this.mount.querySelector<HTMLButtonElement>('[data-theme]')!.onclick = () => { this.theme = this.theme === 'light' ? 'dark' : 'light'; localStorage.setItem('itsalive.theme', this.theme); this.render(); };
    this.mount.querySelector<HTMLButtonElement>('[data-collapse]')!.onclick = () => { this.collapsed = !this.collapsed; localStorage.setItem('itsalive.sidebar', this.collapsed ? 'collapsed' : 'expanded'); this.render(); };
    this.renderPanel();
    createIcons({ icons });
  }

  mountFrame(frame: HTMLIFrameElement | undefined): void {
    if (!frame) return;
    const wrap = this.mount.querySelector('.app-frame-wrap');
    if (!wrap) return;
    wrap.replaceChildren(frame);
    frame.className = 'app-frame';
    frame.title = `${this.active?.name ?? 'itsalive app'} application`;
  }

  private tabButton(id: ShellTab, icon: string, label: string): string {
    return `<button class="tab ${this.tab === id ? 'active':''}" data-tab="${id}" title="${label}"><i data-lucide="${icon}" size="14"></i><span>${label}</span></button>`;
  }
  private renderStatus(): void { const node = this.mount.querySelector('[data-status]'); if (node) node.textContent = this.status; const pill = this.mount.querySelector<HTMLElement>('.status-pill'); if (pill) pill.dataset.tone = this.statusTone; }

  private renderPanel(): void {
    const panel = this.mount.querySelector<HTMLElement>('[data-panel]');
    if (!panel) return;
    if (this.tab === 'apps') this.renderApps(panel);
    else if (this.tab === 'chat') this.renderChat(panel);
    else this.renderSettings(panel);
    createIcons({ icons });
  }

  private renderApps(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-head"><h2>Your apps</h2><p>Each app lives securely on its own subdomain.</p></header><div class="scroll">
      <div class="app-list">${this.apps.map(app => `<button class="app-item ${this.active?.slug === app.slug ? 'active':''}" data-app="${esc(app.slug)}"><span class="app-icon">${esc(app.name.slice(0,2))}</span><span class="app-copy"><strong>${esc(app.name)}</strong><small>${esc(app.slug)}.${esc(ROOT_DOMAIN)}</small></span><i class="kebab" data-lucide="chevron-right" size="14"></i></button>`).join('')}</div>
      <button class="action primary create-button" data-new><i data-lucide="plus" size="14"></i> Create itsalive app</button>
      ${this.active ? `<hr class="divider"><div class="card"><h3 class="card-title">App instructions</h3><p class="card-copy">This purpose is included in every agent run.</p><div class="field" style="margin-top:10px"><label for="app-prompt">What is this app for?</label><textarea id="app-prompt">${esc(this.active.prompt)}</textarea></div><div class="row" style="margin-top:9px"><button class="action" data-save-prompt>Save prompt</button><button class="action" data-reload><i data-lucide="refresh-cw" size="12"></i>Reload</button><button class="action danger icon-button" data-delete title="Delete app"><i data-lucide="trash-2" size="13"></i></button></div></div>` : ''}
    </div>`;
    panel.querySelector('[data-new]')?.addEventListener('click', () => this.showCreateForm(panel));
    panel.querySelectorAll<HTMLElement>('[data-app]').forEach(el => el.onclick = () => void this.actions.selectApp(el.dataset.app ?? ''));
    panel.querySelector('[data-save-prompt]')?.addEventListener('click', () => void this.actions.updatePrompt((panel.querySelector('#app-prompt') as HTMLTextAreaElement).value));
    panel.querySelector('[data-reload]')?.addEventListener('click', () => this.actions.reloadApp());
    panel.querySelector('[data-delete]')?.addEventListener('click', () => { if (this.active && confirm(`Delete ${this.active.name}? App-origin data may remain in this browser.`)) void this.actions.deleteApp(this.active.slug); });
  }

  private showCreateForm(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-head"><h2>What should we build?</h2><p>Chat with the app designer. It will turn your goal into a name and clear instructions.</p></header><div class="creation-chat"><div class="message assistant">Tell me what you want the app to help you accomplish. You can describe the audience, workflow, or outcome.</div></div><form class="composer" data-create><div class="composer-box"><label class="sr-only" for="goal">App goal</label><textarea id="goal" required autofocus placeholder="I want an app that…"></textarea><div class="composer-foot"><span></span><button class="send" title="Send"><i data-lucide="arrow-up" size="15"></i></button></div></div></form><button class="action cancel-create" type="button" data-cancel>Cancel</button>`;
    panel.querySelector('[data-cancel]')?.addEventListener('click', () => this.renderPanel());
    const form = panel.querySelector<HTMLFormElement>('form')!; const goal = panel.querySelector<HTMLTextAreaElement>('#goal')!;
    form.onsubmit = event => { event.preventDefault(); const content = goal.value.trim(); if (!content) return; goal.disabled = true; (form.querySelector('button') as HTMLButtonElement).disabled = true; const chat = panel.querySelector('.creation-chat')!; chat.insertAdjacentHTML('beforeend', `<div class="message user">${esc(content)}</div><div class="thinking"><i></i><i></i><i></i></div>`); void this.actions.designApp(content).then(draft => { chat.querySelector('.thinking')?.remove(); chat.insertAdjacentHTML('beforeend', `<div class="message assistant"><strong>${esc(draft.name)}</strong><br>${esc(draft.prompt)}<br><small>${esc(draft.slug)}.${esc(ROOT_DOMAIN)}</small><div class="proposal-actions"><button class="action primary" data-confirm>Create this app</button></div></div>`); chat.querySelector<HTMLButtonElement>('[data-confirm]')!.onclick = () => void this.actions.createApp(draft); }).catch(error => { chat.querySelector('.thinking')?.remove(); chat.insertAdjacentHTML('beforeend', `<div class="message system">${esc(error instanceof Error ? error.message : String(error))}</div>`); goal.disabled = false; (form.querySelector('button') as HTMLButtonElement).disabled = false; }); };
    goal.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } };
  }

  private renderChat(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-head"><h2>${esc(this.active?.name ?? 'Chat')}</h2><p>${this.active ? 'Ask the agent to inspect, build, or improve this app.' : 'Select or create an app before chatting.'}</p></header>
      <div class="chat-stream" data-stream>${this.messages.length ? this.messages.map(m => `<div class="message ${m.role}">${esc(m.content)}</div>`).join('') : `<div class="empty-chat"><i data-lucide="wand-sparkles" size="25"></i><strong>Build as you use</strong>Describe what you need. The agent will inspect and change your live app.</div>`}${this.busy ? '<div class="thinking"><i></i><i></i><i></i></div>':''}</div>
      <form class="composer" data-composer><div class="composer-box"><label class="sr-only" for="message">Message</label><textarea id="message" placeholder="Ask the app to change…" ${!this.active || this.busy ? 'disabled':''}></textarea><div class="composer-foot"><span></span><button class="send" title="Send" ${!this.active || this.busy ? 'disabled':''}><i data-lucide="arrow-up" size="15"></i></button></div></div></form>`;
    const stream = panel.querySelector('[data-stream]'); if (stream) stream.scrollTop = stream.scrollHeight;
    const form = panel.querySelector<HTMLFormElement>('[data-composer]')!; const textarea = panel.querySelector<HTMLTextAreaElement>('#message')!;
    form.onsubmit = event => { event.preventDefault(); const content = textarea.value.trim(); if (content) { textarea.value=''; void this.actions.sendMessage(content); } };
    textarea.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } };
  }

  private renderSettings(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-head"><h2>Model settings</h2><p>Credentials stay in root-origin browser storage and are never shared with apps.</p></header><form class="scroll form" data-settings>
      <div class="notice"><strong>Bring your own provider.</strong><br>The browser sends requests directly to your selected model endpoint.</div>
      <div class="field"><label for="provider">Provider</label><select id="provider"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option><option value="openrouter">OpenRouter</option><option value="compatible">OpenAI-compatible</option></select></div>
      <div class="field"><label for="model">Model</label><input id="model" required value="${esc(this.settings.model)}" placeholder="gpt-5-mini"></div>
      <div class="field"><label for="apiKey">API key / bearer token</label><input id="apiKey" type="password" value="${esc(this.settings.apiKey)}" autocomplete="off" placeholder="Stored only in this browser"></div>
      <div class="field"><label for="endpoint">Custom endpoint (optional)</label><input id="endpoint" type="url" value="${esc(this.settings.endpoint)}" placeholder="https://api.example.com/v1"></div>
      <button class="action primary" type="submit">Save and test connection</button><div class="settings-result" data-result role="status"></div><hr class="divider"><button class="action" type="button" data-export><i data-lucide="download" size="13"></i>Export session logs</button>
      <p class="hint">API keys in browser storage are accessible to root-origin JavaScript. Do not use this on an untrusted shared device.</p>
    </form>`;
    const provider = panel.querySelector<HTMLSelectElement>('#provider')!; provider.value = this.settings.provider;
    panel.querySelector<HTMLFormElement>('form')!.onsubmit = event => { event.preventDefault(); const result = panel.querySelector<HTMLElement>('[data-result]')!; const button = panel.querySelector<HTMLButtonElement>('button[type=submit]')!; result.className = 'settings-result pending'; result.textContent = 'Testing connection…'; button.disabled = true; void this.actions.saveSettings({ provider: provider.value, model: panel.querySelector<HTMLInputElement>('#model')!.value.trim(), apiKey: panel.querySelector<HTMLInputElement>('#apiKey')!.value, endpoint: panel.querySelector<HTMLInputElement>('#endpoint')!.value.trim(), maxContextTokens: this.settings.maxContextTokens, maxOutputTokens: this.settings.maxOutputTokens }).then(() => { result.className = 'settings-result success'; result.textContent = 'Connection successful. Settings saved.'; }).catch(error => { result.className = 'settings-result failure'; result.textContent = `Connection failed: ${error instanceof Error ? error.message : String(error)}`; }).finally(() => { button.disabled = false; }); };
    panel.querySelector('[data-export]')?.addEventListener('click', () => void this.actions.exportLogs());
  }
}
