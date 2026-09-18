import './styles.css';
import { ShellUI, type AppSummary, type ChatLine, type SettingsValue } from './ui';
import { AgentRunner, OpenRouterJevAdapter, DiagnosticLog, InitialBuildIntent, ReactionBatcher, RuntimeSession, ShellDatabase, appendHistory, buildDiagnosticExport, createDefaultRegistry, decideJevEscalation, deleteApp, formatReactionBatch, JEV_ESCALATION_THRESHOLD, nextCronRun, renameAppRecord, runtimePresentation, searchHistory, type AppRecord, type Credential, type DecisionModel, type LogEntry, type ModelConfig, type ReactionBatch } from './core';
import { ROOT_DOMAIN, appIdFromShellUrl, appOrigin, createBridgeMessage, isAppToShellMessage, createRequestId, serializeError, shellUrlForApp, validateMessageEvent, type BridgeMessage, type JevState } from '../shared';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Shell mount point is missing');

const db = new ShellDatabase();
let activeId: string | undefined;
let runtimeEpoch = 0;
const jevControllers = new Set<AbortController>();
const diagnostics = new DiagnosticLog(db, () => activeId);
diagnostics.installConsoleCapture();
const registry = createDefaultRegistry();
let apps: AppRecord[] = [];
let running = false;
let activeRun: AbortController | undefined;
let connectionTimer: number | undefined;
const initialBuild = new InitialBuildIntent();
const INITIAL_BUILD_TRIGGER = 'Build the initial version of this app now.';

const OPENROUTER_PROVIDER = 'openrouter';
const OPENROUTER_MODEL = 'openrouter/auto';
const MODEL_CONTEXT_TOKENS = 128_000;
const MODEL_OUTPUT_TOKENS = 8_192;

const defaultSettings: SettingsValue = { apiKey: '' };
const stored = localStorage.getItem('itsalive.settings');
let settings: SettingsValue = defaultSettings;
if (stored) {
  try {
    const parsed = JSON.parse(stored) as { apiKey?: unknown };
    settings = { apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '' };
    localStorage.setItem('itsalive.settings', JSON.stringify(settings));
  } catch (error) {
    console.warn('[itsalive] Ignoring invalid saved settings', error);
    localStorage.removeItem('itsalive.settings');
  }
}

const environmentalObservations: string[] = [];
const reactionBatcher = new ReactionBatcher(batch => deliverReactionBatch(batch));
let jevSessionStats = { requests: 0, inputTokens: 0, escalations: 0, coalescedEvents: 0 };

