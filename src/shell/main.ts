import './styles.css';
import { DEFAULT_HISTORY_CONTEXT_TOKENS, ShellUI, type AppSummary, type ChatLine, type InteractionPrompt, type ResumePrompt, type SettingsValue } from './ui';
import { AgentRunner, OpenRouterJevAdapter, DiagnosticLog, InitialBuildIntent, PausedRunStore, ReactionBatcher, ReactionConfirmationGate, RuntimeSession, SessionUsageTracker, ShellDatabase, appendHistory, buildDiagnosticExport, clearAppOrigin, createAgentAbort, createDefaultRegistry, fetchOpenRouterContextCapacity, fetchOpenRouterKeyInfo, decideJevEscalation, deleteApp, formatReactionBatch, interactionConfirmationMessage, JEV_ESCALATION_THRESHOLD, nextCronRun, normalizeAgentRunFailure, persistNewApp, renameAppRecord, searchHistory, type AgentProgressPhase, type AppRecord, type Credential, type DecisionModel, type ExternalAgentAbortKind, type LogEntry, type ModelConfig, type ReactionBatch, type SessionUsageState } from './core';
import { loadRuntimeSource } from './runtime-source';
import { ROOT_DOMAIN, appIdFromShellUrl, appOrigin, serializeError, shellUrlForApp, type AppToShellPayload, type BridgeMessage, type JevState } from '../shared';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Shell mount point is missing');

const db = new ShellDatabase();
let activeId: string | undefined;
let runtimeEpoch = 0;
const jevControllers = new Set<AbortController>();
const diagnostics = new DiagnosticLog(db, () => activeId);
diagnostics.installConsoleCapture();

const SESSION_USAGE_STORAGE_KEY = 'itsalive.session-usage-v1';
function loadSessionUsageState(): Partial<SessionUsageState> | undefined {
  try {
    const stored = sessionStorage.getItem(SESSION_USAGE_STORAGE_KEY);
    if (!stored) return undefined;
    const parsed = JSON.parse(stored) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Partial<SessionUsageState> : undefined;
  } catch {
    sessionStorage.removeItem(SESSION_USAGE_STORAGE_KEY);
    return undefined;
  }
}
const sessionUsage = new SessionUsageTracker(loadSessionUsageState());
function persistSessionUsage(): void {
  try { sessionStorage.setItem(SESSION_USAGE_STORAGE_KEY, JSON.stringify(sessionUsage.state())); }
  catch (error) { console.warn('[itsalive] Could not persist session usage', error); }
}
const registry = createDefaultRegistry(usage => { sessionUsage.recordGeneration(usage); persistSessionUsage(); });
let apps: AppRecord[] = [];
let running = false;
let activeRun: AbortController | undefined;
let activeRunFinished: Promise<void> | undefined;
let connectionTimer: number | undefined;
const initialBuild = new InitialBuildIntent();
const INITIAL_BUILD_TRIGGER = 'Build the initial version of this app now.';

const OPENROUTER_PROVIDER = 'openrouter';
const OPENROUTER_MODEL = 'openrouter/auto';
const MODEL_OUTPUT_HEADROOM_TOKENS = 8_192;

const defaultSettings: SettingsValue = { apiKey: '', historyContextTokens: DEFAULT_HISTORY_CONTEXT_TOKENS };
let modelContextTokens: number | undefined;
const stored = localStorage.getItem('itsalive.settings');
let settings: SettingsValue = defaultSettings;
if (stored) {
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Settings must be an object');
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 2
      || typeof record.apiKey !== 'string'
      || typeof record.historyContextTokens !== 'number'
      || !Number.isFinite(record.historyContextTokens)
      || record.historyContextTokens < 0) throw new Error('Settings schema does not match this beta build');
    settings = { apiKey: record.apiKey, historyContextTokens: Math.floor(record.historyContextTokens) };
  } catch (error) {
    console.warn('[itsalive] Ignoring incompatible saved settings', error);
    localStorage.removeItem('itsalive.settings');
  }
}

const environmentalObservations: string[] = [];
const reactionBatcher = new ReactionBatcher(batch => deliverReactionBatch(batch));
const reactionConfirmationGates = new Map<string, ReactionConfirmationGate>();
const confirmedReactionQueue = new Map<string, { batch: ReactionBatch; intent: string }>();
const pausedRuns = new PausedRunStore();
let jevSessionStats = { requests: 0, inputTokens: 0, escalations: 0, coalescedEvents: 0 };

