import './styles.css';
import { DEFAULT_HISTORY_CONTEXT_TOKENS, ShellUI, type AdaptationPrompt, type AppSummary, type ChatLine, type InteractionPrompt, type ResumePrompt, type SettingsValue } from './ui';
import { BehaviorTracker, CodingOrchestrator, OpenRouterJevAdapter, activateAlivePolicy, alivePolicyDiagnostic, adaptationFingerprint, adaptationOutcomeContext, appendAdaptationHistory, createActiveAdaptation, decideAdaptationOutcome, finalizeAdaptation, JEV_ADAPTATION_OUTCOME_QUESTIONS, JEV_ADAPTATION_OUTCOME_QUESTION_SET_VERSION, markAdaptationApplied, MAX_ADAPTATION_ASSESSMENTS, recordAdaptationAssessment, shouldSuppressAdaptation, DiagnosticLog, InitialBuildIntent, LlmTraceTracker, MAX_BEHAVIOR_SUMMARY_CHARACTERS, PausedRunStore, ReactionBatcher, ReactionConfirmationGate, RuntimeSession, SessionUsageTracker, ShellDatabase, agentProfile, agentProfileDiagnostic, appendHistory, behaviorEpisodeRetentionPlan, behaviorSummaryFromEpisodes, buildDiagnosticExport, buildUserIntentRequest, createAgentAbort, createDefaultRegistry, createLlmTraceIdentity, fetchOpenRouterContextCapacity, fetchOpenRouterKeyInfo, decideJevEscalation, compactJevDecisionTelemetry, contextRelevanceQuestions, decideContextRelevance, JEV_CONTEXT_RELEVANCE_QUESTION_SET_VERSION, DEFAULT_CONTEXT_RELEVANCE_POLICY, deleteApp, formatReactionTelemetry, formBehaviorEpisode, initialBuildTechnicalIntent, interactionConfirmationMessage, JEV_COMPLETION_QUESTIONS, JEV_COMPLETION_QUESTION_SET_VERSION, DEFAULT_JEV_COMPLETION_POLICY, decideJevCompletion, GENERIC_JEV_QUESTION, JEV_BEHAVIOR_EPISODE_QUESTIONS, JEV_BEHAVIOR_EPISODE_QUESTION_SET_VERSION, decideBehaviorEpisodeRetention, mergeBehaviorEpisode, JEV_FAILURE_QUESTIONS, JEV_FAILURE_QUESTION_SET_VERSION, DEFAULT_JEV_FAILURE_POLICY, decideJevFailure, JEV_ESCALATION_THRESHOLD, JEV_INTERACTION_QUESTION_SET_VERSION, JEV_PATTERN_SIGNAL_FLOOR, nextCronRun, normalizeAgentRunFailure, parseUserIntentDecision, persistNewApp, queryRuntimeLogs, renameAppRecord, resolveAgentProfile, searchHistory, selectAlivePolicyContext, technicalIntentBlock, type AgentProfileId, type AppRecord, type CodingOrchestratorResult, type Credential, type ExternalAgentAbortKind, type LlmTraceIdentity, type LogEntry, type ReactionBatch, type ResolvedAgentProfile, type SessionUsageState, type TechnicalIntent, type UserInputSource } from './core';
import { loadRuntimeSource } from './runtime-source';
import { codingLifecycleLabel } from './progress';
import { ROOT_DOMAIN, appIdFromShellUrl, appOrigin, isAppDocumentSnapshot, serializeError, shellUrlForApp, type AppToShellPayload, type BridgeMessage, type InteractionObservation, type JevState } from '../shared';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Shell mount point is missing');

const db = new ShellDatabase();
let activeId: string | undefined;
let runtimeEpoch = 0;
const jevControllers = new Set<AbortController>();
const diagnostics = new DiagnosticLog(db, () => activeId);
diagnostics.installConsoleCapture();

const SESSION_USAGE_STORAGE_KEY = 'itsalive.session-usage-v2';
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
const llmTraceTracker = new LlmTraceTracker();
function persistSessionUsage(): void {
  try { sessionStorage.setItem(SESSION_USAGE_STORAGE_KEY, JSON.stringify(sessionUsage.state())); }
  catch (error) { console.warn('[itsalive] Could not persist session usage', error); }
}
const registry = createDefaultRegistry(
  usage => { sessionUsage.recordLlmGeneration(usage); persistSessionUsage(); },
  event => llmTraceTracker.record(event),
);
let apps: AppRecord[] = [];
let running = false;
let activeRun: AbortController | undefined;
let activeRunFinished: Promise<void> | undefined;
let activeIntent: AbortController | undefined;
let interpreting = false;
let connectionTimer: number | undefined;
let runtimeLogWrites: Promise<void> = Promise.resolve();
const initialBuild = new InitialBuildIntent();

const PRIMARY_PROFILE_ID: AgentProfileId = 'coding-manager';

