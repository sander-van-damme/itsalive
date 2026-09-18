import './styles.css';
import { ShellUI, type AppSummary, type ChatLine, type SettingsValue } from './ui';
import { AgentRunner, InitialBuildIntent, RuntimeSession, ShellDatabase, createDefaultRegistry, createHttpAdapter, nextCronRun, openAiCompatible, renameAppRecord, runtimePresentation, sanitizeDiagnostic, searchHistory, type AppRecord, type Credential, type LogEntry, type ModelConfig } from './core';
import { ROOT_DOMAIN, appOrigin, createBridgeMessage, isAppToShellMessage, createRequestId, serializeError, validateMessageEvent, type BridgeMessage } from '../shared';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Shell mount point is missing');

const db = new ShellDatabase();
const registry = createDefaultRegistry();
let apps: AppRecord[] = [];
let activeId: string | undefined;
let running = false;
let activeRun: AbortController | undefined;
let connectionTimer: number | undefined;
const initialBuild = new InitialBuildIntent();
const INITIAL_BUILD_TRIGGER = 'Build the initial version of this app now.';

const defaultSettings: SettingsValue = { provider: 'openai', model: 'gpt-5-mini', endpoint: '', apiKey: '', maxContextTokens: 128000, maxOutputTokens: 8192 };
const stored = localStorage.getItem('itsalive.settings');
let settings: SettingsValue = defaultSettings;
if (stored) {
  try { settings = { ...defaultSettings, ...JSON.parse(stored) as Partial<SettingsValue> }; }
  catch (error) { console.warn('[itsalive] Ignoring invalid saved settings', error); }
}

const ui = new ShellUI(root, {
  createApp: async input => {
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.apps.put({ ...input, id, summary: '', createdAt: now, updatedAt: now });
    initialBuild.schedule(id);
    ui.setConnectionStatus('Preparing your app…', 'working');
    await refreshApps(id);
  },
  selectApp: async id => { await selectApp(id); },
  deleteApp: async id => { await db.apps.delete(id); initialBuild.clear(id); if (activeId === id) disposeFrame(); await refreshApps(apps.find(a => a.id !== id)?.id); },
  sendMessage: async content => { await runAgent(content); },
  renameApp: async name => {
    const app = currentApp(); if (!app) return;
    const updated = renameAppRecord(app, name); await db.apps.put(updated);
    apps = apps.map(item => item.id === updated.id ? updated : item); ui.setApps(apps as AppSummary[], updated.id);
    document.title = `${updated.name} · itsalive`;
    await log('info', `agent:${app.id}`, 'App renamed', { previousName: app.name, name: updated.name }, app.id);
  },
  saveSettings: async value => {
    const candidate = await testModelConnection(value);
    settings = candidate;
    localStorage.setItem('itsalive.settings', JSON.stringify(candidate));
    ui.setSettings(candidate);
  },
  designApp: async goal => {
    configureRegistry();
    const system = `You are the itsalive app designer. Turn the user's goal into a durable app specification. Choose a short, friendly product name. Write precise instructions for an autonomous coding agent, including the user's desired outcome and essential behavior. Return ONLY one complete JSON object with string fields "name" and "prompt". Do not use markdown.`;
    const parsed = await generateAppProposal(goal, system);
    return { name: parsed.name.trim().slice(0, 60), prompt: parsed.prompt.trim() };
  },
  exportLogs: async () => {
    const logs = await db.logs.all();
    const selected = activeId ? logs.filter(item => !item.appId || item.appId === activeId) : logs;
    const contents = selected.sort((a, b) => a.timestamp - b.timestamp).map(item => `${new Date(item.timestamp).toISOString()} [${item.level.toUpperCase()}] [${item.source}] ${item.message}${item.details === undefined ? '' : ` ${safeStringify(item.details)}`}`).join('\n');
    downloadText(`itsalive-logs-${Date.now()}.log`, contents || 'No log entries recorded.');
  },
  reloadApp: () => {
    if (!activeId || !runtime.frame?.contentWindow) return;
    runtime.setState('loading');
    ui.setConnectionStatus('Reloading app…', 'working');
    runtime.frame?.contentWindow?.postMessage(createBridgeMessage(activeId, createRequestId(), { type: 'reload' }), currentOrigin());
  }
});
const runtime = new RuntimeSession(frame => ui.mountFrame(frame));
ui.setSettings(settings);