const ui = new ShellUI(root, {
  createApp: async goal => {
    const prompt = goal.trim();
    if (!prompt) return;
    const id = crypto.randomUUID();
    await persistNewApp(db, id, prompt);
    initialBuild.schedule(id);
    ui.setConnectionStatus('working');
    await refreshApps(id);
  },
  selectApp: async id => { await selectApp(id); },
  deleteApp: async id => {
    reactionConfirmationGates.delete(id);
    confirmedReactionQueue.delete(id);
    pausedRuns.clear(id);
    if (activeId === id) {
      if (runtime.state === 'ready') {
        try { await requestRuntime({ type: 'document.flush' }); }
        catch (error) { console.warn(`[itsalive] Could not flush ${id} before deletion; continuing deletion`, error); }
      }
      disposeFrame();
    }
    const origin = appOrigin(id, ROOT_DOMAIN, 'https:');
    await deleteApp(db, id, () => clearAppOrigin(origin), error => console.warn(`[itsalive] Could not clear origin storage for ${id}; continuing deletion`, error));
    initialBuild.clear(id);
    await refreshApps(apps.find(a => a.id !== id)?.id);
  },
  sendMessage: async content => {
    const targetAppId = activeId;
    if (targetAppId) {
      pausedRuns.clear(targetAppId);
      syncResumePrompt();
    }
    await waitForAgentIdle();
    if (activeId !== targetAppId) return;
    await runAgent(content);
  },
  stopAgent: () => { stopActiveRun('user-stop'); },
  resumePausedRun: async id => { await resumePausedRun(id); },
  resolveInteractionPrompt: async (id, intent) => { await resolveInteractionPrompt(id, intent); },
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
    ui.setModelContextCapacity(modelContextTokens);
    syncUsage();
  },
  refreshUsage: async () => { await refreshOpenRouterUsage(); },
  checkDiagnostics: async () => {
    const probe = crypto.randomUUID();
    await diagnostics.write('info', 'logging', 'Diagnostic storage self-check', { probe });
    await diagnostics.flush();
    const logs = await db.logs.all();
    const persisted = logs.some(entry =>
      entry.source === 'logging'
      && entry.message === 'Diagnostic storage self-check'
      && entry.details !== null
      && typeof entry.details === 'object'
      && !Array.isArray(entry.details)
      && (entry.details as Record<string, unknown>).probe === probe
    );
    if (!persisted) throw new Error('Diagnostic storage self-check could not read back its persisted entry');
    return logs.length;
  },
  exportLogs: async () => {
    await diagnostics.write('info', 'logging', 'Diagnostic export requested');
    await diagnostics.flush();
    const [logs, history] = await Promise.all([db.logs.all(), db.history.all()]);
    if (!logs.length) throw new Error('Diagnostic storage returned no log entries');
    const contents = buildDiagnosticExport(logs, history);
    if (!contents.trim()) throw new Error('Diagnostic export was unexpectedly empty');
    downloadText(`itsalive-logs-${Date.now()}.log`, contents);
  },
  reloadApp: () => {
    if (!activeId || runtime.state !== 'ready') return;
    runtime.setState('loading');
    ui.setConnectionStatus('working');
    runtime.post({ type: 'reload' });
  }
});
const runtime = new RuntimeSession(
  frame => ui.mountFrame(frame),
  message => { void handleRuntimeMessage(message); },
  error => {
    if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = undefined; }
    ui.setBusy(false);
    ui.setConnectionStatus('error');
    ui.showError(error.message);
  },
);
ui.setSettings(settings);
syncUsage();
if (settings.apiKey) {
  const startupKey = { value: settings.apiKey };
  void Promise.all([
    loadModelContextCapacity(startupKey),
    fetchOpenRouterKeyInfo(startupKey),
  ]).then(([capacity, keyInfo]) => {
    ui.setModelContextCapacity(capacity);
    sessionUsage.setKeyInfo(keyInfo);
    syncUsage();
  }).catch(error => console.warn('[itsalive] Could not refresh OpenRouter metadata yet', error));
}

window.addEventListener('unhandledrejection', event => { void log('error', 'shell', String(event.reason), event.reason); });
window.addEventListener('error', event => { void log('error', 'shell', event.message, event.error); });
setInterval(() => { void fireDueSchedules(); }, 30_000);