const defaultSettings: SettingsValue = { apiKey: '', historyContextTokens: DEFAULT_HISTORY_CONTEXT_TOKENS };
const modelContextTokens = new Map<string, number>();
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
const behaviorTracker = new BehaviorTracker();
const reactionConfirmationGates = new Map<string, ReactionConfirmationGate>();
const pausedRuns = new PausedRunStore();
let jevSessionStats = { requests: 0, inputTokens: 0, outputTokens: 0, knownCost: 0, pricedRequests: 0, escalations: 0, coalescedEvents: 0 };

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
    pausedRuns.clear(id);
    if (activeId === id) {
      if (running) {
        stopActiveRun('runtime-disposed');
        await waitForAgentIdle();
      }
      await flushActiveDocument();
      behaviorTracker.clear(id);
      disposeFrame();
    }
    await deleteApp(db, id, undefined, error => console.warn(`[itsalive] Could not clear origin storage for ${id}; continuing deletion`, error));
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
    await handleUserFacingInput(content, 'chat');
  },
  stopAgent: () => {
    if (!stopActiveRun('user-stop') && activeIntent && !activeIntent.signal.aborted) {
      activeIntent.abort(new DOMException('Stopped', 'AbortError'));
    }
  },
  resumePausedRun: async id => { await resumePausedRun(id); },
  resolveInteractionPrompt: async (id, clarification) => { await resolveInteractionPrompt(id, clarification); },
  resolveAdaptationPrompt: async (id, action) => { await resolveAdaptationPrompt(id, action); },
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
    ui.setModelContextCapacity(primaryModelContextCapacity());
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
    const usage = sessionUsage.snapshot();
    await diagnostics.write('info', 'usage', 'Session usage snapshot', { llm: usage.llm, jev: usage.jev });
    await diagnostics.write('info', 'llm-trace', 'LLM trace rollups', {
      requests: llmTraceTracker.snapshot().length,
      rollups: llmTraceTracker.rollups(),
    });
    await diagnostics.flush();
    const [logs, history] = await Promise.all([db.logs.all(), db.history.all()]);
    if (!logs.length) throw new Error('Diagnostic storage returned no log entries');
    const contents = buildDiagnosticExport(logs, history);
    if (!contents.trim()) throw new Error('Diagnostic export was unexpectedly empty');
    downloadText(`itsalive-logs-${Date.now()}.log`, contents);
  },
  reloadApp: () => { void reloadActiveApp(); }
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
  const primaryModel = agentProfile(PRIMARY_PROFILE_ID).model;
  void Promise.all([
    loadModelContextCapacity(primaryModel, startupKey),
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

async function refreshApps(select?: string): Promise<void> {
  apps = (await db.apps.list()).sort((a,b) => b.updatedAt - a.updatedAt);
  if (select) await selectApp(select); else {
    if (activeId && !apps.some(a => a.id === activeId)) activeId = undefined;
    ui.setApps(apps as AppSummary[], activeId);
    syncInteractionPrompt();
    syncResumePrompt();
    syncAdaptationPrompt();
    await refreshMessages();
  }
}

async function selectApp(id: string): Promise<void> {
  if (!apps.some(a => a.id === id)) return;
  if (activeId !== id && activeIntent && !activeIntent.signal.aborted) {
    activeIntent.abort(new DOMException('App switched', 'AbortError'));
  }
  if (activeId !== id && running) {
    ui.setAgentProgress('Pausing work before switching…');
    stopActiveRun('app-switch');
    await waitForAgentIdle();
  }
  await flushActiveDocument();
  const previousAppId = activeId;
  if (previousAppId) behaviorTracker.clear(previousAppId);
  activeId = id;
  history.replaceState(null, '', shellUrlForApp(location.href, id));
  disposeFrame();
  ui.setConnectionStatus('working');
  ui.setApps(apps as AppSummary[], id);
  syncInteractionPrompt();
  syncResumePrompt();
  syncAdaptationPrompt();
  const runtimeSource = await loadRuntimeSource();
  connectionTimer = window.setTimeout(() => { runtime.setState('error'); ui.setBusy(false); ui.setConnectionStatus('error'); }, 10_000);
  const frame = runtime.switchTo(id, currentOrigin(), runtimeSource);
  frame.addEventListener('error', () => { if (runtime.frame !== frame) return; clearTimeout(connectionTimer); ui.setBusy(false); runtime.setState('error'); ui.setConnectionStatus('error'); });
  frame.addEventListener('load', () => { if (runtime.frame === frame) ui.setConnectionStatus('working'); });
  await refreshMessages();
}

async function reloadActiveApp(): Promise<void> {
  const id = activeId;
  if (!id || runtime.appId !== id || runtime.state === 'disposed') return;
  await flushActiveDocument();
  behaviorTracker.clear(id);
  ui.setConnectionStatus('working');
  if (connectionTimer) clearTimeout(connectionTimer);
  connectionTimer = window.setTimeout(() => {
    runtime.setState('error');
    ui.setBusy(false);
    ui.setConnectionStatus('error');
  }, 10_000);
  runtime.reload();
}

async function flushActiveDocument(): Promise<void> {
  const id = activeId;
  if (!id || runtime.appId !== id || runtime.state !== 'ready') return;
  try {
    const snapshot = await runtime.request<{ document?: unknown }>({ type: 'document.snapshot' }, 5_000);
    if (!snapshot || !isAppDocumentSnapshot(snapshot.document)) throw new Error('Runtime returned an invalid document snapshot');
    await db.documents.put({ appId: id, ...snapshot.document, updatedAt: Date.now() });
  } catch (error) {
    console.warn(`[itsalive] Could not flush document snapshot for ${id}`, error);
  }
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
function disposeFrame(): void { runtimeEpoch++; for (const controller of jevControllers) controller.abort(createAgentAbort('runtime-disposed')); jevControllers.clear(); stopActiveRun('runtime-disposed'); reactionBatcher.destroy(); environmentalObservations.splice(0); jevSessionStats = { requests: 0, inputTokens: 0, outputTokens: 0, knownCost: 0, pricedRequests: 0, escalations: 0, coalescedEvents: 0 }; if (connectionTimer) clearTimeout(connectionTimer); connectionTimer = undefined; runtime.dispose(); }
function currentApp(): AppRecord | undefined { return apps.find(a => a.id === activeId); }
function currentOrigin(): string { if (!activeId) throw new Error('No active app'); return appOrigin(activeId, ROOT_DOMAIN, 'https:'); }

async function refreshMessages(): Promise<void> {
  if (!activeId) return ui.setMessages([]);
  const entries = (await db.history.forApp(activeId)).filter(e => e.kind === 'chat' && (e.role === 'user' || e.role === 'assistant'));
  ui.setMessages(entries.sort((a,b) => a.timestamp-b.timestamp).map(e => ({ role: e.role as ChatLine['role'], content: e.content })));
}

async function resolvedProfile(id: AgentProfileId): Promise<ResolvedAgentProfile> {
  const key = credential();
  if (!key) throw new Error('OpenRouter is not configured');
  const definition = agentProfile(id);
  return resolveAgentProfile(id, {
    contextCapacity: await loadModelContextCapacity(definition.model, key),
    configuredHistoryTokens: settings.historyContextTokens,
  });
}
function credential(): Credential | undefined { return settings.apiKey ? { value: settings.apiKey } : undefined; }

function primaryModelContextCapacity(): number | undefined {
  return modelContextTokens.get(agentProfile(PRIMARY_PROFILE_ID).model);
}

async function loadModelContextCapacity(model: string, key: Credential): Promise<number> {
  const cached = modelContextTokens.get(model);
  if (cached != null) return cached;
  const capacity = await fetchOpenRouterContextCapacity(model, key);
  modelContextTokens.set(model, capacity);
  return capacity;
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

interface InteractionAdaptationContext {
  interactionKey: string;
  hypothesis: string;
}

async function handleUserFacingInput(
  content: string,
  source: UserInputSource,
  telemetrySummary?: string,
  adaptationContext?: InteractionAdaptationContext,
): Promise<void> {
  const app = currentApp();
  const userText = content.trim();
  if (!app || !userText || interpreting) return;
  const appId = app.id;
  const intentController = new AbortController();
  activeIntent = intentController;
  interpreting = true;
  await appendHistory(db, { appId, role: 'user', kind: 'chat', content: userText });
  if (activeId === appId) {
    ui.setBusy(true);
    ui.setAgentProgress('Understanding your message…');
    await refreshMessages();
  }
  try {
    const profile = await resolvedProfile('user-intent');
    const model = profile.modelConfig;
    const intentRequest = buildUserIntentRequest({
      appPrompt: app.prompt,
      behaviorSummary: app.behaviorSummary,
      userText,
      source,
      ...(telemetrySummary?.trim() ? { telemetrySummary } : {}),
    }, model, intentController.signal);
    intentRequest.trace = createLlmTraceIdentity(profile.role, profile.id, { scope: appId });
    const generated = await registry.generate(intentRequest, credential());
    syncUsage();
    const decision = parseUserIntentDecision(generated.text, {
      appPrompt: app.prompt,
      behaviorSummary: app.behaviorSummary,
      userText,
      source,
      ...(telemetrySummary?.trim() ? { telemetrySummary } : {}),
    });
    await log('info', 'intent', 'User input interpreted', {
      source,
      profile: agentProfileDiagnostic(profile),
      kind: decision.kind,
      shouldCode: decision.shouldCode,
      ...(decision.technicalIntent ? {
        goal: decision.technicalIntent.goal,
        capabilityIds: decision.technicalIntent.capabilityIds,
      } : {}),
    }, appId);
    if (activeId !== appId) return;

    if (!decision.shouldCode || !decision.technicalIntent) {
      const reply = decision.reply.trim() || (decision.kind === 'explanation'
        ? 'Thanks — I understand that as context, not a request to change the app.'
        : 'I understand. I won’t change the app unless you ask for a specific change.');
      await appendHistory(db, { appId, role: 'assistant', kind: 'chat', content: reply });
      await refreshMessages();
      return;
    }

    const latestApp = await db.apps.get(appId) ?? app;
    if (latestApp.activeAdaptation) {
      if (source === 'interaction') {
        await appendHistory(db, {
          appId,
          role: 'assistant',
          kind: 'chat',
          content: 'There is already a reversible adaptation waiting for a Keep or Undo decision. I won’t stack another automatic adaptation on top of it.',
        });
        syncAdaptationPrompt();
        await refreshMessages();
        return;
      }
      await completeAdaptationForApp(
        appId,
        latestApp.activeAdaptation.id,
        latestApp.activeAdaptation.status === 'applied' ? 'neutral' : 'failed',
        'superseded-by-explicit-user-change',
      );
    }

    if (source === 'interaction' && adaptationContext) {
      await flushActiveDocument();
      const before = await db.documents.get(appId);
      const current = await db.apps.get(appId);
      if (!before || !current) throw new Error('Could not capture a reversible pre-adaptation snapshot');

      const fingerprint = adaptationFingerprint(adaptationContext.interactionKey, decision.technicalIntent.goal);
      if (shouldSuppressAdaptation(current.adaptationHistory, fingerprint)) {
        await log('info', 'adaptation', 'Repeated failed adaptation suppressed', {
          fingerprint,
          goal: decision.technicalIntent.goal.slice(0, 500),
        }, appId);
        await appendHistory(db, {
          appId,
          role: 'assistant',
          kind: 'chat',
          content: 'A very similar adaptation has already failed more than once, so I won’t keep reshaping the app from the same signal. Tell me the exact change you want and I can treat it as a normal explicit edit.',
        });
        await refreshMessages();
        return;
      }

      const active = createActiveAdaptation({
        id: crypto.randomUUID(),
        interactionKey: adaptationContext.interactionKey,
        hypothesis: adaptationContext.hypothesis,
        technicalGoal: decision.technicalIntent.goal,
        intendedOutcome: decision.technicalIntent.acceptanceCriteria.join(' '),
        beforeDocument: { html: before.html, scripts: before.scripts },
      });
      const updated: AppRecord = { ...current, activeAdaptation: active, updatedAt: Date.now() };
      await db.apps.put(updated);
      apps = apps.map(item => item.id === appId ? updated : item);
      await log('info', 'adaptation', 'Interaction adaptation hypothesis created', {
        adaptationId: active.id,
        fingerprint: active.fingerprint,
        hypothesis: active.hypothesis,
        intendedOutcome: active.intendedOutcome,
      }, appId);

      ui.setAgentProgress('Planning your change…');
      const started = await runAgent(technicalIntentBlock(decision.technicalIntent), false, async result => {
        if (result.status !== 'done') {
          await completeAdaptationForApp(appId, active.id, 'failed', 'coding-run-' + result.status);
          return;
        }
        await flushActiveDocument();
        await markAdaptationAppliedForApp(appId, active.id);
      });
      const afterRun = await db.apps.get(appId);
      if (!started || afterRun?.activeAdaptation?.id === active.id && afterRun.activeAdaptation.status === 'pending') {
        await completeAdaptationForApp(appId, active.id, 'failed', started ? 'coding-run-ended-without-completion' : 'coding-run-not-started');
      }
      return;
    }

    ui.setAgentProgress('Planning your change…');
    await runAgent(technicalIntentBlock(decision.technicalIntent));
  } catch (error) {
    if (intentController.signal.aborted) {
      await log('info', 'intent', 'User intent interpretation stopped', { source }, appId);
    } else {
      await log('error', 'intent', 'User intent interpretation failed', {
        source,
        error: error instanceof Error ? error.message : String(error),
      }, appId);
      if (activeId === appId) ui.showError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (activeIntent === intentController) activeIntent = undefined;
    interpreting = false;
    if (!running) {
      ui.setBusy(false);
      ui.setConnectionStatus(runtime.state === 'ready' ? 'connected' : runtime.state === 'loading' ? 'working' : 'error');
      if (activeId === appId) await refreshMessages();
    }
  }
}

function runtimeSignalIntent(goal: string, telemetrySummary: string): TechnicalIntent {
  return {
    goal,
    constraints: [
      'Treat the supplied runtime signal as evidence, not as a user request for unrelated changes.',
      'Preserve unrelated app behavior and user data.',
    ],
    acceptanceCriteria: ['Any required repair is limited to the observed runtime condition and leaves the app functional.'],
    capabilityIds: [],
    telemetrySummary,
  };
}

async function runAgent(
  trigger: string,
  isInitialBuild = false,
  onResult?: (result: CodingOrchestratorResult) => void | Promise<void>,
): Promise<boolean> {
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
  ui.setBusy(true);
  ui.setAgentProgress(isInitialBuild ? 'Preparing the first version…' : 'Applying your change…');
  let trace: LlmTraceIdentity | undefined;
  try {
    const profile = await resolvedProfile('coding-manager');
    trace = createLlmTraceIdentity(profile.role, profile.id, { scope: app.id });
    await log('info', `agent:${app.id}`, 'Agent run started', {
      technicalIntent: trigger,
      trace,
      profile: agentProfileDiagnostic(profile),
    }, app.id);
    const orchestrator = new CodingOrchestrator(db, registry, executor);
    const result = await orchestrator.run({
      appId: app.id,
      appPrompt: app.prompt,
      technicalIntent: trigger,
      managerProfile: profile,
      resolveProfile: id => resolvedProfile(id),
      ...(credential() ? { credential: credential() } : {}),
      signal: runController.signal,
      managerTrace: trace,
      consumeEnvironmentObservations: () => environmentalObservations.splice(0),
      onLifecycle: summary => ui.setAgentProgress(codingLifecycleLabel(summary, isInitialBuild)),
      onContext: context => {
        sessionUsage.setContext(context.estimatedInputTokens, context.maxContextTokens);
        syncUsage();
      },
      completionAssessor: (state, signal) => assessCompletionWithJev(app.id, state, signal),
      failureAssessor: (state, signal) => assessFailureWithJev(app.id, state, signal),
      contextRelevanceAssessor: (state, signal) => assessContextRelevanceWithJev(app.id, state, signal),
      alivePolicy: app.alivePolicy,
      onAlivePolicyProposal: proposal => activateAlivePolicyForApp(app.id, proposal),
    });
    await log('info', `agent:${app.id}`, `Agent run finished: ${result.status}`, {
      workerTurns: result.workerTurns,
      message: result.message,
      trace,
      plan: result.plan,
      handoffs: result.handoffs,
      timeline: result.timeline,
    }, app.id);
    await onResult?.(result);
    if (result.message) {
      await db.history.add({ appId: app.id, timestamp: Date.now(), role: 'assistant', kind: 'chat', content: result.message });
    }
  } catch (error) {
    const failure = normalizeAgentRunFailure(error, runController.signal);
    await log(failure.kind === 'run-error' ? 'error' : 'info', `agent:${app.id}`, 'Agent run stopped', {
      kind: failure.kind,
      resumable: failure.resumable,
      technical: failure.technical,
      trace,
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
        syncAdaptationPrompt();
        await refreshMessages();
      }
      void startPendingInitialBuild();
      if (stillActive && environmentalObservations.length && runtime.state === 'ready') {
        const telemetry = environmentalObservations.splice(0).join('\n\n');
        void runAgent(technicalIntentBlock(runtimeSignalIntent(
          'Review the new runtime/environment observation and make only a necessary repair if the app is actually broken.',
          telemetry,
        )));
      }
    } finally {
      resolveRunFinished();
      if (activeRunFinished === runFinished) activeRunFinished = undefined;
      syncUsage();
    }
  }
  return true;
}

async function activateAlivePolicyForApp(
  appId: string,
  proposal: import('./core').AlivePolicyProposal,
): Promise<void> {
  const current = await db.apps.get(appId);
  if (!current) return;
  const policy = activateAlivePolicy(proposal, current.alivePolicy);
  const updated: AppRecord = { ...current, alivePolicy: policy, updatedAt: Date.now() };
  await db.apps.put(updated);
  apps = apps.map(item => item.id === appId ? updated : item);
  await log('info', 'alive-policy', 'Alive policy activated', alivePolicyDiagnostic(policy), appId);
}

async function markAdaptationAppliedForApp(appId: string, adaptationId: string): Promise<void> {
  const current = await db.apps.get(appId);
  if (!current?.activeAdaptation || current.activeAdaptation.id !== adaptationId) return;
  const activeAdaptation = markAdaptationApplied(current.activeAdaptation);
  const updated: AppRecord = { ...current, activeAdaptation, updatedAt: Date.now() };
  await db.apps.put(updated);
  apps = apps.map(item => item.id === appId ? updated : item);
  await log('info', 'adaptation', 'Interaction adaptation applied', {
    adaptationId,
    fingerprint: activeAdaptation.fingerprint,
    hypothesis: activeAdaptation.hypothesis,
    intendedOutcome: activeAdaptation.intendedOutcome,
  }, appId);
  if (activeId === appId) syncAdaptationPrompt();
}

async function completeAdaptationForApp(
  appId: string,
  adaptationId: string,
  outcome: import('./core').AdaptationOutcome,
  reason: string,
): Promise<void> {
  const current = await db.apps.get(appId);
  const active = current?.activeAdaptation;
  if (!current || !active || active.id !== adaptationId) return;
  const entry = finalizeAdaptation(active, outcome, reason);
  const updated: AppRecord = {
    ...current,
    activeAdaptation: undefined,
    adaptationHistory: appendAdaptationHistory(current.adaptationHistory, entry),
    updatedAt: Date.now(),
  };
  await db.apps.put(updated);
  apps = apps.map(item => item.id === appId ? updated : item);
  await log('info', 'adaptation', 'Interaction adaptation finalized', {
    adaptationId,
    fingerprint: entry.fingerprint,
    outcome: entry.outcome,
    reason: entry.reason,
    assessments: entry.assessments,
    hypothesis: entry.hypothesis,
    intendedOutcome: entry.intendedOutcome,
  }, appId);
  if (activeId === appId) syncAdaptationPrompt();
}

async function recordAdaptationOutcomeForApp(
  appId: string,
  adaptationId: string,
  assessment: import('./core').AdaptationAssessment,
): Promise<void> {
  const current = await db.apps.get(appId);
  const active = current?.activeAdaptation;
  if (!current || !active || active.id !== adaptationId || active.status !== 'applied') return;
  const next = recordAdaptationAssessment(active, assessment);
  const updated: AppRecord = { ...current, activeAdaptation: next, updatedAt: Date.now() };
  await db.apps.put(updated);
  apps = apps.map(item => item.id === appId ? updated : item);
  await log('info', 'adaptation', 'Adaptation outcome assessed', {
    adaptationId,
    fingerprint: next.fingerprint,
    assessment: assessment.action,
    reason: assessment.reason,
    helpedProbability: assessment.helpedProbability,
    classificationConfidence: assessment.classificationConfidence,
    assessmentCount: next.assessmentCount,
  }, appId);
  if (activeId === appId) syncAdaptationPrompt();
}

function syncAdaptationPrompt(): void {
  const active = currentApp()?.activeAdaptation;
  let prompt: AdaptationPrompt | undefined;
  if (active?.status === 'applied') {
    const assessment = active.lastAssessment?.action;
    const content = assessment === 'harmful' || assessment === 'rejected'
      ? 'This change may not have helped and could be causing new friction. Keep it only if you prefer it, or undo it.'
      : assessment === 'successful'
        ? 'This change appears to be helping. Keep it, or undo it while the previous version is still available.'
        : active.assessmentCount >= MAX_ADAPTATION_ASSESSMENTS
          ? 'I could not verify that this change helped. Keep it or undo it before I make another proactive adaptation.'
          : 'I changed the app based on that interaction. Keep this change, or undo it if it was not what you wanted.';
    prompt = {
      id: active.id,
      content,
      keepLabel: 'Keep change',
      undoLabel: 'Undo change',
    };
  }
  ui.setAdaptationPrompt(prompt);
}

async function reloadSavedDocumentWithoutFlush(appId: string): Promise<void> {
  if (activeId !== appId || runtime.appId !== appId || runtime.state === 'disposed') return;
  behaviorTracker.clear(appId);
  runtimeEpoch++;
  for (const controller of jevControllers) controller.abort(createAgentAbort('runtime-disposed'));
  jevControllers.clear();
  reactionBatcher.destroy();
  reactionConfirmationGates.get(appId)?.clear();
  syncInteractionPrompt();
  ui.setConnectionStatus('working');
  if (connectionTimer) clearTimeout(connectionTimer);
  connectionTimer = window.setTimeout(() => {
    runtime.setState('error');
    ui.setBusy(false);
    ui.setConnectionStatus('error');
  }, 10_000);
  runtime.reload();
}

async function startPendingInitialBuild(): Promise<void> {
  const id = initialBuild.candidate(activeId, runtime.state === 'ready', running);
  const app = id ? apps.find(item => item.id === id) : undefined;
  if (!id || !app) return;
  ui.setConnectionStatus('working');
  const run = runAgent(technicalIntentBlock(initialBuildTechnicalIntent(app.prompt)), true);
  if (running && activeRun) initialBuild.accepted(id);
  await run;
}

async function assessCompletionWithJev(
  appId: string,
  state: import('./core').CompletionAssessmentState,
  signal: AbortSignal,
): Promise<import('./core').CompletionAssessmentDecision> {
  const key = credential();
  if (!key) throw new Error('OpenRouter is not configured');
  const result = await new OpenRouterJevAdapter().evaluate({
    state,
    questions: JEV_COMPLETION_QUESTIONS,
    signal,
  }, key);
  sessionUsage.recordJevDecision(result.usage);
  syncUsage();
  const decision = decideJevCompletion(result);
  await log('info', 'jev', 'Completion decision', {
    ...compactJevDecisionTelemetry({
      decisionKind: 'agent-completion',
      questionSetVersion: JEV_COMPLETION_QUESTION_SET_VERSION,
      result,
      policy: {
        outcome: DEFAULT_JEV_COMPLETION_POLICY.outcome,
        failure: DEFAULT_JEV_COMPLETION_POLICY.failure,
      },
      action: decision.action,
    }),
    reason: decision.reason,
    bands: decision.bands,
    evidence: {
      inspectionAvailable: state.evidence.inspectionAvailable,
      scopeSelector: state.evidence.scopeSelector,
      htmlCharacters: state.evidence.htmlCharacters,
      interactiveCount: state.evidence.interactiveCount,
      visualCount: state.evidence.visualCount,
      structureCount: state.evidence.structureCount,
      buildingCount: state.evidence.buildingCount,
      runtimeOnlyEventListenerCount: state.evidence.runtimeOnlyEventListenerCount,
    },
  }, appId);
  return { action: decision.action, reason: decision.reason };
}

async function assessFailureWithJev(
  appId: string,
  state: import('./core').FailureAssessmentState,
  signal: AbortSignal,
): Promise<import('./core').FailureAssessmentDecision> {
  const key = credential();
  if (!key) throw new Error('OpenRouter is not configured');
  const result = await new OpenRouterJevAdapter().evaluate({
    state,
    questions: JEV_FAILURE_QUESTIONS,
    signal,
  }, key);
  sessionUsage.recordJevDecision(result.usage);
  syncUsage();
  const decision = decideJevFailure(result);
  await log('info', 'jev', 'Failure route decision', {
    ...compactJevDecisionTelemetry({
      correlationId: state.correlationId,
      decisionKind: 'agent-failure-route',
      questionSetVersion: JEV_FAILURE_QUESTION_SET_VERSION,
      result,
      policy: {
        repair: DEFAULT_JEV_FAILURE_POLICY.repair,
        minimumClassConfidence: DEFAULT_JEV_FAILURE_POLICY.minimumClassConfidence,
      },
      action: decision.action,
    }),
    phase: state.phase,
    attempt: state.attempt,
    maxAttempts: state.maxAttempts,
    scopeSelector: state.scopeSelector,
    reason: decision.reason,
    failureClass: decision.failureClass,
    classConfidence: decision.classConfidence,
    repairBand: decision.repairBand,
  }, appId);
  return { action: decision.action, reason: decision.reason, failureClass: decision.failureClass };
}

async function assessContextRelevanceWithJev(
  appId: string,
  state: import('./core').ContextRelevanceState,
  signal: AbortSignal,
): Promise<import('./core').ContextRelevanceDecision> {
  if (!state.candidates.length) return { selectedIds: [], omittedIds: [], uncertainIds: [] };
  const key = credential();
  if (!key) throw new Error('OpenRouter is not configured');
  const result = await new OpenRouterJevAdapter().evaluate({
    state,
    questions: contextRelevanceQuestions(state.candidates),
    signal,
  }, key);
  sessionUsage.recordJevDecision(result.usage);
  syncUsage();
  const decision = decideContextRelevance(result, state.candidates);
  await log('info', 'jev', 'Context relevance decision', {
    ...compactJevDecisionTelemetry({
      decisionKind: 'context-relevance',
      questionSetVersion: JEV_CONTEXT_RELEVANCE_QUESTION_SET_VERSION,
      result,
      policy: {
        lowMax: DEFAULT_CONTEXT_RELEVANCE_POLICY.lowMax,
        highMin: DEFAULT_CONTEXT_RELEVANCE_POLICY.highMin,
      },
      action: 'filter',
    }),
    candidateCount: state.candidates.length,
    technicalCandidates: state.candidates.filter(item => item.source === 'technical-history').length,
    behavioralCandidates: state.candidates.filter(item => item.source === 'behavior-episode').length,
    selectedCount: decision.selectedIds.length,
    omittedCount: decision.omittedIds.length,
    uncertainCount: decision.uncertainIds.length,
    selectedIds: decision.selectedIds,
    omittedIds: decision.omittedIds,
  }, appId);
  return decision;
}

async function handleRuntimeMessage(message: BridgeMessage<AppToShellPayload>): Promise<void> {
  if (!activeId || message.appId !== activeId) return;
  switch (message.type) {
    case 'document.request': {
      const saved = await db.documents.get(activeId);
      const valid = saved && isAppDocumentSnapshot({ html: saved.html, scripts: (saved as { scripts?: unknown }).scripts })
        ? { html: saved.html, scripts: saved.scripts }
        : undefined;
      if (saved && !valid) {
        await db.documents.delete(activeId);
        await log('warn', 'persistence', 'Discarded incompatible beta document snapshot', undefined, activeId);
      }
      respond(message, { type: 'document.response', ...(valid ? { document: valid } : {}) });
      break;
    }
    case 'document.save':
      await db.documents.put({ appId: activeId, ...message.document, updatedAt: Date.now() });
      break;
    case 'log':
      runtimeLogWrites = runtimeLogWrites.then(
        () => log(message.record.level, message.record.source, message.record.message, message.record.details, message.appId),
        () => log(message.record.level, message.record.source, message.record.message, message.record.details, message.appId),
      );
      try { await runtimeLogWrites; }
      catch (error) { console.warn('[itsalive] Could not persist app runtime log', error); }
      break;
    case 'history.request':
      respond(message, { type: 'history.response', results: await searchHistory(db, activeId, message.query, message.limit) });
      break;
    case 'logs.request':
      try {
        await runtimeLogWrites;
        respond(message, { type: 'logs.response', results: await queryRuntimeLogs(db, message.appId, { level: message.level, limit: message.limit }) });
      } catch (error) {
        respond(message, { type: 'logs.response', error: serializeError(error) });
      }
      break;
    case 'jev.request': await handleJevRequest(message); break;
    case 'llm.request': await handleLlmRequest(message); break;
    case 'cron.register': {
      const id = `${activeId}:${message.registration.callbackId}`; const previous = await db.get<import('./core').ScheduleRecord>('schedules', id);
      await db.schedules.put({ id, appId: activeId, expression: message.registration.schedule, registeredAt: Date.now(), lastFired: previous?.lastFired, nextRun: nextCronRun(message.registration.schedule) });
      break;
    }
    case 'wake': if (!running) {
      const reason = message.reason || 'The app requested an agent wake-up.';
      void runAgent(technicalIntentBlock(runtimeSignalIntent(
        'Handle the app-requested follow-up only if it requires an implementation change.',
        reason,
      )));
    } break;
    case 'status':
      runtime.setState('ready');
      if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = undefined; }
      ui.setConnectionStatus('connected');
      void startPendingInitialBuild();
      break;
  }
}

async function handleJevRequest(message: BridgeMessage & { type: 'jev.request'; state: InteractionObservation }): Promise<void> {
  const startedAt = performance.now();
  const appId = activeId;
  const epoch = runtimeEpoch;
  const app = appId ? apps.find(item => item.id === appId) : undefined;
  if (!appId || !app) return;
  const state: JevState = behaviorTracker.observe(appId, message.state, app.behaviorSummary, app.alivePolicy);
  const alivePolicy = selectAlivePolicyContext(app.alivePolicy, message.state, state.pattern);
  const episode = formBehaviorEpisode(message.state, state.pattern);
  const controller = new AbortController();
  jevControllers.add(controller);
  const current = () => Boolean(appId && activeId === appId && runtimeEpoch === epoch && runtime.appId === appId && !controller.signal.aborted);
  try {
    const key = credential();
    if (!key) throw new Error('OpenRouter is not configured');
    jevSessionStats.requests++;
    jevSessionStats.coalescedEvents += state.pattern?.coalescedCount ?? 0;
    const result = await new OpenRouterJevAdapter().evaluate({
      state: {
        ...state,
        ...(alivePolicy ? { alivePolicy } : {}),
        ...(episode.action === 'triage' ? { behaviorEpisode: episode.candidate } : {}),
      },
      ...(episode.action === 'triage'
        ? { questions: { ...GENERIC_JEV_QUESTION, ...JEV_BEHAVIOR_EPISODE_QUESTIONS } }
        : {}),
      signal: controller.signal,
    }, key);
    if (!current()) return;
    const usage = result.usage;
    jevSessionStats.inputTokens += usage?.inputTokens ?? 0;
    jevSessionStats.outputTokens += usage?.outputTokens ?? 0;
    if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
      jevSessionStats.knownCost += usage.cost;
      jevSessionStats.pricedRequests++;
    }
    sessionUsage.recordJevDecision(usage);
    syncUsage();
    const decision = decideJevEscalation(result.probability, state);
    const episodeDecision = episode.action === 'triage'
      ? decideBehaviorEpisodeRetention(result)
      : undefined;
    if (decision.escalated) jevSessionStats.escalations++;
    if (episode.action === 'triage' && episodeDecision?.action === 'retain') {
      await retainBehaviorEpisode(appId, episode.candidate, episodeDecision);
    }
    await log('info', 'jev', 'Interaction decision', {
      ...compactJevDecisionTelemetry({
        correlationId: message.requestId,
        decisionKind: 'interaction-wake',
        questionSetVersion: JEV_INTERACTION_QUESTION_SET_VERSION,
        result,
        policy: { threshold: JEV_ESCALATION_THRESHOLD, patternSignalFloor: JEV_PATTERN_SIGNAL_FLOOR },
        action: decision.escalated ? 'escalate-to-confirmation' : 'no-op',
      }),
      probability: result.probability,
      escalated: decision.escalated,
      escalationReason: decision.reason,
      pattern: state.pattern,
      durationMs: Math.round(performance.now() - startedAt),
      snapshotCharacters: state.document.length,
      alivePolicy: alivePolicy ? {
        revision: alivePolicy.revision,
        meaningfulMatches: alivePolicy.matchedMeaningfulEvents.length,
        repeatableMatches: alivePolicy.matchedRepeatableInteractions.length,
        safeReactions: alivePolicy.safeReactions.length,
        invariants: alivePolicy.invariants.length,
      } : undefined,
      behaviorEpisode: episode.action === 'drop'
        ? { localAction: 'drop', reason: episode.reason }
        : {
            localAction: 'triage',
            questionSetVersion: JEV_BEHAVIOR_EPISODE_QUESTION_SET_VERSION,
            triageAction: episodeDecision?.action,
            triageReason: episodeDecision?.reason,
            kind: episodeDecision?.kind,
            retentionProbability: episodeDecision?.retentionProbability,
            classificationConfidence: episodeDecision?.classificationConfidence,
          },
      session: { ...jevSessionStats },
    }, appId);
    if (!current()) return;
    respond(message, { type: 'jev.response', probability: result.probability, escalated: decision.escalated });
    if (decision.escalated) reactionBatcher.add(state);
  } catch (error) {
    if (!current()) return;
    await log('warn', 'jev', 'Observation failed; interaction remains available', { durationMs: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), session: { ...jevSessionStats } }, appId);
    if (!current()) return;
    respond(message, { type: 'jev.response', probability: 0, escalated: false, error: serializeError(error) });
  } finally { jevControllers.delete(controller); }
}

async function retainBehaviorEpisode(
  appId: string,
  candidate: import('./core').BehaviorEpisodeCandidate,
  triage: import('./core').BehaviorEpisodeTriageDecision,
): Promise<void> {
  const existing = await db.behaviorEpisodes.forApp(appId);
  const record = mergeBehaviorEpisode(appId, existing, candidate, triage, crypto.randomUUID(), Date.now());
  if (!record) return;

  await db.behaviorEpisodes.put(record);
  const withRecord = [...existing.filter(item => item.id !== record.id), record];
  const retention = behaviorEpisodeRetentionPlan(withRecord);
  await Promise.all(retention.deleteIds.map(id => db.behaviorEpisodes.delete(id)));

  const summary = behaviorSummaryFromEpisodes(retention.keep, MAX_BEHAVIOR_SUMMARY_CHARACTERS);
  const current = await db.apps.get(appId);
  if (current && summary) {
    const updated: AppRecord = {
      ...current,
      behaviorSummary: summary,
      behaviorSummaryUpdatedAt: Date.now(),
    };
    await db.apps.put(updated);
    apps = apps.map(item => item.id === appId ? updated : item);
  }

  await log('info', 'behavior', 'Behavior episode retained', {
    kind: record.kind,
    occurrences: record.occurrences,
    actionCount: record.actionCount,
    retainedEpisodes: retention.keep.length,
    prunedEpisodes: retention.deleteIds.length,
    retentionProbability: record.retentionProbability,
    classificationConfidence: record.classificationConfidence,
  }, appId);
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
        intentPlaceholder: 'Describe what happened or what you expected…',
        confirmLabel: 'Send explanation',
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

async function resolveInteractionPrompt(id: string, clarification?: string): Promise<void> {
  const appId = activeId;
  if (!appId) return;
  const resolution = reactionConfirmationGates.get(appId)?.resolve(id, clarification) ?? { kind: 'missing' as const };
  if (resolution.kind === 'missing') {
    await log('warn', 'reaction', 'Ignored stale interaction clarification response', { promptId: id }, appId);
    syncInteractionPrompt();
    return;
  }

  syncInteractionPrompt();
  await log('info', 'reaction', resolution.kind === 'submitted' ? 'Interaction clarification submitted' : 'Interaction clarification dismissed', {
    promptId: resolution.confirmation.id,
    size: resolution.confirmation.batch.events.length,
    ...(resolution.kind === 'submitted' ? { clarification: resolution.clarification } : {}),
  }, appId);
  if (resolution.kind !== 'submitted') return;

  await waitForAgentIdle();
  if (activeId !== appId) return;
  await handleUserFacingInput(
    resolution.clarification,
    'interaction',
    formatReactionTelemetry(resolution.confirmation.batch),
  );
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
    const profile = await resolvedProfile('runtime-llm');
    const result = await registry.generate({
      purpose: 'app itsalive.llm.ask',
      model: profile.modelConfig,
      system: 'Respond helpfully to this request from the active app.',
      messages: [{ role: 'user', content: message.prompt }],
      trace: createLlmTraceIdentity(profile.role, profile.id, { scope: message.appId }),
    }, credential());
    syncUsage();
    respond(message, { type: 'llm.response', result: result.text });
  } catch (error) { respond(message, { type: 'llm.response', error: serializeError(error) }); }
}

function respond(message: BridgeMessage<AppToShellPayload>, payload: Parameters<RuntimeSession['post']>[0]): void { runtime.respond(message, payload); }
async function log(level: LogEntry['level'], source: string, message: string, details?: unknown, appId?: string) {
  await diagnostics.write(level, source, message, details, appId);
}


function downloadText(name: string, value: string): void { const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url); }

async function testModelConnection(candidate: SettingsValue): Promise<SettingsValue> {
  const apiKey = candidate.apiKey.trim();
  const historyContextTokens = Math.max(0, Math.floor(candidate.historyContextTokens));
  if (!apiKey) throw new Error('OpenRouter API key is required');
  if (!Number.isFinite(historyContextTokens)) throw new Error('History context budget must be a number');
  const key = { value: apiKey };
  const primaryModel = agentProfile(PRIMARY_PROFILE_ID).model;
  const [capacity, keyInfo] = await Promise.all([
    fetchOpenRouterContextCapacity(primaryModel, key),
    fetchOpenRouterKeyInfo(key),
  ]);
  if (apiKey !== settings.apiKey) {
    sessionUsage.reset();
    llmTraceTracker.reset();
    modelContextTokens.clear();
  }
  modelContextTokens.set(primaryModel, capacity);
  sessionUsage.setKeyInfo(keyInfo);
  return { apiKey, historyContextTokens };
}

void refreshApps(appIdFromShellUrl(location.href)).catch(error => ui.showError(error instanceof Error ? error.message : String(error)));