const ui = new ShellUI(root, {
  createApp: async goal => {
    const prompt = goal.trim();
    if (!prompt) return;
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.apps.put({ name: appNameFromGoal(prompt), prompt, id, summary: '', createdAt: now, updatedAt: now });
    initialBuild.schedule(id);
    ui.setConnectionStatus('Preparing your app…', 'working');
    await refreshApps(id);
  },
  selectApp: async id => { await selectApp(id); },
  deleteApp: async id => {
    const clearOrigin = activeId === id && runtime.state === 'ready' ? () => requestRuntime({ type: 'storage.clear' }) : undefined;
    await deleteApp(db, id, clearOrigin, error => console.warn(`[itsalive] Could not clear origin storage for ${id}; continuing deletion`, error));
    initialBuild.clear(id); if (activeId === id) disposeFrame(); await refreshApps(apps.find(a => a.id !== id)?.id);
  },
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
  exportLogs: async () => {
    await diagnostics.flush();
    const [logs, history] = await Promise.all([db.logs.all(), db.history.all()]);
    const contents = buildDiagnosticExport(logs, history, activeId);
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

function appNameFromGoal(goal: string): string {
  const compact = goal.replace(/\s+/g, ' ').trim()
    .replace(/^please\s+/i, '')
    .replace(/^(?:build|make|create|design)\s+(?:me\s+)?(?:an?\s+)?/i, '');
  const firstThought = compact.split(/[.!?]/, 1)[0]?.trim() || 'New app';
  const short = firstThought.split(/\s+/).slice(0, 5).join(' ').slice(0, 60).trim() || 'New app';
  return short.charAt(0).toUpperCase() + short.slice(1);
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
  history.replaceState(null, '', shellUrlForApp(location.href, id));
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
function disposeFrame(): void { runtimeEpoch++; for (const controller of jevControllers) controller.abort(new DOMException('App runtime disposed', 'AbortError')); jevControllers.clear(); stopActiveRun('App runtime disposed'); reactionBatcher.destroy(); environmentalObservations.splice(0); jevSessionStats = { requests: 0, inputTokens: 0, escalations: 0, coalescedEvents: 0 }; if (connectionTimer) clearTimeout(connectionTimer); connectionTimer = undefined; runtime.dispose(); }
function currentApp(): AppRecord | undefined { return apps.find(a => a.id === activeId); }
function currentOrigin(): string { if (!activeId) throw new Error('No active app'); return appOrigin(activeId, ROOT_DOMAIN, 'https:'); }

async function refreshMessages(): Promise<void> {
  if (!activeId) return ui.setMessages([]);
  const entries = (await db.history.forApp(activeId)).filter(e => e.kind === 'chat' && (e.role === 'user' || e.role === 'assistant'));
  ui.setMessages(entries.sort((a,b) => a.timestamp-b.timestamp).map((e,i) => ({ id: String(e.id ?? i), role: e.role as ChatLine['role'], content: e.content, timestamp: e.timestamp })));
}

function modelConfig(): ModelConfig { return { id: 'active', provider: OPENROUTER_PROVIDER, model: OPENROUTER_MODEL, maxContextTokens: MODEL_CONTEXT_TOKENS, maxOutputTokens: MODEL_OUTPUT_TOKENS, credentialId: 'active', options: { reasoning: { enabled: false } } }; }
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
    if (persistTrigger) {
      await appendHistory(db, { appId: app.id, role: 'user', kind: 'chat', content: trigger });
      await refreshMessages();
    }
    await log('info', `agent:${app.id}`, 'Agent run started', { trigger }, app.id);
    const runner = new AgentRunner(db, registry, executor);
    const result = await runner.run({
      appId: app.id,
      appPrompt: app.prompt,
      trigger,
      persistTrigger: false,
      model: modelConfig(),
      credential: credential(),
      summary: app.summary,
      signal: runController.signal,
      consumeEnvironmentObservations: () => environmentalObservations.splice(0),
    });
    await log('info', `agent:${app.id}`, `Agent run finished: ${result.status}`, { turns: result.turns }, app.id);
    if (result.status === 'turn-limit') await db.history.add({ appId: app.id, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: 'I reached the agent turn limit. Your changes so far were preserved; ask me to continue.' });
    if (result.status === 'stalled') await db.history.add({ appId: app.id, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: 'I stopped a repeated verification loop because it was no longer changing the app. Your changes were preserved; ask me to continue if you want another repair attempt.' });
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
    if (environmentalObservations.length && runtime.state === 'ready') {
      const trigger = environmentalObservations.splice(0).join('\n\n');
      void runAgent(trigger, false);
    }
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
    case 'jev.request': await handleJevRequest(message); break;
    case 'llm.request': await handleLlmRequest(message); break;
    case 'cron.register': {
      const id = `${activeId}:${message.registration.callbackId}`; const previous = await db.get<import('./core').ScheduleRecord>('schedules', id);
      await db.schedules.put({ id, appId: activeId, expression: message.registration.schedule, registeredAt: Date.now(), lastFired: previous?.lastFired, nextRun: nextCronRun(message.registration.schedule) });
      break;
    }
    case 'wake': if (!running) void runAgent(message.reason || 'The app requested an agent wake-up.'); break;
    case 'status':
      runtime.setState('ready');
      if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = undefined; }
      ui.setConnectionStatus('Ready', 'connected');
      void startPendingInitialBuild();
      break;
  }
}

async function handleJevRequest(message: BridgeMessage & { type: 'jev.request'; state: JevState }): Promise<void> {
  const startedAt = performance.now();
  const appId = activeId;
  const epoch = runtimeEpoch;
  const controller = new AbortController();
  jevControllers.add(controller);
  const current = () => Boolean(appId && activeId === appId && runtimeEpoch === epoch && runtime.appId === appId && !controller.signal.aborted);
  try {
    const key = credential();
    if (!key) throw new Error('OpenRouter is not configured');
    jevSessionStats.requests++;
    jevSessionStats.coalescedEvents += message.state.pattern?.coalescedCount ?? 0;
    const decisionModel: DecisionModel = new OpenRouterJevAdapter();
    const result = await decisionModel.evaluate({ state: message.state, signal: controller.signal }, key);
    if (!current()) return;
    jevSessionStats.inputTokens += result.usage?.inputTokens ?? 0;
    const decision = decideJevEscalation(result.probability, message.state);
    if (decision.escalated) jevSessionStats.escalations++;
    await log('info', 'jev', 'Interaction decision', {
      probability: result.probability,
      threshold: JEV_ESCALATION_THRESHOLD,
      escalated: decision.escalated,
      escalationReason: decision.reason,
      pattern: message.state.pattern,
      durationMs: Math.round(performance.now() - startedAt),
      snapshotCharacters: message.state.document.length,
      inputTokens: result.usage?.inputTokens,
      session: { ...jevSessionStats },
    }, appId);
    if (!current()) return;
    respond(message, { type: 'jev.response', probability: result.probability, escalated: decision.escalated });
    if (decision.escalated) reactionBatcher.add(message.state);
  } catch (error) {
    if (!current()) return;
    await log('warn', 'jev', 'Observation failed; interaction remains available', { durationMs: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), session: { ...jevSessionStats } }, appId);
    if (!current()) return;
    respond(message, { type: 'jev.response', probability: 0, escalated: false, error: serializeError(error) });
  } finally { jevControllers.delete(controller); }
}