function agentProgressLabel(phase: AgentProgressPhase, initialBuild: boolean, step?: number): string {
  if (phase === 'executing') {
    const part = step && step > 1 ? ` · part ${step}` : '';
    return initialBuild ? `Building your app${part}…` : `Applying your change${part}…`;
  }
  if (phase === 'repairing') return 'Fixing something that didn’t work…';
  if (phase === 'verifying') return 'Checking the result…';
  if (phase === 'finishing') return 'Finishing up…';
  return initialBuild ? 'Planning your app…' : 'Planning your change…';
}

async function refreshApps(select?: string): Promise<void> {
  apps = (await db.apps.list()).sort((a,b) => b.updatedAt - a.updatedAt);
  if (select) await selectApp(select); else {
    if (activeId && !apps.some(a => a.id === activeId)) activeId = undefined;
    ui.setApps(apps as AppSummary[], activeId);
    syncInteractionPrompt();
    syncResumePrompt();
    await refreshMessages();
  }
}

async function selectApp(id: string): Promise<void> {
  if (!apps.some(a => a.id === id)) return;
  if (activeId !== id && running) {
    ui.setAgentProgress('Pausing work before switching…');
    stopActiveRun('app-switch');
    await waitForAgentIdle();
  }
  if (runtime.state === 'ready' && !await flushCurrentDocument()) return;

  activeId = id;
  history.replaceState(null, '', shellUrlForApp(location.href, id));
  disposeFrame();
  ui.setConnectionStatus('working');
  ui.setApps(apps as AppSummary[], id);
  syncInteractionPrompt();
  syncResumePrompt();
  const [runtimeSource, savedDocument] = await Promise.all([
    loadRuntimeSource(),
    db.documents.get(id),
  ]);
  connectionTimer = window.setTimeout(() => { runtime.setState('error'); ui.setBusy(false); ui.setConnectionStatus('error'); }, 10_000);
  const frame = runtime.switchTo(id, currentOrigin(), runtimeSource, savedDocument?.html);
  frame.addEventListener('error', () => { if (runtime.frame !== frame) return; clearTimeout(connectionTimer); ui.setBusy(false); runtime.setState('error'); ui.setConnectionStatus('error'); });
  frame.addEventListener('load', () => { if (runtime.frame === frame) ui.setConnectionStatus('working'); });
  await refreshMessages();
}

async function waitForAgentIdle(): Promise<void> {
  while (running) {
    const pending = activeRunFinished;
    if (!pending) return;
    await pending;
  }
}

function stopActiveRun(kind: ExternalAgentAbortKind): boolean {
  if (!activeRun || activeRun.signal.aborted) return false;
  activeRun.abort(createAgentAbort(kind));
  return true;
}
function disposeFrame(): void { runtimeEpoch++; for (const controller of jevControllers) controller.abort(createAgentAbort('runtime-disposed')); jevControllers.clear(); stopActiveRun('runtime-disposed'); reactionBatcher.destroy(); environmentalObservations.splice(0); jevSessionStats = { requests: 0, inputTokens: 0, escalations: 0, coalescedEvents: 0 }; if (connectionTimer) clearTimeout(connectionTimer); connectionTimer = undefined; runtime.dispose(); }
function currentApp(): AppRecord | undefined { return apps.find(a => a.id === activeId); }
function currentOrigin(): string { if (!activeId) throw new Error('No active app'); return appOrigin(activeId, ROOT_DOMAIN, 'https:'); }

async function refreshMessages(): Promise<void> {
  if (!activeId) return ui.setMessages([]);
  const entries = (await db.history.forApp(activeId)).filter(e => e.kind === 'chat' && (e.role === 'user' || e.role === 'assistant'));
  ui.setMessages(entries.sort((a,b) => a.timestamp-b.timestamp).map(e => ({ role: e.role as ChatLine['role'], content: e.content })));
}

async function modelConfig(): Promise<ModelConfig> {
  const key = credential();
  if (!key) throw new Error('OpenRouter is not configured');
  return {
    provider: OPENROUTER_PROVIDER,
    model: OPENROUTER_MODEL,
    maxContextTokens: await loadModelContextCapacity(key),
    outputHeadroomTokens: MODEL_OUTPUT_HEADROOM_TOKENS,
    historyContextTokens: settings.historyContextTokens,
  };
}
function credential(): Credential | undefined { return settings.apiKey ? { value: settings.apiKey } : undefined; }

