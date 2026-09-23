import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpAdapter, ProviderRegistry, ProviderResponseError } from "../src/shell/core/providers";

describe("ProviderRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("registers and routes neutral generation requests", async () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const registry = new ProviderRegistry().register({ id: "local", generate: async request => ({ text: request.system }) });
    const result = await registry.generate({ model: { provider: "local", model: "x" }, system: "system", messages: [] });
    expect(result.text).toBe("system");
  });

  it('centrally traces compact request and response metadata without replaying full prompts', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    const registry = new ProviderRegistry().register({ id: 'local', generate: async () => ({ text: 'ok', raw: { id: 'response-id', model: 'resolved-model', authorization: 'Bearer secret-token' } }) });
    await registry.generate({ purpose: 'app design', model: { provider: 'local', model: 'x' }, system: 'full system', messages: [{ role: 'user', content: 'full message' }] }, { value: 'credential-secret' });
    const trace = JSON.stringify(info.mock.calls);
    expect(trace).toContain('systemCharacters');
    expect(trace).toContain('messages');
    expect(trace).toContain('response-id');
    expect(trace).toContain('resolved-model');
    expect(trace).toContain('textPreview');
    expect(trace).not.toContain('full system');
    expect(trace).not.toContain('full message');
    expect(trace).not.toContain('secret-token');
    expect(trace).not.toContain('credential-secret');
  });

  it("rejects unknown providers clearly", () => {
    expect(() => new ProviderRegistry().get("missing")).toThrow("Unknown LLM provider");
  });

  it("preserves a sanitized response diagnostic when successful HTTP has no text", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { refusal: 'unsupported request shape' } }],
      authorization: 'Bearer must-not-leak',
      metadata: { api_key: 'must-not-leak-either' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const error = await createHttpAdapter({ id: 'custom', endpoint: 'https://example.test/generate' })
      .generate({ model: { provider: 'custom', model: 'x' }, system: 'system', messages: [] }, { value: 'request-secret' })
      .catch(value => value);
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect(error.message).toBe('Provider returned no text response');
    expect(error.diagnostic).toEqual({
      choices: [{ message: { refusal: 'unsupported request shape' } }],
      authorization: '[redacted]',
      metadata: { api_key: '[redacted]' },
    });
    expect(JSON.stringify(error.diagnostic)).not.toContain('must-not-leak');
  });

  it('preserves HTTP status and a sanitized response body in provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Invalid request', authorization: 'Bearer response-secret' },
      apiKey: 'another-response-secret',
    }), { status: 400, statusText: 'Bad Request', headers: { 'content-type': 'application/json' } })));

    const error = await createHttpAdapter({ id: 'custom', endpoint: 'https://example.test/generate' })
      .generate({ model: { provider: 'custom', model: 'x' }, system: 'system', messages: [] })
      .catch(value => value);

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect(error.diagnostic).toEqual({
      status: 400,
      statusText: 'Bad Request',
      body: {
        error: { message: 'Invalid request', authorization: '[redacted]' },
        apiKey: '[redacted]',
      },
    });
    expect(JSON.stringify(error.diagnostic)).not.toContain('response-secret');
  });

  it('includes provider diagnostics in the centralized failure trace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Denied', credential: 'credential-secret' },
    }), { status: 403, statusText: 'Forbidden', headers: { 'content-type': 'application/json' } })));
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorTrace = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new ProviderRegistry().register(createHttpAdapter({ id: 'custom', endpoint: 'https://example.test/generate' }));

    await expect(registry.generate({ model: { provider: 'custom', model: 'x' }, system: 'system', messages: [] })).rejects.toBeInstanceOf(ProviderResponseError);

    const trace = JSON.stringify(errorTrace.mock.calls);
    expect(trace).toContain('diagnostic');
    expect(trace).toContain('403');
    expect(trace).toContain('Forbidden');
    expect(trace).toContain('[redacted]');
    expect(trace).not.toContain('credential-secret');
  });

  it("streams OpenRouter-style SSE text and reconstructs the full response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" second"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"cost":0.0012}}\n\n',
      'data: [DONE]\n\n',
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter({ id: "custom", endpoint: "https://example.test/generate" });
    const deltas: string[] = [];

    const result = await adapter.stream!(
      { model: { provider: "custom", model: "x" }, system: "system", messages: [] },
      undefined,
      delta => deltas.push(delta),
    );

    expect(deltas).toEqual(["first", " second"]);
    expect(result.text).toBe("first second");
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2, cost: 0.0012 });
    const request = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(request.stream).toBe(true);
    expect(request.usage).toEqual({ include: true });
    expect(request).not.toHaveProperty("max_tokens");
  });


  it("reports stream transport activity separately from visible text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter({ id: "custom", endpoint: "https://example.test/generate" });
    const deltas: string[] = [];
    const activity = vi.fn();

    const result = await adapter.stream!(
      { model: { provider: "custom", model: "x" }, system: "system", messages: [] },
      undefined,
      delta => deltas.push(delta),
      activity,
    );

    expect(activity).toHaveBeenCalled();
    expect(deltas).toEqual(["done"]);
    expect(result.text).toBe("done");
  });


  it("reports missing usage metadata to the registry instead of silently skipping accounting", async () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const onUsage = vi.fn();
    const registry = new ProviderRegistry(onUsage).register({
      id: "local",
      generate: async () => ({ text: "ok" }),
    });

    await registry.generate({ model: { provider: "local", model: "x" }, system: "system", messages: [] });

    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(undefined);
  });


  it("emits hierarchical request traces with explicit unknown usage", async () => {
    vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const onTrace = vi.fn();
    const registry = new ProviderRegistry(undefined, onTrace).register({
      id: "local",
      generate: async () => ({ text: "ok" }),
    });

    await registry.generate({
      purpose: "worker repair",
      model: { provider: "local", model: "worker-model", options: { reasoning: { effort: "low" } } },
      system: "system",
      messages: [],
      trace: {
        runId: "worker-run",
        agentId: "worker-a",
        parentRunId: "manager-run",
        parentAgentId: "manager",
        role: "repair-worker",
        profile: "repair-low",
        scope: "#timer",
        turn: 3,
        context: {
          turn: 3,
          estimatedInputTokens: 250,
          selectedHistoryTokens: 40,
          omittedHistoryCount: 2,
        },
      },
    });

    expect(onTrace).toHaveBeenCalledOnce();
    expect(onTrace.mock.calls[0]?.[0]).toMatchObject({
      runId: "worker-run",
      agentId: "worker-a",
      parentRunId: "manager-run",
      parentAgentId: "manager",
      role: "repair-worker",
      profile: "repair-low",
      scope: "#timer",
      purpose: "worker repair",
      provider: "local",
      model: "worker-model",
      turn: 3,
      context: {
        estimatedInputTokens: 250,
        selectedHistoryTokens: 40,
        omittedHistoryCount: 2,
      },
      status: "success",
      usage: {
        inputTokens: null,
        cachedInputTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cost: null,
      },
    });
  });

  it("normalizes cached, cache-write, reasoning, and cost usage from OpenRouter-style responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "done" } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        cost: 0.012,
        prompt_tokens_details: {
          cached_tokens: 80,
          cache_creation_input_tokens: 20,
        },
        completion_tokens_details: {
          reasoning_tokens: 7,
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await createHttpAdapter({ id: "custom", endpoint: "https://example.test/generate" })
      .generate({ model: { provider: "custom", model: "x" }, system: "system", messages: [] });

    expect(result.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 80,
      cacheWriteTokens: 20,
      outputTokens: 30,
      reasoningTokens: 7,
      cost: 0.012,
    });
  });

  it("records failed requests as trace errors without inventing token or cost usage", async () => {
    vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onTrace = vi.fn();
    const registry = new ProviderRegistry(undefined, onTrace).register({
      id: "local",
      generate: async () => { throw new Error("generation failed"); },
    });

    await expect(registry.generate({
      model: { provider: "local", model: "x" },
      system: "system",
      messages: [],
      trace: { runId: "r", agentId: "a", role: "coding-agent", profile: "coding-default" },
    })).rejects.toThrow("generation failed");

    expect(onTrace.mock.calls[0]?.[0]).toMatchObject({
      status: "error",
      error: { name: "Error", message: "generation failed" },
      usage: {
        inputTokens: null,
        cachedInputTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cost: null,
      },
    });
  });

});