async function deliverReactionBatch(batch: ReactionBatch): Promise<void> {
  const observation = formatReactionBatch(batch);
  if (running) {
    environmentalObservations.push(observation);
    await log('info', 'reaction', 'Attached reaction batch to active agent', { size: batch.events.length }, activeId);
    return;
  }
  await log('info', 'reaction', 'Starting agent for reaction batch', { size: batch.events.length }, activeId);
  await runAgent(observation, false);
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
  try { const result = await registry.generate({ purpose: 'app itsalive.llm.ask', model: modelConfig(), system: 'Respond helpfully to this request from the active app.', messages: [{ role: 'user', content: message.prompt }], maxOutputTokens: MODEL_OUTPUT_TOKENS }, credential()); respond(message, { type: 'llm.response', result: result.text }); }
  catch (error) { respond(message, { type: 'llm.response', error: serializeError(error) }); }
}

function respond(message: BridgeMessage, payload: Parameters<typeof createBridgeMessage>[2]): void { runtime.frame?.contentWindow?.postMessage(createBridgeMessage(message.appId, message.requestId, payload), currentOrigin()); }
async function log(level: LogEntry['level'], source: string, message: string, details?: unknown, appId?: string) {
  await diagnostics.write(level, source, message, details, appId);
}

async function requestRuntime<T>(payload: Parameters<typeof createBridgeMessage>[2], timeoutMs = 10_000): Promise<T> {
  const frame = runtime.frame;
  const requestAppId = activeId;
  const requestOrigin = runtime.origin;
  if (!frame?.contentWindow || !requestAppId || !requestOrigin || runtime.state !== 'ready') throw new Error('App is not connected');
  const requestId = createRequestId();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('Runtime request timed out')); }, timeoutMs);
    const listener = (event: MessageEvent) => { const msg = validateMessageEvent(event, { expectedOrigin: requestOrigin, expectedAppId: requestAppId, expectedSource: frame.contentWindow, direction: 'to-shell' }); if (!msg || msg.requestId !== requestId || (msg.type !== 'result' && msg.type !== 'execution.error')) return; clearTimeout(timer); window.removeEventListener('message', listener); if (msg.type === 'execution.error') reject(new Error(msg.error.message)); else resolve(msg.result as T); };
    window.addEventListener('message', listener); frame.contentWindow!.postMessage(createBridgeMessage(requestAppId, requestId, payload), requestOrigin);
  });
}

function downloadText(name: string, value: string): void { const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url); }

async function testModelConnection(candidate: SettingsValue): Promise<SettingsValue> {
  const apiKey = candidate.apiKey.trim();
  if (!apiKey) throw new Error('OpenRouter API key is required');
  const testRegistry = createDefaultRegistry();
  const model: ModelConfig = {
    id: 'connection-test',
    provider: OPENROUTER_PROVIDER,
    model: OPENROUTER_MODEL,
    maxContextTokens: MODEL_CONTEXT_TOKENS,
    maxOutputTokens: MODEL_OUTPUT_TOKENS,
    options: { reasoning: { enabled: true } },
  };
  await testRegistry.generate({ purpose: 'OpenRouter connection test', model, system: 'This is a connection test. Reply with OK.', messages: [{ role: 'user', content: 'OK' }], maxOutputTokens: MODEL_OUTPUT_TOKENS }, { id: 'connection-test', type: 'api-key', value: apiKey });
  return { apiKey };
}

void refreshApps(appIdFromShellUrl(location.href)).catch(error => ui.showError(error instanceof Error ? error.message : String(error)));