window.addEventListener('message', event => { void handleRuntimeMessage(event); });
window.addEventListener('unhandledrejection', event => { void log('error', 'shell', String(event.reason), event.reason); });
window.addEventListener('error', event => { void log('error', 'shell', event.message, event.error); });
setInterval(() => { void fireDueSchedules(); }, 30_000);

async function generateAppProposal(goal: string, system: string): Promise<{ name: string; prompt: string }> {
  let failure = 'invalid JSON';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const repair = attempt === 1 ? goal : `${goal}\n\nYour previous response could not be parsed (${failure}). Return the complete JSON object again. Do not abbreviate or add commentary.`;
    const result = await registry.generate({ purpose: `app design attempt ${attempt}`, model: modelConfig(), system, messages: [{ role: 'user', content: repair }], maxOutputTokens: Math.min(settings.maxOutputTokens, 2000) }, credential());
    try {
      const parsed = parseJsonObject(result.text) as { name?: unknown; prompt?: unknown };
      if (typeof parsed.name !== 'string' || typeof parsed.prompt !== 'string') throw new Error('required string fields are missing');
      if (!parsed.name.trim() || !parsed.prompt.trim()) throw new Error('required fields are empty');
      if (attempt > 1) await log('info', 'app-designer', `Recovered valid proposal on attempt ${attempt}`);
      return parsed as { name: string; prompt: string };
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
    if (activeId && !apps.some(a => a.id === activeId)) activeId = undefined;
    ui.setApps(apps as AppSummary[], activeId);
    await refreshMessages();
  }
}

async function selectApp(id: string): Promise<void> {
  if (!apps.some(a => a.id === id)) return;
  if (activeId !== id) stopActiveRun('App selection changed');
  activeId = id;
  const url = new URL(location.href); url.searchParams.set('app', id); history.replaceState(null, '', url);
  disposeFrame();
  ui.setConnectionStatus('Connecting…', 'working');
  connectionTimer = window.setTimeout(() => { runtime.setState('error'); ui.setBusy(false); ui.setConnectionStatus('App unavailable', 'error'); }, 10_000);
  ui.setApps(apps as AppSummary[], id);
  const frame = runtime.switchTo(id, currentOrigin());
  frame.addEventListener('error', () => { if (runtime.frame !== frame) return; clearTimeout(connectionTimer); ui.setBusy(false); runtime.setState('error'); ui.setConnectionStatus('Connection failed', 'error'); });
  frame.addEventListener('load', () => { if (runtime.frame === frame) ui.setConnectionStatus('Starting app…', 'working'); });
  await refreshMessages();
}

function stopActiveRun(reason: string): void { activeRun?.abort(new DOMException(reason, 'AbortError')); ui.setBusy(false); }
function disposeFrame(): void { stopActiveRun('App runtime disposed'); if (connectionTimer) clearTimeout(connectionTimer); connectionTimer = undefined; runtime.dispose(); }
function currentApp(): AppRecord | undefined { return apps.find(a => a.id === activeId); }
function currentOrigin(): string { if (!activeId) throw new Error('No active app'); return appOrigin(activeId, ROOT_DOMAIN, 'https:'); }

