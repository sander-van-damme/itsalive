import { createIcons, icons } from 'lucide';

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

  constructor(private readonly mount: HTMLElement, private readonly actions: ShellActions) { this.render(); }

  setApps(apps: AppSummary[], activeSlug?: string): void {
    this.apps = apps;
    this.active = apps.find(a => a.slug === activeSlug);
    this.render();
  }
  setMessages(messages: ChatLine[]): void { this.messages = messages; if (this.tab === 'chat') this.render(); }
  setSettings(settings: Partial<SettingsValue>): void { this.settings = { ...this.settings, ...settings }; if (this.tab === 'settings') this.render(); }
  setBusy(busy: boolean, status = busy ? 'Agent is working' : 'Ready'): void { this.busy = busy; this.status = status; this.renderStatus(); if (this.tab === 'chat') this.renderPanel(); }
  showError(message: string): void { this.messages.push({ id: crypto.randomUUID(), role: 'system', content: `Error: ${message}`, timestamp: Date.now() }); this.tab = 'chat'; this.render(); }

  private render(): void {
    this.mount.innerHTML = `<main class="shell">
      <section class="stage" aria-label="Active application">
        <div class="status-pill"><span class="status-dot"></span><span data-status>${esc(this.status)}</span></div>
        <div class="app-frame-wrap"><div class="empty-stage"><div><i data-lucide="sparkles" size="30"></i><strong>${this.active ? 'Loading app…' : 'Create an app to begin'}</strong><p>${this.active ? esc(this.active.name) : 'Your living applications will appear here.'}</p></div></div></div>
      </section>
      <aside class="rail">
        <header class="brand"><span class="brand-mark"><i data-lucide="sprout" size="16"></i></span><strong>Living Apps</strong><span>runtime · v1</span></header>
        <nav class="tabs" aria-label="Workspace">
          ${this.tabButton('apps','layout-grid','Apps')}${this.tabButton('chat','message-circle','Chat')}${this.tabButton('settings','settings-2','Settings')}
        </nav>
        <section class="panel" data-panel></section>
      </aside>
    </main>`;
    this.mount.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.onclick = () => { this.tab = button.dataset.tab as ShellTab; this.render(); });
    this.renderPanel();
    createIcons({ icons });
  }

  mountFrame(frame: HTMLIFrameElement | undefined): void {
    if (!frame) return;
    const wrap = this.mount.querySelector('.app-frame-wrap');
    if (!wrap) return;
    wrap.replaceChildren(frame);
    frame.className = 'app-frame';
    frame.title = `${this.active?.name ?? 'Living app'} application`;
  }

  private tabButton(id: ShellTab, icon: string, label: string): string {
    return `<button class="tab ${this.tab === id ? 'active':''}" data-tab="${id}"><i data-lucide="${icon}" size="14"></i>${label}</button>`;
  }
  private renderStatus(): void { const node = this.mount.querySelector('[data-status]'); if (node) node.textContent = this.status; }

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
      <button class="action primary" data-new style="width:100%"><i data-lucide="plus" size="14"></i> Create living app</button>
      <div class="app-list">${this.apps.map(app => `<button class="app-item ${this.active?.slug === app.slug ? 'active':''}" data-app="${esc(app.slug)}"><span class="app-icon">${esc(app.name.slice(0,2))}</span><span class="app-copy"><strong>${esc(app.name)}</strong><small>${esc(app.slug)}.${esc(__ROOT_DOMAIN__)}</small></span><i class="kebab" data-lucide="chevron-right" size="14"></i></button>`).join('')}</div>
      ${this.active ? `<hr class="divider"><div class="card"><h3 class="card-title">App instructions</h3><p class="card-copy">This purpose is included in every agent run.</p><div class="field" style="margin-top:10px"><label for="app-prompt">What is this app for?</label><textarea id="app-prompt">${esc(this.active.prompt)}</textarea></div><div class="row" style="margin-top:9px"><button class="action" data-save-prompt>Save prompt</button><button class="action" data-reload><i data-lucide="refresh-cw" size="12"></i>Reload</button><button class="action danger icon-button" data-delete title="Delete app"><i data-lucide="trash-2" size="13"></i></button></div></div>` : ''}
    </div>`;
    panel.querySelector('[data-new]')?.addEventListener('click', () => this.showCreateForm(panel));
    panel.querySelectorAll<HTMLElement>('[data-app]').forEach(el => el.onclick = () => void this.actions.selectApp(el.dataset.app ?? ''));
    panel.querySelector('[data-save-prompt]')?.addEventListener('click', () => void this.actions.updatePrompt((panel.querySelector('#app-prompt') as HTMLTextAreaElement).value));
    panel.querySelector('[data-reload]')?.addEventListener('click', () => this.actions.reloadApp());
    panel.querySelector('[data-delete]')?.addEventListener('click', () => { if (this.active && confirm(`Delete ${this.active.name}? App-origin data may remain in this browser.`)) void this.actions.deleteApp(this.active.slug); });
  }

  private showCreateForm(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-head"><h2>New living app</h2><p>Give your app a durable home and a clear purpose.</p></header><form class="scroll form" data-create>
      <div class="field"><label for="name">App name</label><input id="name" required maxlength="60" placeholder="Violin Coach" autofocus></div>
      <div class="field"><label for="slug">Subdomain</label><input id="slug" required maxlength="63" pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?" placeholder="violin"><span class="hint">Lowercase letters, numbers, and hyphens. This becomes slug.${esc(__ROOT_DOMAIN__)}.</span></div>
      <div class="field"><label for="purpose">App purpose</label><textarea id="purpose" required placeholder="This app helps me practice violin with focused, adaptive exercises."></textarea></div>
      <div class="row"><button class="action primary" type="submit">Create app</button><button class="action" type="button" data-cancel>Cancel</button></div>
    </form>`;
    const name = panel.querySelector<HTMLInputElement>('#name')!; const slug = panel.querySelector<HTMLInputElement>('#slug')!;
    name.oninput = () => { if (!slug.dataset.edited) slug.value = name.value.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,63); };
    slug.oninput = () => { slug.dataset.edited = 'true'; slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g,''); };
    panel.querySelector('[data-cancel]')?.addEventListener('click', () => this.renderPanel());
    panel.querySelector('form')!.onsubmit = event => { event.preventDefault(); void this.actions.createApp({ name: name.value.trim(), slug: slug.value, prompt: panel.querySelector<HTMLTextAreaElement>('#purpose')!.value.trim() }); };
  }

  private renderChat(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-head"><h2>${esc(this.active?.name ?? 'Chat')}</h2><p>${this.active ? 'Ask the agent to inspect, build, or improve this app.' : 'Select or create an app before chatting.'}</p></header>
      <div class="chat-stream" data-stream>${this.messages.length ? this.messages.map(m => `<div class="message ${m.role}">${esc(m.content)}</div>`).join('') : `<div class="empty-chat"><i data-lucide="wand-sparkles" size="25"></i><strong>Build as you use</strong>Describe what you need. The agent will inspect and change your live app.</div>`}${this.busy ? '<div class="thinking"><i></i><i></i><i></i></div>':''}</div>
      <form class="composer" data-composer><div class="composer-box"><label class="sr-only" for="message">Message</label><textarea id="message" placeholder="Ask the app to change…" ${!this.active || this.busy ? 'disabled':''}></textarea><div class="composer-foot"><span>⌘ + Enter to send</span><button class="send" title="Send" ${!this.active || this.busy ? 'disabled':''}><i data-lucide="arrow-up" size="15"></i></button></div></div></form>`;
    const stream = panel.querySelector('[data-stream]'); if (stream) stream.scrollTop = stream.scrollHeight;
    const form = panel.querySelector<HTMLFormElement>('[data-composer]')!; const textarea = panel.querySelector<HTMLTextAreaElement>('#message')!;
    form.onsubmit = event => { event.preventDefault(); const content = textarea.value.trim(); if (content) { textarea.value=''; void this.actions.sendMessage(content); } };
    textarea.onkeydown = event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) form.requestSubmit(); };
  }

  private renderSettings(panel: HTMLElement): void {
    panel.innerHTML = `<header class="panel-head"><h2>Model settings</h2><p>Credentials stay in root-origin browser storage and are never shared with apps.</p></header><form class="scroll form" data-settings>
      <div class="notice"><strong>Bring your own provider.</strong><br>The browser sends requests directly to your selected model endpoint.</div>
      <div class="field"><label for="provider">Provider</label><select id="provider"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option><option value="openrouter">OpenRouter</option><option value="compatible">OpenAI-compatible</option></select></div>
      <div class="field"><label for="model">Model</label><input id="model" required value="${esc(this.settings.model)}" placeholder="gpt-5-mini"></div>
      <div class="field"><label for="apiKey">API key / bearer token</label><input id="apiKey" type="password" value="${esc(this.settings.apiKey)}" autocomplete="off" placeholder="Stored only in this browser"></div>
      <div class="field"><label for="endpoint">Custom endpoint (optional)</label><input id="endpoint" type="url" value="${esc(this.settings.endpoint)}" placeholder="https://api.example.com/v1"></div>
      <div class="row"><div class="field" style="flex:1"><label for="context">Context tokens</label><input id="context" type="number" min="4096" value="${this.settings.maxContextTokens}"></div><div class="field" style="flex:1"><label for="output">Max output</label><input id="output" type="number" min="256" value="${this.settings.maxOutputTokens}"></div></div>
      <button class="action primary" type="submit">Save settings</button><hr class="divider"><button class="action" type="button" data-export><i data-lucide="download" size="13"></i>Export session logs</button>
      <p class="hint">API keys in browser storage are accessible to root-origin JavaScript. Do not use this on an untrusted shared device.</p>
    </form>`;
    const provider = panel.querySelector<HTMLSelectElement>('#provider')!; provider.value = this.settings.provider;
    panel.querySelector<HTMLFormElement>('form')!.onsubmit = event => { event.preventDefault(); void this.actions.saveSettings({ provider: provider.value, model: panel.querySelector<HTMLInputElement>('#model')!.value.trim(), apiKey: panel.querySelector<HTMLInputElement>('#apiKey')!.value, endpoint: panel.querySelector<HTMLInputElement>('#endpoint')!.value.trim(), maxContextTokens: Number(panel.querySelector<HTMLInputElement>('#context')!.value), maxOutputTokens: Number(panel.querySelector<HTMLInputElement>('#output')!.value) }); };
    panel.querySelector('[data-export]')?.addEventListener('click', () => void this.actions.exportLogs());
  }
}
