import './styles.css';
import { ShellUI, type AppSummary, type ChatLine, type SettingsValue } from './ui';
import { AgentRunner, PostMessageExecutor, ShellDatabase, createDefaultRegistry, createHttpAdapter, nextCronRun, openAiCompatible, searchHistory, type AppRecord, type Credential, type LogEntry, type ModelConfig } from './core';
import { ROOT_DOMAIN, appOrigin, createBridgeMessage, isAppToShellMessage, createRequestId, normalizeAppSlug, serializeError, validateMessageEvent, type BridgeMessage } from '../shared';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Shell mount point is missing');

const db = new ShellDatabase();
const registry = createDefaultRegistry();
let apps: AppRecord[] = [];
let activeSlug: string | undefined;
let frame: HTMLIFrameElement | undefined;
let executor: PostMessageExecutor | undefined;
let running = false;
let connectionTimer: number | undefined;

const defaultSettings: SettingsValue = { provider: 'openai', model: 'gpt-5-mini', endpoint: '', apiKey: '', maxContextTokens: 128000, maxOutputTokens: 8192 };
const stored = localStorage.getItem('itsalive.settings');
let settings: SettingsValue = defaultSettings;
if (stored) {
  try { settings = { ...defaultSettings, ...JSON.parse(stored) as Partial<SettingsValue> }; }
  catch (error) { console.warn('[itsalive] Ignoring invalid saved settings', error); }
}

const ui = new ShellUI(root, {
  createApp: async input => {
    const slug = normalizeAppSlug(input.slug);
    if (await db.apps.get(slug)) throw new Error(`An app named “${slug}” already exists.`);
    const now = Date.now();
    await db.apps.put({ ...input, slug, summary: '', createdAt: now, updatedAt: now });
    await refreshApps(slug);
  },
  selectApp: async slug => { await selectApp(slug); },
  deleteApp: async slug => { await db.apps.delete(slug); if (activeSlug === slug) disposeFrame(); await refreshApps(apps.find(a => a.slug !== slug)?.slug); },
  updatePrompt: async prompt => { const app = currentApp(); if (!app) return; await db.apps.put({ ...app, prompt, updatedAt: Date.now() }); await refreshApps(app.slug); },
  sendMessage: async content => { await runAgent(content); },
  saveSettings: async value => {
    const candidate = await testModelConnection(value);
    settings = candidate;
    localStorage.setItem('itsalive.settings', JSON.stringify(candidate));
    ui.setSettings(candidate);
  },
  designApp: async goal => {
    configureRegistry();
    const system = `You are the itsalive app designer. Turn the user's goal into a durable app specification. Choose a short, friendly product name and a DNS-safe lowercase slug. Write precise instructions for an autonomous coding agent, including the user's desired outcome and essential behavior. Return ONLY one complete JSON object with string fields "name", "slug", and "prompt". Do not use markdown.`;
    const parsed = await generateAppProposal(goal, system);
    return { name: parsed.name.trim().slice(0, 60), slug: normalizeAppSlug(parsed.slug), prompt: parsed.prompt.trim() };
  },
  exportLogs: async () => {
    const logs = await db.logs.all();
    const selected = activeSlug ? logs.filter(item => !item.appSlug || item.appSlug === activeSlug) : logs;
    const contents = selected.sort((a, b) => a.timestamp - b.timestamp).map(item => `${new Date(item.timestamp).toISOString()} [${item.level.toUpperCase()}] [${item.source}] ${item.message}${item.details === undefined ? '' : ` ${safeStringify(item.details)}`}`).join('\n');
    downloadText(`itsalive-logs-${Date.now()}.log`, contents || 'No log entries recorded.');
  },
  reloadApp: () => frame?.contentWindow?.postMessage(createBridgeMessage(activeSlug!, createRequestId(), { type: 'reload' }), currentOrigin())
});
ui.setSettings(settings);

window.addEventListener('message', event => { void handleRuntimeMessage(event); });
window.addEventListener('unhandledrejection', event => { void log('error', 'shell', String(event.reason), event.reason); });
window.addEventListener('error', event => { void log('error', 'shell', event.message, event.error); });
setInterval(() => { void fireDueSchedules(); }, 30_000);

