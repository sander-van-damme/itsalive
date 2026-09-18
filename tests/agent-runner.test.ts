import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, type ExecutionResult } from '../src/shell/core/agent-runner';
import type { HistoryEntry } from '../src/shell/core/types';

describe('AgentRunner lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

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
      appId: '550e8400-e29b-41d4-a716-446655440000', appPrompt: 'Maintain the app', trigger: 'Make a change',
      model: { id: 'm', provider: 'local', model: 'test-model', maxContextTokens: 10_000, maxOutputTokens: 100 },
      tools: [], maxTurns: 2,
    });

    expect(result).toEqual({ status: 'turn-limit', turns: 2 });
    expect(providers.generate).toHaveBeenCalledTimes(2);
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(groups.mock.calls.map(call => call[0])).toEqual([
      '[itsalive:agent] Run · 550e8400-e29b-41d4-a716-446655440000', '[itsalive:agent] Turn 1/2', '[itsalive:agent] Turn 2/2',
    ]);
    expect(groupEnds).toHaveBeenCalledTimes(3);
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
      appId: '550e8400-e29b-41d4-a716-446655440000', appPrompt: 'Maintain the app', trigger: 'Change it',
      model: { id: 'm', provider: 'local', model: 'test-model', maxContextTokens: 10_000, maxOutputTokens: 100 },
      tools: [], signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(providers.generate).not.toHaveBeenCalled();
    expect(groupEnds).toHaveBeenCalledTimes(2);
  });

  it('notifies after persisting a user trigger and before model generation', async () => {
    const entries: HistoryEntry[] = [];
    const events: string[] = [];
    const db = { history: {
      add: vi.fn(async (entry: HistoryEntry) => { entries.push(entry); events.push('persisted'); return entries.length; }),
      forApp: vi.fn(async () => entries),
    } };
    const providers = { generate: vi.fn(async () => { events.push('generated'); return { text: 'return itsalive.done();' }; }) };
    const executor = { execute: vi.fn(async (): Promise<ExecutionResult> => ({ done: true })) };
    const onTriggerPersisted = vi.fn(async () => {
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', kind: 'chat', content: 'Add a chart' }),
      ]));
      events.push('notified');
    });
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await new AgentRunner(db as never, providers as never, executor).run({
      appId: '550e8400-e29b-41d4-a716-446655440000', appPrompt: 'Maintain it', trigger: 'Add a chart',
      model: { id: 'm', provider: 'local', model: 'test-model', maxContextTokens: 10_000, maxOutputTokens: 100 },
      tools: [], onTriggerPersisted,
    });

    expect(onTriggerPersisted).toHaveBeenCalledOnce();
    expect(events.slice(0, 3)).toEqual(['persisted', 'notified', 'generated']);
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

    const onTriggerPersisted = vi.fn();

    await new AgentRunner(db as never, providers as never, executor).run({
      appId: '550e8400-e29b-41d4-a716-446655440000', appPrompt: 'A durable detailed specification',
      trigger: 'Build the initial version of this app now.', persistTrigger: false,
      model: { id: 'm', provider: 'local', model: 'test-model', maxContextTokens: 10_000, maxOutputTokens: 100 }, tools: [],
      onTriggerPersisted,
    });

    expect(onTriggerPersisted).not.toHaveBeenCalled();
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
      appId: '550e8400-e29b-41d4-a716-446655440000', appPrompt: 'Maintain it', trigger: 'Add a chart',
      model: { id: 'm', provider: 'local', model: 'test-model', maxContextTokens: 10_000, maxOutputTokens: 100 }, tools: [],
    });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', kind: 'chat', content: 'Add a chart' }));
  });
});