async function loadModelContextCapacity(key: Credential): Promise<number> {
  if (modelContextTokens != null) return modelContextTokens;
  modelContextTokens = await fetchOpenRouterContextCapacity(OPENROUTER_MODEL, key);
  return modelContextTokens;
}

function syncUsage(): void {
  persistSessionUsage();
  ui.setUsage(sessionUsage.snapshot());
}

async function refreshOpenRouterUsage(): Promise<void> {
  const key = credential();
  if (!key) return;
  try {
    sessionUsage.setKeyInfo(await fetchOpenRouterKeyInfo(key));
    syncUsage();
  } catch (error) {
    console.warn('[itsalive] Could not refresh OpenRouter key usage', error);
  }
}

async function runAgent(trigger: string, persistTrigger = true): Promise<boolean> {
  const app = currentApp();
  if (!app || running) return false;
  let executor: ReturnType<RuntimeSession['requireReady']>;
  try { executor = runtime.requireReady(); }
  catch (error) { ui.setBusy(false); ui.setConnectionStatus('error'); ui.showError(error instanceof Error ? error.message : String(error)); return false; }
  const runController = new AbortController();
  let resolveRunFinished!: () => void;
  const runFinished = new Promise<void>(resolve => { resolveRunFinished = resolve; });
  activeRun = runController;
  activeRunFinished = runFinished;
  running = true;
  const isInitialBuild = trigger === INITIAL_BUILD_TRIGGER;
  ui.setBusy(true);
  ui.setAgentProgress(isInitialBuild ? 'Preparing the first version…' : 'Applying your change…');
  try {
    if (persistTrigger) {
      await appendHistory(db, { appId: app.id, role: 'user', kind: 'chat', content: trigger });
      await refreshMessages();
    }
    await log('info', `agent:${app.id}`, 'Agent run started', { trigger }, app.id);
    const runner = new AgentRunner(db, registry, executor);
    const model = await modelConfig();
    const result = await runner.run({
      appId: app.id,
      appPrompt: app.prompt,
      trigger,
      persistTrigger: false,
      model,
      credential: credential(),
      signal: runController.signal,
      consumeEnvironmentObservations: () => environmentalObservations.splice(0),
      onProgress: progress => ui.setAgentProgress(agentProgressLabel(progress.phase, isInitialBuild, progress.step)),
      onContext: context => {
        sessionUsage.setContext(context.estimatedInputTokens, context.maxContextTokens);
        syncUsage();
      },
    });
    await log('info', `agent:${app.id}`, `Agent run finished: ${result.status}`, { turns: result.turns }, app.id);
    if (result.status === 'turn-limit') await db.history.add({ appId: app.id, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: 'I reached the agent turn limit. Your changes so far were preserved; ask me to continue.' });
    if (result.status === 'stalled') await db.history.add({ appId: app.id, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: 'I stopped a repeated verification loop because it was no longer changing the app. Your changes were preserved; ask me to continue if you want another repair attempt.' });
  } catch (error) {
    const failure = normalizeAgentRunFailure(error, runController.signal);
    await log(failure.kind === 'run-error' ? 'error' : 'info', `agent:${app.id}`, 'Agent run stopped', {
      kind: failure.kind,
      resumable: failure.resumable,
      technical: failure.technical,
      error,
    }, app.id);
    if (failure.kind === 'app-switch') {
      const paused = pausedRuns.pause(app.id, trigger);
      await db.history.add({ appId: app.id, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: 'Work paused because you switched apps. Return here when you want to continue.' });
      await log('info', `agent:${app.id}`, 'Agent run paused for app switch', { pausedRunId: paused.id }, app.id);
    } else if (failure.userMessage) {
      await db.history.add({ appId: app.id, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: failure.userMessage });
    }
  } finally {
    if (activeRun === runController) activeRun = undefined;
    running = false;
    try {
      const stillActive = activeId === app.id;
      if (stillActive) {
        ui.setBusy(false);
        ui.setConnectionStatus(runtime.state === 'ready' ? 'connected' : runtime.state === 'loading' ? 'working' : 'error');
        syncResumePrompt();
        await refreshMessages();
      }
      void startPendingInitialBuild();
      void startQueuedConfirmedReaction();
      if (stillActive && environmentalObservations.length && runtime.state === 'ready') {
        const trigger = environmentalObservations.splice(0).join('\n\n');
        void runAgent(trigger, false);
      }
    } finally {
      resolveRunFinished();
      if (activeRunFinished === runFinished) activeRunFinished = undefined;
      syncUsage();
    }
  }
  return true;
}