async function refreshMessages(): Promise<void> {
  if (!activeId) return ui.setMessages([]);
  const entries = (await db.history.forApp(activeId)).filter(e => e.kind === 'chat' && (e.role === 'user' || e.role === 'assistant'));
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

async function runAgent(trigger: string, persistTrigger = true): Promise<boolean> {
  const app = currentApp();
  if (!app || running) return false;
  let executor: ReturnType<RuntimeSession['requireReady']>;
  try { executor = runtime.requireReady(); }
  catch (error) { ui.setBusy(false); ui.setConnectionStatus(error instanceof Error ? error.message : String(error), 'error'); ui.showError(error instanceof Error ? error.message : String(error)); return false; }
  const runController = new AbortController();
  activeRun = runController;
  running = true;
  ui.setBusy(true);
  try {
    await log('info', `agent:${app.id}`, 'Agent run started', { trigger }, app.id);
    await refreshMessages();
    configureRegistry();
    const tools = await requestRuntime<{ name: string; description: string }[]>({ type: 'execute', code: 'return await itsalive.tools.search("");' }).catch(() => []);
    const runner = new AgentRunner(db, registry, executor);
    const result = await runner.run({ appId: app.id, appPrompt: app.prompt, trigger, persistTrigger, model: modelConfig(), credential: credential(), tools, summary: app.summary, signal: runController.signal });
    await log('info', `agent:${app.id}`, `Agent run finished: ${result.status}`, { turns: result.turns }, app.id);
    if (result.status === 'turn-limit') await db.history.add({ appId: app.id, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: 'I reached the agent turn limit. Your changes so far were preserved; ask me to continue.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log('error', `agent:${app.id}`, message, error, app.id);
    await db.history.add({ appId: app.id, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: `Agent stopped: ${message}` });
  } finally {
    if (activeRun === runController) activeRun = undefined;
    running = false;
    const connection = runtimePresentation(runtime.state);
    ui.setBusy(false);
    ui.setConnectionStatus(connection.status, connection.tone);
    await refreshMessages();
    void startPendingInitialBuild();
  }
  return true;
}

async function startPendingInitialBuild(): Promise<void> {
  const id = initialBuild.candidate(activeId, runtime.state === 'ready', running);
  if (!id) return;
  ui.setConnectionStatus('Building your first version…', 'working');
  // runAgent marks the run active before its first await. Clear only after that
  // synchronous acceptance; otherwise retain the intent for a later retry.
  const run = runAgent(INITIAL_BUILD_TRIGGER, false);
  if (running && activeRun) initialBuild.accepted(id);
  await run;
}

async function handleRuntimeMessage(event: MessageEvent<unknown>): Promise<void> {
  if (!activeId || !runtime.frame?.contentWindow) return;
  const message = validateMessageEvent(event, { expectedOrigin: currentOrigin(), expectedAppId: activeId, expectedSource: runtime.frame.contentWindow, direction: 'to-shell' });
  if (!message || !isAppToShellMessage(message)) return;
  switch (message.type) {
    case 'log': await log(message.record.level, message.record.source, message.record.message, message.record.details, activeId); break;
    case 'history.request': respond(message, { type: 'history.response', results: await searchHistory(db, activeId, message.query, message.limit) }); break;
    case 'logs.request': { const all = await db.logs.forApp(activeId); const filtered = message.level ? all.filter(x => x.level === message.level) : all; respond(message, { type: 'logs.response', logs: filtered.slice(-(message.limit ?? 30)).map(toProtocolLog) }); break; }
    case 'llm.request': await handleLlmRequest(message); break;
    case 'app.meta.update': await handleMetadataUpdate(message); break;
    case 'cron.register': {
      const id = `${activeId}:${message.registration.callbackId}`; const previous = await db.get<import('./core').ScheduleRecord>('schedules', id);
      await db.schedules.put({ id, appId: activeId, expression: message.registration.schedule, registeredAt: Date.now(), lastFired: previous?.lastFired, nextRun: nextCronRun(message.registration.schedule) });
      break;
    }
    case 'wake': if (!running) void runAgent(message.reason || 'The app requested an agent wake-up.'); break;
    case 'status':
      runtime.setState(message.status === 'ready' ? 'ready' : message.status === 'error' ? 'error' : 'loading');
      if (message.status === 'error') ui.setBusy(false);
      if (message.status === 'ready' && connectionTimer) { clearTimeout(connectionTimer); connectionTimer = undefined; }
      ui.setConnectionStatus(message.status === 'ready' ? 'Ready' : (message.detail || message.status), message.status === 'ready' ? 'connected' : (message.status === 'error' ? 'error' : 'working'));
      if (message.status === 'ready') {
        void startPendingInitialBuild();
      }
      break;
  }
}

async function handleMetadataUpdate(message: BridgeMessage & { type: 'app.meta.update'; metadata: { name: string } }): Promise<void> {
  try {
    const app = currentApp();
    if (!app || app.id !== message.appId) throw new Error('The selected app changed');
    const updated = renameAppRecord(app, message.metadata.name);
    const name = updated.name;
    await db.apps.put(updated);
    apps = apps.map(item => item.id === updated.id ? updated : item);
    ui.setApps(apps as AppSummary[], updated.id);
    document.title = `${name} · itsalive`;
    respond(message, { type: 'app.meta.response', metadata: { name } });
    await log('info', `agent:${app.id}`, 'App renamed', { previousName: app.name, name }, app.id);
  } catch (error) {
    await log('error', 'app-metadata', error instanceof Error ? error.message : String(error), error, message.appId);
    respond(message, { type: 'app.meta.response', error: serializeError(error) });
  }
}

async function fireDueSchedules(): Promise<void> {
  const now = Date.now();
  for (const schedule of await db.schedules.list()) {
    if (!schedule.nextRun || schedule.nextRun > now || schedule.appId !== activeId || runtime.state !== 'ready' || !runtime.frame?.contentWindow) continue;
    const callbackId = schedule.id.slice(schedule.appId.length + 1);
    runtime.frame.contentWindow.postMessage(createBridgeMessage(schedule.appId, createRequestId(), { type: 'cron.fire', callbackId }), currentOrigin());
    await db.schedules.put({ ...schedule, lastFired: now, nextRun: nextCronRun(schedule.expression, now) });
  }
}

async function handleLlmRequest(message: BridgeMessage & { type: 'llm.request'; prompt: string }): Promise<void> {
  try { configureRegistry(); const result = await registry.generate({ purpose: 'app itsalive.llm.ask', model: modelConfig(), system: 'Respond helpfully to this request from the active app.', messages: [{ role: 'user', content: message.prompt }], maxOutputTokens: settings.maxOutputTokens }, credential()); respond(message, { type: 'llm.response', result: result.text }); }
  catch (error) { respond(message, { type: 'llm.response', error: serializeError(error) }); }
}

function respond(message: BridgeMessage, payload: Parameters<typeof createBridgeMessage>[2]): void { runtime.frame?.contentWindow?.postMessage(createBridgeMessage(message.appId, message.requestId, payload), currentOrigin()); }
function toProtocolLog(item: LogEntry) { return { timestamp: item.timestamp, level: item.level, source: item.source, message: item.message, details: item.details }; }
async function log(level: LogEntry['level'], source: string, message: string, details?: unknown, appId?: string) {
  const method = level === 'debug' ? 'debug' : level;
  const safeMessage = String(sanitizeDiagnostic(message));
  const safeDetails = sanitizeDiagnostic(serializableDetails(details));
  console[method](`[itsalive:${source}] ${safeMessage}`, ...(safeDetails === undefined ? [] : [safeDetails]));
  await db.logs.add({ timestamp: Date.now(), level, source, message: safeMessage, details: safeDetails, appId });
}

function serializableDetails(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  try { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

async function requestRuntime<T>(payload: Parameters<typeof createBridgeMessage>[2], timeoutMs = 10_000): Promise<T> {
  const frame = runtime.frame;
  const requestAppId = activeId;
  const requestOrigin = runtime.origin;
  if (!frame?.contentWindow || !requestAppId || !requestOrigin || runtime.state !== 'ready') throw new Error('App is not connected');
  const requestId = createRequestId();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('Runtime request timed out')); }, timeoutMs);
    const listener = (event: MessageEvent) => { const msg = validateMessageEvent(event, { expectedOrigin: requestOrigin, expectedAppId: requestAppId, expectedSource: frame.contentWindow, direction: 'to-shell' }); if (!msg || msg.requestId !== requestId || msg.type !== 'result') return; clearTimeout(timer); window.removeEventListener('message', listener); resolve(msg.result as T); };
    window.addEventListener('message', listener); frame.contentWindow!.postMessage(createBridgeMessage(requestAppId, requestId, payload), requestOrigin);
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
  await testRegistry.generate({ purpose: 'model connection test', model, system: 'This is a connection test. Reply with OK.', messages: [{ role: 'user', content: 'OK' }], maxOutputTokens: 8 }, candidate.apiKey ? { id: 'connection-test', type: 'api-key', value: candidate.apiKey } : undefined);
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