async function generateAppProposal(goal: string, system: string): Promise<{ name: string; slug: string; prompt: string }> {
  let failure = 'invalid JSON';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const repair = attempt === 1 ? goal : `${goal}\n\nYour previous response could not be parsed (${failure}). Return the complete JSON object again. Do not abbreviate or add commentary.`;
    const result = await registry.generate({ model: modelConfig(), system, messages: [{ role: 'user', content: repair }], maxOutputTokens: Math.min(settings.maxOutputTokens, 2000) }, credential());
    try {
      const parsed = parseJsonObject(result.text) as { name?: unknown; slug?: unknown; prompt?: unknown };
      if (typeof parsed.name !== 'string' || typeof parsed.slug !== 'string' || typeof parsed.prompt !== 'string') throw new Error('required string fields are missing');
      if (!parsed.name.trim() || !parsed.slug.trim() || !parsed.prompt.trim()) throw new Error('required fields are empty');
      if (attempt > 1) await log('info', 'app-designer', `Recovered valid proposal on attempt ${attempt}`);
      return parsed as { name: string; slug: string; prompt: string };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      await log('warn', 'app-designer', `Invalid model JSON on attempt ${attempt}/3: ${failure}`, { response: result.text.slice(0, 2_000) });
    }
  }
  throw new Error('The app designer returned invalid JSON after 3 attempts. Please try again.');
}

function parseJsonObject(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); }
  catch (firstError) {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw firstError;
  }
}

async function refreshApps(select?: string): Promise<void> {
  apps = (await db.apps.list()).sort((a,b) => b.updatedAt - a.updatedAt);
  if (select) await selectApp(select); else {
    if (activeSlug && !apps.some(a => a.slug === activeSlug)) activeSlug = undefined;
    ui.setApps(apps as AppSummary[], activeSlug);
    await refreshMessages();
  }
}

async function selectApp(slug: string): Promise<void> {
  if (!apps.some(a => a.slug === slug)) return;
  activeSlug = slug;
  const url = new URL(location.href); url.searchParams.set('app', slug); history.replaceState(null, '', url);
  disposeFrame();
  frame = document.createElement('iframe');
  frame.allow = 'camera; microphone; geolocation; clipboard-read; clipboard-write';
  frame.referrerPolicy = 'strict-origin';
  frame.src = currentOrigin();
  ui.setConnectionStatus('Connecting…', 'working');
  connectionTimer = window.setTimeout(() => ui.setConnectionStatus('App unavailable', 'error'), 10_000);
  frame.addEventListener('error', () => { clearTimeout(connectionTimer); ui.setConnectionStatus('Connection failed', 'error'); });
  frame.addEventListener('load', () => ui.setConnectionStatus('Starting app…', 'working'));
  executor = new PostMessageExecutor(frame, slug, currentOrigin());
  ui.setApps(apps as AppSummary[], slug); ui.mountFrame(frame);
  await refreshMessages();
}

function disposeFrame(): void { if (connectionTimer) clearTimeout(connectionTimer); connectionTimer = undefined; executor?.dispose(); executor = undefined; frame?.remove(); frame = undefined; }
function currentApp(): AppRecord | undefined { return apps.find(a => a.slug === activeSlug); }
function currentOrigin(): string { if (!activeSlug) throw new Error('No active app'); return appOrigin(activeSlug, ROOT_DOMAIN, 'https:'); }

async function refreshMessages(): Promise<void> {
  if (!activeSlug) return ui.setMessages([]);
  const entries = (await db.history.forApp(activeSlug)).filter(e => e.kind === 'chat' && (e.role === 'user' || e.role === 'assistant'));
  ui.setMessages(entries.sort((a,b) => a.timestamp-b.timestamp).map((e,i) => ({ id: String(e.id ?? i), role: e.role as ChatLine['role'], content: e.content, timestamp: e.timestamp })));
}