async function startPendingInitialBuild(): Promise<void> {
  const id = initialBuild.candidate(activeId, runtime.state === 'ready', running);
  if (!id) return;
  ui.setConnectionStatus('working');
  // runAgent marks the run active before its first await. Clear only after that
  // synchronous acceptance; otherwise retain the intent for a later retry.
  const run = runAgent(INITIAL_BUILD_TRIGGER, false);
  if (running && activeRun) initialBuild.accepted(id);
  await run;
}

async function handleRuntimeMessage(message: BridgeMessage<AppToShellPayload>): Promise<void> {
  if (!activeId || message.appId !== activeId) return;
  switch (message.type) {
    case 'log': await log(message.record.level, message.record.source, message.record.message, message.record.details, activeId); break;
    case 'document.save': {
      try {
        await db.documents.put({ appId: activeId, html: message.html, updatedAt: Date.now() });
        respond(message, { type: 'document.saved' });
      } catch (error) {
        respond(message, { type: 'document.saved', error: serializeError(error) });
      }
      break;
    }
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
      ui.setConnectionStatus('connected');
      void startPendingInitialBuild();
      void startQueuedConfirmedReaction();
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
    sessionUsage.recordUnpricedUsage({ inputTokens: result.usage?.inputTokens });
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

function reactionConfirmationGate(appId: string): ReactionConfirmationGate {
  let gate = reactionConfirmationGates.get(appId);
  if (!gate) {
    gate = new ReactionConfirmationGate();
    reactionConfirmationGates.set(appId, gate);
  }
  return gate;
}

function syncResumePrompt(): void {
  const appId = activeId;
  const paused = appId ? pausedRuns.current(appId) : undefined;
  const prompt: ResumePrompt | undefined = paused
    ? {
        id: paused.id,
        content: 'Work paused because you switched apps. Changes already applied were kept.',
        actionLabel: 'Continue change',
      }
    : undefined;
  ui.setResumePrompt(prompt);
}

async function resumePausedRun(id: string): Promise<void> {
  const appId = activeId;
  if (!appId) return;
  await waitForAgentIdle();
  if (activeId !== appId || runtime.state !== 'ready') return;
  const paused = pausedRuns.take(appId, id);
  if (!paused) {
    syncResumePrompt();
    return;
  }
  syncResumePrompt();
  await log('info', `agent:${appId}`, 'Resuming paused agent run', { pausedRunId: paused.id }, appId);
  const started = await runAgent(paused.trigger, false);
  if (!started) {
    pausedRuns.restore(paused);
    syncResumePrompt();
  }
}

function syncInteractionPrompt(): void {
  const appId = activeId;
  const confirmation = appId ? reactionConfirmationGates.get(appId)?.current() : undefined;
  const prompt: InteractionPrompt | undefined = confirmation
    ? {
        id: confirmation.id,
        content: interactionConfirmationMessage(confirmation.batch),
        intentPlaceholder: 'Describe what you expected to happen…',
        confirmLabel: 'Use this intent',
        dismissLabel: 'Not now',
      }
    : undefined;
  ui.setInteractionPrompt(prompt);
}

async function deliverReactionBatch(batch: ReactionBatch): Promise<void> {
  const appId = activeId;
  if (!appId || !batch.events.length) return;
  const offer = reactionConfirmationGate(appId).offer(batch);
  if (offer.kind !== 'prompt') {
    await log('info', 'reaction', 'Interaction adaptation confirmation suppressed', {
      reason: offer.kind,
      size: batch.events.length,
      ...(offer.kind === 'cooldown' ? { cooldownUntil: offer.until } : {}),
    }, appId);
    return;
  }
  await log('info', 'reaction', 'Interaction adaptation confirmation requested', {
    promptId: offer.confirmation.id,
    size: batch.events.length,
    pattern: batch.events.at(-1)?.pattern,
  }, appId);
  if (activeId === appId) syncInteractionPrompt();
}

async function resolveInteractionPrompt(id: string, intent?: string): Promise<void> {
  const appId = activeId;
  if (!appId) return;
  const resolution = reactionConfirmationGates.get(appId)?.resolve(id, intent) ?? { kind: 'missing' as const };
  if (resolution.kind === 'missing') {
    await log('warn', 'reaction', 'Ignored stale interaction confirmation response', { promptId: id }, appId);
    syncInteractionPrompt();
    return;
  }

  syncInteractionPrompt();
  await log('info', 'reaction', resolution.kind === 'confirmed' ? 'Interaction intent confirmed' : 'Interaction adaptation dismissed', {
    promptId: resolution.confirmation.id,
    size: resolution.confirmation.batch.events.length,
    ...(resolution.kind === 'confirmed' ? { intent: resolution.intent } : {}),
  }, appId);
  if (resolution.kind !== 'confirmed') return;

  confirmedReactionQueue.set(appId, { batch: resolution.confirmation.batch, intent: resolution.intent });
  void startQueuedConfirmedReaction();
}

async function startQueuedConfirmedReaction(): Promise<void> {
  const appId = activeId;
  if (!appId || running || runtime.state !== 'ready') return;
  const queued = confirmedReactionQueue.get(appId);
  if (!queued) return;
  confirmedReactionQueue.delete(appId);
  const accepted = await runAgent(formatReactionBatch(queued.batch, queued.intent), false);
  if (!accepted) confirmedReactionQueue.set(appId, queued);
}

async function fireDueSchedules(): Promise<void> {
  const now = Date.now();
  for (const schedule of await db.schedules.list()) {
    if (!schedule.nextRun || schedule.nextRun > now || schedule.appId !== activeId || runtime.state !== 'ready') continue;
    const callbackId = schedule.id.slice(schedule.appId.length + 1);
    runtime.post({ type: 'cron.fire', callbackId });
    await db.schedules.put({ ...schedule, lastFired: now, nextRun: nextCronRun(schedule.expression, now) });
  }
}

async function handleLlmRequest(message: BridgeMessage & { type: 'llm.request'; prompt: string }): Promise<void> {
  try {
    const result = await registry.generate({ purpose: 'app itsalive.llm.ask', model: await modelConfig(), system: 'Respond helpfully to this request from the active app.', messages: [{ role: 'user', content: message.prompt }] }, credential());
    syncUsage();
    respond(message, { type: 'llm.response', result: result.text });
  } catch (error) { respond(message, { type: 'llm.response', error: serializeError(error) }); }
}

function respond(message: BridgeMessage<AppToShellPayload>, payload: Parameters<RuntimeSession['post']>[0]): void { runtime.respond(message, payload); }
async function log(level: LogEntry['level'], source: string, message: string, details?: unknown, appId?: string) {
  await diagnostics.write(level, source, message, details, appId);
}

async function requestRuntime<T>(payload: Parameters<RuntimeSession['post']>[0], timeoutMs = 10_000): Promise<T> {
  return runtime.request<T>(payload, timeoutMs);
}

async function flushCurrentDocument(): Promise<boolean> {
  const appId = activeId;
  if (!appId || runtime.state !== 'ready') return true;
  try {
    await requestRuntime<{ saved: true }>({ type: 'document.flush' });
    return true;
  } catch (error) {
    await log('error', 'persistence', 'Could not save the current app before leaving it', { error }, appId);
    ui.showError('Could not save the current app. The app was left open so your latest changes are not discarded.');
    return false;
  }
}

function downloadText(name: string, value: string): void { const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url); }

async function testModelConnection(candidate: SettingsValue): Promise<SettingsValue> {
  const apiKey = candidate.apiKey.trim();
  const historyContextTokens = Math.max(0, Math.floor(candidate.historyContextTokens));
  if (!apiKey) throw new Error('OpenRouter API key is required');
  if (!Number.isFinite(historyContextTokens)) throw new Error('History context budget must be a number');
  const key = { value: apiKey };
  const [capacity, keyInfo] = await Promise.all([
    fetchOpenRouterContextCapacity(OPENROUTER_MODEL, key),
    fetchOpenRouterKeyInfo(key),
  ]);
  if (apiKey !== settings.apiKey) sessionUsage.reset();
  modelContextTokens = capacity;
  sessionUsage.setKeyInfo(keyInfo);
  return { apiKey, historyContextTokens };
}

void refreshApps(appIdFromShellUrl(location.href)).catch(error => ui.showError(error instanceof Error ? error.message : String(error)));
