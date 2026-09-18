import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, type ExecutionResult } from '../src/shell/core/agent-runner';
import type { HistoryEntry } from '../src/shell/core/types';

const appId = '550e8400-e29b-41d4-a716-446655440000';
const model = { id: 'm', provider: 'local', model: 'test-model', maxContextTokens: 10_000, maxOutputTokens: 100 };

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
      appId, appPrompt: 'Maintain the app', trigger: 'Make a change',
      model, tools: [], maxTurns: 2,
    });

    expect(result).toEqual({ status: 'turn-limit', turns: 2 });
    expect(providers.generate).toHaveBeenCalledTimes(2);
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(groups.mock.calls.map(call => call[0])).toEqual([
      `[itsalive:agent] Run · ${appId}`, '[itsalive:agent] Turn 1/2', '[itsalive:agent] Turn 2/2',
    ]);
    expect(groupEnds).toHaveBeenCalledTimes(3);
  });

  it('extracts a single JavaScript fence even when the model adds prose', async () => {
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    const providers = { generate: vi.fn(async () => ({ text: 'I will inspect first.\n\n```js\nconst view = await itsalive.dom.inspect();\nreturn view;\n```' })) };
    const executor = { execute: vi.fn(async (): Promise<ExecutionResult> => ({ value: 'ok' })) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Inspect it', model, tools: [], maxTurns: 1,
    });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect((executor.execute.mock.calls as unknown[][])[0]?.[1]).toBe('const view = await itsalive.dom.inspect();\nreturn view;');
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
      appId, appPrompt: 'Maintain it', trigger: 'Build it', model, tools: [], maxTurns: 1,
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
      appId, appPrompt: 'Maintain it', trigger: 'Build it', model, tools: [], maxTurns: 12,
    })).rejects.toThrow(/invalid JavaScript 3 times in a row/);

    expect(providers.generate).toHaveBeenCalledTimes(3);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('does not accept done() when the rendered app is still empty', async () => {
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    const providers = { generate: vi.fn()
      .mockResolvedValueOnce({ text: 'return itsalive.done("shell");' })
      .mockResolvedValueOnce({ text: 'return itsalive.done("ready");' }) };
    let inspections = 0;
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
      if (code.includes('itsalive.dom.inspect')) {
        inspections++;
        return inspections === 1
          ? { value: '@1 body\n└─ @2 fiddl-app' }
          : { value: '@1 body\n└─ @2 fiddl-app\n   └─ @3 main "Today’s practice"' };
      }
      return { done: true, message: 'candidate' };
    }) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new AgentRunner(db as never, providers as never, executor).run({
      appId, appPrompt: 'Maintain it', trigger: 'Build it', model, tools: [], maxTurns: 3,
    });

    expect(result).toMatchObject({ status: 'done', turns: 2 });
    expect(providers.generate).toHaveBeenCalledTimes(2);
    expect(inspections).toBe(2);
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
      model, tools: [], signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(providers.generate).not.toHaveBeenCalled();
    expect(groupEnds).toHaveBeenCalledTimes(2);
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
      model, tools: [],
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
      model, tools: [],
    });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', kind: 'chat', content: 'Add a chart' }));
  });

  it('injects an in-flight environmental observation once into the next turn of the same run', async () => {
    const db = { history: { add: vi.fn(async () => 1), forApp: vi.fn(async () => []) } };
    let release!: (value: { text: string }) => void;
    const first = new Promise<{ text: string }>(resolve => { release = resolve; });
    const providers = { generate: vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce({ text: 'return itsalive.done();' }) };
    const executor = { execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => code.includes('dom.inspect') ? { value: '@1 body\n└─ @2 main "Ready"' } : code.includes('done') ? { done: true } : { value: 'turn one' }) };
    const queue: string[] = [];
    const consume = vi.fn(() => queue.splice(0));
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const run = new AgentRunner(db as never, providers as never, executor).run({ appId, appPrompt: 'Maintain it', trigger: 'Start', model, tools: [], consumeEnvironmentObservations: consume });
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
      if (code.includes('dom.inspect')) return { value: '@1 body\n└─ @2 main "Ready"' };
      if (++executions === 1) queue.push('A final user action arrived.');
      return { done: true };
    }) };
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const result = await new AgentRunner(db as never, providers as never, executor).run({ appId, appPrompt: 'Maintain it', trigger: 'Start', model, tools: [], consumeEnvironmentObservations: () => queue.splice(0) });
    expect(result).toMatchObject({ status: 'done', turns: 2 });
    expect(providers.generate.mock.calls[1]![0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('A final user action arrived.') })]));
  });
});