function configureRegistry(): void {
  if (settings.provider === 'compatible' && settings.endpoint) registry.register(openAiCompatible('compatible', settings.endpoint));
  if (settings.provider === 'google') {
    const endpoint = settings.endpoint || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`;
    registry.register(createHttpAdapter({ id: 'google', endpoint, format: 'google' }));
  }
  if (settings.endpoint && !['compatible','google'].includes(settings.provider)) registry.register(createHttpAdapter({ id: settings.provider, endpoint: settings.endpoint, format: settings.provider === 'anthropic' ? 'anthropic' : 'openai' }));
}

function modelConfig(): ModelConfig { return { id: 'active', provider: settings.provider, model: settings.model, maxContextTokens: settings.maxContextTokens, maxOutputTokens: settings.maxOutputTokens, credentialId: 'active' }; }
function credential(): Credential | undefined { return settings.apiKey ? { id: 'active', type: 'api-key', value: settings.apiKey } : undefined; }

async function runAgent(trigger: string): Promise<void> {
  const app = currentApp();
  if (!app || !executor || running) return;
  running = true; ui.setBusy(true); await log('info', `agent:${app.slug}`, 'Agent run started', { trigger }, app.slug); await refreshMessages();
  try {
    configureRegistry();
    const tools = await requestRuntime<{ name: string; description: string }[]>({ type: 'execute', code: 'return await tools.search("");' }).catch(() => []);
    const runner = new AgentRunner(db, registry, executor);
    const result = await runner.run({ appSlug: app.slug, appPrompt: app.prompt, trigger, model: modelConfig(), credential: credential(), tools, summary: app.summary });
    await log('info', `agent:${app.slug}`, `Agent run finished: ${result.status}`, { turns: result.turns }, app.slug);
    if (result.status === 'turn-limit') await db.history.add({ appSlug: app.slug, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: 'I reached the agent turn limit. Your changes so far were preserved; ask me to continue.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log('error', `agent:${app.slug}`, message, error, app.slug);
    await db.history.add({ appSlug: app.slug, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: `Agent stopped: ${message}` });
  } finally { running = false; ui.setBusy(false, 'App connected', 'connected'); await refreshMessages(); }
}

async function handleRuntimeMessage(event: MessageEvent<unknown>): Promise<void> {
  if (!activeSlug || !frame?.contentWindow) return;
  const message = validateMessageEvent(event, { expectedOrigin: currentOrigin(), expectedAppSlug: activeSlug, expectedSource: frame.contentWindow, direction: 'to-shell' });
  if (!message || !isAppToShellMessage(message)) return;
  switch (message.type) {
    case 'log': await log(message.record.level, message.record.source, message.record.message, message.record.details, activeSlug); break;
    case 'history.request': respond(message, { type: 'history.response', results: await searchHistory(db, activeSlug, message.query, message.limit) }); break;
    case 'logs.request': { const all = await db.logs.forApp(activeSlug); const filtered = message.level ? all.filter(x => x.level === message.level) : all; respond(message, { type: 'logs.response', logs: filtered.slice(-(message.limit ?? 30)).map(toProtocolLog) }); break; }
    case 'ai.request': await handleAiRequest(message); break;
    case 'cron.register': {
      const id = `${activeSlug}:${message.registration.callbackId}`; const previous = await db.get<import('./core').ScheduleRecord>('schedules', id);
      await db.schedules.put({ id, appSlug: activeSlug, expression: message.registration.schedule, registeredAt: Date.now(), lastFired: previous?.lastFired, nextRun: nextCronRun(message.registration.schedule) });
      break;
    }
    case 'wake': if (!running) void runAgent(message.reason || 'The app requested an agent wake-up.'); break;
    case 'status': if (message.status === 'ready' && connectionTimer) { clearTimeout(connectionTimer); connectionTimer = undefined; } ui.setBusy(message.status === 'busy' || message.status === 'saving', message.status === 'ready' ? 'App connected' : (message.detail || message.status), message.status === 'ready' ? 'connected' : (message.status === 'error' ? 'error' : 'working')); break;
  }
}

async function fireDueSchedules(): Promise<void> {
  const now = Date.now();
  for (const schedule of await db.schedules.list()) {
    if (!schedule.nextRun || schedule.nextRun > now || schedule.appSlug !== activeSlug || !frame?.contentWindow) continue;
    const callbackId = schedule.id.slice(schedule.appSlug.length + 1);
    frame.contentWindow.postMessage(createBridgeMessage(schedule.appSlug, createRequestId(), { type: 'cron.fire', callbackId }), currentOrigin());
    await db.schedules.put({ ...schedule, lastFired: now, nextRun: nextCronRun(schedule.expression, now) });
  }
}

async function handleAiRequest(message: BridgeMessage & { type: 'ai.request'; prompt: string }): Promise<void> {
  try { configureRegistry(); const result = await registry.generate({ model: modelConfig(), system: 'Respond helpfully to this request from the active app.', messages: [{ role: 'user', content: message.prompt }], maxOutputTokens: settings.maxOutputTokens }, credential()); respond(message, { type: 'ai.response', result: result.text }); }
  catch (error) { respond(message, { type: 'ai.response', error: serializeError(error) }); }
}

function respond(message: BridgeMessage, payload: Parameters<typeof createBridgeMessage>[2]): void { frame?.contentWindow?.postMessage(createBridgeMessage(message.appSlug, message.requestId, payload), currentOrigin()); }
function toProtocolLog(item: LogEntry) { return { timestamp: item.timestamp, level: item.level, source: item.source, message: item.message, details: item.details }; }
async function log(level: LogEntry['level'], source: string, message: string, details?: unknown, appSlug?: string) {
  const method = level === 'debug' ? 'debug' : level;
  console[method](`[itsalive:${source}] ${message}`, ...(details === undefined ? [] : [details]));
  await db.logs.add({ timestamp: Date.now(), level, source, message, details: serializableDetails(details), appSlug });
}

function serializableDetails(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  try { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

async function requestRuntime<T>(payload: Parameters<typeof createBridgeMessage>[2], timeoutMs = 10_000): Promise<T> {
  if (!frame?.contentWindow || !activeSlug) throw new Error('App is not connected');
  const requestId = createRequestId();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('Runtime request timed out')); }, timeoutMs);
    const listener = (event: MessageEvent) => { const msg = validateMessageEvent(event, { expectedOrigin: currentOrigin(), expectedAppSlug: activeSlug!, expectedSource: frame!.contentWindow, direction: 'to-shell' }); if (!msg || msg.requestId !== requestId || msg.type !== 'result') return; clearTimeout(timer); window.removeEventListener('message', listener); resolve(msg.result as T); };
    window.addEventListener('message', listener); frame!.contentWindow!.postMessage(createBridgeMessage(activeSlug!, requestId, payload), currentOrigin());
  });
}

function safeStringify(value: unknown): string { try { return JSON.stringify(value); } catch { return String(value); } }
function downloadText(name: string, value: string): void { const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url); }

async function testModelConnection(candidate: SettingsValue): Promise<SettingsValue> {
  const testRegistry = createDefaultRegistry();
  if (candidate.provider === 'compatible' && candidate.endpoint) testRegistry.register(openAiCompatible('compatible', candidate.endpoint));
  else if (candidate.provider === 'google') testRegistry.register(createHttpAdapter({ id: 'google', endpoint: candidate.endpoint || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidate.model)}:generateContent`, format: 'google' }));
  else if (candidate.endpoint) testRegistry.register(createHttpAdapter({ id: candidate.provider, endpoint: candidate.endpoint, format: candidate.provider === 'anthropic' ? 'anthropic' : 'openai' }));
  const model = { id: 'connection-test', provider: candidate.provider, model: candidate.model, maxContextTokens: candidate.maxContextTokens, maxOutputTokens: candidate.maxOutputTokens };
  await testRegistry.generate({ model, system: 'This is a connection test. Reply with OK.', messages: [{ role: 'user', content: 'OK' }], maxOutputTokens: 8 }, candidate.apiKey ? { id: 'connection-test', type: 'api-key', value: candidate.apiKey } : undefined);
  return { ...candidate, ...await retrieveModelLimits(candidate).catch(() => ({})) };
}

