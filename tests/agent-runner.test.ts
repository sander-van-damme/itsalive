import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, type ExecutionResult } from '../src/shell/core/agent-runner';
import { AGENT_IDLE_TIMEOUT_REASON, AGENT_SAFETY_TIMEOUT_REASON } from '../src/shell/core/run-lifecycle';
import type { HistoryEntry } from '../src/shell/core/types';

const appId = '550e8400-e29b-41d4-a716-446655440000';
const model = { provider: 'local', model: 'test-model', maxContextTokens: 10_000, outputHeadroomTokens: 100, historyContextTokens: 2_000 };

describe('AgentRunner lifecycle', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('traces each turn and reports a deterministic turn-limit result', async () => {
    const entries: HistoryEntry[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push({ ...entry, id: entries.length + 1 }); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const providers = { generate: vi.fn(async () => ({ text: 'return 1;', usage: { inputTokens: 10, outputTokens: 3 }, raw: { id: 'response' } })) };
    const executor = { execute: vi.fn(async (): Promise<ExecutionResult> => ({ value: 1 })) };
    const groups = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    const groupEnds = vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain the app', trigger: 'Make a change',
      model, maxTurns: 2,
    });

    expect(result).toEqual({ status: 'turn-limit', turns: 2 });
    expect(providers.generate).toHaveBeenCalledTimes(2);
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(groups.mock.calls.map(call => call[0])).toEqual([
      `[itsalive:agent] Run · ${appId}`, '[itsalive:agent] Turn 1/2', '[itsalive:agent] Turn 2/2',
    ]);
    expect(groupEnds).toHaveBeenCalledTimes(3);
  });

  it('executes complete commands while the same model response is still streaming', async () => {
    const entries: HistoryEntry[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push(entry); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const events: string[] = [];
    const progress: string[] = [];
    const executionSteps: number[] = [];
    let releaseFirst!: () => void;
    const firstExecuted = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = '/* itsalive:command */\ndocument.body.dataset.first = "yes";\n/* itsalive:end */\n';
    const second = '/* itsalive:command */\nreturn itsalive.done("ready");\n/* itsalive:end */';
    const providers = {
      generateStreaming: vi.fn(async (_request: unknown, onText: (delta: string) => void) => {
        events.push('emit:first');
        onText('/* itsalive:com');
        onText(first.slice('/* itsalive:com'.length));
        await firstExecuted;
        events.push('emit:second');
        onText('/* itsalive:command */\nreturn itsalive.');
        onText('done("ready");\n/* itsalive:end */');
        return { text: first + second };
      }),
      generate: vi.fn(),
    };
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
      if (code.includes('rootCount')) return { value: { rootHtml: '<main>Ready</main>', rootCount: 1, outsideUiCount: 0 } };
      if (code.includes('dataset.first')) {
        events.push('execute:first');
        releaseFirst();
        return { value: null };
      }
      if (code.includes('itsalive.done')) {
        events.push('execute:done');
        return { done: true, message: 'ready' };
      }
      return { value: null };
    }) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Build it', model, maxTurns: 1,
      onProgress: update => {
        progress.push(update.phase);
        if (update.phase === 'executing' && update.step != null) executionSteps.push(update.step);
      },
    });

    expect(result).toEqual({ status: 'done', message: 'ready', turns: 1 });
    expect(events.indexOf('execute:first')).toBeGreaterThan(events.indexOf('emit:first'));
    expect(events.indexOf('execute:first')).toBeLessThan(events.indexOf('emit:second'));
    expect(events).toEqual(['emit:first', 'execute:first', 'emit:second', 'execute:done']);
    expect(progress).toEqual(expect.arrayContaining(['generating', 'executing', 'verifying', 'finishing']));
    expect(executionSteps).toEqual([1, 2]);
    const milestones = info.mock.calls.filter(call => call[0] === 'Timing milestone').map(call => (call[1] as { milestone: string }).milestone);
    expect(milestones).toEqual(expect.arrayContaining(['request-started', 'first-stream-text', 'first-complete-command', 'first-runtime-execution']));
    const timingSummary = info.mock.calls.find(call => call[0] === 'Timing summary')?.[1] as Record<string, number | undefined>;
    expect(timingSummary).toMatchObject({
      totalMs: expect.any(Number),
      firstStreamTextMs: expect.any(Number),
      firstCompleteCommandMs: expect.any(Number),
      firstExecutionMs: expect.any(Number),
      lastProgressMs: expect.any(Number),
    });
    expect(timingSummary.firstCompleteCommandMs!).toBeGreaterThanOrEqual(timingSummary.firstStreamTextMs!);
    expect(timingSummary.firstExecutionMs!).toBeGreaterThanOrEqual(timingSummary.firstCompleteCommandMs!);
    expect(entries.filter(entry => entry.role === 'agent').map(entry => entry.content)).toEqual([
      'document.body.dataset.first = "yes";',
      'return itsalive.done("ready");',
    ]);
  });

  it('extracts a single JavaScript fence even when the model adds prose', async () => {
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    const providers = { generate: vi.fn(async () => ({ text: 'I will inspect first.\n\n```js\nconst view = document.body;\nreturn view;\n```' })) };
    const executor = { execute: vi.fn(async (): Promise<ExecutionResult> => ({ value: 'ok' })) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Inspect it', model, maxTurns: 1,
    });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect((executor.execute.mock.calls as unknown[][])[0]?.[1]).toBe('const view = document.body;\nreturn view;');
  });

  it('rejects syntax-invalid generated JavaScript before calling the executor', async () => {
    const entries: HistoryEntry[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push(entry); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const providers = { generate: vi.fn(async () => ({ text: "const html = '<p>Today's focus</p>'; return html;" })) };
    const executor = { execute: vi.fn() };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Build it', model, maxTurns: 1,
    })).resolves.toEqual({ status: 'turn-limit', turns: 1 });

    expect(executor.execute).not.toHaveBeenCalled();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'observation', kind: 'error', content: expect.stringContaining('Generated JavaScript did not parse') }),
    ]));
  });

  it('stops after three consecutive generated-code failures instead of burning the turn budget', async () => {
    const entries: HistoryEntry[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push(entry); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const providers = { generate: vi.fn(async () => ({ text: 'I will inspect the app now.' })) };
    const executor = { execute: vi.fn() };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Build it', model, maxTurns: 12,
    })).rejects.toThrow(/invalid JavaScript 3 times in a row/);

    expect(providers.generate).toHaveBeenCalledTimes(3);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('replaces technical completion reports with a plain user-facing fallback', async () => {
    const entries: HistoryEntry[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push(entry); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const providers = { generate: vi.fn(async () => ({ text: 'return itsalive.done("AudioContext now resumes before scheduling and shows a confirmation toast while respecting prefers-reduced-motion.");' })) };
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
      if (code.includes('rootCount')) return { value: { rootHtml: '<main>Ready</main>', rootCount: 1, outsideUiCount: 0 } };
      return { done: true, message: 'AudioContext now resumes before scheduling and shows a confirmation toast while respecting prefers-reduced-motion.' };
    }) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const result = await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Fix audio', model, maxTurns: 1,
    });

    expect(result).toEqual({ status: 'done', message: 'Done — it’s ready.', turns: 1 });
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', kind: 'chat', content: 'Done — it’s ready.' }),
    ]));
    expect(entries.map(entry => entry.content).join('\n')).not.toContain('AudioContext');
  });

  it('keeps concise non-technical completion messages intact', async () => {
    const entries: HistoryEntry[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push(entry); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const providers = { generate: vi.fn(async () => ({ text: 'return itsalive.done("There’s your zebra — it runs while the timer is going.");' })) };
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
      if (code.includes('rootCount')) return { value: { rootHtml: '<main>Ready</main>', rootCount: 1, outsideUiCount: 0 } };
      return { done: true, message: 'There’s your zebra — it runs while the timer is going.' };
    }) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const result = await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Add a zebra', model, maxTurns: 1,
    });

    expect(result.message).toBe('There’s your zebra — it runs while the timer is going.');
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: 'There’s your zebra — it runs while the timer is going.' }),
    ]));
  });

  it('does not accept done() when the rendered app is still empty', async () => {
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    const providers = { generate: vi.fn()
      .mockResolvedValueOnce({ text: 'return itsalive.done("shell");' })
      .mockResolvedValueOnce({ text: 'return itsalive.done("ready");' }) };
    let inspections = 0;
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
      if (code.includes('rootCount')) {
        inspections++;
        return inspections === 1
          ? { value: { rootHtml: '<fiddl-app></fiddl-app>', rootCount: 1, outsideUiCount: 0 } }
          : { value: { rootHtml: '<fiddl-app><main>Today’s practice</main></fiddl-app>', rootCount: 1, outsideUiCount: 0 } };
      }
      return { done: true, message: 'candidate' };
    }) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Build it', model, maxTurns: 3,
    });

    expect(result).toMatchObject({ status: 'done', turns: 2 });
    expect(providers.generate).toHaveBeenCalledTimes(2);
    expect(inspections).toBe(2);
  });

  it('does not accept done while a staged scaffold is still marked as building', async () => {
    const entries: HistoryEntry[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push(entry); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const providers = { generate: vi.fn()
      .mockResolvedValueOnce({ text: 'return itsalive.done("too early");' })
      .mockResolvedValueOnce({ text: 'document.querySelector("[data-itsalive-building]")?.removeAttribute("data-itsalive-building"); return itsalive.done("ready");' }) };
    let inspections = 0;
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
      if (code.includes('rootCount')) {
        inspections++;
        return inspections === 1
          ? { value: { rootHtml: '<section data-itsalive-building inert>Loading</section>', rootCount: 1, outsideUiCount: 0, buildingCount: 1 } }
          : { value: { rootHtml: '<section>Ready</section>', rootCount: 1, outsideUiCount: 0, buildingCount: 0 } };
      }
      return { done: true, message: inspections ? 'ready' : 'candidate' };
    }) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Build progressively', model, maxTurns: 3,
    });

    expect(result).toMatchObject({ status: 'done', turns: 2 });
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'observation', kind: 'error', content: expect.stringContaining('data-itsalive-building') }),
    ]));
  });

  it('does not accept done while app behavior depends on transient agent listeners', async () => {
    const entries: HistoryEntry[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push(entry); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const providers = { generate: vi.fn()
      .mockResolvedValueOnce({ text: 'return itsalive.done("too early");' })
      .mockResolvedValueOnce({ text: 'return itsalive.done("durable");' }) };
    let inspections = 0;
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
      if (code.includes('rootCount')) {
        inspections++;
        return inspections === 1
          ? { value: { rootHtml: '<main><button>Play</button></main>', rootCount: 1, outsideUiCount: 0, runtimeOnlyEventListenerCount: 1 } }
          : { value: { rootHtml: '<main x-data><button @click="playing = true">Play</button></main>', rootCount: 1, outsideUiCount: 0, runtimeOnlyEventListenerCount: 0 } };
      }
      return { done: true, message: inspections ? 'durable' : 'candidate' };
    }) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Make the button durable', model, maxTurns: 3,
    });

    expect(result).toMatchObject({ status: 'done', turns: 2 });
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'observation', kind: 'error', content: expect.stringContaining('runtime-only event listener') }),
    ]));
  });

  it('stops a repeated low-signal verification loop after one diagnostic repair turn', async () => {
    const entries: HistoryEntry[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push(entry); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const providers = { generate: vi.fn(async () => ({ text: "return document.querySelector('[data-missing]');" })) };
    const stableState = '<main id="itsalive-root"><button data-vct="q-check">Check</button></main>';
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
      if (code.includes('document.getElementById("itsalive-root")?.outerHTML')) return { value: stableState };
      return { value: null };
    }) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Fix the quiz', model, maxTurns: 12,
    });

    expect(result).toMatchObject({ status: 'stalled', turns: 3 });
    expect(providers.generate).toHaveBeenCalledTimes(3);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'observation', kind: 'error', content: expect.stringContaining('Do not repeat the same probe') }),
      expect.objectContaining({ role: 'observation', kind: 'error', content: expect.stringContaining('stopped early to avoid burning the remaining turn budget') }),
    ]));
  });

  it('closes trace groups and rejects when aborted', async () => {
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    const providers = { generate: vi.fn() };
    const executor = { execute: vi.fn() };
    const controller = new AbortController();
    controller.abort(new DOMException('Stopped', 'AbortError'));
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    const groupEnds = vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain the app', trigger: 'Change it',
      model, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(providers.generate).not.toHaveBeenCalled();
    expect(groupEnds).toHaveBeenCalledTimes(2);
  });

  it('stops an inactive run with the product idle-timeout reason', async () => {
    vi.useFakeTimers();
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    const providers = {
      generateStreaming: vi.fn((request: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('BodyStreamBuffer was aborted')), { once: true });
      })),
      generate: vi.fn(),
    };
    const executor = { execute: vi.fn() };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const run = new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Make it complex', model,
      idleTimeoutMs: 50, maxDurationMs: 1_000,
    });
    const assertion = expect(run).rejects.toMatchObject({ name: 'TimeoutError', message: AGENT_IDLE_TIMEOUT_REASON });
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
  });

  it('treats provider activity without visible text as liveness until the safety ceiling', async () => {
    vi.useFakeTimers();
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    const providers = {
      generateStreaming: vi.fn((request: { signal?: AbortSignal }, _onText: (delta: string) => void, _credential: unknown, onActivity?: () => void) => new Promise((_resolve, reject) => {
        const timer = setInterval(() => onActivity?.(), 30);
        request.signal?.addEventListener('abort', () => {
          clearInterval(timer);
          reject(new Error('stream transport aborted'));
        }, { once: true });
      })),
      generate: vi.fn(),
    };
    const executor = { execute: vi.fn() };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const run = new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Reason before coding', model,
      idleTimeoutMs: 50, maxDurationMs: 125,
    });
    const assertion = expect(run).rejects.toMatchObject({ name: 'TimeoutError', message: AGENT_SAFETY_TIMEOUT_REASON });
    await vi.advanceTimersByTimeAsync(126);
    await assertion;

    expect(info.mock.calls.some(call => call[0] === 'Timing milestone' && (call[1] as { milestone?: string })?.milestone === 'first-provider-activity')).toBe(true);
  });

  it('lets streamed progress outlive the idle watchdog until the safety ceiling', async () => {
    vi.useFakeTimers();
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    const providers = {
      generateStreaming: vi.fn((request: { signal?: AbortSignal }, onText: (delta: string) => void) => new Promise((_resolve, reject) => {
        const timer = setInterval(() => onText(' '), 30);
        request.signal?.addEventListener('abort', () => {
          clearInterval(timer);
          reject(new Error('stream transport aborted'));
        }, { once: true });
      })),
      generate: vi.fn(),
    };
    const executor = { execute: vi.fn() };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const run = new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Keep building', model,
      idleTimeoutMs: 50, maxDurationMs: 125,
    });
    const assertion = expect(run).rejects.toMatchObject({ name: 'TimeoutError', message: AGENT_SAFETY_TIMEOUT_REASON });
    await vi.advanceTimersByTimeAsync(126);
    await assertion;
  });

  it('does not persist a platform-owned initial-build trigger as user chat', async () => {
    const entries: HistoryEntry[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push(entry); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const providers = { generate: vi.fn(async () => ({ text: 'return itsalive.done();' })) };
    const executor = { execute: vi.fn(async (): Promise<ExecutionResult> => ({ done: true })) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'A durable detailed specification',
      trigger: 'Build the initial version of this app now.', persistTrigger: false,
      model,
    });

    expect(entries).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user' })]));
    expect(entries.map(entry => entry.content)).not.toContain('A durable detailed specification');
    expect(providers.generate).toHaveBeenCalledTimes(1);
  });

  it('continues to persist normal user triggers', async () => {
    const add = vi.fn(async () => 1);
    const db = { history: { add, forApp: vi.fn(async () => []) } };
    const providers = { generate: vi.fn(async () => ({ text: 'return itsalive.done();' })) };
    const executor = { execute: vi.fn(async (): Promise<ExecutionResult> => ({ done: true })) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Add a chart',
      model,
    });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', kind: 'chat', content: 'Add a chart' }));
  });

  it('injects an in-flight environmental observation once into the next turn of the same run', async () => {
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    let release!: (value: { text: string }) => void;
    const first = new Promise<{ text: string }>(resolve => { release = resolve; });
    const providers = { generate: vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce({ text: 'return itsalive.done();' }) };
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => code.includes('rootCount') ? { value: { rootHtml: '<main>Ready</main>', rootCount: 1, outsideUiCount: 0 } } : code.includes('done') ? { done: true } : { value: 'turn one' }) };
    const queue: string[] = [];
    const consume = vi.fn(() => queue.splice(0));
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const run = new AgentRunner(db as never, providers as never, executor).run({ appId, appPrompt: 'Maintain it', trigger: 'Start', model, consumeEnvironmentObservations: consume });
    await vi.waitFor(() => expect(providers.generate).toHaveBeenCalledTimes(1));
    queue.push('The user changed tempo to 120.');
    release({ text: 'return "updated";' });
    await expect(run).resolves.toMatchObject({ status: 'done', turns: 2 });
    const firstMessages = providers.generate.mock.calls[0]![0].messages.map((message: { content: string }) => message.content).join('\n');
    const secondMessages = providers.generate.mock.calls[1]![0].messages.map((message: { content: string }) => message.content).join('\n');
    expect(firstMessages).not.toContain('changed tempo');
    expect(secondMessages.match(/changed tempo/g)).toHaveLength(1);
    expect(providers.generate).toHaveBeenCalledTimes(2);
    expect(queue).toHaveLength(0);
  });

  it('continues instead of accepting done when an environmental observation is pending', async () => {
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    const providers = { generate: vi.fn().mockResolvedValueOnce({ text: 'return itsalive.done();' }).mockResolvedValueOnce({ text: 'return itsalive.done();' }) };
    const queue: string[] = [];
    let executions = 0;
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
      if (code.includes('rootCount')) return { value: { rootHtml: '<main>Ready</main>', rootCount: 1, outsideUiCount: 0 } };
      if (++executions === 1) queue.push('A final user action arrived.');
      return { done: true };
    }) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const result = await new AgentRunner(db as never, providers as never, executor).run({ appId, appPrompt: 'Maintain it', trigger: 'Start', model, consumeEnvironmentObservations: () => queue.splice(0) });
    expect(result).toMatchObject({ status: 'done', turns: 2 });
    expect(providers.generate.mock.calls[1]![0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('A final user action arrived.') })]));
  });
});