async function retrieveModelLimits(candidate: SettingsValue): Promise<Partial<SettingsValue>> {
  let url: string | undefined;
  const headers: Record<string, string> = {};
  if (candidate.provider === 'openrouter') url = `https://openrouter.ai/api/v1/models/${encodeURIComponent(candidate.model)}/endpoints`;
  else if (candidate.provider === 'google') url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidate.model)}?key=${encodeURIComponent(candidate.apiKey)}`;
  else if (candidate.provider === 'openai') { url = `https://api.openai.com/v1/models/${encodeURIComponent(candidate.model)}`; headers.authorization = `Bearer ${candidate.apiKey}`; }
  else if (candidate.provider === 'anthropic') { url = `https://api.anthropic.com/v1/models/${encodeURIComponent(candidate.model)}`; headers['x-api-key'] = candidate.apiKey; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-dangerous-direct-browser-access'] = 'true'; }
  if (!url) return {};
  const response = await fetch(url, { headers });
  if (!response.ok) return {};
  const json = await response.json() as Record<string, unknown>;
  const record = (typeof json.data === 'object' && json.data !== null ? json.data : json) as Record<string, unknown>;
  const endpoint = (Array.isArray(record.endpoints) && typeof record.endpoints[0] === 'object' && record.endpoints[0] !== null ? record.endpoints[0] : {}) as Record<string, unknown>;
  const maxContextTokens = Number(record.context_length ?? record.inputTokenLimit ?? endpoint.context_length);
  const maxOutputTokens = Number(record.max_completion_tokens ?? record.outputTokenLimit ?? endpoint.max_completion_tokens);
  return { ...(Number.isFinite(maxContextTokens) && maxContextTokens > 0 ? { maxContextTokens } : {}), ...(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {}) };
}

void refreshApps(new URL(location.href).searchParams.get('app') ?? undefined).catch(error => ui.showError(error instanceof Error ? error.message : String(error)));
